"""Structured clearance lifecycle. Free text can propose, never execute, state."""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone

try:
    from .aviation_numbers import parse_altitude, parse_frequency, parse_heading, parse_speed, parse_squawk
    from .schemas import Clearance, ClearanceInstruction
except ImportError:  # pragma: no cover
    from aviation_numbers import parse_altitude, parse_frequency, parse_heading, parse_speed, parse_squawk
    from schemas import Clearance, ClearanceInstruction


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ClearanceManager:
    def __init__(self, max_history: int = 30):
        self._items: list[Clearance] = []
        self.max_history = max_history

    def _append(self, clearance: Clearance) -> Clearance:
        self._items.append(clearance)
        self._items = self._items[-self.max_history:]
        return clearance.model_copy(deep=True)

    def record_request(self, text: str, callsign: str) -> Clearance | None:
        lowered = text.lower()
        if not any(word in lowered for word in (
            "request", "ready for", "mayday", "pan pan", "direct", "higher", "lower",
            "takeoff", "taxi", "pushback", "landing", "approach",
        )):
            return None
        requested = Clearance(
            clearance_id=str(uuid.uuid4()),
            status="requested",
            callsign=callsign or "AIRCRAFT",
            raw_text=text,
            instructions=self._parse_instructions(text, issued=False),
            issued_at=_now(),
        )
        return self._append(requested)

    def issue_from_atc(self, text: str, callsign: str) -> Clearance | None:
        instructions = self._parse_instructions(text, issued=True)
        if not instructions:
            return None
        clearance = Clearance(
            clearance_id=str(uuid.uuid4()),
            status="issued",
            callsign=callsign or "AIRCRAFT",
            raw_text=text,
            instructions=instructions,
            issued_at=_now(),
        )
        return self._append(clearance)

    @staticmethod
    def _parse_instructions(text: str, issued: bool) -> list[ClearanceInstruction]:
        lowered = text.lower()
        output: list[ClearanceInstruction] = []

        def add(kind: str, value=None, unit: str | None = None) -> None:
            if not any(item.instruction_type == kind for item in output):
                output.append(ClearanceInstruction(instruction_type=kind, value=value, unit=unit))

        if issued and ("pushback approved" in lowered or "push back approved" in lowered):
            add("pushback")
        if issued and re.search(r"\b(?:taxi\s+to|taxi\s+via|cleared\s+to\s+taxi)\b", lowered):
            add("taxi")
        if issued and "hold short" in lowered:
            add("hold_short")
        if issued and "line up and wait" in lowered:
            add("line_up")
        if issued and re.search(r"\bcleared\s+(?:for\s+)?takeoff\b", lowered):
            add("takeoff")
        if issued and "cleared to land" in lowered:
            add("land")

        altitude = parse_altitude(text)
        if altitude is not None and (issued or any(word in lowered for word in ("request", "higher", "lower"))):
            add("altitude", altitude, "ft")
        heading = parse_heading(text)
        if heading is not None:
            add("heading", heading, "deg")
        speed = parse_speed(text)
        if speed is not None:
            add("speed", speed, "kt")
        frequency = parse_frequency(text)
        if frequency is not None and issued:
            add("frequency", frequency, "MHz")
        squawk = parse_squawk(text)
        if squawk is not None and issued:
            add("squawk", squawk)

        direct = re.search(r"\b(?:cleared|proceed)\s+direct(?:\s+to)?\s+([A-Z0-9]{3,5})\b", text, flags=re.IGNORECASE)
        if direct and issued:
            add("direct", direct.group(1).upper())
        return output

    def accept(self, clearance_id: str, readback: str, accepted_by: str = "pilot") -> Clearance:
        for index, clearance in enumerate(self._items):
            if clearance.clearance_id != clearance_id:
                continue
            if clearance.status != "issued":
                raise ValueError(f"Clearance is {clearance.status}, not issued.")
            mismatches = self._readback_mismatches(clearance, readback)
            if mismatches:
                raise ValueError(f"Readback mismatch: {', '.join(mismatches)}. Say again with every assigned item.")
            accepted = clearance.model_copy(update={
                "status": "accepted",
                "accepted_at": _now(),
                "accepted_by": accepted_by,
                "readback": readback,
            })
            self._items[index] = accepted
            return accepted.model_copy(deep=True)
        raise KeyError(clearance_id)

    @staticmethod
    def _readback_mismatches(clearance: Clearance, readback: str) -> list[str]:
        lowered = readback.lower()
        mismatches: list[str] = []
        for instruction in clearance.instructions:
            kind, expected = instruction.instruction_type, instruction.value
            actual = None
            if kind == "altitude":
                actual = parse_altitude(readback)
            elif kind == "heading":
                actual = parse_heading(readback)
            elif kind == "speed":
                actual = parse_speed(readback)
            elif kind == "frequency":
                actual = parse_frequency(readback)
            elif kind == "squawk":
                actual = parse_squawk(readback)
            elif kind == "direct":
                if not expected or str(expected).upper() not in readback.upper():
                    mismatches.append("direct-to fix")
                continue
            else:
                phrases = {
                    "pushback": ("pushback", "push back"),
                    "taxi": ("taxi",),
                    "hold_short": ("hold short", "holding short"),
                    "line_up": ("line up", "lining up"),
                    "takeoff": ("takeoff", "take off"),
                    "land": ("land", "landing"),
                }.get(kind, ())
                if phrases and not any(phrase in lowered for phrase in phrases):
                    mismatches.append(kind)
                continue
            if actual is None or expected is None or abs(float(actual) - float(expected)) > 0.01:
                mismatches.append(kind)
        return mismatches

    def mark_executing(self, clearance_id: str) -> Clearance:
        for index, clearance in enumerate(self._items):
            if clearance.clearance_id == clearance_id:
                updated = clearance.model_copy(update={"status": "executing"})
                self._items[index] = updated
                return updated.model_copy(deep=True)
        raise KeyError(clearance_id)

    def list(self) -> list[Clearance]:
        return [item.model_copy(deep=True) for item in reversed(self._items)]

    def get(self, clearance_id: str) -> Clearance | None:
        for item in self._items:
            if item.clearance_id == clearance_id:
                return item.model_copy(deep=True)
        return None

    def latest_issued(self) -> Clearance | None:
        return next((item.model_copy(deep=True) for item in reversed(self._items) if item.status == "issued"), None)

    def reset(self) -> None:
        self._items.clear()
