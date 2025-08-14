"""
Real-time flight simulation engine.

Runs an asyncio tick loop that integrates physics (position, altitude, speed,
heading, fuel) toward target/commanded values with realistic inertia.
Also drives weather and traffic modules so the world updates between chats.
"""
from __future__ import annotations

import asyncio
import math
import random
import time
from dataclasses import dataclass, field
from typing import Callable, Optional


TICK_HZ = 10
TICK_DT = 1.0 / TICK_HZ          # 100 ms
EARTH_R_NM = 3440.065


@dataclass
class Targets:
    """Commanded values that the aircraft is moving toward."""
    altitude: Optional[float] = None
    heading: Optional[float] = None
    speed: Optional[float] = None        # ground speed target (kts)


@dataclass
class FlightDynamics:
    # Hard performance envelope (jet airliner-ish)
    max_climb_rate: float = 2500.0       # ft/min
    max_descent_rate: float = 2200.0     # ft/min
    max_turn_rate: float = 3.0           # deg / sec
    max_accel_kts_per_sec: float = 1.5
    max_decel_kts_per_sec: float = 2.0
    fuel_burn_kg_per_hr_cruise: float = 2400.0
    fuel_burn_kg_per_hr_climb: float = 3800.0
    fuel_burn_kg_per_hr_idle: float = 600.0


def _normalize_heading(h: float) -> float:
    return h % 360.0


def _shortest_turn(curr: float, target: float) -> float:
    """Signed shortest delta from curr to target heading in degrees (-180,180]."""
    d = (target - curr + 540.0) % 360.0 - 180.0
    return d


def _move_position(lat: float, lon: float, hdg_deg: float, dist_nm: float) -> tuple[float, float]:
    """Advance on a great-circle arc, including poles and the date line."""
    angular = dist_nm / EARTH_R_NM
    phi1 = math.radians(lat)
    lam1 = math.radians(lon)
    theta = math.radians(hdg_deg)
    sin_phi2 = math.sin(phi1) * math.cos(angular) + math.cos(phi1) * math.sin(angular) * math.cos(theta)
    phi2 = math.asin(max(-1.0, min(1.0, sin_phi2)))
    lam2 = lam1 + math.atan2(
        math.sin(theta) * math.sin(angular) * math.cos(phi1),
        math.cos(angular) - math.sin(phi1) * math.sin(phi2),
    )
    return math.degrees(phi2), (math.degrees(lam2) + 540.0) % 360.0 - 180.0


class SimEngine:
    """
    Drives `state` (a dict shared with main.py's demo_state) at TICK_HZ.

    External code may set targets via `set_target_*`. The engine smoothly
    integrates the actual values toward the target with realistic constraints.
    Wind from a weather provider perturbs ground speed.
    """

    def __init__(
        self,
        state: dict,
        get_wind: Optional[Callable[[float, float, float], tuple[float, float]]] = None,
    ):
        self.state = state
        self.targets = Targets()
        self.dyn = FlightDynamics()
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self._last_tick: float = 0.0
        self._get_wind = get_wind  # (lat, lon, alt) -> (wind_dir_deg_from, wind_speed_kts)
        self._listeners: list[Callable[[dict], None]] = []
        # Initial fuel if not provided
        self.state.setdefault("fuel_kg", 18000.0)
        self.state.setdefault("fuel_initial_kg", 18000.0)
        self.state.setdefault("vertical_speed_fpm", 0.0)
        self.state.setdefault("true_airspeed", 0.0)
        self.state.setdefault("wind_dir", 0)
        self.state.setdefault("wind_kts", 0)

    # ---- targeting api -----------------------------------------------------
    def set_target_altitude(self, alt: float):
        self.targets.altitude = max(-1500.0, min(60000.0, float(alt)))

    def set_target_heading(self, hdg: float):
        self.targets.heading = _normalize_heading(float(hdg))

    def set_target_speed(self, kts: float):
        self.targets.speed = max(0.0, min(700.0, float(kts)))

    def clear_target_altitude(self): self.targets.altitude = None
    def clear_target_heading(self):  self.targets.heading = None
    def clear_target_speed(self):    self.targets.speed = None

    def reset_targets(self):
        self.targets = Targets()

    def advance(
        self,
        dt: float,
        *,
        max_distance_nm: float | None = None,
        destination: tuple[float, float] | None = None,
    ) -> None:
        """Advance exactly once with caller-owned deterministic time.

        The production runtime uses this method instead of the legacy private
        background loop, so state composition and kinematics share one clock.
        """
        self._tick(
            max(0.0, min(float(dt), 30.0)),
            max_distance_nm=max_distance_nm,
            destination=destination,
        )
        self._notify()

    # ---- listener api ------------------------------------------------------
    def add_listener(self, fn: Callable[[dict], None]):
        self._listeners.append(fn)

    def remove_listener(self, fn: Callable[[dict], None]):
        if fn in self._listeners:
            self._listeners.remove(fn)

    # ---- lifecycle ---------------------------------------------------------
    async def start(self):
        if self._running:
            return
        self._running = True
        self._last_tick = time.monotonic()
        self._task = asyncio.create_task(self._loop())

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    # ---- main loop ---------------------------------------------------------
    async def _loop(self):
        try:
            while self._running:
                await asyncio.sleep(TICK_DT)
                now = time.monotonic()
                dt = max(0.001, min(0.5, now - self._last_tick))
                self._last_tick = now
                try:
                    self._tick(dt)
                except Exception:
                    # Never let the loop die because of one bad tick
                    pass
                self._notify()
        except asyncio.CancelledError:
            return

    def _notify(self):
        for fn in list(self._listeners):
            try:
                fn(self.state)
            except Exception:
                pass

    # ---- physics integration ----------------------------------------------
    def _tick(
        self,
        dt: float,
        *,
        max_distance_nm: float | None = None,
        destination: tuple[float, float] | None = None,
    ):
        s = self.state
        on_ground = bool(s.get("on_ground", True))
        alt = float(s.get("altitude", 0))
        hdg = _normalize_heading(float(s.get("heading_mag", 0)))
        gs = float(s.get("ground_speed", 0))

        # ---- altitude integration ----
        target_alt = self.targets.altitude
        if target_alt is not None and not on_ground:
            diff = target_alt - alt
            if abs(diff) < 5.0:
                alt = target_alt
                vs = 0.0
            else:
                # match real airliner climb/descent
                desired_vs_fpm = (
                    min(self.dyn.max_climb_rate, max(500.0, abs(diff) * 0.5))
                    if diff > 0
                    else -min(self.dyn.max_descent_rate, max(500.0, abs(diff) * 0.5))
                )
                vs = desired_vs_fpm
                alt += (vs / 60.0) * dt
                # don't overshoot
                if (diff > 0 and alt > target_alt) or (diff < 0 and alt < target_alt):
                    alt = target_alt
                    vs = 0.0
        else:
            vs = 0.0
            if not on_ground:
                # natural drift toward stable cruise — none
                pass
            else:
                alt = max(alt, 0.0)
        s["vertical_speed_fpm"] = round(vs)

        # ---- heading integration ----
        if self.targets.heading is not None:
            d = _shortest_turn(hdg, self.targets.heading)
            max_step = self.dyn.max_turn_rate * dt
            if abs(d) <= max_step:
                hdg = self.targets.heading
            else:
                hdg = _normalize_heading(hdg + math.copysign(max_step, d))

        # ---- speed integration ----
        if self.targets.speed is not None:
            sd = self.targets.speed - gs
            max_step = (
                self.dyn.max_accel_kts_per_sec
                if sd > 0
                else self.dyn.max_decel_kts_per_sec
            ) * dt
            if abs(sd) <= max_step:
                gs = self.targets.speed
            else:
                gs += math.copysign(max_step, sd)
        gs = max(0.0, gs)
        if on_ground and gs < 0.5:
            gs = 0.0

        # ---- wind / true airspeed model ----
        wind_dir, wind_kts = 0.0, 0.0
        if self._get_wind:
            try:
                wind_dir, wind_kts = self._get_wind(s.get("lat", 0.0), s.get("lon", 0.0), alt)
            except Exception:
                wind_dir, wind_kts = 0.0, 0.0
        # wind_dir is direction the wind comes FROM; aircraft heads `hdg`.
        # ground speed = TAS - headwind_component (rough)
        # If we're ON ground, wind doesn't matter for movement.
        tas = gs
        if not on_ground and wind_kts > 0:
            # wind_to vector is (wind_dir + 180)
            wind_to = (wind_dir + 180.0) % 360.0
            rel = math.radians(wind_to - hdg)
            tail = math.cos(rel) * wind_kts  # +ve means tailwind
            tas = max(0.0, gs - tail)
        s["true_airspeed"] = round(tas)
        s["wind_dir"] = round(wind_dir)
        s["wind_kts"] = round(wind_kts)

        # ---- position integration ----
        if gs > 0.05 and dt > 0:
            dist_nm = (gs / 3600.0) * dt
            if max_distance_nm is not None:
                dist_nm = min(dist_nm, max(0.0, max_distance_nm))
            if destination is not None and max_distance_nm is not None and dist_nm >= max_distance_nm - 1e-9:
                new_lat, new_lon = destination
            else:
                new_lat, new_lon = _move_position(s.get("lat", 0.0), s.get("lon", 0.0), hdg, dist_nm)
            s["lat"] = round(new_lat, 6)
            s["lon"] = round(new_lon, 6)

        # ---- fuel burn ----
        # Pick burn rate by phase
        if on_ground and gs < 5:
            burn = self.dyn.fuel_burn_kg_per_hr_idle
        elif vs > 200:
            burn = self.dyn.fuel_burn_kg_per_hr_climb
        else:
            burn = self.dyn.fuel_burn_kg_per_hr_cruise
        fuel = max(0.0, float(s.get("fuel_kg", 0)) - burn * (dt / 3600.0))
        s["fuel_kg"] = round(fuel, 1)

        # ---- write back ----
        s["altitude"] = round(alt, 1)
        s["heading_mag"] = round(hdg, 1)
        s["ground_speed"] = round(gs, 1)


def random_initial_fuel(scenario: str = "default") -> float:
    return {
        "default": 18000.0,
        "fuel_emergency": 800.0,
        "engine_failure": 14000.0,
        "medical_emergency": 16000.0,
        "hydraulic_failure": 12000.0,
        "bird_strike": 17000.0,
        "ground_taxi": 21000.0,
    }.get(scenario, 18000.0) + random.uniform(-300, 300)
