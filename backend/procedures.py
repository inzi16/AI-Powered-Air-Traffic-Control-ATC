"""
ATC procedure helpers.

Picks an active runway based on wind direction and aircraft phase, and maps
flight phase to the most appropriate frequency type at the local airport.
"""
from __future__ import annotations

from typing import Optional


PHASE_TO_FREQ_TYPE = {
    "AT_GATE": "gnd",
    "PUSHBACK": "gnd",
    "TAXI": "gnd",
    "HOLDING_SHORT": "twr",
    "TAKEOFF_ROLL": "twr",
    "INITIAL_CLIMB": "dep",
    "CLIMB": "dep",
    "CRUISE": "ctr",
    "DESCENT": "ctr",
    "APPROACH": "app",
    "FINAL_APPROACH": "twr",
    "LANDING": "twr",
    "LANDED": "gnd",
    "UNKNOWN": "gnd",
}


def _heading_diff(a: float, b: float) -> float:
    return abs(((a - b + 540.0) % 360.0) - 180.0)


def parse_runway_heading(rwy_label: str) -> int:
    """e.g. '07' -> 70, '36' -> 360, '27L' -> 270."""
    digits = "".join(c for c in rwy_label if c.isdigit())
    if not digits:
        return 0
    return int(digits[:2]) * 10


def pick_active_runway(airport: dict, wind_dir_from: float) -> Optional[str]:
    """
    Pick a runway whose heading is closest to landing INTO the wind.

    `wind_dir_from` is the direction the wind is coming from (METAR style).
    Aircraft land/takeoff into the wind, so runway heading should match
    wind_dir_from.
    """
    rwys = airport.get("rwys") or []
    if not rwys:
        return None
    candidates: list[str] = []
    for r in rwys:
        # rwy entry can be "07/25" — take both directions
        for part in str(r).split("/"):
            part = part.strip()
            if part:
                candidates.append(part)
    if not candidates:
        return None
    best = min(candidates, key=lambda r: _heading_diff(parse_runway_heading(r), wind_dir_from))
    return best


def freq_for_phase(airport: dict, phase: str) -> Optional[float]:
    typ = PHASE_TO_FREQ_TYPE.get(phase, "gnd")
    freqs = airport.get("freq") or {}
    return freqs.get(typ) or freqs.get("twr") or freqs.get("gnd")
