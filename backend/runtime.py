"""Single-authority simulation runtime and cached snapshot broadcaster."""

from __future__ import annotations

import asyncio
import json
import math
import time
import uuid
from datetime import datetime, timezone
from typing import Any

try:
    from .clearances import ClearanceManager
    from .conflicts import predict_conflicts
    from .emergencies import EmergencyManager
    from .flight_phase import FlightPhaseDetector
    from .navigation import AirportCatalog, AirportResolutionError, RouteAutopilot
    from .schemas import (
        Alert,
        Clearance,
        DemoStateUpdate,
        EventMetadata,
        Severity,
        Snapshot,
        SourceKind,
        SCHEMA_VERSION,
    )
    from .sim_engine import SimEngine
    from .traffic import TrafficEngine
    from .weather import WeatherEngine
except ImportError:  # pragma: no cover
    from clearances import ClearanceManager
    from conflicts import predict_conflicts
    from emergencies import EmergencyManager
    from flight_phase import FlightPhaseDetector
    from navigation import AirportCatalog, AirportResolutionError, RouteAutopilot
    from schemas import Alert, Clearance, DemoStateUpdate, EventMetadata, Severity, Snapshot, SourceKind, SCHEMA_VERSION
    from sim_engine import SimEngine
    from traffic import TrafficEngine
    from weather import WeatherEngine


DEFAULT_STATE: dict[str, Any] = {
    "connected": False,
    "altitude": 52.0,
    "ground_speed": 0.0,
    "heading_mag": 70.0,
    "lat": 12.9941,
    "lon": 80.1709,
    "com1_active": 121.9,
    "com1_standby": 118.1,
    "squawk": "2000",
    "xpdr_mode": "C",
    "xpdr_ident": False,
    "on_ground": True,
    "atc_id": "",
    "atc_flight_number": "",
    "fuel_kg": 18000.0,
    "fuel_initial_kg": 18000.0,
    "vertical_speed_fpm": 0.0,
    "true_airspeed": 0.0,
    "wind_dir": 0,
    "wind_kts": 0,
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _coerce_observed_time(value: Any, fallback: datetime) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return fallback
    else:
        return fallback
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


class SimulationRuntime:
    """Owns every mutable flight value and publishes one snapshot per tick."""

    def __init__(self, *, tick_hz: float = 5.0, sim_reader: Any = None, seed: int = 73):
        self.tick_hz = max(1.0, min(20.0, tick_hz))
        self.tick_interval = 1.0 / self.tick_hz
        self.catalog = AirportCatalog()
        self.state: dict[str, Any] = dict(DEFAULT_STATE)
        self.weather = WeatherEngine(seed=seed)
        self.traffic = TrafficEngine(seed=seed)
        self.phase_detector = FlightPhaseDetector()
        self.route = RouteAutopilot()
        self.emergencies = EmergencyManager()
        self.clearances = ClearanceManager()
        self.engine = SimEngine(self.state, get_wind=self.weather.get_wind)
        self.sim_reader = sim_reader
        self.session_id = str(uuid.uuid4())
        self.sequence = 0
        self.event_sequence = 0
        self.callsign = ""
        self.active_scenario = ""
        self.source = SourceKind.DEMO
        self.observed_at = utc_now()
        self.started_at = time.monotonic()
        self.last_tick_monotonic = 0.0
        self.last_tick_duration_ms = 0.0
        self.running = False
        self._task: asyncio.Task | None = None
        self._subscribers: set[asyncio.Queue[str]] = set()
        self._snapshot: Snapshot | None = None
        self._snapshot_json = ""
        self._manual_phase: str | None = None
        self._manual_takeoff = False
        self._last_error: str | None = None
        self.lock = asyncio.Lock()
        self.traffic.reset_around(self.state["lat"], self.state["lon"], self.state["altitude"])
        self.tick_once(0.0)

    async def start(self) -> None:
        if self.running:
            return
        self.running = True
        self._task = asyncio.create_task(self._loop(), name="authoritative-simulation-loop")

    async def stop(self) -> None:
        self.running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _loop(self) -> None:
        deadline = time.monotonic()
        while self.running:
            deadline += self.tick_interval
            await asyncio.sleep(max(0.0, deadline - time.monotonic()))
            started = time.perf_counter()
            external = None
            if self.sim_reader is not None and not self.route.autopilot_engaged:
                try:
                    external = await asyncio.wait_for(asyncio.to_thread(self.sim_reader.get_state), timeout=0.15)
                except (asyncio.TimeoutError, Exception):
                    external = None
            try:
                async with self.lock:
                    self.tick_once(self.tick_interval, external_state=external)
                self._last_error = None
            except Exception as exc:  # keep the authority loop alive, expose safe health detail
                self._last_error = type(exc).__name__
            self.last_tick_duration_ms = (time.perf_counter() - started) * 1000.0

    def tick_once(
        self,
        dt: float,
        *,
        now: datetime | None = None,
        external_state: dict | None = None,
    ) -> Snapshot:
        """Advance and compose exactly one immutable snapshot."""
        server_time = now or utc_now()
        source = SourceKind.DEMO
        if external_state and external_state.get("connected") and not self.route.autopilot_engaged:
            self._apply_external_state(external_state)
            source = SourceKind.SIMCONNECT
            self.observed_at = _coerce_observed_time(external_state.get("observed_at"), server_time)
        else:
            self.observed_at = server_time
            simulated_dt = max(0.0, dt) * (self.route.time_scale if self.route.autopilot_engaged else 1.0)
            effects = self.emergencies.effects()
            targets = self.route.targets(self.state, simulated_dt, effects)
            max_distance = None
            destination = None
            if targets:
                self.state["on_ground"] = bool(targets["on_ground"])
                self._manual_phase = targets["phase"]
                self.engine.set_target_heading(targets["heading"])
                self.engine.set_target_speed(targets["speed"])
                self.engine.set_target_altitude(targets["altitude"])
                max_distance = targets.get("max_distance_nm")
                if self.route.destination:
                    destination = (self.route.destination.lat, self.route.destination.lon)
                if self.state["on_ground"]:
                    self.state["altitude"] = float(targets["altitude"])
            elif self._manual_takeoff and self.state["ground_speed"] >= 145:
                self.state["on_ground"] = False
                self._manual_phase = "INITIAL_CLIMB"
                self.engine.set_target_altitude(max(self.state["altitude"] + 5000.0, 5000.0))
                self._manual_takeoff = False
            self.engine.advance(simulated_dt, max_distance_nm=max_distance, destination=destination)
            self.weather.tick()
            self.traffic.tick(self.state["lat"], self.state["lon"], self.state["altitude"], simulated_dt)

        self.source = source
        self.sequence += 1
        self.last_tick_monotonic = time.monotonic()
        self._snapshot = self._compose_snapshot(server_time)
        self._snapshot_json = self._snapshot.model_dump_json()
        self._publish(self._snapshot_json)
        return self._snapshot.model_copy(deep=True)

    def _apply_external_state(self, external: dict) -> None:
        bounded = {
            "connected": bool(external.get("connected", True)),
            "altitude": max(-1500.0, min(60000.0, float(external.get("altitude", self.state["altitude"])))),
            "ground_speed": max(0.0, min(700.0, float(external.get("ground_speed", self.state["ground_speed"])))),
            "heading_mag": float(external.get("heading_mag", self.state["heading_mag"])) % 360.0,
            "lat": max(-90.0, min(90.0, float(external.get("lat", self.state["lat"])))),
            "lon": max(-180.0, min(180.0, float(external.get("lon", self.state["lon"])))),
            "on_ground": bool(external.get("on_ground", self.state["on_ground"])),
        }
        for optional in (
            "com1_active", "com1_standby", "squawk", "xpdr_mode", "xpdr_ident",
            "atc_id", "atc_flight_number", "fuel_kg", "fuel_initial_kg",
            "vertical_speed_fpm", "true_airspeed",
        ):
            if optional in external and external[optional] is not None:
                bounded[optional] = external[optional]
        self.state.update(bounded)

    def _compose_snapshot(self, server_time: datetime) -> Snapshot:
        nearest = self.catalog.nearest(self.state["lat"], self.state["lon"])
        field_elevation = nearest.elev if nearest and (nearest.distance_nm or 0) < 10 else 0.0
        route_state = self.route.to_state(self.state)
        authoritative_phase = route_state.phase if route_state and self.route.route_id else self._manual_phase
        phase_info = self.phase_detector.get_phase_info(
            self.state,
            timestamp=self.last_tick_monotonic,
            field_elevation_ft=field_elevation,
            authoritative_phase=authoritative_phase,
        )
        traffic = self.traffic.to_list(self.state["lat"], self.state["lon"])
        conflicts = predict_conflicts(self.state, traffic)
        emergency = self.emergencies.refresh(self.state)
        alerts: list[Alert] = []
        if emergency and emergency.status != "resolved":
            alerts.append(Alert(
                alert_id=f"emergency:{emergency.emergency_id}",
                category="emergency",
                severity=emergency.severity,
                title=emergency.title,
                message=emergency.alert_message,
                created_at=emergency.declared_at,
            ))
        for conflict in conflicts:
            alerts.append(Alert(
                alert_id=conflict.conflict_id,
                category="traffic",
                severity=conflict.severity,
                title=f"Traffic conflict — {conflict.callsign}",
                message=(
                    f"CPA {conflict.cpa_distance_nm:.1f} NM / {conflict.cpa_vertical_separation_ft:.0f} ft "
                    f"in {conflict.time_to_cpa_seconds}s. {conflict.advisory}"
                ),
                created_at=server_time,
            ))
        data_age_ms = max(0, int((server_time - self.observed_at).total_seconds() * 1000.0))
        snapshot_id = f"{self.session_id}:{self.sequence}"
        return Snapshot(
            schema_version=SCHEMA_VERSION,
            session_id=self.session_id,
            sequence=self.sequence,
            snapshot_id=snapshot_id,
            observed_at=self.observed_at,
            server_time=server_time,
            source=self.source,
            data_age_ms=data_age_ms,
            **{key: self.state[key] for key in (
                "connected", "altitude", "ground_speed", "heading_mag", "lat", "lon",
                "com1_active", "com1_standby", "squawk", "xpdr_mode", "xpdr_ident",
                "on_ground", "atc_id", "atc_flight_number", "fuel_kg", "fuel_initial_kg",
                "vertical_speed_fpm", "true_airspeed", "wind_dir", "wind_kts",
            )},
            phase=phase_info["phase"],
            phase_label=phase_info["phase_label"],
            vertical_rate=phase_info["vertical_rate"],
            nearest_airport=nearest,
            callsign=self.callsign,
            traffic=traffic,
            conflicts=conflicts,
            weather=self.weather.to_dict(),
            route=route_state,
            emergency=emergency,
            alerts=alerts,
            clearances=self.clearances.list(),
            emergency_active=bool(emergency and emergency.status != "resolved"),
            active_scenario=self.active_scenario,
        )

    def current_snapshot(self) -> Snapshot:
        assert self._snapshot is not None
        return self._snapshot.model_copy(deep=True)

    def current_payload(self) -> dict:
        return self.current_snapshot().model_dump(mode="json")

    @property
    def current_json(self) -> str:
        return self._snapshot_json

    def subscribe(self) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=1)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[str]) -> None:
        self._subscribers.discard(queue)

    def _publish(self, payload: str) -> None:
        for queue in tuple(self._subscribers):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                pass

    def event(self, event_type: str) -> EventMetadata:
        self.event_sequence += 1
        now = utc_now()
        data_age = max(0, int((now - self.observed_at).total_seconds() * 1000.0))
        return EventMetadata(
            event_id=str(uuid.uuid4()),
            event_type=event_type,
            session_id=self.session_id,
            sequence=self.sequence,
            event_sequence=self.event_sequence,
            observed_at=self.observed_at,
            server_time=now,
            source=self.source,
            data_age_ms=data_age,
        )

    def accept_clearance(self, clearance_id: str, readback: str) -> Clearance:
        clearance = self.clearances.accept(clearance_id, readback)
        self._apply_clearance(clearance)
        return self.clearances.mark_executing(clearance_id)

    def _apply_clearance(self, clearance: Clearance) -> None:
        """The only bridge from an accepted structured clearance to targets."""
        for instruction in clearance.instructions:
            kind, value = instruction.instruction_type, instruction.value
            if kind == "altitude" and value is not None:
                self.state["on_ground"] = False
                self.engine.set_target_altitude(float(value))
                self._manual_phase = "CLIMB" if float(value) > self.state["altitude"] else "DESCENT"
            elif kind == "heading" and value is not None:
                self.engine.set_target_heading(float(value))
            elif kind == "speed" and value is not None:
                self.engine.set_target_speed(float(value))
            elif kind == "frequency" and value is not None:
                self.state["com1_standby"] = self.state["com1_active"]
                self.state["com1_active"] = float(value)
            elif kind == "squawk" and value is not None:
                self.state["squawk"] = str(value)
            elif kind == "pushback":
                self.state["on_ground"] = True
                self.engine.set_target_speed(3.0)
                self._manual_phase = "PUSHBACK"
            elif kind == "taxi":
                self.state["on_ground"] = True
                self.engine.set_target_speed(18.0)
                self._manual_phase = "TAXI"
            elif kind in {"hold_short", "line_up"}:
                self.state["on_ground"] = True
                self.engine.set_target_speed(0.0)
                self._manual_phase = "HOLDING_SHORT"
            elif kind == "takeoff":
                self.state["on_ground"] = True
                self.engine.set_target_speed(170.0)
                self._manual_phase = "TAKEOFF_ROLL"
                self._manual_takeoff = True
            elif kind == "land":
                self._manual_phase = "FINAL_APPROACH"
            elif kind == "direct" and value:
                airport = self.catalog.get(str(value))
                if airport:
                    self.route.divert(self.state, airport, f"Accepted direct-to clearance {clearance.clearance_id}")

    def update_demo_state(self, update: DemoStateUpdate) -> None:
        for key, value in update.model_dump(exclude_none=True).items():
            self.state[key] = value
        if update.heading_mag is not None:
            self.state["heading_mag"] %= 360.0

    def reset(self) -> Snapshot:
        self.state.clear()
        self.state.update(DEFAULT_STATE)
        self.engine.reset_targets()
        self.phase_detector.reset()
        self.route = RouteAutopilot()
        self.emergencies.reset()
        self.clearances.reset()
        self.callsign = ""
        self.active_scenario = ""
        self.session_id = str(uuid.uuid4())
        self.sequence = 0
        self.event_sequence = 0
        self.source = SourceKind.DEMO
        self.observed_at = utc_now()
        self._manual_phase = None
        self._manual_takeoff = False
        self.traffic.reset_around(self.state["lat"], self.state["lon"], self.state["altitude"])
        return self.tick_once(0.0)

    def health(self) -> dict[str, Any]:
        age_seconds = max(0.0, time.monotonic() - self.last_tick_monotonic) if self.last_tick_monotonic else math.inf
        ready = self._snapshot is not None and (not self.running or age_seconds <= max(2.0, self.tick_interval * 5))
        return {
            "status": "ok" if ready and self._last_error is None else "degraded",
            "ready": ready,
            "schema_version": SCHEMA_VERSION,
            "session_id": self.session_id,
            "sequence": self.sequence,
            "source": self.source.value,
            "data_age_ms": self.current_snapshot().data_age_ms,
            "runtime_running": self.running,
            "tick_hz": self.tick_hz,
            "last_tick_duration_ms": round(self.last_tick_duration_ms, 2),
            "connected_clients": len(self._subscribers),
            "airport_catalog_count": self.catalog.count,
            "simconnect_enabled": self.sim_reader is not None,
            "sim_available": self.sim_reader is not None,
            "version": SCHEMA_VERSION,
            "last_error": self._last_error,
            "uptime_seconds": round(time.monotonic() - self.started_at, 1),
        }
