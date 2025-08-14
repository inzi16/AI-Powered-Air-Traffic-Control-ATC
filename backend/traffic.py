"""
Procedurally-generated AI traffic for the radar.

Spawns and moves a small set of aircraft around the player. Each tick the
controller advances them forward along their heading.

Used to populate radar/map; also supports a simple TCAS conflict alert.
"""
from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass, field
from typing import Optional


EARTH_R_NM = 3440.065


def _haversine(lat1, lon1, lat2, lon2) -> float:
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    )
    return EARTH_R_NM * 2 * math.asin(math.sqrt(a))


def _bearing(lat1, lon1, lat2, lon2) -> float:
    """Initial bearing from (lat1,lon1) to (lat2,lon2) in degrees [0,360)."""
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


_AIRLINE_TEMPLATES = [
    ("EK", "Emirates"), ("BA", "Speedbird"), ("DL", "Delta"), ("UA", "United"),
    ("AA", "American"), ("SQ", "Singapore"), ("QF", "Qantas"), ("AI", "AirIndia"),
    ("LH", "Lufthansa"), ("AF", "AirFrans"), ("EY", "Etihad"), ("QR", "Qatari"),
    ("CX", "Cathay"), ("KL", "KLM"), ("TK", "Turkish"), ("FX", "FedEx"),
    ("6E", "IndiGo"), ("UK", "Vistara"), ("JL", "JapanAir"), ("KE", "KoreanAir"),
]
_AC_TYPES = ["B738", "A320", "A21N", "B77W", "A359", "B789", "A333", "B748", "B763", "E190"]


@dataclass
class TrafficAircraft:
    callsign: str
    aircraft_type: str
    lat: float
    lon: float
    altitude: float
    heading: float
    speed: float          # knots ground
    target_alt: float
    vertical_speed_fpm: float = 0.0
    on_ground: bool = False
    squawk: str = "2000"
    spawned_at: float = field(default_factory=time.monotonic)


class TrafficEngine:
    def __init__(self, seed: int | None = None):
        self.rng = random.Random(seed)
        self.aircraft: list[TrafficAircraft] = []
        self._last_tick = time.monotonic()
        self._last_spawn = 0.0
        self._elapsed = 0.0
        self.max_count = 12
        self.min_count = 5

    # ------------------------------------------------------------------
    def _make_callsign(self) -> str:
        prefix = self.rng.choice(_AIRLINE_TEMPLATES)[0]
        num = self.rng.randint(1, 9999)
        return f"{prefix}{num}"

    def spawn_around(self, ref_lat: float, ref_lon: float, ref_alt: float) -> None:
        if len(self.aircraft) >= self.max_count:
            return
        # Spawn within 10–45 NM of player, heading roughly at random
        dist_nm = self.rng.uniform(10.0, 45.0)
        bearing = self.rng.uniform(0.0, 360.0)
        rad = math.radians(bearing)
        lat = ref_lat + (dist_nm / 60.0) * math.cos(rad)
        coslat = max(math.cos(math.radians(ref_lat)), 0.01)
        lon = ref_lon + (dist_nm / 60.0) * math.sin(rad) / coslat

        # Altitude near player or at common cruise levels
        alt_band = self.rng.choice([
            max(0, ref_alt + self.rng.uniform(-3000, 3000)),
            self.rng.choice([5000, 8000, 12000, 24000, 30000, 35000, 38000]),
        ])
        alt = max(1000.0, alt_band)
        target_alt = alt + self.rng.uniform(-3000, 3000)
        if target_alt < 2000:
            target_alt = alt
        spd = self.rng.uniform(220, 480) if alt > 10000 else self.rng.uniform(180, 280)
        hdg = self.rng.uniform(0, 359)
        ac = TrafficAircraft(
            callsign=self._make_callsign(),
            aircraft_type=self.rng.choice(_AC_TYPES),
            lat=lat,
            lon=lon,
            altitude=alt,
            heading=hdg,
            speed=spd,
            target_alt=target_alt,
            on_ground=False,
            squawk="".join(str(self.rng.randint(0, 7)) for _ in range(4)),
        )
        self.aircraft.append(ac)

    def despawn_far(self, ref_lat: float, ref_lon: float, max_nm: float = 80.0):
        self.aircraft = [
            a for a in self.aircraft
            if _haversine(a.lat, a.lon, ref_lat, ref_lon) <= max_nm
        ]

    def tick(self, ref_lat: float, ref_lon: float, ref_alt: float, dt: float | None = None):
        if dt is None:
            now = time.monotonic()
            dt = max(0.05, min(1.0, now - self._last_tick))
            self._last_tick = now
        else:
            dt = max(0.0, min(float(dt), 30.0))
        self._elapsed += dt

        for a in self.aircraft:
            # Simple chase of target altitude
            diff = a.target_alt - a.altitude
            vs = max(min(diff * 0.4, 1500), -1500)
            a.vertical_speed_fpm = vs
            a.altitude += (vs / 60.0) * dt

            # Mild heading wander to simulate vectoring
            a.heading = (a.heading + self.rng.uniform(-0.25, 0.25)) % 360.0

            # Move along heading
            dist_nm = (a.speed / 3600.0) * dt
            rad = math.radians(a.heading)
            a.lat += (dist_nm / 60.0) * math.cos(rad)
            coslat = max(math.cos(math.radians(a.lat)), 0.01)
            a.lon += (dist_nm / 60.0) * math.sin(rad) / coslat

        # Despawn far traffic
        self.despawn_far(ref_lat, ref_lon, max_nm=90.0)

        # Spawn-up to maintain count
        if (self._elapsed - self._last_spawn) > 2.0 and len(self.aircraft) < self.min_count:
            self._last_spawn = self._elapsed
            self.spawn_around(ref_lat, ref_lon, ref_alt)
        elif (self._elapsed - self._last_spawn) > 6.0 and len(self.aircraft) < self.max_count:
            self._last_spawn = self._elapsed
            if self.rng.random() < 0.4:
                self.spawn_around(ref_lat, ref_lon, ref_alt)

    def reset_around(self, ref_lat: float, ref_lon: float, ref_alt: float):
        self.aircraft.clear()
        self._elapsed = 0.0
        self._last_spawn = 0.0
        for _ in range(self.min_count + 2):
            self.spawn_around(ref_lat, ref_lon, ref_alt)

    def to_list(self, ref_lat: float, ref_lon: float) -> list[dict]:
        out = []
        for a in self.aircraft:
            r = _haversine(ref_lat, ref_lon, a.lat, a.lon)
            b = _bearing(ref_lat, ref_lon, a.lat, a.lon)
            out.append({
                "callsign": a.callsign,
                "type": a.aircraft_type,
                "lat": round(a.lat, 6),
                "lon": round(a.lon, 6),
                "altitude": round(a.altitude),
                "heading": round(a.heading, 1),
                "speed": round(a.speed),
                "vertical_speed_fpm": round(a.vertical_speed_fpm),
                "squawk": a.squawk,
                "on_ground": a.on_ground,
                "range_nm": round(r, 1),
                "bearing": round(b, 1),
            })
        # Sort by range so closest is first
        out.sort(key=lambda x: x["range_nm"])
        return out

    def conflicts(self, ref_lat: float, ref_lon: float, ref_alt: float) -> list[dict]:
        """Return traffic within 5 NM and 1000 ft (TCAS RA-ish)."""
        out = []
        for a in self.aircraft:
            r = _haversine(ref_lat, ref_lon, a.lat, a.lon)
            if r < 5.0 and abs(a.altitude - ref_alt) < 1000.0:
                out.append({
                    "callsign": a.callsign,
                    "range_nm": round(r, 1),
                    "alt_diff_ft": round(a.altitude - ref_alt),
                    "bearing": round(_bearing(ref_lat, ref_lon, a.lat, a.lon), 1),
                })
        return out
