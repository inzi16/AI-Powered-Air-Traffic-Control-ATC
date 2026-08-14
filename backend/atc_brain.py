"""
ATC Brain — Core AI Intelligence Module
Manages system prompts, conversation history, flight context, and Ollama integration.
"""

import httpx
import json
import math
import os

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
MODEL = os.environ.get("OLLAMA_MODEL", "llama3.1")


def _ollama_timeout_seconds() -> float:
    """Keep model latency below the 60-second reverse-proxy deadline."""

    try:
        configured = float(os.environ.get("OLLAMA_HTTP_TIMEOUT_SECONDS", "45"))
    except ValueError:
        return 45.0
    if not math.isfinite(configured):
        return 45.0
    return max(1.0, min(55.0, configured))


OLLAMA_HTTP_TIMEOUT_SECONDS = _ollama_timeout_seconds()

# Load airports database
_airports_path = os.path.join(os.path.dirname(__file__), "airports.json")
with open(_airports_path, "r", encoding="utf-8") as f:
    AIRPORTS = json.load(f)


def _haversine(lat1, lon1, lat2, lon2):
    R = 3440.065  # Earth radius in nautical miles
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def find_nearest_airport(lat: float, lon: float) -> dict | None:
    if lat == 0 and lon == 0:
        return None
    best = None
    best_dist = float("inf")
    for ap in AIRPORTS:
        d = _haversine(lat, lon, ap["lat"], ap["lon"])
        if d < best_dist:
            best_dist = d
            best = {**ap, "distance_nm": round(d, 1)}
    return best if best_dist < 200 else None


SYSTEM_PROMPT = """You are a professional ICAO Air Traffic Controller (ATC). You MUST follow these rules absolutely:

## IDENTITY & BEHAVIOR
- You are the ATC controller for the facility the pilot is contacting (Ground, Tower, Approach, Departure, or Center — infer from context)
- NEVER break character. You are NOT an AI assistant. You ARE the controller on duty.
- Never use markdown, bullet points, or formatting. Respond in plain radio transmission text only.
- Keep responses SHORT and CLIPPED — real ATC transmissions are brief. Typically 1-3 sentences max.

## CONVERSATION CONTINUITY — CRITICAL
- You MUST maintain context across the entire conversation. If the pilot previously requested pushback, then taxi, then takeoff — you are now past those phases. Do NOT reset to earlier phases.
- Track the logical flow: Gate → Pushback → Taxi → Hold Short → Takeoff → Climb → Cruise → Descent → Approach → Landing → Vacate → Ground
- If the pilot reports a problem mid-flight (engine failure, landing gear, fire, etc.), respond to THAT problem in the CURRENT context. Do NOT go back to ground procedures.
- Reference previous instructions you gave. If you cleared them to FL350, and they report a problem, reference that altitude.
- If the conversation has progressed to cruise and the pilot reports an emergency, handle it as an in-flight emergency, not a ground operation.

## ICAO RADIOTELEPHONY RULES
- Always use the aircraft callsign in your response
- Use standard phraseology: CLEARED, APPROVED, HOLD SHORT, ROGER, WILCO, AFFIRM, NEGATIVE, STANDBY, SAY AGAIN, UNABLE
- For readbacks always repeat key info: runway, altitude, heading, squawk, frequency
- Use proper number pronunciation: individually for headings/squawk (e.g., "heading two seven zero"), grouped for altitudes (e.g., "flight level three five zero")
- Use "ROGER" only to acknowledge, never to approve
- Use phonetic alphabet when spelling

## PROCEDURES (follow in sequence based on context)

### AT GATE / PUSHBACK
- Grant pushback clearance with facing direction
- Include ATIS information letter
- Example: "EK547, information Alpha, pushback approved, face south, report ready for taxi"

### TAXI
- Give specific taxi instructions with taxiway designators
- Include hold short instructions for active runways
- Example: "EK547, taxi to holding point runway 27 via taxiway Alpha, Bravo, hold short runway 27"
- After taxi: "EK547, contact tower on 118.1 when ready"

### TAKEOFF
- Clear for takeoff with wind information
- Example: "EK547, runway 27, wind 260 degrees 8 knots, cleared for takeoff"
- After takeoff: "EK547, airborne, contact departure on 127.95, good day"

### CLIMB / CRUISE
- Issue climb/descent clearances with specific altitudes
- Issue heading changes when needed
- Hand off to next controller with frequency change
- Example: "EK547, climb and maintain flight level 350, when passing flight level 240 contact Mumbai Control on 132.5"

### DESCENT / APPROACH
- Issue descent clearances, approach type, and runway assignment
- Provide traffic and sequence information
- Example: "EK547, descend to altitude 3000, expect ILS approach runway 07, number 2 in traffic, report established"

### LANDING
- Issue landing clearance with wind
- Example: "EK547, runway 07, wind 050 degrees 12 knots, cleared to land"
- After landing: "EK547, vacate left when able, contact ground on 121.9, good day"

## EMERGENCY HANDLING
- If pilot declares MAYDAY or PAN PAN: acknowledge immediately, give priority handling
- Ask for: nature of emergency, souls on board, fuel remaining, pilot intentions
- Provide vectors to nearest suitable airport with specific heading and distance
- Clear all conflicting traffic
- For MAYDAY: "EK547, MAYDAY acknowledged, all stations standby. State souls on board and fuel remaining"
- Give specific headings and altitudes: "EK547, turn left heading 270, descend to 3000, vectors for ILS runway 27 at Chennai, 12 miles"
- Coordinate emergency services: "EK547, emergency services alerted, crash rescue standing by runway 27"
- For landing gear problems: offer low pass for visual inspection, suggest alternate procedures
- For engine failure: provide nearest suitable runway heading and distance
- For fuel emergency: give priority sequence, shortest approach available

## IN-FLIGHT PROBLEMS (non-emergency)
- Landing gear issues: "EK547, roger landing gear problem, would you like to do a low approach for Tower to inspect?"
- Pressurization: "EK547, descend immediately to flight level 100, turn right heading 180 for weather avoidance"
- Electrical: "EK547, squawk 7600 if you lose communications, proceed direct nearest suitable airport"
- Turbulence: "EK547, roger, moderate turbulence reported, suggest flight level 370 or 330, pilot discretion"
- Navigation failure: "EK547, radar vectors available, say your request"

## SQUAWK CODES
- 7700 = Emergency (MAYDAY)
- 7600 = Communication failure
- 7500 = Hijack
- React appropriately to these codes

## CRITICAL RULES
- NEVER say "I'm an AI" or "As an AI" or anything breaking character
- NEVER give lengthy explanations — keep it radio-style
- NEVER use colloquial language — maintain professional controller demeanor
- NEVER reset conversation context — if pilot was climbing, don't tell them to pushback
- If pilot request is unclear: "Station calling, say again"
- If unable to comply: "EK547, unable, [reason], [alternative instruction]"
- Always end handoffs with "good day" or "good evening"
- Use "QNH" for altimeter settings below transition altitude
"""


class ATCBrain:
    def __init__(self):
        self.conversation_history: list[dict] = []
        self.callsign: str = ""
        self.max_history = 24  # rolling window
        self.active_scenario: str = ""  # e.g. "Engine Failure After Takeoff"
        self.scenario_context: str = ""  # description of loaded scenario
        self.emergency_active: bool = False  # True until user resolves it

    def set_callsign(self, callsign: str):
        self.callsign = callsign.strip()

    def set_scenario(self, name: str, description: str):
        """Set scenario context so AI maintains continuity."""
        self.active_scenario = name
        self.scenario_context = description
        self.emergency_active = "emergency" in description.lower() or "failure" in description.lower() or "mayday" in description.lower()

    def _build_context(self, flight_state: dict, phase_info: dict, nearest_airport: dict | None) -> str:
        lines = ["[CURRENT FLIGHT DATA]"]
        lines.append(f"Callsign: {self.callsign or 'Unknown'}")
        lines.append(f"Flight Phase: {phase_info.get('phase_label', 'Unknown')}")
        lines.append(f"Altitude: {flight_state.get('altitude', 0)} ft")
        lines.append(f"Ground Speed: {flight_state.get('ground_speed', 0)} kts")
        lines.append(f"Heading: {flight_state.get('heading_mag', 0)}°")
        if flight_state.get("vertical_speed_fpm"):
            lines.append(f"Vertical Speed: {flight_state.get('vertical_speed_fpm')} fpm")
        if flight_state.get("fuel_kg") is not None:
            fkg = flight_state.get("fuel_kg", 0)
            f0 = max(1, flight_state.get("fuel_initial_kg", fkg) or 1)
            pct = round(100.0 * fkg / f0)
            lines.append(f"Fuel: {round(fkg)} kg ({pct}% remaining)")

        # Scenario context — critical for maintaining continuity
        if self.active_scenario:
            lines.append(f"\n[ACTIVE SCENARIO]")
            lines.append(f"Scenario: {self.active_scenario}")
            lines.append(f"Description: {self.scenario_context}")
            if self.emergency_active:
                lines.append("Status: EMERGENCY ACTIVE — DO NOT change topic, maintain emergency handling until resolved")
        lines.append(f"Position: {flight_state.get('lat', 0)}, {flight_state.get('lon', 0)}")
        lines.append(f"Squawk: {flight_state.get('squawk', '----')}")
        lines.append(f"Transponder Mode: {flight_state.get('xpdr_mode', 'Unknown')}")
        lines.append(f"On Ground: {'Yes' if flight_state.get('on_ground') else 'No'}")
        lines.append(f"COM1 Active: {flight_state.get('com1_active', '---')}")
        vrate = phase_info.get("vertical_rate", 0)
        if vrate:
            lines.append(f"Vertical Rate: {vrate} ft/min")

        # Wind / weather context
        wd = flight_state.get("wind_dir")
        wk = flight_state.get("wind_kts")
        if wd is not None and wk:
            lines.append(f"Wind: {int(wd):03d}° at {int(wk)} kt")

        if nearest_airport:
            lines.append(f"\n[NEAREST AIRPORT]")
            lines.append(f"ICAO: {nearest_airport['icao']}")
            lines.append(f"Name: {nearest_airport['name']}")
            lines.append(f"City: {nearest_airport.get('city', '')}")
            lines.append(f"Distance: {nearest_airport.get('distance_nm', '?')} NM")
            lines.append(f"Elevation: {nearest_airport.get('elev', 0)} ft")
            rwys = nearest_airport.get("rwys", [])
            if rwys:
                lines.append(f"Runways: {', '.join(rwys)}")
            freq = nearest_airport.get("freq", {})
            if freq:
                for k, v in freq.items():
                    lines.append(f"  {k.upper()}: {v}")

        route = flight_state.get("route")
        if route:
            destination = route.get("destination") or {}
            lines.append("\n[AUTHORITATIVE ROUTE]")
            lines.append(f"Destination: {destination.get('icao', 'Unknown')} — {destination.get('name', '')}")
            lines.append(f"Route status: {route.get('status', 'unknown')}; autopilot: {route.get('autopilot_engaged', False)}")
            lines.append(f"Progress: {round(float(route.get('progress', 0)) * 100)}%; remaining: {route.get('remaining_distance_nm', '?')} NM")
            lines.append(f"Bearing: {route.get('bearing_deg', '?')} degrees; ETA: {route.get('eta_seconds', '?')} seconds")

        conflicts = flight_state.get("conflicts") or []
        lines.append("\n[PREDICTED TRAFFIC CONFLICTS]")
        if conflicts:
            for conflict in conflicts[:5]:
                lines.append(
                    f"{conflict.get('callsign')}: {conflict.get('severity')} CPA "
                    f"{conflict.get('cpa_distance_nm')} NM / {conflict.get('cpa_vertical_separation_ft')} ft "
                    f"in {conflict.get('time_to_cpa_seconds')} seconds"
                )
        else:
            lines.append("None predicted within the configured lookahead.")

        emergency = flight_state.get("emergency")
        if emergency and emergency.get("status") != "resolved":
            lines.append("\n[DETERMINISTIC EMERGENCY WORKFLOW]")
            lines.append(f"Type: {emergency.get('type')}; severity: {emergency.get('severity')}; status: {emergency.get('status')}")
            diversion = emergency.get("recommended_diversion") or {}
            if diversion:
                lines.append(f"Recommended diversion: {diversion.get('icao')} at {diversion.get('distance_nm')} NM")
            incomplete = [action for action in emergency.get("actions", []) if not action.get("completed")]
            if incomplete:
                next_action = sorted(incomplete, key=lambda action: action.get("priority", 99))[0]
                lines.append(f"Next action: {next_action.get('category')} — {next_action.get('instruction')}")

        lines.append("\n[CONTROL BOUNDARY]")
        lines.append("Your text is advisory/clearance phraseology only. It cannot alter aircraft state until the pilot explicitly accepts the separately parsed structured clearance.")

        return "\n".join(lines)

    async def chat(self, message: str, flight_state: dict, phase_info: dict) -> str:
        """Generate one reply without mutating committed conversation history.

        The authoritative API commits the exchange only after its session and
        semantic-revision guard succeeds.  Callers therefore cannot leave a
        stale user/assistant pair in later model context.
        """

        nearest = find_nearest_airport(
            flight_state.get("lat", 0),
            flight_state.get("lon", 0)
        )
        context = self._build_context(flight_state, phase_info, nearest)

        pending_history = [dict(item) for item in self.conversation_history]
        pending_history.append({"role": "user", "content": message})
        pending_history = pending_history[-self.max_history:]

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT + "\n\n" + context},
            *pending_history,
        ]

        try:
            async with httpx.AsyncClient(timeout=OLLAMA_HTTP_TIMEOUT_SECONDS) as client:
                resp = await client.post(
                    f"{OLLAMA_URL}/api/chat",
                    json={
                        "model": MODEL,
                        "messages": messages,
                        "stream": False,
                        "options": {
                            "temperature": 0.35,
                            "top_p": 0.85,
                            "num_predict": 200,
                        },
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                reply = data.get("message", {}).get("content", "").strip()
        except httpx.ConnectError:
            reply = self._fallback_response(message, flight_state, phase_info, nearest)
        except Exception as e:
            reply = self._fallback_response(message, flight_state, phase_info, nearest)

        reply = self._enforce_brevity(reply)
        return reply

    def commit_exchange(self, message: str, reply: str) -> None:
        """Atomically retain a revision-validated conversation exchange."""

        exchange = [{"role": "user", "content": message}]
        if reply:
            exchange.append({"role": "assistant", "content": reply})
        self.conversation_history = [
            *self.conversation_history,
            *exchange,
        ][-self.max_history:]

    @staticmethod
    def _enforce_brevity(text: str) -> str:
        """Strip markdown, collapse whitespace, cap to 3 sentences / 60 words.

        Keeps ATC sounding like radio (snappy and clipped) even when the LLM
        gets verbose.
        """
        if not text:
            return text
        # Strip markdown emphasis & bullets
        import re
        cleaned = re.sub(r'[*_`#>]+', '', text)
        cleaned = re.sub(r'^\s*[-•]\s*', '', cleaned, flags=re.MULTILINE)
        cleaned = re.sub(r'\s+', ' ', cleaned).strip()
        # Cap sentences
        parts = re.split(r'(?<=[.!?])\s+', cleaned)
        if len(parts) > 3:
            cleaned = ' '.join(parts[:3])
        # Word cap as ultimate safety
        words = cleaned.split()
        if len(words) > 60:
            cleaned = ' '.join(words[:60]).rstrip('.,;:') + '.'
        return cleaned

    def _get_conversation_phase(self) -> str:
        """Infer what phase the conversation is in by reading history."""
        if not self.conversation_history:
            return "INITIAL"
        # Scan from most recent to oldest
        keywords_map = {
            "EMERGENCY": ["mayday", "pan pan", "emergency", "7700", "fire", "engine failure", "hydraulic", "fuel emergency"],
            "LANDING": ["cleared to land", "landing clearance", "vacate", "touchdown", "runway vacated"],
            "APPROACH": ["on approach", "established", "on the ils", "visual approach", "on final", "intercepting localizer"],
            "DESCENT": ["descend", "descent", "lower", "leaving flight level"],
            "CRUISE": ["flight level", "cruise", "maintain fl", "direct to"],
            "CLIMB": ["climb", "climbing", "passing", "airborne", "radar contact"],
            "TAKEOFF": ["cleared for takeoff", "takeoff", "rolling", "rotate"],
            "HOLDING": ["hold short", "holding short", "number one", "line up", "lined up", "ready for departure", "ready to go"],
            "TAXI": ["taxi to", "taxiway", "taxi via"],
            "PUSHBACK": ["pushback", "push back", "startup"],
        }
        # Check last 8 messages for context
        recent = self.conversation_history[-8:]
        for msg in reversed(recent):
            text = msg.get("content", "").lower()
            for phase, kws in keywords_map.items():
                if any(kw in text for kw in kws):
                    return phase
        return "INITIAL"

    def _fallback_response(self, message: str, flight_state: dict, phase_info: dict, nearest: dict | None) -> str:
        """Context-aware ATC responses when Ollama is not available."""
        import random
        cs = self.callsign or "Aircraft"
        msg = message.lower()
        alt = flight_state.get("altitude", 0)
        hdg = flight_state.get("heading_mag", 0)
        spd = flight_state.get("ground_speed", 0)
        on_ground = flight_state.get("on_ground", True)
        apt_icao = nearest["icao"] if nearest else "nearest airport"
        apt_name = nearest["name"] if nearest else "nearest airport"
        rwys = nearest.get("rwys", ["07/25"]) if nearest else ["07/25"]
        rwy = rwys[0].split("/")[0] if rwys else "27"
        dist_nm = nearest.get("distance_nm", 0) if nearest else 0
        freq_twr = nearest.get("freq", {}).get("twr", 118.1) if nearest else 118.1
        freq_gnd = nearest.get("freq", {}).get("gnd", 121.9) if nearest else 121.9
        freq_app = nearest.get("freq", {}).get("app", 119.55) if nearest else 119.55
        freq_dep = nearest.get("freq", {}).get("dep", 127.95) if nearest else 127.95

        conv_phase = self._get_conversation_phase()

        # If an emergency scenario is active, override conv_phase to EMERGENCY
        if self.emergency_active and conv_phase != "EMERGENCY":
            conv_phase = "EMERGENCY"

        # --- EMERGENCY HANDLING (always highest priority) ---
        if any(w in msg for w in ["mayday", "pan pan", "7700", "emergency"]):
            responses = [
                f"{cs}, MAYDAY acknowledged, all stations standby. Squawk 7700, state souls on board and fuel remaining. Turn left heading {(hdg - 30) % 360:03.0f}, vectors for {apt_icao} runway {rwy}, {dist_nm} miles.",
                f"{cs}, MAYDAY acknowledged. All traffic standby. {cs}, say nature of emergency, souls on board, fuel remaining in minutes. Emergency services alerted at {apt_icao}.",
                f"{cs}, PAN PAN acknowledged. State your intentions. {apt_icao} is {dist_nm} miles, runway {rwy} available. Crash fire rescue on standby.",
            ]
            return random.choice(responses)

        # --- SPECIFIC IN-FLIGHT PROBLEMS ---
        if any(w in msg for w in ["landing gear", "gear problem", "gear stuck", "gear won't", "gear failure", "gear not"]):
            return f"{cs}, roger landing gear problem. Suggest low approach runway {rwy} at {apt_icao} for visual inspection by Tower. Descend and maintain 2000, turn heading {(hdg + 10) % 360:03.0f}. Squawk 7700. Emergency services alerted."

        if any(w in msg for w in ["engine failure", "engine out", "flame out", "engine fire", "lost engine"]):
            return f"{cs}, roger engine failure. Turn left heading {(hdg - 20) % 360:03.0f}, vectors for {apt_icao} runway {rwy}, {dist_nm} miles. Descend to 3000. Emergency services on standby. State souls on board and fuel remaining."

        if any(w in msg for w in ["fire", "smoke", "fumes"]):
            return f"{cs}, roger fire report. Squawk 7700, descend immediately to altitude 10000. Turn heading {(hdg - 30) % 360:03.0f}, direct {apt_icao}, {dist_nm} miles. Crash fire rescue alerted. State souls and fuel."

        if any(w in msg for w in ["hydraulic", "flight control", "control problem"]):
            return f"{cs}, roger hydraulic failure. Maintain present altitude if able. Turn heading {(hdg + 15) % 360:03.0f} for vectors to {apt_icao} runway {rwy}. Emergency services on standby. Advise your controllability."

        if any(w in msg for w in ["fuel low", "minimum fuel", "fuel emergency", "bingo fuel"]):
            return f"{cs}, roger fuel emergency. Squawk 7700. Priority handling approved. Turn heading {(hdg - 10) % 360:03.0f}, direct {apt_icao} runway {rwy}, {dist_nm} miles. Expect straight-in approach, no delay. State fuel remaining in minutes."

        if any(w in msg for w in ["pressur", "cabin pressure", "depress"]):
            return f"{cs}, roger pressurization failure. Descend immediately to flight level 100. Turn heading {(hdg + 20) % 360:03.0f}, vectors for {apt_icao}. Emergency descent approved. Report when level at FL100."

        if any(w in msg for w in ["bird strike", "bird hit", "bird"]):
            return f"{cs}, roger bird strike. State any damage or performance issues. If able to continue, you are cleared direct {apt_icao}. Emergency services on standby runway {rwy}."

        if any(w in msg for w in ["turbulence", "rough ride", "chop"]):
            fl_up = int(alt / 100) + 20
            fl_down = int(alt / 100) - 20
            return f"{cs}, roger turbulence report. Flight level {fl_up:03d} or {fl_down:03d} available, pilot's discretion. PIREP noted, advising following traffic."

        if any(w in msg for w in ["navigation", "nav failure", "gps", "fms failure"]):
            return f"{cs}, roger navigation failure. Radar vectors available. Maintain present heading {hdg:03.0f}, I will provide vectors. Squawk 4521 and ident."

        if any(w in msg for w in ["electrical", "power failure", "generator"]):
            return f"{cs}, roger electrical problem. Squawk 7600 if you lose comms. Proceed direct {apt_icao}, expect visual approach runway {rwy}. Reduce non-essential electrical load."

        # --- SOULS / FUEL FOLLOWUP (emergency context) ---
        if conv_phase == "EMERGENCY":
            if any(w in msg for w in ["soul", "passenger", "people", "pob"]):
                return f"{cs}, roger souls on board copied. State fuel remaining in minutes. Continue present heading for vectors to {apt_icao} runway {rwy}."
            if any(w in msg for w in ["fuel", "minutes", "hours"]):
                return f"{cs}, fuel remaining copied. Continue heading {hdg:03.0f}, descend to 3000 when ready. {apt_icao} runway {rwy} in sight, {dist_nm} miles. Cleared ILS approach runway {rwy}. Emergency services standing by."
            if any(w in msg for w in ["request", "want", "need", "intention"]):
                return f"{cs}, roger. {apt_icao} runway {rwy} available, {dist_nm} miles. You are cleared direct. Descend at pilot's discretion. All traffic cleared from your path."
            # Generic emergency followup
            return f"{cs}, continue present heading {hdg:03.0f}. {apt_icao} runway {rwy}, {dist_nm} miles. You are number one, no delay. Report field in sight."

        # --- PUSHBACK ---
        if any(w in msg for w in ["pushback", "push back", "push", "startup", "start up"]):
            return f"{cs}, information Alpha, QNH 1013, pushback approved, face south. Report ready for taxi."

        # --- READY FOR TAXI (post-pushback) ---
        if any(w in msg for w in ["ready for taxi", "request taxi", "ready to taxi"]):
            return f"{cs}, taxi to holding point runway {rwy} via taxiway Alpha, Bravo. Hold short runway {rwy}. QNH 1013."

        # --- TAXI ---
        if "taxi" in msg:
            if conv_phase in ["LANDING", "APPROACH"]:
                return f"{cs}, taxi to bay via taxiway Charlie, Delta. Welcome to {apt_name}."
            return f"{cs}, taxi to holding point runway {rwy} via taxiway Alpha, Bravo. Hold short runway {rwy}."

        # --- HOLDING SHORT / READY ---
        if any(w in msg for w in ["holding short", "hold short"]):
            return f"{cs}, runway {rwy}, line up and wait. Traffic on short final."

        if any(w in msg for w in ["lined up", "ready for departure", "ready to go", "number one"]):
            return f"{cs}, runway {rwy}, wind 260 degrees 8 knots, cleared for takeoff. After departure climb heading {hdg:03.0f}, climb and maintain 5000. Contact departure {freq_dep}, good day."

        # --- TAKEOFF ---
        if any(w in msg for w in ["takeoff", "take off", "rolling"]):
            return f"{cs}, runway {rwy}, wind 260 degrees 8 knots, cleared for takeoff. After departure climb heading {hdg:03.0f}, climb and maintain 5000. Contact departure {freq_dep}, good day."

        # --- AIRBORNE / INITIAL CLIMB ---
        if any(w in msg for w in ["airborne", "passing", "leaving"]):
            if conv_phase == "TAKEOFF":
                return f"{cs}, radar contact. Climb and maintain flight level 240. Report passing flight level 100."
            return f"{cs}, roger, continue climb. Report reaching assigned altitude."

        # --- CLIMB ---
        if any(w in msg for w in ["climb", "higher", "request flight level", "request fl"]):
            if alt < 10000:
                return f"{cs}, climb and maintain flight level 240. Report passing flight level 100."
            elif alt < 24000:
                return f"{cs}, climb and maintain flight level 350."
            elif alt < 35000:
                return f"{cs}, climb and maintain flight level 390. When passing flight level 300, contact control on 132.5."
            else:
                return f"{cs}, flight level 410 approved. Report reaching."

        # --- CRUISE REQUESTS ---
        if any(w in msg for w in ["direct to", "direct", "proceed direct"]):
            return f"{cs}, cleared direct {apt_icao}. Maintain flight level {int(alt/100):03d}. Report {apt_icao} in range."

        if any(w in msg for w in ["request descent", "descend", "lower", "start descent"]):
            return f"{cs}, descend and maintain flight level 120. Expect ILS approach runway {rwy} at {apt_icao}. Cross {apt_icao} at or above flight level 120."

        # --- APPROACH ---
        if any(w in msg for w in ["established", "localizer", "glideslope", "on the ils"]):
            return f"{cs}, roger, continue approach runway {rwy}. Wind 240 degrees 10 knots. You are number one. Contact tower {freq_twr} when established."

        if any(w in msg for w in ["approach", "ils", "visual", "vectors"]):
            return f"{cs}, descend to altitude 3000. Expect ILS approach runway {rwy}. Turn heading {(hdg - 20) % 360:03.0f} for base leg. Report established on localizer."

        if any(w in msg for w in ["final", "short final"]):
            return f"{cs}, runway {rwy}, wind 240 degrees 10 knots, cleared to land. Report vacated."

        # --- LANDING CLEARANCE ---
        if any(w in msg for w in ["land", "cleared to land", "request landing"]):
            return f"{cs}, runway {rwy}, wind 250 degrees 8 knots, cleared to land. After landing vacate left, contact ground {freq_gnd}."

        # --- AFTER LANDING ---
        if any(w in msg for w in ["vacated", "clear of runway", "runway vacated", "on the ground"]):
            return f"{cs}, roger, runway vacated. Contact ground {freq_gnd}. Welcome to {apt_name}, good day."

        # --- FREQUENCY CHANGE ---
        if any(w in msg for w in ["frequency", "contact", "handoff"]):
            if on_ground:
                return f"{cs}, contact tower {freq_twr}, good day."
            elif alt < 5000:
                return f"{cs}, contact approach {freq_app}, good day."
            else:
                return f"{cs}, contact control on 132.5, good day."

        # --- SQUAWK ---
        if "squawk" in msg:
            return f"{cs}, squawk 4521, ident."

        # --- POSITION REPORT ---
        if any(w in msg for w in ["position", "where", "flight following", "radar contact"]):
            fl = f"flight level {int(alt/100):03d}" if alt > 18000 else f"{alt} feet"
            return f"{cs}, radar contact. {fl}, {spd} knots ground speed, heading {hdg:03.0f}. Continue present heading and altitude."

        # --- WEATHER / ATIS ---
        if any(w in msg for w in ["weather", "atis", "winds", "metar", "information"]):
            return f"{cs}, {apt_icao} weather: wind 250 at 12, visibility 10 kilometers, few clouds 3000, scattered 8000, temperature 24 dewpoint 18, QNH 1013. Information Alpha is current."

        # --- ACKNOWLEDGE / READBACK ---
        if any(w in msg for w in ["roger", "wilco", "copy", "affirm", "understand", "acknowledged"]):
            # Continue from current conversation context
            if conv_phase == "PUSHBACK":
                return f"{cs}, report ready for taxi."
            elif conv_phase == "TAXI":
                return f"{cs}, hold short runway {rwy}, report ready."
            elif conv_phase == "HOLDING":
                return f"{cs}, runway {rwy}, cleared for takeoff, wind 260 degrees 8 knots."
            elif conv_phase == "TAKEOFF":
                return f"{cs}, contact departure {freq_dep}, good day."
            elif conv_phase == "CLIMB":
                return f"{cs}, report reaching assigned altitude."
            elif conv_phase == "CRUISE":
                return f"{cs}, roger, maintain flight level {int(alt/100):03d}."
            elif conv_phase in ["DESCENT", "APPROACH"]:
                return f"{cs}, report established on ILS runway {rwy}."
            elif conv_phase == "LANDING":
                return f"{cs}, after landing vacate left, contact ground {freq_gnd}."
            elif conv_phase == "EMERGENCY":
                return f"{cs}, roger. Continue heading {hdg:03.0f}. Report field in sight."
            return f"{cs}, roger."

        # --- GENERIC / CATCH-ALL BASED ON CONVERSATION CONTEXT ---
        if conv_phase == "PUSHBACK":
            return f"{cs}, report ready for taxi."
        elif conv_phase == "TAXI":
            return f"{cs}, continue taxi. Hold short runway {rwy}, report ready for departure."
        elif conv_phase == "HOLDING":
            return f"{cs}, runway {rwy}, wind 260 degrees 8 knots, cleared for takeoff."
        elif conv_phase == "TAKEOFF":
            return f"{cs}, radar contact, climb and maintain 5000. Contact departure {freq_dep}."
        elif conv_phase == "CLIMB":
            return f"{cs}, continue climb to assigned altitude. Report reaching."
        elif conv_phase == "CRUISE":
            return f"{cs}, roger. Continue present heading, maintain flight level {int(alt/100):03d}. Traffic information: no conflicting traffic."
        elif conv_phase == "DESCENT":
            return f"{cs}, continue descent. Report passing flight level 100. Expect vectors for ILS approach runway {rwy}."
        elif conv_phase == "APPROACH":
            return f"{cs}, continue approach runway {rwy}. Wind 240 degrees 10 knots. Report established."
        elif conv_phase == "LANDING":
            return f"{cs}, runway {rwy}, cleared to land. Wind 250 degrees 8 knots. After landing contact ground {freq_gnd}."
        elif conv_phase == "EMERGENCY":
            return f"{cs}, continue heading {hdg:03.0f}, {apt_icao} runway {rwy}, {dist_nm} miles. You are number one, no delay expected. Report field in sight."

        # True fallback — no context at all
        if on_ground:
            return f"{cs}, {apt_name} ground, say your request."
        elif alt < 5000:
            return f"{cs}, {apt_name} approach, say your request."
        elif alt > 18000:
            return f"{cs}, control, say your request. Squawk 4521, ident."
        return f"{cs}, roger, say your request."

    def reset(self):
        self.conversation_history.clear()
        self.active_scenario = ""
        self.scenario_context = ""
        self.emergency_active = False

    def resolve_emergency(self):
        """Resolve current emergency — allow AI to move on."""
        self.emergency_active = False
        self.active_scenario = ""
        self.scenario_context = ""

    def get_context_for_emergency(self, flight_state: dict, phase_info: dict) -> dict:
        nearest = find_nearest_airport(
            flight_state.get("lat", 0),
            flight_state.get("lon", 0)
        )
        return {
            "callsign": self.callsign,
            "flight_state": flight_state,
            "phase": phase_info,
            "nearest_airport": nearest,
        }
