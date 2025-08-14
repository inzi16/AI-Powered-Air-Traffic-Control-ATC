import math

try:
    from SimConnect import SimConnect, AircraftRequests
except (ImportError, OSError):
    SimConnect = None
    AircraftRequests = None


def decode_squawk(raw):
    try:
        v = int(raw)
    except (ValueError, TypeError):
        return "----"
    if 0 <= v <= 7777:
        return str(v).zfill(4)
    d1 = (v >> 12) & 0xF
    d2 = (v >> 8) & 0xF
    d3 = (v >> 4) & 0xF
    d4 = v & 0xF
    return f"{d1}{d2}{d3}{d4}"


class MSFSSim:
    def __init__(self):
        self.connected = False
        self.sm = None
        self.aq = None

    def connect(self):
        if SimConnect is None or AircraftRequests is None:
            self.connected = False
            return
        try:
            self.sm = SimConnect()
            self.aq = AircraftRequests(self.sm, _time=2000)
            self.connected = True
        except Exception:
            self.connected = False

    def get(self, name):
        try:
            return self.aq.get(name)
        except Exception:
            return None

    def get_state(self):
        if not self.connected:
            self.connect()
        if not self.connected:
            return {"connected": False}
        try:
            heading = self.get("PLANE_HEADING_DEGREES_MAGNETIC")
            altitude = self.get("PLANE_ALTITUDE")
            speed = self.get("GROUND_VELOCITY")
            lat = self.get("PLANE_LATITUDE")
            lon = self.get("PLANE_LONGITUDE")
            com_active = self.get("COM_ACTIVE_FREQUENCY:1")
            com_stby = self.get("COM_STANDBY_FREQUENCY:1")
            xpdr_raw = self.get("TRANSPONDER_CODE:1")
            squawk = decode_squawk(xpdr_raw)
            xpdr_state = self.get("TRANSPONDER_STATE:1")
            ident = self.get("TRANSPONDER_IDENT")
            atc_id = self.get("ATC_ID") or ""
            atc_flight_number = self.get("ATC_FLIGHT_NUMBER") or ""
            return {
                "connected": True,
                "altitude": round(altitude or 0),
                "ground_speed": round(speed or 0),
                "heading_mag": round(heading or 0),
                "lat": round(lat or 0, 5),
                "lon": round(lon or 0, 5),
                "com1_active": round(com_active or 0, 3),
                "com1_standby": round(com_stby or 0, 3),
                "squawk": squawk,
                "xpdr_mode": xpdr_state,
                "xpdr_ident": bool(ident),
                "on_ground": bool(self.get("SIM_ON_GROUND")),
                "atc_id": atc_id,
                "atc_flight_number": atc_flight_number,
            }
        except Exception:
            self.connected = False
            return {"connected": False}
