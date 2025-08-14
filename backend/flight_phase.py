"""
Flight Phase Detection Module
Detects the current phase of flight from SimConnect state data.
"""

from enum import Enum
from collections import deque
import time


class FlightPhase(str, Enum):
    AT_GATE = "AT_GATE"
    PUSHBACK = "PUSHBACK"
    TAXI = "TAXI"
    HOLDING_SHORT = "HOLDING_SHORT"
    TAKEOFF_ROLL = "TAKEOFF_ROLL"
    INITIAL_CLIMB = "INITIAL_CLIMB"
    CLIMB = "CLIMB"
    CRUISE = "CRUISE"
    DESCENT = "DESCENT"
    APPROACH = "APPROACH"
    FINAL_APPROACH = "FINAL_APPROACH"
    LANDING = "LANDING"
    LANDED = "LANDED"
    UNKNOWN = "UNKNOWN"


PHASE_LABELS = {
    FlightPhase.AT_GATE: "At Gate",
    FlightPhase.PUSHBACK: "Pushback",
    FlightPhase.TAXI: "Taxi",
    FlightPhase.HOLDING_SHORT: "Holding Short",
    FlightPhase.TAKEOFF_ROLL: "Takeoff Roll",
    FlightPhase.INITIAL_CLIMB: "Initial Climb",
    FlightPhase.CLIMB: "Climb",
    FlightPhase.CRUISE: "Cruise",
    FlightPhase.DESCENT: "Descent",
    FlightPhase.APPROACH: "Approach",
    FlightPhase.FINAL_APPROACH: "Final Approach",
    FlightPhase.LANDING: "Landing Roll",
    FlightPhase.LANDED: "Landed",
    FlightPhase.UNKNOWN: "Unknown",
}


class FlightPhaseDetector:
    def __init__(self, history_size: int = 15):
        self.altitude_history: deque = deque(maxlen=history_size)
        self.speed_history: deque = deque(maxlen=history_size)
        self.timestamp_history: deque = deque(maxlen=history_size)
        self.last_phase = FlightPhase.UNKNOWN
        self.was_airborne = False
        self.takeoff_alt = 0
        self.phase_hint: FlightPhase | None = None  # hint from chat context

    def set_phase_hint(self, phase: FlightPhase | None):
        """Set a phase hint from conversation context to override sensor-based detection."""
        self.phase_hint = phase

    def _avg_vertical_rate(self) -> float:
        if len(self.altitude_history) < 3:
            return 0.0
        recent = list(self.altitude_history)[-5:]
        times = list(self.timestamp_history)[-5:]
        if len(recent) < 2:
            return 0.0
        dt = times[-1] - times[0]
        if dt < 0.5:
            return 0.0
        return (recent[-1] - recent[0]) / (dt / 60.0)  # ft/min

    def detect(
        self,
        state: dict,
        *,
        timestamp: float | None = None,
        field_elevation_ft: float = 0.0,
        authoritative_phase: str | None = None,
    ) -> FlightPhase:
        if authoritative_phase:
            phase = FlightPhase(authoritative_phase)
            self.last_phase = phase
            self.was_airborne = not bool(state.get("on_ground", True)) or self.was_airborne
            return phase
        on_ground = state.get("on_ground", True)
        altitude = state.get("altitude", 0)
        speed = state.get("ground_speed", 0)

        now = time.monotonic() if timestamp is None else timestamp
        self.altitude_history.append(altitude)
        self.speed_history.append(speed)
        self.timestamp_history.append(now)

        sensor_vrate = state.get("vertical_speed_fpm")
        vrate = float(sensor_vrate) if sensor_vrate is not None else self._avg_vertical_rate()

        # If there's a chat-based phase hint, use it (overrides sensor detection)
        if self.phase_hint is not None:
            phase = self.phase_hint
            self.phase_hint = None  # one-shot hint; subsequent polls revert to sensor
            self.last_phase = phase
            if not on_ground:
                self.was_airborne = True
            return phase

        # --- ON GROUND ---
        if on_ground:
            if self.was_airborne and speed > 40:
                phase = FlightPhase.LANDING
            elif self.was_airborne and speed <= 40:
                self.was_airborne = False
                phase = FlightPhase.LANDED
            elif speed < 1:
                # If we were taxiing and stopped, could be holding short
                if self.last_phase in (FlightPhase.TAXI, FlightPhase.HOLDING_SHORT):
                    phase = FlightPhase.HOLDING_SHORT
                else:
                    phase = FlightPhase.AT_GATE
            elif speed < 5:
                if self.last_phase in (FlightPhase.TAXI, FlightPhase.HOLDING_SHORT):
                    phase = FlightPhase.HOLDING_SHORT
                else:
                    phase = FlightPhase.PUSHBACK
            elif speed < 30:
                phase = FlightPhase.TAXI
            elif speed >= 30:
                phase = FlightPhase.TAKEOFF_ROLL
            else:
                phase = FlightPhase.AT_GATE
        else:
            # --- AIRBORNE ---
            self.was_airborne = True
            if not self.takeoff_alt and self.last_phase in (FlightPhase.TAKEOFF_ROLL, FlightPhase.AT_GATE):
                self.takeoff_alt = altitude

            agl_approx = max(0.0, altitude - field_elevation_ft)

            if agl_approx < 1500 and vrate > 200:
                phase = FlightPhase.INITIAL_CLIMB
            elif vrate > 300:
                phase = FlightPhase.CLIMB
            elif vrate < -300 and agl_approx < 4000 and speed < 190:
                phase = FlightPhase.FINAL_APPROACH
            elif vrate < -300 and agl_approx < 10000:
                phase = FlightPhase.APPROACH
            elif vrate < -200:
                phase = FlightPhase.DESCENT
            elif abs(vrate) < 200:
                phase = FlightPhase.CRUISE
            else:
                phase = FlightPhase.CLIMB if vrate > 0 else FlightPhase.DESCENT

        self.last_phase = phase
        return phase

    def get_phase_info(
        self,
        state: dict,
        *,
        timestamp: float | None = None,
        field_elevation_ft: float = 0.0,
        authoritative_phase: str | None = None,
    ) -> dict:
        phase = self.detect(
            state,
            timestamp=timestamp,
            field_elevation_ft=field_elevation_ft,
            authoritative_phase=authoritative_phase,
        )
        vrate = float(state.get("vertical_speed_fpm", self._avg_vertical_rate()))
        return {
            "phase": phase.value,
            "phase_label": PHASE_LABELS[phase],
            "vertical_rate": round(vrate),
        }

    def reset(self):
        self.altitude_history.clear()
        self.speed_history.clear()
        self.timestamp_history.clear()
        self.last_phase = FlightPhase.UNKNOWN
        self.was_airborne = False
        self.takeoff_alt = 0
        self.phase_hint = None
