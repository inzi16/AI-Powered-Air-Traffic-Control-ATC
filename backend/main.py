"""Production-oriented FastAPI entry point for the authoritative ATC demo."""

from __future__ import annotations

import os
import re
import tempfile
import asyncio
import hashlib
from contextlib import asynccontextmanager
from contextvars import ContextVar
from datetime import timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, File, HTTPException, Query, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse

try:
    from .ai_gateway import (
        ActionProposal,
        ConstrainedAIToolGateway,
        EvalMetrics,
        EvidenceRecord,
        GatewayCatalogResponse,
        GatewayContext,
        GatewayErrorCode,
        GatewayFailureResponse,
        GatewayPolicyResponse,
        GatewayProposalCreateRequest,
        GatewayProposalRevalidateRequest,
        GatewayReadInvokeRequest,
        GatewayRejection,
        GATEWAY_POLICY_VERSION,
        ProposalRevalidation,
        ProvenanceRecord,
        ReadToolResult,
        ToolMode,
        canonical_content_hash,
        deterministic_fallback,
        run_eval_fixture,
    )
    from .atc_brain import ATCBrain
    from .command_ledger import CommandNotFound, CommandRejected
    from .emergencies import EMERGENCY_CATALOG
    from .journal import JournalBookmarkNotFound, JournalSessionNotFound, JournalTargetError
    from .navigation import AirportResolutionError
    from .runtime import SimulationRuntime
    from .session_registry import (
        DEFAULT_TRAINING_SESSION_ID,
        InvalidTrainingSessionId,
        SessionRegistry,
        TrainingSessionConflict,
        TrainingSessionContext,
        TrainingSessionNotFound,
        TrainingSessionQuotaExceeded,
    )
    from .schemas import (
        ActionCompleteRequest,
        AlertAcknowledgementRequest,
        AlertAcknowledgementResponse,
        BookmarkCreateRequest,
        BookmarkUpdateRequest,
        CallsignRequest,
        ChatRequest,
        ClearanceAcceptRequest,
        CommandAuditPage,
        CommandAuditRecord,
        CommandOnlyRequest,
        CommandRequestMetadata,
        CustomScenarioRequest,
        DemoStateUpdate,
        EmergencyActivateRequest,
        EmergencyResolveRequest,
        EventEnvelope,
        JournalEventPage,
        JournalExport,
        JournalReplayResponse,
        JournalSessionSummary,
        RouteDemoRequest,
        ScenarioRequest,
        ScenarioControlRequest,
        ScenarioControlState,
        ScenarioTimeScaleRequest,
        Snapshot,
        TimelineBookmark,
        TrainingSessionCreateRequest,
        TrainingSessionList,
        TrainingSessionMetadata,
        TTSRequest,
    )
except ImportError:  # direct `python backend/main.py` compatibility
    from ai_gateway import (
        ActionProposal,
        ConstrainedAIToolGateway,
        EvalMetrics,
        EvidenceRecord,
        GatewayCatalogResponse,
        GatewayContext,
        GatewayErrorCode,
        GatewayFailureResponse,
        GatewayPolicyResponse,
        GatewayProposalCreateRequest,
        GatewayProposalRevalidateRequest,
        GatewayReadInvokeRequest,
        GatewayRejection,
        GATEWAY_POLICY_VERSION,
        ProposalRevalidation,
        ProvenanceRecord,
        ReadToolResult,
        ToolMode,
        canonical_content_hash,
        deterministic_fallback,
        run_eval_fixture,
    )
    from atc_brain import ATCBrain
    from command_ledger import CommandNotFound, CommandRejected
    from emergencies import EMERGENCY_CATALOG
    from journal import JournalBookmarkNotFound, JournalSessionNotFound, JournalTargetError
    from navigation import AirportResolutionError
    from runtime import SimulationRuntime
    from session_registry import (
        DEFAULT_TRAINING_SESSION_ID,
        InvalidTrainingSessionId,
        SessionRegistry,
        TrainingSessionConflict,
        TrainingSessionContext,
        TrainingSessionNotFound,
        TrainingSessionQuotaExceeded,
    )
    from schemas import (
        ActionCompleteRequest,
        AlertAcknowledgementRequest,
        AlertAcknowledgementResponse,
        BookmarkCreateRequest,
        BookmarkUpdateRequest,
        CallsignRequest,
        ChatRequest,
        ClearanceAcceptRequest,
        CommandAuditPage,
        CommandAuditRecord,
        CommandOnlyRequest,
        CommandRequestMetadata,
        CustomScenarioRequest,
        DemoStateUpdate,
        EmergencyActivateRequest,
        EmergencyResolveRequest,
        EventEnvelope,
        JournalEventPage,
        JournalExport,
        JournalReplayResponse,
        JournalSessionSummary,
        RouteDemoRequest,
        ScenarioRequest,
        ScenarioControlRequest,
        ScenarioControlState,
        ScenarioTimeScaleRequest,
        Snapshot,
        TimelineBookmark,
        TrainingSessionCreateRequest,
        TrainingSessionList,
        TrainingSessionMetadata,
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


def _bounded_env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        return max(minimum, min(maximum, int(os.getenv(name, str(default)))))
    except ValueError:
        return default


MIN_PRODUCTION_API_KEY_CHARACTERS = 43


def _require_production_api_key() -> None:
    """Fail startup unless production has a header-safe 256-bit-class token."""

    if os.getenv("ATC_ENV", "development").strip().lower() != "production":
        return
    configured = os.getenv("ATC_API_KEY", "")
    if not configured:
        raise RuntimeError("ATC_API_KEY is required when ATC_ENV=production.")
    if (
        len(configured) < MIN_PRODUCTION_API_KEY_CHARACTERS
        or not configured.isascii()
        or any(character.isspace() for character in configured)
    ):
        raise RuntimeError(
            "ATC_API_KEY must be a whitespace-free ASCII token of at least "
            f"{MIN_PRODUCTION_API_KEY_CHARACTERS} characters when ATC_ENV=production "
            "(generate it from at least 32 random bytes)."
        )


def _session_runtime_factory(_session_id: str, is_default: bool) -> SimulationRuntime:
    # A physical SimConnect adapter belongs only to the legacy default room.
    # Created training rooms are deterministic demo runtimes and never share IO.
    return SimulationRuntime(sim_reader=_optional_sim_reader() if is_default else None)


_default_idle_timeout = _bounded_env_int("ATC_SESSION_IDLE_SECONDS", 3_600, 60, 86_400)
_max_idle_timeout = max(
    _default_idle_timeout,
    _bounded_env_int("ATC_SESSION_MAX_IDLE_SECONDS", 86_400, 60, 604_800),
)
session_registry = SessionRegistry(
    _session_runtime_factory,
    max_sessions=_bounded_env_int("ATC_MAX_TRAINING_SESSIONS", 25, 1, 250),
    default_idle_timeout_seconds=_default_idle_timeout,
    max_idle_timeout_seconds=_max_idle_timeout,
    max_websocket_clients_per_session=_bounded_env_int("ATC_MAX_WS_CLIENTS_PER_SESSION", 8, 1, 100),
    max_commands_per_session=_bounded_env_int("ATC_MAX_COMMANDS_PER_SESSION", 500, 10, 10_000),
)
_training_context: ContextVar[TrainingSessionContext | None] = ContextVar("training_context", default=None)


def _current_context() -> TrainingSessionContext:
    return _training_context.get() or session_registry.default_context


class _ContextObjectProxy:
    """Forward attribute access and assignment to the request's isolated object."""

    __slots__ = ("_attribute",)

    def __init__(self, attribute: str):
        object.__setattr__(self, "_attribute", attribute)

    def _target(self):
        return getattr(_current_context(), object.__getattribute__(self, "_attribute"))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._target(), name)

    def __setattr__(self, name: str, value: Any) -> None:
        setattr(self._target(), name, value)


runtime = _ContextObjectProxy("runtime")
brain = _ContextObjectProxy("brain")
ai_gateway = ConstrainedAIToolGateway()
_gateway_catalog = tuple(ai_gateway.catalog())
_gateway_tool_modes = {item.name: item.mode for item in _gateway_catalog}
_gateway_eval_fixture = Path(__file__).resolve().parent / "evals" / "ai_gateway_v1.json"


def _gateway_policy() -> GatewayPolicyResponse:
    return GatewayPolicyResponse()


@lru_cache(maxsize=1)
def _gateway_baseline_metrics() -> EvalMetrics:
    return run_eval_fixture(_gateway_eval_fixture, gateway=ai_gateway)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _require_production_api_key()
    await session_registry.start()
    try:
        yield
    finally:
        await session_registry.stop()


app = FastAPI(
    title="Smart Air Traffic Control (ATC) API",
    version="3.0.0",
    description=(
        "Production-oriented air traffic control training platform with authoritative simulation, "
        "sequenced collaboration, emergency workflows, and an advisory-only AI gateway."
    ),
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
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-API-Key", "X-Session-ID"],
    expose_headers=["X-Session-ID", "X-Runtime-Session-ID"],
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


def _requested_training_session_id(request: Request) -> str | None:
    header_id = request.headers.get("X-Session-ID")
    query_id = request.query_params.get("session_id")
    if header_id and query_id and header_id.strip() != query_id.strip():
        raise InvalidTrainingSessionId("X-Session-ID and session_id query parameter must match when both are supplied.")
    return header_id or query_id


@app.middleware("http")
async def bind_training_session(request: Request, call_next):
    configured = os.getenv("ATC_API_KEY")
    if configured and request.url.path not in {"/health", "/ready"}:
        import secrets
        if not secrets.compare_digest(request.headers.get("X-API-Key", ""), configured):
            # Let the authentication middleware return 401 before resolving a
            # caller-controlled room ID, avoiding session-existence disclosure.
            return await call_next(request)
    try:
        if request.url.path.startswith("/training-sessions"):
            context = session_registry.default_context
            request_lease = False
        else:
            context = await session_registry.acquire_request(_requested_training_session_id(request))
            request_lease = True
    except InvalidTrainingSessionId as exc:
        return JSONResponse(status_code=400, content={"detail": str(exc)})
    except TrainingSessionNotFound as exc:
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    token = _training_context.set(context)
    request.state.training_session_id = context.session_id
    try:
        response = await call_next(request)
    finally:
        _training_context.reset(token)
        if request_lease:
            await session_registry.release_request(context)
    response.headers["X-Session-ID"] = context.session_id
    response.headers["X-Runtime-Session-ID"] = context.runtime.session_id
    return response


def _event(event_type: str, data: dict) -> dict:
    return runtime.record_event(event_type, data).model_dump(mode="json")


def _publish_command_tick() -> Snapshot:
    runtime.advance_state_revision()
    return runtime.tick_once(0.0)


def _raise_journal_http_error(exc: Exception) -> None:
    if isinstance(exc, (JournalSessionNotFound, JournalBookmarkNotFound)):
        raise HTTPException(status_code=404, detail=str(exc)) from None
    if isinstance(exc, JournalTargetError):
        raise HTTPException(status_code=422, detail=str(exc)) from None
    raise exc


def _raise_training_session_http_error(exc: Exception) -> None:
    if isinstance(exc, TrainingSessionNotFound):
        raise HTTPException(status_code=404, detail=str(exc)) from None
    if isinstance(exc, InvalidTrainingSessionId):
        raise HTTPException(status_code=400, detail=str(exc)) from None
    if isinstance(exc, TrainingSessionConflict):
        raise HTTPException(status_code=409, detail=str(exc)) from None
    if isinstance(exc, TrainingSessionQuotaExceeded):
        raise HTTPException(status_code=429, detail=str(exc)) from None
    raise exc


async def _run_command(
    command: CommandRequestMetadata | None,
    *,
    operation: str,
    payload: dict[str, Any],
    executor,
) -> dict[str, Any]:
    context = _current_context()
    try:
        return await context.commands.execute(
            command,
            operation=operation,
            payload=payload,
            runtime=context.runtime,
            executor=executor,
        )
    except CommandRejected as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail()) from None


def _command_payload(request: Any | None, **extra: Any) -> dict[str, Any]:
    payload = request.model_dump(mode="json", exclude={"command"}) if request is not None else {}
    payload.update(extra)
    return payload


def _gateway_preconditions(snapshot: Snapshot) -> dict[str, Any]:
    route = snapshot.route
    emergency = snapshot.emergency
    return {
        "schema_version": snapshot.schema_version,
        "state_revision": snapshot.state_revision,
        "callsign": snapshot.callsign,
        "phase": snapshot.phase,
        "on_ground": snapshot.on_ground,
        "nearest_airport": snapshot.nearest_airport.icao if snapshot.nearest_airport else None,
        "route": None if route is None else {
            "route_id": route.route_id,
            "status": route.status,
            "autopilot_engaged": route.autopilot_engaged,
            "destination_icao": route.destination.icao,
            "diverted": route.diverted,
        },
        "emergency": None if emergency is None else {
            "emergency_id": emergency.emergency_id,
            "type": emergency.type,
            "status": emergency.status,
            "completed_action_ids": sorted(item.action_id for item in emergency.actions if item.completed),
        },
        "conflicts": sorted(
            ({"conflict_id": item.conflict_id, "severity": item.severity.value} for item in snapshot.conflicts),
            key=lambda item: item["conflict_id"],
        ),
        "clearances": sorted(
            ({"clearance_id": item.clearance_id, "status": item.status} for item in snapshot.clearances),
            key=lambda item: item["clearance_id"],
        ),
        "alerts": sorted(
            (
                {
                    "alert_id": item.alert_id,
                    "severity": item.severity.value,
                    "acknowledged": item.acknowledged,
                }
                for item in snapshot.alerts
            ),
            key=lambda item: item["alert_id"],
        ),
    }


def _build_gateway_context(snapshot: Snapshot) -> tuple[GatewayContext, list[EvidenceRecord]]:
    """Build trusted advisory context exclusively from one cached snapshot."""

    snapshot_data = snapshot.model_dump(mode="json")
    preconditions = _gateway_preconditions(snapshot)
    source_id = f"snapshot:{snapshot.session_id}:{snapshot.sequence}:{snapshot.state_revision}"
    provenance = ProvenanceRecord(
        source_id=source_id,
        source_type="snapshot",
        authority="Smart ATC authoritative runtime",
        version=snapshot.schema_version,
        locator=f"runtime-snapshot/{snapshot.session_id}/{snapshot.sequence}",
        content_hash=canonical_content_hash(snapshot_data),
        observed_at=snapshot.observed_at,
        effective_at=snapshot.observed_at,
        expires_at=snapshot.server_time + timedelta(seconds=30),
    )
    context = GatewayContext(
        session_id=snapshot.session_id,
        current_sequence=snapshot.sequence,
        current_revision=snapshot.state_revision,
        snapshot=snapshot_data,
        preconditions=preconditions,
        evaluated_at=snapshot.server_time,
        provenance=[provenance],
    )
    evidence = EvidenceRecord(
        evidence_id=f"evidence:{snapshot.session_id}:{snapshot.sequence}:{snapshot.state_revision}",
        session_id=snapshot.session_id,
        observed_sequence=snapshot.sequence,
        observed_revision=snapshot.state_revision,
        claim="Authoritative cached flight state supports this advisory proposal evaluation.",
        source_ids=[source_id],
        data=preconditions,
    )
    return context, [evidence]


_GATEWAY_STATUS_CODES = {
    GatewayErrorCode.UNKNOWN_TOOL: 404,
    GatewayErrorCode.DIRECT_MUTATION_FORBIDDEN: 403,
    GatewayErrorCode.INJECTION_DETECTED: 400,
    GatewayErrorCode.SCHEMA_INVALID: 422,
    GatewayErrorCode.INVALID_CONTEXT: 409,
    GatewayErrorCode.EVIDENCE_REQUIRED: 422,
    GatewayErrorCode.PROVENANCE_REQUIRED: 422,
    GatewayErrorCode.VALIDATOR_FAILED: 409,
    GatewayErrorCode.STALE_PROPOSAL: 409,
    GatewayErrorCode.EXPIRED_PROPOSAL: 409,
}
_GATEWAY_ERROR_RESPONSES = {
    status_code: {"model": GatewayFailureResponse}
    for status_code in sorted(set(_GATEWAY_STATUS_CODES.values()))
}


def _gateway_public_details(rejection: GatewayRejection) -> dict[str, Any]:
    """Expose useful deterministic diagnostics without reflecting raw inputs."""

    details: dict[str, Any] = {}
    for key in (
        "reason", "current_sequence", "expiry_sequence", "based_on_revision", "current_revision",
    ):
        value = rejection.details.get(key)
        if isinstance(value, (str, int, float, bool)) or value is None:
            if key in rejection.details:
                details[key] = value
    errors = rejection.details.get("errors")
    if isinstance(errors, list):
        details["errors"] = [
            {
                "type": str(item.get("type", "validation_error"))[:100],
                "location": [str(part)[:100] for part in item.get("loc", ())[:12]],
                "message": str(item.get("msg", "Invalid value."))[:300],
            }
            for item in errors[:20]
            if isinstance(item, dict)
        ]
    validators = rejection.details.get("validator_results")
    if isinstance(validators, list):
        details["validator_results"] = [
            {
                "validator": str(item.get("validator", "gateway.validator"))[:100],
                "passed": bool(item.get("passed", False)),
                "severity": str(item.get("severity", "error"))[:20],
                "message": str(item.get("message", "Validation failed."))[:300],
            }
            for item in validators[:32]
            if isinstance(item, dict)
        ]
    return details


def _gateway_rejection_response(
    rejection: GatewayRejection,
    *,
    operation: str,
    tool_name: str | None = None,
    proposal_id: str | None = None,
) -> JSONResponse:
    fallback = deterministic_fallback(rejection)
    public_details = _gateway_public_details(rejection)
    failure = GatewayFailureResponse.model_validate({
        "error": {
            "code": rejection.code,
            "message": rejection.message,
            "details": public_details,
        },
        "fallback": fallback,
    })
    runtime.record_event("ai_gateway.rejected", {
        "operation": operation,
        "tool_name": tool_name,
        "proposal_id": proposal_id,
        "rejection_code": rejection.code.value,
        "fallback_id": fallback.fallback_id,
    })
    return JSONResponse(
        status_code=_GATEWAY_STATUS_CODES[rejection.code],
        content=failure.model_dump(mode="json"),
    )


def _require_gateway_mode(tool_name: str, expected: ToolMode) -> None:
    mode = _gateway_tool_modes.get(tool_name)
    if mode is not None and mode is not expected:
        raise GatewayRejection(
            GatewayErrorCode.DIRECT_MUTATION_FORBIDDEN,
            f"{tool_name} is not available through this advisory endpoint.",
            details={"reason": "wrong_gateway_mode"},
        )


def _reject_stale_ai_response(
    *,
    operation: Literal["chat", "scenario"],
    expected_session_id: str,
    expected_state_revision: int,
    reply: str,
    scenario_id: str | None = None,
) -> None:
    """Fail closed when delayed advisory text no longer matches authoritative state."""

    current_session_id = runtime.session_id
    current_state_revision = runtime.state_revision
    if (
        current_session_id == expected_session_id
        and current_state_revision == expected_state_revision
    ):
        return
    reasons: list[str] = []
    if current_session_id != expected_session_id:
        reasons.append("session_changed")
    if current_state_revision != expected_state_revision:
        reasons.append("state_revision_changed")
    runtime.record_event(f"{operation}.response_discarded", {
        "reason": reasons,
        "scenario_id": scenario_id,
        "expected_session_id": expected_session_id,
        "current_session_id": current_session_id,
        "expected_state_revision": expected_state_revision,
        "current_state_revision": current_state_revision,
        "reply_sha256": hashlib.sha256(reply.encode("utf-8", errors="replace")).hexdigest(),
        "reply_length": len(reply),
        "clearance_committed": False,
    })
    raise HTTPException(
        status_code=409,
        detail=(
            "The authoritative simulation state changed while the AI response was being generated; "
            "the stale response was discarded."
        ),
    )


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


@app.post("/training-sessions", response_model=TrainingSessionMetadata, status_code=201)
async def create_training_session(request: TrainingSessionCreateRequest):
    try:
        return await session_registry.create(request)
    except Exception as exc:
        _raise_training_session_http_error(exc)


@app.get("/training-sessions", response_model=TrainingSessionList)
async def list_training_sessions():
    return await session_registry.list()


@app.get("/training-sessions/{session_id}", response_model=TrainingSessionMetadata)
async def get_training_session(session_id: str):
    try:
        return await session_registry.metadata(session_id)
    except Exception as exc:
        _raise_training_session_http_error(exc)


@app.post("/training-sessions/{session_id}/touch", response_model=TrainingSessionMetadata)
async def touch_training_session(session_id: str):
    try:
        return await session_registry.touch(session_id)
    except Exception as exc:
        _raise_training_session_http_error(exc)


@app.delete("/training-sessions/{session_id}", status_code=204)
async def delete_training_session(session_id: str):
    try:
        await session_registry.delete(session_id)
    except Exception as exc:
        _raise_training_session_http_error(exc)
    return Response(status_code=204)


@app.get("/commands", response_model=CommandAuditPage)
async def list_commands(
    limit: int = Query(default=100, ge=1, le=500),
    status: str | None = Query(default=None, pattern=r"^(pending|succeeded|rejected)$"),
    operation: str | None = Query(default=None, min_length=1, max_length=100),
):
    return await _current_context().commands.list(limit=limit, status=status, operation=operation)


@app.get("/commands/idempotency/{idempotency_key}", response_model=CommandAuditRecord)
async def get_command_by_idempotency_key(idempotency_key: str):
    try:
        return await _current_context().commands.get_by_idempotency_key(idempotency_key)
    except CommandNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None


@app.get("/commands/{command_id}", response_model=CommandAuditRecord)
async def get_command(command_id: str):
    try:
        return await _current_context().commands.get(command_id)
    except CommandNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None


@app.get("/ai/gateway/catalog", response_model=GatewayCatalogResponse)
def get_ai_gateway_catalog():
    return GatewayCatalogResponse(policy=_gateway_policy(), tools=list(_gateway_catalog))


@app.get("/ai/gateway/policy", response_model=GatewayPolicyResponse)
def get_ai_gateway_policy():
    return _gateway_policy()


@app.post(
    "/ai/gateway/tools/read",
    response_model=ReadToolResult,
    responses=_GATEWAY_ERROR_RESPONSES,
)
async def invoke_ai_gateway_read(request: GatewayReadInvokeRequest):
    async with runtime.lock:
        snapshot = runtime.current_snapshot()
        context, _evidence = _build_gateway_context(snapshot)
        try:
            _require_gateway_mode(request.tool_name, ToolMode.READ)
            result = ai_gateway.invoke(
                tool_name=request.tool_name,
                arguments=request.arguments,
                context=context,
            )
            if not isinstance(result, ReadToolResult):
                raise GatewayRejection(
                    GatewayErrorCode.DIRECT_MUTATION_FORBIDDEN,
                    "Only allowlisted read tools are available through this endpoint.",
                    details={"reason": "wrong_gateway_mode"},
                )
            return result
        except GatewayRejection as exc:
            return _gateway_rejection_response(
                exc,
                operation="read",
                tool_name=request.tool_name,
            )


@app.post(
    "/ai/gateway/proposals",
    response_model=ActionProposal,
    responses=_GATEWAY_ERROR_RESPONSES,
)
async def create_ai_gateway_proposal(request: GatewayProposalCreateRequest):
    async with runtime.lock:
        snapshot = runtime.current_snapshot()
        context, evidence = _build_gateway_context(snapshot)
        try:
            _require_gateway_mode(request.tool_name, ToolMode.PROPOSAL)
            result = ai_gateway.invoke(
                tool_name=request.tool_name,
                arguments=request.arguments,
                context=context,
                evidence=evidence,
                provenance=context.provenance,
            )
            if not isinstance(result, ActionProposal):
                raise GatewayRejection(
                    GatewayErrorCode.DIRECT_MUTATION_FORBIDDEN,
                    "Read results cannot enter the proposal workflow.",
                    details={"reason": "wrong_gateway_mode"},
                )
            runtime.record_event("ai_gateway.proposed", {
                "proposal": result.model_dump(mode="json"),
                "advisory_only": True,
                "commit_performed": False,
            })
            return result
        except GatewayRejection as exc:
            return _gateway_rejection_response(
                exc,
                operation="propose",
                tool_name=request.tool_name,
            )


@app.post(
    "/ai/gateway/proposals/revalidate",
    response_model=ProposalRevalidation,
    responses=_GATEWAY_ERROR_RESPONSES,
)
async def revalidate_ai_gateway_proposal(request: GatewayProposalRevalidateRequest):
    proposal_id = request.proposal.get("proposal_id")
    tool_name = request.proposal.get("tool_name")
    async with runtime.lock:
        snapshot = runtime.current_snapshot()
        context, _evidence = _build_gateway_context(snapshot)
        try:
            result = ai_gateway.revalidate_proposal(request.proposal, context=context)
            runtime.record_event("ai_gateway.revalidated", {
                "revalidation": result.model_dump(mode="json"),
                "advisory_only": True,
                "commit_performed": False,
            })
            return result
        except GatewayRejection as exc:
            return _gateway_rejection_response(
                exc,
                operation="revalidate",
                tool_name=tool_name if isinstance(tool_name, str) else None,
                proposal_id=proposal_id if isinstance(proposal_id, str) else None,
            )


@app.get("/ai/gateway/evals/baseline", response_model=EvalMetrics)
def get_ai_gateway_baseline_metrics():
    return _gateway_baseline_metrics().model_copy(deep=True)


@app.get("/health")
def health():
    health_data = runtime.health()
    health_data["training_session_id"] = _current_context().session_id
    metrics = _gateway_baseline_metrics()
    health_data["ai_gateway"] = {
        "mode": "advisory_only",
        "policy_version": GATEWAY_POLICY_VERSION,
        "tool_count": len(_gateway_catalog),
        "read_tool_count": sum(item.mode is ToolMode.READ for item in _gateway_catalog),
        "proposal_tool_count": sum(item.mode is ToolMode.PROPOSAL for item in _gateway_catalog),
        "direct_commit_available": False,
        "baseline_eval": {
            "fixture_version": metrics.fixture_version,
            "total_cases": metrics.total_cases,
            "passed_cases": metrics.passed_cases,
            "pass_rate": metrics.pass_rate,
            "unauthorized_action_outputs": metrics.unauthorized_action_outputs,
            "unauthorized_action_rate": metrics.unauthorized_action_rate,
        },
    }
    return health_data


@app.get("/ready")
def ready():
    health_data = runtime.health()
    health_data["training_session_id"] = _current_context().session_id
    if not health_data["ready"]:
        raise HTTPException(status_code=503, detail="Authoritative snapshot loop is not ready.")
    return health_data


@app.get("/sim/state", response_model=Snapshot)
def sim_state():
    """Return the cached snapshot. Reads never advance phase or simulation."""
    return runtime.current_snapshot()


@app.get("/scenario/control", response_model=ScenarioControlState)
def get_scenario_control():
    return runtime.current_snapshot().scenario_control


async def _update_scenario_control(
    *,
    paused: bool | None = None,
    time_scale: float | None = None,
    event_type: str,
    operation: str,
    command: CommandRequestMetadata | None = None,
) -> dict:
    async def mutate(_command: CommandRequestMetadata) -> dict[str, Any]:
        runtime.set_control(paused=paused, time_scale=time_scale)
        snapshot = _publish_command_tick()
        return _event(event_type, {
            "control": snapshot.scenario_control.model_dump(mode="json"),
            "snapshot_sequence": snapshot.sequence,
        })

    return await _run_command(
        command,
        operation=operation,
        payload={"paused": paused, "time_scale": time_scale},
        executor=mutate,
    )


@app.post("/scenario/control", response_model=EventEnvelope)
async def update_scenario_control(request: ScenarioControlRequest):
    return await _update_scenario_control(
        paused=request.paused,
        time_scale=request.time_scale,
        event_type="scenario.control_updated",
        operation="scenario.control.update",
        command=request.command,
    )


@app.post("/scenario/pause", response_model=EventEnvelope)
async def pause_scenario(request: CommandOnlyRequest | None = None):
    return await _update_scenario_control(
        paused=True,
        event_type="scenario.paused",
        operation="scenario.pause",
        command=request.command if request else None,
    )


@app.post("/scenario/resume", response_model=EventEnvelope)
async def resume_scenario(request: CommandOnlyRequest | None = None):
    return await _update_scenario_control(
        paused=False,
        event_type="scenario.resumed",
        operation="scenario.resume",
        command=request.command if request else None,
    )


@app.post("/scenario/time-scale", response_model=EventEnvelope)
async def set_scenario_time_scale(request: ScenarioTimeScaleRequest):
    return await _update_scenario_control(
        time_scale=request.time_scale,
        event_type="scenario.time_scale_changed",
        operation="scenario.time_scale.set",
        command=request.command,
    )


@app.get("/sessions", response_model=list[JournalSessionSummary])
def list_journal_sessions(limit: int = Query(default=20, ge=1, le=100)):
    return runtime.journal.list_sessions(limit=limit)


@app.get("/sessions/{session_id}", response_model=JournalSessionSummary)
def get_journal_session(session_id: str):
    try:
        return runtime.journal.session(session_id)
    except Exception as exc:
        _raise_journal_http_error(exc)


@app.get("/sessions/{session_id}/events", response_model=JournalEventPage)
def list_journal_events(
    session_id: str,
    after_event_sequence: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=1_000),
    event_type: str | None = Query(default=None, min_length=1, max_length=80),
):
    try:
        return runtime.journal.events(
            session_id,
            after_event_sequence=after_event_sequence,
            limit=limit,
            event_type=event_type,
        )
    except Exception as exc:
        _raise_journal_http_error(exc)


@app.get("/sessions/{session_id}/replay", response_model=JournalReplayResponse)
def replay_journal_session(
    session_id: str,
    from_event_sequence: int = Query(default=1, ge=1),
    to_event_sequence: int | None = Query(default=None, ge=1),
    after_event_sequence: int = Query(default=0, ge=0),
    limit: int = Query(default=500, ge=1, le=2_000),
):
    try:
        return runtime.journal.replay(
            session_id,
            from_event_sequence=from_event_sequence,
            to_event_sequence=to_event_sequence,
            after_event_sequence=after_event_sequence,
            limit=limit,
        )
    except Exception as exc:
        _raise_journal_http_error(exc)


@app.get("/sessions/{session_id}/export", response_model=JournalExport)
def export_journal_session(session_id: str):
    try:
        exported = runtime.journal.export(session_id)
    except Exception as exc:
        _raise_journal_http_error(exc)
    safe_session_id = re.sub(r"[^A-Za-z0-9_-]", "_", session_id)[:64]
    return Response(
        content=exported.model_dump_json(indent=2),
        media_type="application/vnd.smart-atc.session+json",
        headers={"Content-Disposition": f'attachment; filename="smart-atc-{safe_session_id}.json"'},
    )


@app.get("/sessions/{session_id}/bookmarks", response_model=list[TimelineBookmark])
def list_timeline_bookmarks(session_id: str):
    try:
        return runtime.journal.list_bookmarks(session_id)
    except Exception as exc:
        _raise_journal_http_error(exc)


@app.post("/sessions/{session_id}/bookmarks", response_model=TimelineBookmark, status_code=201)
def create_timeline_bookmark(session_id: str, request: BookmarkCreateRequest):
    if (
        session_id == runtime.session_id
        and request.event_id is None
        and request.event_sequence is None
        and request.snapshot_sequence is None
    ):
        request = request.model_copy(update={"snapshot_sequence": runtime.sequence})
    try:
        return runtime.journal.create_bookmark(session_id, request)
    except Exception as exc:
        _raise_journal_http_error(exc)


@app.patch("/sessions/{session_id}/bookmarks/{bookmark_id}", response_model=TimelineBookmark)
def update_timeline_bookmark(session_id: str, bookmark_id: str, request: BookmarkUpdateRequest):
    try:
        return runtime.journal.update_bookmark(session_id, bookmark_id, request)
    except Exception as exc:
        _raise_journal_http_error(exc)


@app.delete("/sessions/{session_id}/bookmarks/{bookmark_id}", status_code=204)
def delete_timeline_bookmark(session_id: str, bookmark_id: str):
    try:
        runtime.journal.delete_bookmark(session_id, bookmark_id)
    except Exception as exc:
        _raise_journal_http_error(exc)
    return Response(status_code=204)


@app.websocket("/ws/state")
async def ws_state(websocket: WebSocket):
    configured = os.getenv("ATC_API_KEY")
    supplied = websocket.headers.get("X-API-Key", "")
    if configured:
        import secrets
        if not secrets.compare_digest(supplied, configured):
            await websocket.close(code=4401)
            return
    header_session_id = websocket.headers.get("X-Session-ID")
    query_session_id = websocket.query_params.get("session_id")
    if header_session_id and query_session_id and header_session_id.strip() != query_session_id.strip():
        await websocket.close(code=4400, reason="X-Session-ID and session_id query parameter must match.")
        return
    try:
        context = await session_registry.acquire_websocket(header_session_id or query_session_id)
    except InvalidTrainingSessionId as exc:
        await websocket.close(code=4400, reason=str(exc))
        return
    except TrainingSessionNotFound as exc:
        await websocket.close(code=4404, reason=str(exc))
        return
    except TrainingSessionQuotaExceeded as exc:
        await websocket.close(code=4429, reason=str(exc))
        return

    token = _training_context.set(context)
    selected_runtime = context.runtime
    queue = selected_runtime.subscribe()
    try:
        await websocket.accept(headers=[
            (b"x-session-id", context.session_id.encode("ascii")),
            (b"x-runtime-session-id", selected_runtime.session_id.encode("ascii")),
        ])
        await websocket.send_text(selected_runtime.current_json)
        while True:
            await websocket.send_text(await queue.get())
    except WebSocketDisconnect:
        pass
    finally:
        selected_runtime.unsubscribe(queue)
        _training_context.reset(token)
        await session_registry.release_websocket(context)


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
    async def mutate(_command: CommandRequestMetadata) -> dict[str, Any]:
        try:
            route = runtime.route.create(request, runtime.catalog, runtime.state)
        except AirportResolutionError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        runtime.set_control(time_scale=request.time_scale)
        if request.callsign:
            runtime.callsign = request.callsign
            brain.set_callsign(request.callsign)
        runtime.traffic.reset_around(runtime.state["lat"], runtime.state["lon"], runtime.state["altitude"])
        snapshot = _publish_command_tick()
        return _event("route.created", {
            "route": route.model_dump(mode="json"),
            "snapshot": snapshot.model_dump(mode="json"),
        })

    return await _run_command(
        request.command,
        operation="route.create",
        payload=_command_payload(request),
        executor=mutate,
    )


@app.post("/routes/demo", response_model=EventEnvelope)
async def start_demo_route(request: RouteDemoRequest):
    return await _start_route(request)


@app.post("/route/start", include_in_schema=False)
async def start_route_alias(request: RouteDemoRequest):
    return await _start_route(request)


@app.post("/demo/route", include_in_schema=False)
async def demo_route_alias(request: RouteDemoRequest):
    return await _start_route(request)


@app.post("/routes/{route_id}/engage", response_model=EventEnvelope)
async def engage_route(route_id: str, request: CommandOnlyRequest | None = None):
    async def mutate(_command: CommandRequestMetadata) -> dict[str, Any]:
        if route_id != runtime.route.route_id:
            raise HTTPException(status_code=404, detail="Route not found.")
        runtime.route.engage()
        snapshot = _publish_command_tick()
        return _event("route.engaged", {"route": snapshot.route.model_dump(mode="json") if snapshot.route else None})

    return await _run_command(
        request.command if request else None,
        operation="route.engage",
        payload={"route_id": route_id},
        executor=mutate,
    )


@app.post("/routes/{route_id}/cancel", response_model=EventEnvelope)
async def cancel_route(route_id: str, request: CommandOnlyRequest | None = None):
    async def mutate(_command: CommandRequestMetadata) -> dict[str, Any]:
        if route_id != runtime.route.route_id:
            raise HTTPException(status_code=404, detail="Route not found.")
        runtime.route.cancel()
        runtime.engine.reset_targets()
        snapshot = _publish_command_tick()
        return _event("route.cancelled", {"route": snapshot.route.model_dump(mode="json") if snapshot.route else None})

    return await _run_command(
        request.command if request else None,
        operation="route.cancel",
        payload={"route_id": route_id},
        executor=mutate,
    )


@app.get("/emergencies/catalog")
def emergency_catalog():
    return {"emergencies": list(runtime.emergencies.catalog.values())}


@app.post("/emergencies/activate", response_model=EventEnvelope)
async def activate_emergency(request: EmergencyActivateRequest):
    async def mutate(_command: CommandRequestMetadata) -> dict[str, Any]:
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

    return await _run_command(
        request.command,
        operation="emergency.activate",
        payload=_command_payload(request),
        executor=mutate,
    )


async def _complete_emergency_action(emergency_id: str | None, action_id: str, request: ActionCompleteRequest) -> dict:
    async def mutate(_command: CommandRequestMetadata) -> dict[str, Any]:
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

    return await _run_command(
        request.command,
        operation="emergency.action.update",
        payload=_command_payload(request, emergency_id=emergency_id, action_id=action_id),
        executor=mutate,
    )


@app.post("/emergencies/{emergency_id}/actions/{action_id}/complete", response_model=EventEnvelope)
async def complete_emergency_action(emergency_id: str, action_id: str, request: ActionCompleteRequest):
    return await _complete_emergency_action(emergency_id, action_id, request)


@app.post("/emergency/actions/{action_id}/complete", include_in_schema=False)
async def complete_emergency_action_alias(action_id: str, request: ActionCompleteRequest):
    return await _complete_emergency_action(None, action_id, request)


async def _resolve_emergency(emergency_id: str | None, request: EmergencyResolveRequest | None) -> dict:
    async def mutate(_command: CommandRequestMetadata) -> dict[str, Any]:
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

    return await _run_command(
        request.command if request else None,
        operation="emergency.resolve",
        payload=_command_payload(request, emergency_id=emergency_id),
        executor=mutate,
    )


@app.post("/emergencies/{emergency_id}/resolve", response_model=EventEnvelope)
async def resolve_emergency_by_id(emergency_id: str, request: EmergencyResolveRequest | None = None):
    return await _resolve_emergency(emergency_id, request)


@app.post("/emergency/resolve", response_model=EventEnvelope)
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


async def _set_alert_acknowledgement(
    alert_id: str,
    *,
    acknowledged: bool,
    actor: str,
) -> AlertAcknowledgementResponse:
    async with runtime.lock:
        try:
            acknowledgement, changed = runtime.set_alert_acknowledgement(
                alert_id,
                acknowledged=acknowledged,
                actor=actor,
            )
        except KeyError:
            raise HTTPException(status_code=404, detail="Active alert not found.") from None
        event = None
        if changed:
            snapshot = _publish_command_tick()
            event_type = "alert.acknowledged" if acknowledged else "alert.unacknowledged"
            event = runtime.record_event(event_type, {
                "alert_id": alert_id,
                "acknowledged": acknowledged,
                "actor": actor,
                "acknowledgement": acknowledgement.model_dump(mode="json"),
            }).event
        else:
            snapshot = runtime.current_snapshot()
        alert = next((item for item in snapshot.alerts if item.alert_id == alert_id), None)
        if not alert:  # defensive: the authoritative alert disappeared during recomposition
            raise HTTPException(status_code=409, detail="Alert is no longer active.")
        return AlertAcknowledgementResponse(
            acknowledgement=acknowledgement,
            alert=alert,
            changed=changed,
            event=event,
            snapshot_sequence=snapshot.sequence,
        )


@app.post("/alerts/{alert_id}/ack", response_model=AlertAcknowledgementResponse)
async def acknowledge_alert(alert_id: str, request: AlertAcknowledgementRequest | None = None):
    return await _set_alert_acknowledgement(
        alert_id,
        acknowledged=True,
        actor=request.actor if request else "operator",
    )


@app.post("/alerts/{alert_id}/unack", response_model=AlertAcknowledgementResponse)
async def unacknowledge_alert(alert_id: str, request: AlertAcknowledgementRequest | None = None):
    return await _set_alert_acknowledgement(
        alert_id,
        acknowledged=False,
        actor=request.actor if request else "operator",
    )


@app.get("/clearances")
def list_clearances():
    return {"clearances": [item.model_dump(mode="json") for item in runtime.clearances.list()]}


@app.post("/clearances/{clearance_id}/accept", response_model=EventEnvelope)
async def accept_clearance(clearance_id: str, request: ClearanceAcceptRequest):
    async def mutate(_command: CommandRequestMetadata) -> dict[str, Any]:
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

    return await _run_command(
        request.command,
        operation="clearance.accept",
        payload=_command_payload(request, clearance_id=clearance_id),
        executor=mutate,
    )


@app.post("/callsign", response_model=EventEnvelope)
async def set_callsign(request: CallsignRequest):
    async def mutate(_command: CommandRequestMetadata) -> dict[str, Any]:
        runtime.callsign = request.callsign
        brain.set_callsign(request.callsign)
        _publish_command_tick()
        return _event("callsign.updated", {"callsign": runtime.callsign})

    return await _run_command(
        request.command,
        operation="callsign.set",
        payload=_command_payload(request),
        executor=mutate,
    )


@app.post("/chat")
async def chat(request: ChatRequest):
    async with runtime.lock:
        extracted = _extract_callsign(request.message)
        state_changed = False
        if extracted and not runtime.callsign:
            runtime.callsign = extracted
            brain.set_callsign(extracted)
            state_changed = True

        pilot_request = runtime.clearances.record_request(request.message, runtime.callsign)
        state_changed = state_changed or pilot_request is not None
        inferred = _infer_emergency(request.message)
        emergency = None
        if inferred and (not runtime.emergencies.active or runtime.emergencies.active.status == "resolved"):
            emergency = runtime.emergencies.activate(inferred, runtime.state, runtime.catalog, request.message[:500])
            runtime.active_scenario = emergency.title
            brain.set_scenario(emergency.title, emergency.summary)
            state_changed = True

        if state_changed:
            _publish_command_tick()
        snapshot = runtime.current_snapshot()
        request_session_id = snapshot.session_id
        request_state_revision = snapshot.state_revision
        if pilot_request:
            runtime.record_event("pilot.requested", {
                "request": pilot_request.model_dump(mode="json"),
            })
        if emergency:
            runtime.record_event("emergency.activated", {
                "emergency": emergency.model_dump(mode="json"),
                "source": "pilot_message",
            })
    phase = {"phase": snapshot.phase, "phase_label": snapshot.phase_label, "vertical_rate": snapshot.vertical_rate}
    async with _current_context().brain_lock:
        reply = await brain.chat(request.message, snapshot.model_dump(mode="json"), phase)
        async with runtime.lock:
            _reject_stale_ai_response(
                operation="chat",
                expected_session_id=request_session_id,
                expected_state_revision=request_state_revision,
                reply=reply,
            )
            brain.commit_exchange(request.message, reply)
            issued = runtime.clearances.issue_from_atc(reply, runtime.callsign)
            if issued:
                _publish_command_tick()
                runtime.record_event("clearance.issued", {"clearance": issued.model_dump(mode="json")})
            updated = runtime.current_snapshot()
            runtime.record_event("chat.responded", {
                "reply": reply,
                "clearance_id": issued.clearance_id if issued else None,
            })
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
    kind = None if request.scenario_id == "ground_taxi" else SCENARIO_ALIASES.get(request.scenario_id)
    if request.scenario_id != "ground_taxi" and not kind:
        raise HTTPException(status_code=404, detail="Unknown scenario.")
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
            assert kind is not None
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
        request_session_id = snapshot.session_id
        request_state_revision = snapshot.state_revision
        runtime.record_event("scenario.loaded", {
            "scenario_id": request.scenario_id,
            "scenario": runtime.active_scenario or "Normal ground operations",
            "initial_message": initial,
            "emergency_id": snapshot.emergency.emergency_id if snapshot.emergency else None,
        })
    phase = {"phase": snapshot.phase, "phase_label": snapshot.phase_label, "vertical_rate": snapshot.vertical_rate}
    async with _current_context().brain_lock:
        reply = await brain.chat(initial, snapshot.model_dump(mode="json"), phase)
        async with runtime.lock:
            _reject_stale_ai_response(
                operation="scenario",
                expected_session_id=request_session_id,
                expected_state_revision=request_state_revision,
                reply=reply,
                scenario_id=request.scenario_id,
            )
            brain.commit_exchange(initial, reply)
            issued = runtime.clearances.issue_from_atc(reply, runtime.callsign)
            if issued:
                _publish_command_tick()
                runtime.record_event("clearance.issued", {"clearance": issued.model_dump(mode="json")})
            snapshot = runtime.current_snapshot()
            runtime.record_event("scenario.atc_responded", {
                "scenario_id": request.scenario_id,
                "reply": reply,
                "clearance_id": issued.clearance_id if issued else None,
            })
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


async def _reset_session(command: CommandRequestMetadata | None = None) -> dict:
    async def mutate(_command: CommandRequestMetadata) -> dict[str, Any]:
        brain.reset()
        snapshot = runtime.reset()
        return _event("session.reset", {"status": "Session reset", "snapshot": snapshot.model_dump(mode="json")})

    return await _run_command(
        command,
        operation="session.reset",
        payload={},
        executor=mutate,
    )


@app.post("/session/reset", response_model=EventEnvelope)
async def reset_session_post(request: CommandOnlyRequest | None = None):
    return await _reset_session(request.command if request else None)


@app.get("/session/reset", include_in_schema=False)
async def reset_session_get():
    raise HTTPException(
        status_code=410,
        detail="GET /session/reset no longer mutates state; use POST /session/reset.",
        headers={
            "Allow": "POST",
            "Deprecation": "true",
            "Link": '</session/reset>; rel="successor-version"',
        },
    )


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
