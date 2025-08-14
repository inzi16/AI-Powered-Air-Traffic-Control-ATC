"""Production-oriented FastAPI entry point for the authoritative ATC demo."""

from __future__ import annotations

import os
import re
import tempfile
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Query, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse

try:
    from .atc_brain import ATCBrain
    from .emergencies import EMERGENCY_CATALOG
    from .navigation import AirportResolutionError
    from .runtime import SimulationRuntime
    from .schemas import (
        ActionCompleteRequest,
        CallsignRequest,
        ChatRequest,
        ClearanceAcceptRequest,
        CustomScenarioRequest,
        DemoStateUpdate,
        EmergencyActivateRequest,
        EmergencyResolveRequest,
        EventEnvelope,
        RouteDemoRequest,
        ScenarioRequest,
        Snapshot,
        TTSRequest,
    )
except ImportError:  # direct `python backend/main.py` compatibility
    from atc_brain import ATCBrain
    from emergencies import EMERGENCY_CATALOG
    from navigation import AirportResolutionError
    from runtime import SimulationRuntime
    from schemas import (
        ActionCompleteRequest,
        CallsignRequest,
        ChatRequest,
        ClearanceAcceptRequest,
        CustomScenarioRequest,
        DemoStateUpdate,
        EmergencyActivateRequest,
        EmergencyResolveRequest,
        EventEnvelope,
        RouteDemoRequest,
        ScenarioRequest,
        Snapshot,
        TTSRequest,
    )


def _optional_sim_reader():
    if os.getenv("ATC_ENABLE_SIMCONNECT", "false").lower() not in {"1", "true", "yes"}:
        return None
    try:
        try:
            from .simconnect_reader import MSFSSim
        except ImportError:
            from simconnect_reader import MSFSSim
        return MSFSSim()
    except Exception:
        return None


runtime = SimulationRuntime(sim_reader=_optional_sim_reader())
brain = ATCBrain()
brain_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if os.getenv("ATC_ENV", "development").lower() == "production" and not os.getenv("ATC_API_KEY"):
        raise RuntimeError("ATC_API_KEY is required when ATC_ENV=production.")
    await runtime.start()
    try:
        yield
    finally:
        await runtime.stop()


app = FastAPI(
    title="AI ATC Simulation API",
    version="3.0.0",
    description="Authoritative, sequenced flight demo, clearance, conflict, and emergency runtime.",
    lifespan=lifespan,
)

allowed_origins = [
    value.strip() for value in os.getenv(
        "ATC_ALLOWED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000",
    ).split(",") if value.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-API-Key"],
)
allowed_hosts = [
    value.strip() for value in os.getenv("ATC_ALLOWED_HOSTS", "localhost,127.0.0.1,testserver").split(",") if value.strip()
]
app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)


@app.middleware("http")
async def optional_api_key(request: Request, call_next):
    configured = os.getenv("ATC_API_KEY")
    if configured and request.url.path not in {"/health", "/ready"}:
        supplied = request.headers.get("X-API-Key", "")
        import secrets
        if not secrets.compare_digest(supplied, configured):
            return JSONResponse(status_code=401, content={"detail": "Authentication required."})
    return await call_next(request)


def _event(event_type: str, data: dict) -> dict:
    return EventEnvelope(event=runtime.event(event_type), data=data).model_dump(mode="json")


def _publish_command_tick() -> Snapshot:
    return runtime.tick_once(0.0)


def _extract_callsign(text: str) -> str | None:
    airline_map = {
        "emirates": "EK", "speedbird": "BA", "british": "BA", "delta": "DL",
        "american": "AA", "united": "UA", "lufthansa": "DLH", "air india": "AI",
        "air france": "AFR", "singapore": "SIA", "qatar": "QTR", "turkish": "THY",
        "cathay": "CPA", "qantas": "QFA", "etihad": "EY", "saudia": "SVA",
        "indigo": "IGO", "klm": "KLM", "fedex": "FDX", "ups": "UPS",
    }
    normalized = text.lower()
    digit_words = {
        "zero": "0", "one": "1", "two": "2", "three": "3", "tree": "3", "four": "4",
        "five": "5", "fife": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9", "niner": "9",
    }
    for name, code in airline_map.items():
        match = re.search(rf"\b{re.escape(name)}\s+((?:(?:\d+|{'|'.join(digit_words)})[\s-]*){{1,6}})", normalized)
        if match:
            tokens = re.findall(r"\d+|[a-z]+", match.group(1))
            digits = "".join(token if token.isdigit() else digit_words.get(token, "") for token in tokens)
            if digits:
                return f"{code}{digits[:6]}"
    match = re.search(r"\b([A-Z]{2,3})[\s-]*(\d{1,6})\b", text)
    return f"{match.group(1)}{match.group(2)}" if match else None


def _infer_emergency(text: str) -> str | None:
    lowered = text.lower()
    rules = (
        ("smoke_fire", ("smoke", "fire", "fumes")),
        ("engine_failure", ("engine failure", "engine out", "flameout", "flame out")),
        ("medical", ("medical emergency", "cardiac", "passenger ill", "passenger sick")),
        ("hydraulic", ("hydraulic failure", "hydraulic problem")),
        ("bird_strike", ("bird strike", "bird hit")),
        ("fuel", ("mayday fuel", "fuel emergency", "bingo fuel")),
        ("comm_failure", ("radio failure", "communication failure", "lost comm", "comms failure")),
        ("gear", ("gear failure", "gear stuck", "landing gear problem", "unsafe gear")),
    )
    return next((kind for kind, words in rules if any(word in lowered for word in words)), None)


@app.get("/health")
def health():
    return runtime.health()


@app.get("/ready")
def ready():
    health_data = runtime.health()
    if not health_data["ready"]:
        raise HTTPException(status_code=503, detail="Authoritative snapshot loop is not ready.")
    return health_data


@app.get("/sim/state", response_model=Snapshot)
def sim_state():
    """Return the cached snapshot. Reads never advance phase or simulation."""
    return runtime.current_snapshot()


@app.websocket("/ws/state")
async def ws_state(websocket: WebSocket):
    configured = os.getenv("ATC_API_KEY")
    supplied = websocket.headers.get("X-API-Key") or websocket.query_params.get("api_key", "")
    if configured:
        import secrets
        if not secrets.compare_digest(supplied, configured):
            await websocket.close(code=4401)
            return
    await websocket.accept()
    queue = runtime.subscribe()
    try:
        await websocket.send_text(runtime.current_json)
        while True:
            await websocket.send_text(await queue.get())
    except WebSocketDisconnect:
        pass
    finally:
        runtime.unsubscribe(queue)


@app.get("/airports/search")
def search_airports(q: str = Query(default="", max_length=100), limit: int = Query(default=20, ge=1, le=100)):
    return {"airports": [airport.model_dump(mode="json") for airport in runtime.catalog.search(q, limit)]}


@app.get("/airports/{icao}")
def get_airport(icao: str):
    airport = runtime.catalog.get(icao)
    if not airport:
        raise HTTPException(status_code=404, detail="Airport is not in the local catalog; use manual coordinates when creating a route.")
    return airport


async def _start_route(request: RouteDemoRequest) -> dict:
    async with runtime.lock:
        try:
            route = runtime.route.create(request, runtime.catalog, runtime.state)
        except AirportResolutionError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        if request.callsign:
            runtime.callsign = request.callsign
            brain.set_callsign(request.callsign)
        runtime.traffic.reset_around(runtime.state["lat"], runtime.state["lon"], runtime.state["altitude"])
        snapshot = _publish_command_tick()
    return _event("route.created", {
        "route": route.model_dump(mode="json"),
        "snapshot": snapshot.model_dump(mode="json"),
    })


@app.post("/routes/demo")
async def start_demo_route(request: RouteDemoRequest):
    return await _start_route(request)


@app.post("/route/start", include_in_schema=False)
async def start_route_alias(request: RouteDemoRequest):
    return await _start_route(request)


@app.post("/demo/route", include_in_schema=False)
async def demo_route_alias(request: RouteDemoRequest):
    return await _start_route(request)


@app.post("/routes/{route_id}/engage")
async def engage_route(route_id: str):
    async with runtime.lock:
        if route_id != runtime.route.route_id:
            raise HTTPException(status_code=404, detail="Route not found.")
        runtime.route.engage()
        snapshot = _publish_command_tick()
    return _event("route.engaged", {"route": snapshot.route.model_dump(mode="json") if snapshot.route else None})


@app.post("/routes/{route_id}/cancel")
async def cancel_route(route_id: str):
    async with runtime.lock:
        if route_id != runtime.route.route_id:
            raise HTTPException(status_code=404, detail="Route not found.")
        runtime.route.cancel()
        runtime.engine.reset_targets()
        snapshot = _publish_command_tick()
    return _event("route.cancelled", {"route": snapshot.route.model_dump(mode="json") if snapshot.route else None})


@app.get("/emergencies/catalog")
def emergency_catalog():
    return {"emergencies": list(runtime.emergencies.catalog.values())}


@app.post("/emergencies/activate")
async def activate_emergency(request: EmergencyActivateRequest):
    async with runtime.lock:
        current = runtime.emergencies.active
        if current and current.status != "resolved":
            raise HTTPException(status_code=409, detail="Resolve the active emergency before activating another.")
        emergency = runtime.emergencies.activate(request.type, runtime.state, runtime.catalog, request.details)
        runtime.active_scenario = emergency.title
        brain.set_scenario(emergency.title, emergency.summary)
        if request.auto_divert and emergency.recommended_diversion and request.type != "comm_failure":
            runtime.route.divert(runtime.state, emergency.recommended_diversion, emergency.title)
        snapshot = _publish_command_tick()
    return _event("emergency.activated", {
        "emergency": snapshot.emergency.model_dump(mode="json") if snapshot.emergency else None,
        "route": snapshot.route.model_dump(mode="json") if snapshot.route else None,
    })


async def _complete_emergency_action(emergency_id: str | None, action_id: str, request: ActionCompleteRequest) -> dict:
    async with runtime.lock:
        current = runtime.emergencies.active
        if not current or (emergency_id and current.emergency_id != emergency_id):
            raise HTTPException(status_code=404, detail="Active emergency not found.")
        try:
            emergency = runtime.emergencies.complete_action(action_id, request.completed, runtime.state)
        except KeyError:
            raise HTTPException(status_code=404, detail="Emergency action not found.") from None
        snapshot = _publish_command_tick()
    return _event("emergency.action_updated", {
        "emergency": snapshot.emergency.model_dump(mode="json") if snapshot.emergency else emergency.model_dump(mode="json")
    })


@app.post("/emergencies/{emergency_id}/actions/{action_id}/complete")
async def complete_emergency_action(emergency_id: str, action_id: str, request: ActionCompleteRequest):
    return await _complete_emergency_action(emergency_id, action_id, request)


@app.post("/emergency/actions/{action_id}/complete", include_in_schema=False)
async def complete_emergency_action_alias(action_id: str, request: ActionCompleteRequest):
    return await _complete_emergency_action(None, action_id, request)


async def _resolve_emergency(emergency_id: str | None, request: EmergencyResolveRequest | None) -> dict:
    async with runtime.lock:
        current = runtime.emergencies.active
        if not current or (emergency_id and current.emergency_id != emergency_id):
            raise HTTPException(status_code=404, detail="Active emergency not found.")
        try:
            emergency = runtime.emergencies.resolve(runtime.state, force=bool(request and request.force))
        except PermissionError as exc:
            raise HTTPException(status_code=409, detail={
                "message": str(exc),
                "resolution_criteria": [item.model_dump(mode="json") for item in current.resolution_criteria],
            }) from None
        brain.resolve_emergency()
        runtime.active_scenario = ""
        _publish_command_tick()
    return _event("emergency.resolved", {"emergency": emergency.model_dump(mode="json"), "squawk": runtime.state["squawk"]})


@app.post("/emergencies/{emergency_id}/resolve")
async def resolve_emergency_by_id(emergency_id: str, request: EmergencyResolveRequest | None = None):
    return await _resolve_emergency(emergency_id, request)


@app.post("/emergency/resolve")
async def resolve_emergency(request: EmergencyResolveRequest | None = None):
    return await _resolve_emergency(None, request)


@app.get("/emergency/status")
def emergency_status():
    emergency = runtime.emergencies.refresh(runtime.state)
    return {
        "active": bool(emergency and emergency.status != "resolved"),
        "scenario": runtime.active_scenario,
        "description": emergency.summary if emergency else "",
        "emergency_id": emergency.emergency_id if emergency else None,
        "emergency": emergency.model_dump(mode="json") if emergency else None,
    }


@app.get("/clearances")
def list_clearances():
    return {"clearances": [item.model_dump(mode="json") for item in runtime.clearances.list()]}


@app.post("/clearances/{clearance_id}/accept")
async def accept_clearance(clearance_id: str, request: ClearanceAcceptRequest):
    async with runtime.lock:
        try:
            clearance = runtime.accept_clearance(clearance_id, request.readback)
        except KeyError:
            raise HTTPException(status_code=404, detail="Clearance not found.") from None
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from None
        snapshot = _publish_command_tick()
    return _event("clearance.accepted", {
        "clearance": clearance.model_dump(mode="json"),
        "snapshot": snapshot.model_dump(mode="json"),
    })


@app.post("/callsign")
async def set_callsign(request: CallsignRequest):
    async with runtime.lock:
        runtime.callsign = request.callsign
        brain.set_callsign(request.callsign)
        _publish_command_tick()
    return _event("callsign.updated", {"callsign": runtime.callsign})


@app.post("/chat")
async def chat(request: ChatRequest):
    async with runtime.lock:
        extracted = _extract_callsign(request.message)
        if extracted and not runtime.callsign:
            runtime.callsign = extracted
            brain.set_callsign(extracted)

        pilot_request = runtime.clearances.record_request(request.message, runtime.callsign)
        inferred = _infer_emergency(request.message)
        if inferred and (not runtime.emergencies.active or runtime.emergencies.active.status == "resolved"):
            emergency = runtime.emergencies.activate(inferred, runtime.state, runtime.catalog, request.message[:500])
            runtime.active_scenario = emergency.title
            brain.set_scenario(emergency.title, emergency.summary)
            _publish_command_tick()

        snapshot = runtime.current_snapshot()
    phase = {"phase": snapshot.phase, "phase_label": snapshot.phase_label, "vertical_rate": snapshot.vertical_rate}
    async with brain_lock:
        reply = await brain.chat(request.message, snapshot.model_dump(mode="json"), phase)
    async with runtime.lock:
        issued = runtime.clearances.issue_from_atc(reply, runtime.callsign)
        if issued:
            _publish_command_tick()
        updated = runtime.current_snapshot()
    return {
        "reply": reply,
        "flight_state": updated.model_dump(mode="json"),
        "phase": {"phase": updated.phase, "phase_label": updated.phase_label, "vertical_rate": updated.vertical_rate},
        "nearest_airport": updated.nearest_airport.model_dump(mode="json") if updated.nearest_airport else None,
        "callsign": runtime.callsign,
        "pilot_request": pilot_request.model_dump(mode="json") if pilot_request else None,
        "clearance": issued.model_dump(mode="json") if issued else None,
        "requires_acceptance": issued is not None,
    }


SCENARIO_ALIASES = {
    "engine_failure": "engine_failure",
    "medical_emergency": "medical",
    "medical": "medical",
    "hydraulic_failure": "hydraulic",
    "hydraulic": "hydraulic",
    "bird_strike": "bird_strike",
    "fuel_emergency": "fuel",
    "fuel": "fuel",
    "comm_failure": "comm_failure",
    "smoke_fire": "smoke_fire",
    "gear_failure": "gear",
    "gear": "gear",
}

SCENARIO_STATES = {
    "engine_failure": DemoStateUpdate(altitude=2500, ground_speed=180, heading_mag=70, lat=13.02, lon=80.20, on_ground=False, fuel_kg=14000),
    "medical": DemoStateUpdate(altitude=35000, ground_speed=450, heading_mag=315, lat=17.5, lon=70.2, on_ground=False, fuel_kg=16000),
    "hydraulic": DemoStateUpdate(altitude=3000, ground_speed=160, heading_mag=300, lat=25.15, lon=55.22, on_ground=False, fuel_kg=12000),
    "bird_strike": DemoStateUpdate(altitude=800, ground_speed=170, heading_mag=270, lat=51.4775, lon=-0.4614, on_ground=False, fuel_kg=17000),
    "fuel": DemoStateUpdate(altitude=4000, ground_speed=210, heading_mag=45, lat=40.58, lon=-73.85, on_ground=False, fuel_kg=800),
    "comm_failure": DemoStateUpdate(altitude=12000, ground_speed=280, heading_mag=90, lat=19.0, lon=75.0, on_ground=False, fuel_kg=12000),
    "smoke_fire": DemoStateUpdate(altitude=18000, ground_speed=320, heading_mag=240, lat=22.0, lon=76.0, on_ground=False, fuel_kg=12000),
    "gear": DemoStateUpdate(altitude=3500, ground_speed=170, heading_mag=90, lat=19.0, lon=72.5, on_ground=False, fuel_kg=9000),
}


@app.get("/scenarios")
def list_scenarios():
    scenarios = {
        alias: {
            "name": EMERGENCY_CATALOG[kind].title,
            "description": EMERGENCY_CATALOG[kind].summary,
        }
        for alias, kind in SCENARIO_ALIASES.items()
        if alias in {"engine_failure", "medical_emergency", "hydraulic_failure", "bird_strike", "fuel_emergency", "comm_failure", "smoke_fire", "gear_failure"}
    }
    scenarios["ground_taxi"] = {"name": "Normal ground operations", "description": "Aircraft at Chennai preparing for pushback and taxi."}
    scenarios["custom"] = {"name": "Custom scenario", "description": "Describe an emergency at the current authoritative position."}
    return scenarios


@app.post("/scenario/load")
async def load_scenario(request: ScenarioRequest):
    async with runtime.lock:
        runtime.reset()
        brain.reset()
        if request.scenario_id == "ground_taxi":
            runtime.state["connected"] = True
            runtime.callsign = "EK547"
            brain.set_callsign("EK547")
            initial = request.custom_message or "Chennai Ground, Emirates 547, request pushback and start."
            _publish_command_tick()
        else:
            kind = SCENARIO_ALIASES.get(request.scenario_id)
            if not kind:
                raise HTTPException(status_code=404, detail="Unknown scenario.")
            runtime.update_demo_state(SCENARIO_STATES[kind])
            runtime.state["connected"] = True
            runtime.callsign = "EK547"
            brain.set_callsign("EK547")
            emergency = runtime.emergencies.activate(kind, runtime.state, runtime.catalog)
            runtime.active_scenario = emergency.title
            brain.set_scenario(emergency.title, emergency.summary)
            if emergency.recommended_diversion and kind != "comm_failure":
                runtime.route.divert(runtime.state, emergency.recommended_diversion, emergency.title)
            runtime.traffic.reset_around(runtime.state["lat"], runtime.state["lon"], runtime.state["altitude"])
            initial = request.custom_message or f"MAYDAY, {runtime.callsign}, {emergency.title.lower()}, request priority handling."
            _publish_command_tick()
        snapshot = runtime.current_snapshot()
    phase = {"phase": snapshot.phase, "phase_label": snapshot.phase_label, "vertical_rate": snapshot.vertical_rate}
    async with brain_lock:
        reply = await brain.chat(initial, snapshot.model_dump(mode="json"), phase)
    async with runtime.lock:
        issued = runtime.clearances.issue_from_atc(reply, runtime.callsign)
        if issued:
            _publish_command_tick()
        snapshot = runtime.current_snapshot()
    return {
        "scenario": runtime.active_scenario or "Normal ground operations",
        "state": snapshot.model_dump(mode="json"),
        "phase": {"phase": snapshot.phase, "phase_label": snapshot.phase_label, "vertical_rate": snapshot.vertical_rate},
        "nearest_airport": snapshot.nearest_airport.model_dump(mode="json") if snapshot.nearest_airport else None,
        "initial_message": initial,
        "atc_reply": reply,
        "clearance": issued.model_dump(mode="json") if issued else None,
    }


@app.post("/scenario/custom")
async def custom_scenario(request: CustomScenarioRequest):
    kind = _infer_emergency(request.description)
    if not kind:
        raise HTTPException(
            status_code=422,
            detail="Describe one supported emergency type, or use /routes/demo for a typed origin/destination flight.",
        )
    async with runtime.lock:
        if runtime.emergencies.active and runtime.emergencies.active.status != "resolved":
            raise HTTPException(status_code=409, detail="Resolve the active emergency first.")
        emergency = runtime.emergencies.activate(kind, runtime.state, runtime.catalog, request.description)
        runtime.active_scenario = emergency.title
        brain.set_scenario(emergency.title, emergency.summary)
        if emergency.recommended_diversion and kind != "comm_failure":
            runtime.route.divert(runtime.state, emergency.recommended_diversion, emergency.title)
        snapshot = _publish_command_tick()
    return _event("scenario.created", {
        "scenario": emergency.title,
        "state": snapshot.model_dump(mode="json"),
        "emergency": snapshot.emergency.model_dump(mode="json") if snapshot.emergency else None,
    })


@app.post("/demo/update-state")
async def update_demo_state(request: DemoStateUpdate):
    if os.getenv("ATC_ENABLE_DEV_ENDPOINTS", "false").lower() not in {"1", "true", "yes"}:
        raise HTTPException(status_code=403, detail="Developer state injection is disabled.")
    async with runtime.lock:
        runtime.update_demo_state(request)
        snapshot = _publish_command_tick()
    return _event("demo.state_updated", {"state": snapshot.model_dump(mode="json")})


async def _reset_session() -> dict:
    async with runtime.lock:
        brain.reset()
        snapshot = runtime.reset()
    return _event("session.reset", {"status": "Session reset", "snapshot": snapshot.model_dump(mode="json")})


@app.post("/session/reset")
async def reset_session_post():
    return await _reset_session()


@app.get("/session/reset", deprecated=True)
async def reset_session_get(response: Response):
    response.headers["Deprecation"] = "true"
    response.headers["Link"] = '</session/reset>; rel="successor-version"'
    return await _reset_session()


@app.post("/tts")
async def text_to_speech(request: TTSRequest):
    try:
        try:
            from .tts import generate_speech
        except ImportError:
            from tts import generate_speech
        audio = await generate_speech(request.text, voice=request.voice)
    except Exception:
        raise HTTPException(status_code=503, detail="Text-to-speech service is unavailable.") from None
    return Response(content=audio, media_type="audio/mpeg")


@app.post("/stt")
async def speech_to_text(audio: UploadFile = File(...)):
    allowed_types = {"audio/webm", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/ogg"}
    if audio.content_type not in allowed_types:
        raise HTTPException(status_code=415, detail="Unsupported audio format.")
    payload = await audio.read(10 * 1024 * 1024 + 1)
    if len(payload) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Audio upload exceeds 10 MB.")
    suffixes = {"audio/webm": ".webm", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/ogg": ".ogg"}
    path = ""
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffixes[audio.content_type]) as temporary:
            path = temporary.name
            temporary.write(payload)
        try:
            from .stt import transcribe
        except ImportError:
            from stt import transcribe
        text = transcribe(path)
        if text.startswith("("):
            raise RuntimeError("transcription unavailable")
        return {"text": text}
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Speech-to-text service is unavailable.") from None
    finally:
        if path:
            Path(path).unlink(missing_ok=True)


@app.get("/tts/voices")
def list_voices():
    try:
        try:
            from .tts import get_available_voices
        except ImportError:
            from tts import get_available_voices
        return get_available_voices()
    except Exception:
        return []


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.getenv("ATC_HOST", "127.0.0.1"),
        port=int(os.getenv("ATC_PORT", "8000")),
        proxy_headers=False,
    )
