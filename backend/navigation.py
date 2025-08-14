"""Airport catalog, geodesy, and deterministic route/autopilot state."""

from __future__ import annotations

import json
import math
import uuid
from datetime import datetime, timezone
from pathlib import Path

try:
    from .schemas import Airport, ManualAirport, RouteDemoRequest, RouteEndpoint, RouteState
except ImportError:  # pragma: no cover - direct `python backend/main.py` compatibility
    from schemas import Airport, ManualAirport, RouteDemoRequest, RouteEndpoint, RouteState


EARTH_RADIUS_NM = 3440.065


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def normalize_heading(value: float) -> float:
    return value % 360.0


def shortest_heading_delta(current: float, target: float) -> float:
    return (target - current + 540.0) % 360.0 - 180.0


def haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = phi2 - phi1
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    return EARTH_RADIUS_NM * 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))


def initial_bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dlambda = math.radians(lon2 - lon1)
    y = math.sin(dlambda) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlambda)
    return normalize_heading(math.degrees(math.atan2(y, x)))


def destination_point(lat: float, lon: float, heading: float, distance_nm: float) -> tuple[float, float]:
    """Move along a great-circle arc; valid across poles and the date line."""
    angular = distance_nm / EARTH_RADIUS_NM
    phi1 = math.radians(lat)
    lambda1 = math.radians(lon)
    theta = math.radians(heading)
    sin_phi2 = math.sin(phi1) * math.cos(angular) + math.cos(phi1) * math.sin(angular) * math.cos(theta)
    phi2 = math.asin(max(-1.0, min(1.0, sin_phi2)))
    lambda2 = lambda1 + math.atan2(
        math.sin(theta) * math.sin(angular) * math.cos(phi1),
        math.cos(angular) - math.sin(phi1) * math.sin(phi2),
    )
    out_lon = (math.degrees(lambda2) + 540.0) % 360.0 - 180.0
    return math.degrees(phi2), out_lon


class AirportResolutionError(ValueError):
    pass


class AirportCatalog:
    """Catalog abstraction with a validated manual-coordinate fallback.

    Provider adapters can later populate this interface from OurAirports or a
    licensed source. Unknown codes are never assigned invented coordinates.
    """

    def __init__(self, path: str | Path | None = None):
        source_path = Path(path) if path else Path(__file__).with_name("airports.json")
        raw = json.loads(source_path.read_text(encoding="utf-8"))
        self._airports: dict[str, Airport] = {}
        for item in raw:
            item = dict(item)
            item["icao"] = str(item["icao"]).upper()
            item["catalog_source"] = "local"
            self._airports[item["icao"]] = Airport.model_validate(item)

    def get(self, icao: str) -> Airport | None:
        airport = self._airports.get(icao.upper())
        return airport.model_copy(deep=True) if airport else None

    def resolve(self, icao: str, manual: ManualAirport | None = None) -> Airport:
        code = icao.upper()
        known = self.get(code)
        if known:
            return known
        if manual is None:
            raise AirportResolutionError(
                f"Airport {code} is not in the local catalog; provide validated manual coordinates."
            )
        return Airport(
            icao=code,
            name=manual.name or f"{code} (manual)",
            city=manual.city,
            country=manual.country,
            lat=manual.lat,
            lon=manual.lon,
            elev=manual.elev,
            rwys=manual.rwys,
            freq=manual.freq,
            catalog_source="manual",
        )

    def nearest(self, lat: float, lon: float, max_distance_nm: float | None = None) -> Airport | None:
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return None
        best: Airport | None = None
        best_distance = math.inf
        for airport in self._airports.values():
            distance = haversine_nm(lat, lon, airport.lat, airport.lon)
            if distance < best_distance:
                best = airport
                best_distance = distance
        if best is None or (max_distance_nm is not None and best_distance > max_distance_nm):
            return None
        return best.model_copy(update={"distance_nm": round(best_distance, 1)}, deep=True)

    def search(self, query: str, limit: int = 20) -> list[Airport]:
        needle = query.strip().lower()
        if not needle:
            values = list(self._airports.values())
        else:
            values = [
                airport for airport in self._airports.values()
                if needle in airport.icao.lower()
                or needle in airport.name.lower()
                or needle in airport.city.lower()
                or needle in airport.country.lower()
            ]
        values.sort(key=lambda airport: (not airport.icao.lower().startswith(needle), airport.icao))
        return [airport.model_copy(deep=True) for airport in values[:limit]]

    @property
    def count(self) -> int:
        return len(self._airports)


def _endpoint(airport: Airport) -> RouteEndpoint:
    return RouteEndpoint(
        icao=airport.icao,
        name=airport.name,
        lat=airport.lat,
        lon=airport.lon,
        elevation_ft=airport.elev,
        catalog_source=airport.catalog_source,
    )


def _smart_cruise_altitude(distance_nm: float) -> int:
    if distance_nm < 80:
        return 9000
    if distance_nm < 180:
        return 16000
    if distance_nm < 450:
        return 26000
    if distance_nm < 900:
        return 33000
    return 37000


class RouteAutopilot:
    """A direct great-circle flight with deterministic, phase-aware targets."""

    GROUND_PHASES: tuple[tuple[str, float, float], ...] = (
        ("AT_GATE", 10.0, 0.0),
        ("PUSHBACK", 12.0, 3.0),
        ("TAXI", 30.0, 18.0),
        ("HOLDING_SHORT", 8.0, 0.0),
    )

    def __init__(self):
        self.route_id = ""
        self.origin: Airport | None = None
        self.destination: Airport | None = None
        self.original_destination: Airport | None = None
        self.total_distance_nm = 0.0
        self.cruise_altitude_ft = 0
        self.cruise_speed_kts = 0
        self.time_scale = 1.0
        self.status = "cancelled"
        self.autopilot_engaged = False
        self.started_at = utc_now()
        self.sim_elapsed = 0.0
        self.phase = "AT_GATE"
        self.diverted = False
        self.diversion_reason: str | None = None
        self._touchdown = False
        self._landing_elapsed = 0.0

    @property
    def active(self) -> bool:
        return self.status in {"ready", "active", "diverting"} and self.origin is not None and self.destination is not None

    def create(self, request: RouteDemoRequest, catalog: AirportCatalog, state: dict) -> RouteState:
        origin = catalog.resolve(request.origin_icao, request.origin)
        destination = catalog.resolve(request.destination_icao, request.destination)
        distance = haversine_nm(origin.lat, origin.lon, destination.lat, destination.lon)
        if distance < 1.0:
            raise ValueError("Origin and destination must be at least 1 NM apart.")

        self.route_id = str(uuid.uuid4())
        self.origin = origin
        self.destination = destination
        self.original_destination = None
        self.total_distance_nm = distance
        self.cruise_altitude_ft = request.cruise_altitude_ft or _smart_cruise_altitude(distance)
        self.cruise_speed_kts = request.cruise_speed_kts
        self.time_scale = request.time_scale
        self.status = "active" if request.auto_start else "ready"
        self.autopilot_engaged = request.auto_start
        self.started_at = utc_now()
        self.sim_elapsed = 0.0
        self.phase = "AT_GATE"
        self.diverted = False
        self.diversion_reason = None
        self._touchdown = False
        self._landing_elapsed = 0.0

        # Starting a route is the only operation that intentionally positions
        # the demo aircraft at an origin. Conversational text never does this.
        state.update({
            "connected": True,
            "lat": origin.lat,
            "lon": origin.lon,
            "altitude": float(origin.elev),
            "ground_speed": 0.0,
            "true_airspeed": 0.0,
            "vertical_speed_fpm": 0.0,
            "heading_mag": initial_bearing_deg(origin.lat, origin.lon, destination.lat, destination.lon),
            "on_ground": True,
        })
        if request.callsign:
            prefix = "".join(character for character in request.callsign if character.isalpha())[:3]
            number = "".join(character for character in request.callsign if character.isdigit())[:6]
            state["atc_id"] = prefix
            state["atc_flight_number"] = number
        return self.to_state(state)

    def engage(self) -> None:
        if self.status == "ready":
            self.status = "active"
        if self.active:
            self.autopilot_engaged = True

    def cancel(self) -> None:
        self.autopilot_engaged = False
        self.status = "cancelled"

    def divert(self, state: dict, airport: Airport, reason: str) -> None:
        if not self.route_id:
            self.route_id = str(uuid.uuid4())
            self.cruise_altitude_ft = max(
                5000,
                min(37000, int(math.ceil(float(state.get("altitude", 0.0)) / 1000.0) * 1000)),
            )
            self.cruise_speed_kts = max(180, min(440, int(state.get("ground_speed", 250.0) or 250.0)))
            self.time_scale = 6.0
        if self.destination is None:
            origin = Airport(
                icao="PRES",
                name="Present position",
                lat=state["lat"],
                lon=state["lon"],
                elev=max(0.0, state.get("altitude", 0.0)),
                catalog_source="runtime",
            )
        else:
            origin = Airport(
                icao="PRES",
                name="Present position",
                lat=state["lat"],
                lon=state["lon"],
                elev=max(0.0, state.get("altitude", 0.0)),
                catalog_source="runtime",
            )
            if self.original_destination is None:
                self.original_destination = self.destination
        self.origin = origin
        self.destination = airport.model_copy(deep=True)
        self.total_distance_nm = max(0.01, haversine_nm(origin.lat, origin.lon, airport.lat, airport.lon))
        self.status = "diverting"
        self.autopilot_engaged = True
        self.started_at = utc_now()
        self.sim_elapsed = sum(duration for _, duration, _ in self.GROUND_PHASES) + 15.0
        self.diverted = True
        self.diversion_reason = reason
        self._touchdown = False
        self._landing_elapsed = 0.0

    def _ground_profile(self) -> tuple[str, float] | None:
        cursor = 0.0
        for phase, duration, speed in self.GROUND_PHASES:
            if self.sim_elapsed < cursor + duration:
                return phase, speed
            cursor += duration
        return None

    def targets(self, state: dict, simulated_dt: float, emergency_effects: dict | None = None) -> dict:
        if not self.active or not self.autopilot_engaged or self.destination is None or self.origin is None:
            return {}
        dt = max(0.0, min(simulated_dt, 30.0))
        # Keep ground/takeoff phases visible to a 5 Hz UI even when the user
        # selects a very high en-route time scale.
        ground_and_takeoff_seconds = sum(duration for _, duration, _ in self.GROUND_PHASES) + 20.0
        phase_dt = min(dt, 2.0) if not self.diverted and self.sim_elapsed < ground_and_takeoff_seconds else dt
        self.sim_elapsed += phase_dt
        remaining = haversine_nm(state["lat"], state["lon"], self.destination.lat, self.destination.lon)
        bearing = initial_bearing_deg(state["lat"], state["lon"], self.destination.lat, self.destination.lon)
        effects = emergency_effects or {}

        if self._touchdown:
            self._landing_elapsed += dt
            self.phase = "LANDING" if state.get("ground_speed", 0) > 35 else "LANDED"
            if state.get("ground_speed", 0) < 1.0:
                self.phase = "AT_GATE"
                self.status = "completed"
                self.autopilot_engaged = False
            return {
                "phase": self.phase,
                "on_ground": True,
                "altitude": self.destination.elev,
                "heading": bearing,
                "speed": 0.0,
                "max_distance_nm": 0.0,
            }

        ground = self._ground_profile() if not self.diverted else None
        if ground:
            self.phase, speed = ground
            return {
                "phase": self.phase,
                "on_ground": True,
                "altitude": self.origin.elev,
                "heading": bearing,
                "speed": speed,
                "max_distance_nm": remaining,
            }

        takeoff_end = sum(duration for _, duration, _ in self.GROUND_PHASES) + 20.0
        if self.sim_elapsed < takeoff_end and not self.diverted:
            self.phase = "TAKEOFF_ROLL"
            return {
                "phase": self.phase,
                "on_ground": True,
                "altitude": self.origin.elev,
                "heading": bearing,
                "speed": 170.0,
                "max_distance_nm": remaining,
            }

        state["on_ground"] = False
        travelled = max(0.0, self.total_distance_nm - remaining)
        climb_target = self.origin.elev + travelled * 500.0
        descent_target = self.destination.elev + remaining * 300.0
        altitude_target = min(float(self.cruise_altitude_ft), climb_target, descent_target)
        altitude_target = max(self.destination.elev, altitude_target)
        current_alt = float(state.get("altitude", 0.0))

        if remaining <= 0.08 and current_alt <= self.destination.elev + 180.0:
            self._touchdown = True
            self.phase = "LANDING"
            return {
                "phase": self.phase,
                "on_ground": True,
                "altitude": self.destination.elev,
                "heading": bearing,
                "speed": 0.0,
                "max_distance_nm": remaining,
            }
        if remaining <= 6.0:
            self.phase, speed = "FINAL_APPROACH", 145.0
        elif remaining <= 25.0:
            self.phase, speed = "APPROACH", 190.0
        elif altitude_target < current_alt - 300.0:
            self.phase, speed = "DESCENT", min(310.0, float(self.cruise_speed_kts))
        elif current_alt < 3000.0:
            self.phase, speed = "INITIAL_CLIMB", 220.0
        elif altitude_target > current_alt + 300.0:
            self.phase, speed = "CLIMB", min(320.0, float(self.cruise_speed_kts))
        else:
            self.phase, speed = "CRUISE", float(self.cruise_speed_kts)

        if "max_altitude_ft" in effects:
            altitude_target = min(altitude_target, float(effects["max_altitude_ft"]))
        if "target_altitude_ft" in effects:
            altitude_target = min(altitude_target, float(effects["target_altitude_ft"]))
        if "max_speed_kts" in effects:
            speed = min(speed, float(effects["max_speed_kts"]))
        return {
            "phase": self.phase,
            "on_ground": False,
            "altitude": altitude_target,
            "heading": bearing,
            "speed": speed,
            "max_distance_nm": remaining,
        }

    def to_state(self, state: dict) -> RouteState | None:
        if self.origin is None or self.destination is None or not self.route_id:
            return None
        remaining = haversine_nm(state["lat"], state["lon"], self.destination.lat, self.destination.lon)
        if self.status == "completed":
            remaining = 0.0
        progress = 1.0 if self.status == "completed" else max(0.0, min(1.0, 1.0 - remaining / max(self.total_distance_nm, 0.01)))
        # During gate/taxi phases, instantaneous speed is not a useful arrival
        # predictor. Use a conservative planned average so ETA never explodes
        # into multi-day values before takeoff.
        planned_average = max(120.0, float(self.cruise_speed_kts) * 0.75)
        speed = max(float(state.get("ground_speed", 0.0)), planned_average)
        eta = 0 if self.status == "completed" else int(round(remaining / speed * 3600.0))
        return RouteState(
            route_id=self.route_id,
            status=self.status,
            autopilot_engaged=self.autopilot_engaged,
            origin=_endpoint(self.origin),
            destination=_endpoint(self.destination),
            original_destination=_endpoint(self.original_destination) if self.original_destination else None,
            waypoints=[_endpoint(self.origin), _endpoint(self.destination)],
            total_distance_nm=round(self.total_distance_nm, 2),
            distance_flown_nm=round(max(0.0, self.total_distance_nm - remaining), 2),
            remaining_distance_nm=round(max(0.0, remaining), 2),
            progress=round(progress, 5),
            bearing_deg=round(initial_bearing_deg(state["lat"], state["lon"], self.destination.lat, self.destination.lon), 1),
            eta_seconds=max(0, eta),
            wall_clock_eta_seconds=max(0, int(round(eta / max(self.time_scale, 0.01)))),
            cruise_altitude_ft=self.cruise_altitude_ft,
            cruise_speed_kts=self.cruise_speed_kts,
            time_scale=self.time_scale,
            phase=self.phase,
            started_at=self.started_at,
            diverted=self.diverted,
            diversion_reason=self.diversion_reason,
        )
