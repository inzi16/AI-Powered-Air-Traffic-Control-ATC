"""Deterministic closest-point-of-approach traffic prediction."""

from __future__ import annotations

import math

try:
    from .navigation import haversine_nm, initial_bearing_deg
    from .schemas import ConflictPrediction, Severity
except ImportError:  # pragma: no cover
    from navigation import haversine_nm, initial_bearing_deg
    from schemas import ConflictPrediction, Severity


def _velocity(speed_kts: float, heading_deg: float) -> tuple[float, float]:
    """East/north velocity in nautical miles per minute."""
    radians = math.radians(heading_deg)
    return speed_kts / 60.0 * math.sin(radians), speed_kts / 60.0 * math.cos(radians)


def predict_conflicts(
    ownship: dict,
    traffic: list[dict],
    lookahead_seconds: int = 600,
) -> list[ConflictPrediction]:
    horizon_min = lookahead_seconds / 60.0
    own_east, own_north = _velocity(float(ownship.get("ground_speed", 0.0)), float(ownship.get("heading_mag", 0.0)))
    own_vs = float(ownship.get("vertical_speed_fpm", 0.0))
    output: list[ConflictPrediction] = []

    for track in traffic:
        range_nm = haversine_nm(ownship["lat"], ownship["lon"], track["lat"], track["lon"])
        bearing = initial_bearing_deg(ownship["lat"], ownship["lon"], track["lat"], track["lon"])
        bearing_rad = math.radians(bearing)
        relative_x = range_nm * math.sin(bearing_rad)
        relative_y = range_nm * math.cos(bearing_rad)
        traffic_east, traffic_north = _velocity(float(track.get("speed", 0.0)), float(track.get("heading", 0.0)))
        velocity_x = traffic_east - own_east
        velocity_y = traffic_north - own_north
        velocity_sq = velocity_x * velocity_x + velocity_y * velocity_y
        if velocity_sq < 1e-8:
            time_min = 0.0
        else:
            time_min = max(0.0, min(horizon_min, -(relative_x * velocity_x + relative_y * velocity_y) / velocity_sq))

        cpa_x = relative_x + velocity_x * time_min
        cpa_y = relative_y + velocity_y * time_min
        cpa_nm = math.hypot(cpa_x, cpa_y)
        relative_vs_fpm = float(track.get("vertical_speed_fpm", 0.0)) - own_vs
        current_altitude_delta = float(track.get("altitude", 0.0)) - float(ownship.get("altitude", 0.0))
        cpa_vertical = abs(current_altitude_delta + relative_vs_fpm * time_min)
        current_vertical = abs(current_altitude_delta)
        closing_rate = 0.0
        if range_nm > 1e-6:
            closing_rate = -((relative_x * velocity_x + relative_y * velocity_y) / range_nm) * 60.0

        if cpa_nm < 1.5 and cpa_vertical < 400:
            severity = Severity.CRITICAL
            advisory = "Immediate traffic conflict: stop convergence; turn or change altitude only under a coordinated clearance."
        elif cpa_nm < 3.0 and cpa_vertical < 700:
            severity = Severity.WARNING
            advisory = "Predicted loss of separation: coordinate an early vector or altitude restriction."
        elif cpa_nm < 5.0 and cpa_vertical < 1000:
            severity = Severity.CAUTION
            advisory = "Traffic advisory: monitor closure and prepare a non-converging clearance."
        else:
            continue

        output.append(ConflictPrediction(
            conflict_id=f"cpa:{track['callsign']}",
            callsign=str(track["callsign"]),
            severity=severity,
            current_range_nm=round(range_nm, 2),
            current_vertical_separation_ft=round(current_vertical),
            bearing_deg=round(bearing, 1),
            closing_rate_kts=round(closing_rate, 1),
            time_to_cpa_seconds=max(0, int(round(time_min * 60.0))),
            cpa_distance_nm=round(cpa_nm, 2),
            cpa_vertical_separation_ft=round(cpa_vertical),
            lookahead_seconds=lookahead_seconds,
            advisory=advisory,
        ))

    output.sort(key=lambda conflict: (
        {Severity.CRITICAL: 0, Severity.WARNING: 1, Severity.CAUTION: 2, Severity.INFO: 3}[conflict.severity],
        conflict.time_to_cpa_seconds,
    ))
    return output

