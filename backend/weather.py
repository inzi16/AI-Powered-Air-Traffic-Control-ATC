"""
Procedurally generated weather (METAR-like) per region.

Stable across a session — wind direction shifts slowly. Provides wind vector
to the sim engine and a METAR-style summary string for ATC context.
"""
from __future__ import annotations

import math
import random
import time
from typing import Any


class WeatherEngine:
    """Slowly-evolving weather state that ties to lat/lon."""

    def __init__(self, seed: int | None = None):
        self.rng = random.Random(seed if seed is not None else int(time.time()))
        # Base state
        self.wind_dir = float(self.rng.randint(0, 359))     # direction wind blows FROM
        self.wind_kts = float(self.rng.randint(4, 18))
        self.gust_kts = self.wind_kts + float(self.rng.randint(0, 8))
        self.visibility_km = float(self.rng.choice([10, 10, 10, 8, 6, 4]))
        self.ceiling_ft = self.rng.choice([None, 25000, 12000, 8000, 5000, 3500])
        self.qnh_hpa = self.rng.randint(1005, 1025)
        self.temp_c = self.rng.randint(8, 32)
        self.dewpoint_c = self.temp_c - self.rng.randint(2, 12)
        self._last_drift = time.monotonic()

    def tick(self):
        """Slowly drift wind direction & speed."""
        now = time.monotonic()
        if now - self._last_drift < 5.0:
            return
        self._last_drift = now
        # ±5° drift, ±1 kt drift
        self.wind_dir = (self.wind_dir + self.rng.uniform(-5, 5)) % 360.0
        self.wind_kts = max(0.0, self.wind_kts + self.rng.uniform(-1.0, 1.0))
        self.gust_kts = max(self.wind_kts, self.gust_kts + self.rng.uniform(-1.5, 1.5))

    def get_wind(self, lat: float, lon: float, alt: float) -> tuple[float, float]:
        """Return (wind_dir_from_deg, wind_speed_kts) at this position/alt.

        Slightly stronger winds aloft.
        """
        scale = 1.0 + min(2.5, alt / 20000.0)
        return (self.wind_dir, self.wind_kts * scale)

    def metar_summary(self, icao: str = "XXXX") -> str:
        wd = int(self.wind_dir)
        wk = int(self.wind_kts)
        gust = int(self.gust_kts)
        gust_str = f"G{gust:02d}" if gust > wk + 3 else ""
        vis = int(self.visibility_km)
        ceil = self.ceiling_ft
        cloud = "CAVOK" if (ceil is None and vis >= 10) else (
            f"BKN{int(ceil/100):03d}" if ceil else "SCT100"
        )
        return (
            f"{icao} {wd:03d}{wk:02d}{gust_str}KT {vis}KM {cloud} "
            f"{self.temp_c}/{self.dewpoint_c} Q{self.qnh_hpa}"
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "wind_dir": int(self.wind_dir),
            "wind_kts": int(self.wind_kts),
            "gust_kts": int(self.gust_kts),
            "visibility_km": self.visibility_km,
            "ceiling_ft": self.ceiling_ft,
            "qnh_hpa": self.qnh_hpa,
            "temp_c": self.temp_c,
            "dewpoint_c": self.dewpoint_c,
        }
