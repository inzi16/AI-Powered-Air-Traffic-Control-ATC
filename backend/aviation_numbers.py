"""Parsing helpers for ICAO-style spoken numbers."""

from __future__ import annotations

import re


DIGITS = {
    "zero": "0", "oh": "0",
    "one": "1", "wun": "1",
    "two": "2", "too": "2",
    "three": "3", "tree": "3",
    "four": "4", "fower": "4",
    "five": "5", "fife": "5",
    "six": "6",
    "seven": "7",
    "eight": "8", "ait": "8",
    "nine": "9", "niner": "9",
}


def _tokens(text: str) -> list[str]:
    normalized = re.sub(r"[-_/]", " ", text.lower())
    return re.findall(r"\d+(?:\.\d+)?|[a-z]+|\.", normalized)


def spoken_digits(text: str) -> str:
    """Return digit words/numerals as one sequence, ignoring filler words."""
    output: list[str] = []
    for token in _tokens(text):
        if token in DIGITS:
            output.append(DIGITS[token])
        elif token.isdigit():
            output.append(token)
    return "".join(output)


def parse_spoken_number(text: str) -> float | None:
    """Parse digit-by-digit aviation speech plus hundred/thousand forms."""
    tokens = _tokens(text)
    if not tokens:
        return None
    if len(tokens) == 1 and re.fullmatch(r"\d+(?:\.\d+)?", tokens[0]):
        return float(tokens[0])

    if "decimal" in tokens or "point" in tokens or "." in tokens:
        marker = next((token for token in ("decimal", "point", ".") if token in tokens), None)
        assert marker is not None
        index = tokens.index(marker)
        left = spoken_digits(" ".join(tokens[:index])) or "0"
        right = spoken_digits(" ".join(tokens[index + 1:]))
        return float(f"{int(left)}.{right}") if right else float(left)

    def digit_value(parts: list[str]) -> int:
        digits = spoken_digits(" ".join(parts))
        return int(digits) if digits else 0

    if "thousand" in tokens:
        index = tokens.index("thousand")
        high = digit_value(tokens[:index]) or 1
        tail = tokens[index + 1:]
        value = high * 1000
        if "hundred" in tail:
            h_index = tail.index("hundred")
            value += (digit_value(tail[:h_index]) or 1) * 100
            value += digit_value(tail[h_index + 1:])
        else:
            value += digit_value(tail)
        return float(value)
    if "hundred" in tokens:
        index = tokens.index("hundred")
        return float((digit_value(tokens[:index]) or 1) * 100 + digit_value(tokens[index + 1:]))

    digits = spoken_digits(text)
    return float(digits) if digits else None


def capture_number_after(text: str, pattern: str, max_words: int = 8) -> float | None:
    """Parse a number phrase immediately after a regex keyword pattern."""
    match = re.search(pattern, text, flags=re.IGNORECASE)
    if not match:
        return None
    tail = text[match.end():]
    tail = re.split(
        r"[,.;]|\b(?:degrees?|knots?|kts?|feet|foot|and\s+contact|then|until|for|on\s+course)\b",
        tail,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0]
    words = tail.strip().split()[:max_words]
    return parse_spoken_number(" ".join(words))


def parse_flight_level(text: str) -> int | None:
    value = capture_number_after(text, r"\bflight\s+level\b", max_words=5)
    return int(round(value * 100)) if value is not None and 10 <= value <= 600 else None


def parse_altitude(text: str) -> int | None:
    flight_level = parse_flight_level(text)
    if flight_level is not None:
        return flight_level
    value = capture_number_after(
        text,
        r"\b(?:climb(?:\s+and\s+maintain)?(?:\s+to)?|descend(?:\s+and\s+maintain)?(?:\s+to)?|maintain\s+altitude|altitude)\b",
        max_words=7,
    )
    if value is None:
        return None
    integer = int(round(value))
    return integer if 0 <= integer <= 60000 else None


def parse_heading(text: str) -> int | None:
    value = capture_number_after(text, r"\b(?:turn\s+(?:left|right)\s+)?heading\b", max_words=4)
    return int(round(value)) % 360 if value is not None and 0 <= value <= 360 else None


def parse_speed(text: str) -> int | None:
    value = capture_number_after(text, r"\b(?:reduce\s+to|increase\s+to|maintain\s+speed|speed)\b", max_words=4)
    return int(round(value)) if value is not None and 0 <= value <= 700 else None


def parse_squawk(text: str) -> str | None:
    value = capture_number_after(text, r"\bsquawk\b", max_words=5)
    if value is None:
        return None
    code = f"{int(round(value)):04d}"
    if len(code) == 4 and all(character in "01234567" for character in code):
        return code
    return None


def parse_frequency(text: str) -> float | None:
    match = re.search(r"\b(?:contact|monitor|frequency|switch(?:\s+to)?)\b(.*)", text, flags=re.IGNORECASE)
    if not match:
        return None
    tokens = _tokens(match.group(1))
    start = next((index for index, token in enumerate(tokens) if token in DIGITS or re.fullmatch(r"\d+(?:\.\d+)?", token)), None)
    if start is None:
        return None
    numeric: list[str] = []
    for token in tokens[start:]:
        if token in DIGITS or token in {"decimal", "point", "."} or re.fullmatch(r"\d+(?:\.\d+)?", token):
            numeric.append(token)
        else:
            break
    value = parse_spoken_number(" ".join(numeric))
    return round(value, 3) if value is not None and 108.0 <= value <= 137.0 else None
