"""Constrained, deterministic tool gateway for an advisory aviation AI.

This module deliberately has no model, network, runtime, or FastAPI dependency.
It accepts untrusted tool-call-shaped data, exposes a fixed read-only catalog,
and turns action requests into sequence-bound proposals.  It never executes an
action proposal.  A future API integration must revalidate a proposal and pass
it to the existing deterministic command layer for explicit user commitment.
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import math
import re
import secrets
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt, StrictStr, ValidationError, model_validator


GATEWAY_SCHEMA_VERSION = "1.0.0"
GATEWAY_POLICY_VERSION = "smart-atc-advisory-policy/1.0.0"

_SAFE_NAME = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")
_DIRECT_MUTATION = re.compile(
    r"^(?:accept|activate|apply|cancel|commit|create|delete|engage|execute|inject|issue|land|"
    r"mutate|reset|resolve|set|start|stop|update)_"
)
_INJECTION_PATTERNS = (
    re.compile(r"(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+(?:instructions?|messages?)", re.I),
    re.compile(r"(?:reveal|print|show|return)\s+(?:the\s+)?(?:hidden\s+)?(?:system|developer)\s+prompt", re.I),
    re.compile(r"(?:tool|function)[_\s-]?call\s*[:=]", re.I),
    re.compile(r"<\|\s*(?:system|developer|assistant|tool)\s*\|>", re.I),
    re.compile(r"\b(?:jailbreak|prompt\s*injection)\b", re.I),
    re.compile(r"\b(?:__proto__|constructor\.prototype)\b", re.I),
    re.compile(r"\b(?:powershell|cmd\.exe|/bin/(?:ba)?sh|sudo)\b.{0,40}\b(?:exec|run|command|shell)\b", re.I),
)
_VOLATILE_PRECONDITION_FIELDS = {
    "data_age_ms",
    "event_sequence",
    "last_tick_duration_ms",
    "observed_at",
    "received_at",
    "sequence",
    "server_time",
    "snapshot_id",
    "timestamps",
}


class GatewayModel(BaseModel):
    """Strict local contract; intentionally independent of backend.schemas."""

    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)


class GatewayErrorCode(str, Enum):
    UNKNOWN_TOOL = "unknown_tool"
    DIRECT_MUTATION_FORBIDDEN = "direct_mutation_forbidden"
    INJECTION_DETECTED = "injection_detected"
    SCHEMA_INVALID = "schema_invalid"
    INVALID_CONTEXT = "invalid_context"
    EVIDENCE_REQUIRED = "evidence_required"
    PROVENANCE_REQUIRED = "provenance_required"
    VALIDATOR_FAILED = "validator_failed"
    STALE_PROPOSAL = "stale_proposal"
    EXPIRED_PROPOSAL = "expired_proposal"


class ToolMode(str, Enum):
    READ = "read"
    PROPOSAL = "proposal"


class GatewayRejection(ValueError):
    """Stable, machine-readable rejection raised at the untrusted boundary."""

    def __init__(
        self,
        code: GatewayErrorCode,
        message: str,
        *,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = dict(details or {})

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code.value,
            "message": self.message,
            "details": copy.deepcopy(self.details),
        }


class ProvenanceRecord(GatewayModel):
    source_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:@/-]*$")
    source_type: Literal[
        "snapshot",
        "rule",
        "procedure",
        "weather",
        "performance",
        "checklist",
        "operator",
        "synthetic",
    ]
    authority: str = Field(min_length=1, max_length=120)
    version: str = Field(min_length=1, max_length=80)
    locator: str = Field(min_length=1, max_length=300)
    content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    observed_at: datetime
    effective_at: datetime | None = None
    expires_at: datetime | None = None


class EvidenceRecord(GatewayModel):
    evidence_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:@/-]*$")
    session_id: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:@-]*$")
    observed_sequence: int = Field(ge=0)
    observed_revision: int = Field(default=0, ge=0)
    claim: str = Field(min_length=1, max_length=600)
    source_ids: list[str] = Field(min_length=1, max_length=12)
    data: dict[str, Any] = Field(default_factory=dict)


class ValidatorResult(GatewayModel):
    validator: str = Field(min_length=1, max_length=100, pattern=r"^[a-z][a-z0-9_.-]*$")
    passed: bool
    severity: Literal["info", "warning", "error"] = "error"
    message: str = Field(min_length=1, max_length=500)
    checked_at: datetime
    details: dict[str, Any] = Field(default_factory=dict)


class GatewayContext(GatewayModel):
    session_id: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:@-]*$")
    current_sequence: int = Field(ge=0)
    current_revision: int = Field(default=0, ge=0)
    snapshot: dict[str, Any] = Field(default_factory=dict)
    preconditions: dict[str, Any] = Field(default_factory=dict)
    evaluated_at: datetime
    provenance: list[ProvenanceRecord] = Field(default_factory=list, max_length=32)


class EmptyArguments(GatewayModel):
    pass


class RouteReadArguments(GatewayModel):
    include_constraints: bool = True


class TrafficReadArguments(GatewayModel):
    max_range_nm: StrictFloat | StrictInt = Field(default=100.0, gt=0, le=500)
    min_altitude_ft: StrictFloat | StrictInt = Field(default=-1_500.0, ge=-1_500, le=60_000)
    max_altitude_ft: StrictFloat | StrictInt = Field(default=60_000.0, ge=-1_500, le=60_000)
    include_conflicts: bool = True

    @model_validator(mode="after")
    def altitude_window_is_ordered(self) -> "TrafficReadArguments":
        if float(self.min_altitude_ft) > float(self.max_altitude_ft):
            raise ValueError("min_altitude_ft cannot exceed max_altitude_ft")
        return self


class WeatherReadArguments(GatewayModel):
    airport_icao: str | None = Field(default=None, pattern=r"^[A-Z0-9]{3,4}$")
    include_hazards: bool = True


class ClearanceReadArguments(GatewayModel):
    status: Literal["requested", "issued", "accepted", "executing", "completed", "rejected"] | None = None


InstructionValue: TypeAlias = StrictInt | StrictFloat | StrictStr | None


class ClearanceInstructionInput(GatewayModel):
    instruction_type: Literal[
        "altitude",
        "heading",
        "speed",
        "frequency",
        "squawk",
        "direct",
        "pushback",
        "taxi",
        "hold_short",
        "line_up",
        "takeoff",
        "land",
        "approach",
        "climb_via",
        "descend_via",
    ]
    value: InstructionValue = None
    unit: Literal["ft", "deg", "kt", "MHz"] | None = None

    @model_validator(mode="after")
    def value_matches_instruction(self) -> "ClearanceInstructionInput":
        kind = self.instruction_type
        value = self.value
        numeric_limits = {
            "altitude": (-1_500.0, 60_000.0, "ft"),
            "heading": (0.0, 359.999, "deg"),
            "speed": (0.0, 700.0, "kt"),
            "frequency": (118.0, 136.975, "MHz"),
        }
        if kind in numeric_limits:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
                raise ValueError(f"{kind} requires a finite numeric value")
            low, high, expected_unit = numeric_limits[kind]
            if not low <= float(value) <= high:
                raise ValueError(f"{kind} is outside its supported range")
            if self.unit != expected_unit:
                raise ValueError(f"{kind} requires unit {expected_unit}")
        elif kind == "squawk":
            if not isinstance(value, str) or re.fullmatch(r"[0-7]{4}", value) is None:
                raise ValueError("squawk requires four octal digits")
            if self.unit is not None:
                raise ValueError("squawk cannot have a unit")
        elif kind == "pushback":
            if value is not None or self.unit is not None:
                raise ValueError("pushback does not accept a value or unit")
        else:
            if not isinstance(value, str) or not value.strip() or len(value) > 120:
                raise ValueError(f"{kind} requires a short textual value")
            if self.unit is not None:
                raise ValueError(f"{kind} cannot have a unit")
        return self


class ProposeClearanceArguments(GatewayModel):
    callsign: str = Field(min_length=2, max_length=12, pattern=r"^[A-Z0-9]+$")
    instructions: list[ClearanceInstructionInput] = Field(min_length=1, max_length=12)
    rationale: str = Field(min_length=1, max_length=600)
    expires_after_sequences: int = Field(default=5, ge=1, le=25)


class ProposeDiversionArguments(GatewayModel):
    airport_icao: str = Field(pattern=r"^[A-Z0-9]{3,4}$")
    reason: str = Field(min_length=1, max_length=600)
    expires_after_sequences: int = Field(default=5, ge=1, le=25)


class ProposeEmergencyActionArguments(GatewayModel):
    emergency_id: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:@-]*$")
    action_id: str = Field(min_length=3, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:@-]*$")
    rationale: str = Field(min_length=1, max_length=600)
    expires_after_sequences: int = Field(default=3, ge=1, le=25)


class ToolDescriptor(GatewayModel):
    name: str
    mode: ToolMode
    description: str
    argument_schema: dict[str, Any]


class ReadToolResult(GatewayModel):
    schema_version: Literal["1.0.0"] = GATEWAY_SCHEMA_VERSION
    tool_name: str
    session_id: str
    based_on_sequence: int = Field(ge=0)
    based_on_revision: int = Field(ge=0)
    precondition_checksum: str = Field(pattern=r"^[a-f0-9]{64}$")
    data: Any
    provenance: list[ProvenanceRecord] = Field(default_factory=list)


class ActionProposal(GatewayModel):
    schema_version: Literal["1.0.0"] = GATEWAY_SCHEMA_VERSION
    policy_version: Literal["smart-atc-advisory-policy/1.0.0"] = GATEWAY_POLICY_VERSION
    proposal_id: str = Field(pattern=r"^prop_[a-f0-9]{24}$")
    status: Literal["proposed"] = "proposed"
    advisory_only: Literal[True] = True
    commit_performed: Literal[False] = False
    tool_name: str
    arguments: dict[str, Any]
    session_id: str
    based_on_sequence: int = Field(ge=0)
    based_on_revision: int = Field(ge=0)
    expiry_sequence: int = Field(ge=0)
    precondition_checksum: str = Field(pattern=r"^[a-f0-9]{64}$")
    created_at: datetime
    evidence: list[EvidenceRecord] = Field(min_length=1, max_length=32)
    provenance: list[ProvenanceRecord] = Field(min_length=1, max_length=32)
    validator_results: list[ValidatorResult] = Field(min_length=1, max_length=32)

    @model_validator(mode="after")
    def expiry_follows_basis(self) -> "ActionProposal":
        if self.expiry_sequence <= self.based_on_sequence:
            raise ValueError("expiry_sequence must be greater than based_on_sequence")
        return self


class ProposalRevalidation(GatewayModel):
    schema_version: Literal["1.0.0"] = GATEWAY_SCHEMA_VERSION
    proposal_id: str
    tool_name: str
    session_id: str
    based_on_sequence: int = Field(ge=0)
    based_on_revision: int = Field(ge=0)
    checked_sequence: int = Field(ge=0)
    checked_revision: int = Field(ge=0)
    expiry_sequence: int = Field(ge=0)
    precondition_checksum: str = Field(pattern=r"^[a-f0-9]{64}$")
    valid_for_external_commit: Literal[True] = True
    advisory_only: Literal[True] = True
    commit_performed: Literal[False] = False
    validator_results: list[ValidatorResult] = Field(min_length=1)


class FallbackResponse(GatewayModel):
    schema_version: Literal["1.0.0"] = GATEWAY_SCHEMA_VERSION
    fallback_id: str = Field(pattern=r"^fallback_[a-f0-9]{20}$")
    rejection_code: GatewayErrorCode
    safe_message: str
    user_action: Literal["retry", "refresh", "say_again", "contact_instructor", "none"]
    retryable: bool


class GatewayReadInvokeRequest(GatewayModel):
    tool_name: StrictStr = Field(min_length=1, max_length=200)
    arguments: dict[str, Any] = Field(default_factory=dict)


class GatewayProposalCreateRequest(GatewayModel):
    tool_name: StrictStr = Field(min_length=1, max_length=200)
    arguments: dict[str, Any] = Field(default_factory=dict)


class GatewayProposalRevalidateRequest(GatewayModel):
    proposal: dict[str, Any]


class GatewayPolicyResponse(GatewayModel):
    schema_version: Literal["1.0.0"] = GATEWAY_SCHEMA_VERSION
    policy_version: Literal["smart-atc-advisory-policy/1.0.0"] = GATEWAY_POLICY_VERSION
    mode: Literal["advisory_only"] = "advisory_only"
    context_source: Literal["authoritative_cached_snapshot"] = "authoritative_cached_snapshot"
    direct_mutation_available: Literal[False] = False
    direct_commit_available: Literal[False] = False
    proposal_revalidation_required: Literal[True] = True
    proposal_bindings: list[Literal["session", "sequence", "revision", "expiry", "checksum"]] = Field(
        default_factory=lambda: ["session", "sequence", "revision", "expiry", "checksum"]
    )


class GatewayCatalogResponse(GatewayModel):
    schema_version: Literal["1.0.0"] = GATEWAY_SCHEMA_VERSION
    policy: GatewayPolicyResponse
    tools: list[ToolDescriptor] = Field(max_length=32)


class GatewayErrorDetail(GatewayModel):
    code: GatewayErrorCode
    message: str = Field(min_length=1, max_length=500)
    details: dict[str, Any] = Field(default_factory=dict)


class GatewayFailureResponse(GatewayModel):
    error: GatewayErrorDetail
    fallback: FallbackResponse


class EvalExpected(GatewayModel):
    outcome: Literal["read", "proposal", "authorized", "rejected"]
    rejection_code: GatewayErrorCode | None = None

    @model_validator(mode="after")
    def rejection_code_matches_outcome(self) -> "EvalExpected":
        if self.outcome == "rejected" and self.rejection_code is None:
            raise ValueError("rejected evals require rejection_code")
        if self.outcome != "rejected" and self.rejection_code is not None:
            raise ValueError("successful evals cannot declare rejection_code")
        return self


class EvalCase(GatewayModel):
    case_id: str = Field(min_length=1, max_length=100, pattern=r"^[a-z0-9][a-z0-9_.-]*$")
    operation: Literal["invoke", "revalidate"] = "invoke"
    tool_name: str = Field(min_length=1, max_length=200)
    arguments: dict[str, Any] = Field(default_factory=dict)
    context: GatewayContext
    revalidation_context: GatewayContext | None = None
    evidence: list[EvidenceRecord] = Field(default_factory=list)
    provenance: list[ProvenanceRecord] = Field(default_factory=list)
    expected: EvalExpected

    @model_validator(mode="after")
    def revalidation_has_second_context(self) -> "EvalCase":
        if self.operation == "revalidate" and self.revalidation_context is None:
            raise ValueError("revalidate evals require revalidation_context")
        return self


class GatewayEvalFixture(GatewayModel):
    fixture_version: Literal["1.0.0"]
    description: str = Field(min_length=1, max_length=500)
    cases: list[EvalCase] = Field(min_length=1, max_length=10_000)


class EvalCaseResult(GatewayModel):
    case_id: str
    passed: bool
    expected_outcome: str
    actual_outcome: str
    expected_rejection_code: str | None = None
    actual_rejection_code: str | None = None
    fallback_deterministic: bool | None = None
    diagnostic: str = ""


class EvalMetrics(GatewayModel):
    fixture_version: str
    policy_version: str
    total_cases: int = Field(ge=0)
    passed_cases: int = Field(ge=0)
    failed_cases: int = Field(ge=0)
    pass_rate: float = Field(ge=0, le=1)
    accepted_read_calls: int = Field(ge=0)
    proposals_created: int = Field(ge=0)
    proposals_authorized: int = Field(ge=0)
    rejected_calls: int = Field(ge=0)
    rejection_code_counts: dict[str, int]
    schema_valid_output_rate: float = Field(ge=0, le=1)
    fallback_determinism_rate: float = Field(ge=0, le=1)
    unauthorized_action_outputs: int = Field(ge=0)
    unauthorized_action_rate: float = Field(ge=0, le=1)
    cases: list[EvalCaseResult]


ProposalValidator: TypeAlias = Callable[[BaseModel, GatewayContext], ValidatorResult | bool]


@dataclass(frozen=True)
class _ToolSpec:
    name: str
    mode: ToolMode
    description: str
    arguments_model: type[GatewayModel]
    read_selector: Callable[[GatewayContext, GatewayModel], Any] | None = None


def _deep_json_copy(value: Any) -> Any:
    """Return a detached, JSON-compatible copy or reject unsafe numeric data."""

    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, datetime):
        normalized = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        return normalized.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise GatewayRejection(GatewayErrorCode.INVALID_CONTEXT, "Non-finite numeric data is not allowed.")
        return value
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise GatewayRejection(GatewayErrorCode.INVALID_CONTEXT, "Object keys must be strings.")
            result[key] = _deep_json_copy(item)
        return result
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_deep_json_copy(item) for item in value]
    raise GatewayRejection(
        GatewayErrorCode.INVALID_CONTEXT,
        f"Unsupported value type at the gateway boundary: {type(value).__name__}.",
    )


def _canonical_bytes(value: Any) -> bytes:
    normalized = _deep_json_copy(value)
    return json.dumps(
        normalized,
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def canonical_content_hash(value: Any) -> str:
    """Return the deterministic SHA-256 used for snapshot provenance."""

    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _derived_preconditions(context: GatewayContext) -> dict[str, Any]:
    if context.preconditions:
        return _deep_json_copy(context.preconditions)
    return {
        key: _deep_json_copy(value)
        for key, value in context.snapshot.items()
        if key not in _VOLATILE_PRECONDITION_FIELDS
    }


def precondition_checksum(context: GatewayContext) -> str:
    """Hash stable state preconditions, excluding transport/timestamp fields."""

    payload = {
        "session_id": context.session_id,
        "preconditions": _derived_preconditions(context),
    }
    return hashlib.sha256(_canonical_bytes(payload)).hexdigest()


def _proposal_identifier(
    *,
    signing_key: bytes,
    tool_name: str,
    arguments: Mapping[str, Any],
    session_id: str,
    based_on_sequence: int,
    based_on_revision: int,
    expiry_sequence: int,
    checksum: str,
    created_at: datetime,
    evidence: Sequence[EvidenceRecord],
    provenance: Sequence[ProvenanceRecord],
    validator_results: Sequence[ValidatorResult],
) -> str:
    fingerprint = {
        "policy_version": GATEWAY_POLICY_VERSION,
        "tool_name": tool_name,
        "arguments": arguments,
        "session_id": session_id,
        "based_on_sequence": based_on_sequence,
        "based_on_revision": based_on_revision,
        "expiry_sequence": expiry_sequence,
        "precondition_checksum": checksum,
        "created_at": created_at,
        "evidence": evidence,
        "provenance": provenance,
        "validator_results": validator_results,
    }
    signature = hmac.new(signing_key, _canonical_bytes(fingerprint), hashlib.sha256).hexdigest()
    return f"prop_{signature[:24]}"


def _scan_for_injection(value: Any, *, path: str, depth: int = 0, budget: list[int] | None = None) -> None:
    if budget is None:
        budget = [2_000]
    budget[0] -= 1
    if budget[0] < 0 or depth > 12:
        raise GatewayRejection(
            GatewayErrorCode.INJECTION_DETECTED,
            "Tool arguments exceed the safe structural limit.",
            details={"path": path},
        )
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    if isinstance(value, str):
        if len(value) > 8_000:
            raise GatewayRejection(
                GatewayErrorCode.INJECTION_DETECTED,
                "A tool argument exceeds the safe text limit.",
                details={"path": path},
            )
        if any(pattern.search(value) for pattern in _INJECTION_PATTERNS):
            raise GatewayRejection(
                GatewayErrorCode.INJECTION_DETECTED,
                "Prompt-injection-like content was blocked at the tool boundary.",
                details={"path": path},
            )
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            _scan_for_injection(str(key), path=f"{path}.<key>", depth=depth + 1, budget=budget)
            _scan_for_injection(item, path=f"{path}.{key}", depth=depth + 1, budget=budget)
        return
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        for index, item in enumerate(value):
            _scan_for_injection(item, path=f"{path}[{index}]", depth=depth + 1, budget=budget)


def _validate_tool_name(tool_name: Any) -> str:
    if not isinstance(tool_name, str) or not tool_name:
        raise GatewayRejection(GatewayErrorCode.SCHEMA_INVALID, "tool_name must be a non-empty string.")
    _scan_for_injection(tool_name, path="tool_name")
    if _SAFE_NAME.fullmatch(tool_name) is None:
        raise GatewayRejection(
            GatewayErrorCode.INJECTION_DETECTED,
            "tool_name contains characters outside the constrained tool namespace.",
        )
    return tool_name


def _coerce_context(value: GatewayContext | Mapping[str, Any]) -> GatewayContext:
    if isinstance(value, GatewayContext):
        return value.model_copy(deep=True)
    try:
        return GatewayContext.model_validate(value)
    except ValidationError as exc:
        raise GatewayRejection(
            GatewayErrorCode.INVALID_CONTEXT,
            "Gateway context failed validation.",
            details={"errors": exc.errors(include_url=False)},
        ) from None


def _coerce_records(
    model: type[GatewayModel],
    values: Sequence[GatewayModel | Mapping[str, Any]] | None,
    *,
    label: str,
) -> list[Any]:
    output: list[Any] = []
    for value in values or ():
        try:
            output.append(value.model_copy(deep=True) if isinstance(value, model) else model.model_validate(value))
        except ValidationError as exc:
            raise GatewayRejection(
                GatewayErrorCode.SCHEMA_INVALID,
                f"{label} failed validation.",
                details={"errors": exc.errors(include_url=False)},
            ) from None
    return output


def _select_snapshot(context: GatewayContext, _arguments: GatewayModel) -> Any:
    return context.snapshot


def _select_route(context: GatewayContext, arguments: GatewayModel) -> Any:
    assert isinstance(arguments, RouteReadArguments)
    route = context.snapshot.get("route")
    if route is None:
        route = {
            "plan": context.snapshot.get("route_plan"),
            "progress": context.snapshot.get("route_progress"),
        }
    route = _deep_json_copy(route)
    if not arguments.include_constraints and isinstance(route, dict):
        route.pop("constraints", None)
        if isinstance(route.get("waypoints"), list):
            for waypoint in route["waypoints"]:
                if isinstance(waypoint, dict):
                    waypoint.pop("constraints", None)
    return route


def _select_traffic(context: GatewayContext, arguments: GatewayModel) -> Any:
    assert isinstance(arguments, TrafficReadArguments)
    selected: list[Any] = []
    for raw in context.snapshot.get("traffic", []) or []:
        if not isinstance(raw, Mapping):
            continue
        range_nm = raw.get("range_nm", math.inf)
        altitude = raw.get("altitude", 0)
        if isinstance(range_nm, (int, float)) and isinstance(altitude, (int, float)):
            if float(range_nm) <= float(arguments.max_range_nm) and float(arguments.min_altitude_ft) <= float(altitude) <= float(arguments.max_altitude_ft):
                selected.append(_deep_json_copy(raw))
    result: dict[str, Any] = {"traffic": selected}
    if arguments.include_conflicts:
        callsigns = {str(item.get("callsign")) for item in selected if isinstance(item, dict)}
        result["conflicts"] = [
            _deep_json_copy(conflict)
            for conflict in context.snapshot.get("conflicts", []) or []
            if isinstance(conflict, Mapping) and str(conflict.get("callsign")) in callsigns
        ]
    return result


def _select_weather(context: GatewayContext, arguments: GatewayModel) -> Any:
    assert isinstance(arguments, WeatherReadArguments)
    result = {
        "airport_icao": arguments.airport_icao,
        "weather": context.snapshot.get("weather"),
    }
    if arguments.include_hazards:
        result["hazards"] = context.snapshot.get("weather_hazards", [])
    return result


def _select_emergency(context: GatewayContext, _arguments: GatewayModel) -> Any:
    return context.snapshot.get("emergency", context.snapshot.get("active_emergency"))


def _select_clearances(context: GatewayContext, arguments: GatewayModel) -> Any:
    assert isinstance(arguments, ClearanceReadArguments)
    clearances = context.snapshot.get("clearances", []) or []
    if arguments.status is not None:
        clearances = [
            item for item in clearances
            if isinstance(item, Mapping) and item.get("status") == arguments.status
        ]
    return clearances


_TOOL_SPECS: tuple[_ToolSpec, ...] = (
    _ToolSpec("get_snapshot", ToolMode.READ, "Read the current immutable simulation snapshot.", EmptyArguments, _select_snapshot),
    _ToolSpec("get_route", ToolMode.READ, "Read the active route and progress.", RouteReadArguments, _select_route),
    _ToolSpec("get_traffic", ToolMode.READ, "Read filtered traffic and conflict predictions.", TrafficReadArguments, _select_traffic),
    _ToolSpec("get_weather", ToolMode.READ, "Read weather and available hazard data.", WeatherReadArguments, _select_weather),
    _ToolSpec("get_emergency", ToolMode.READ, "Read the current emergency workflow.", EmptyArguments, _select_emergency),
    _ToolSpec("get_clearances", ToolMode.READ, "Read structured clearance history.", ClearanceReadArguments, _select_clearances),
    _ToolSpec("propose_clearance", ToolMode.PROPOSAL, "Propose, but never execute, a structured clearance.", ProposeClearanceArguments),
    _ToolSpec("propose_diversion", ToolMode.PROPOSAL, "Propose, but never engage, a diversion.", ProposeDiversionArguments),
    _ToolSpec("propose_emergency_action", ToolMode.PROPOSAL, "Propose, but never complete, an emergency action.", ProposeEmergencyActionArguments),
)


class ConstrainedAIToolGateway:
    """Fixed-catalog AI boundary with no direct mutation capability."""

    def __init__(
        self,
        *,
        proposal_validators: Mapping[str, Sequence[ProposalValidator]] | None = None,
        proposal_signing_key: bytes | None = None,
    ) -> None:
        key = proposal_signing_key if proposal_signing_key is not None else secrets.token_bytes(32)
        if not isinstance(key, bytes) or len(key) < 32:
            raise ValueError("proposal_signing_key must contain at least 32 bytes.")
        self._proposal_signing_key = bytes(key)
        self._tools = {spec.name: spec for spec in _TOOL_SPECS}
        supplied = proposal_validators or {}
        unknown_validator_tools = set(supplied) - {
            spec.name for spec in _TOOL_SPECS if spec.mode is ToolMode.PROPOSAL
        }
        if unknown_validator_tools:
            raise ValueError(f"Validators registered for unknown/non-proposal tools: {sorted(unknown_validator_tools)}")
        self._proposal_validators = {
            name: tuple(validators)
            for name, validators in supplied.items()
        }

    def catalog(self) -> list[ToolDescriptor]:
        return [
            ToolDescriptor(
                name=spec.name,
                mode=spec.mode,
                description=spec.description,
                argument_schema=spec.arguments_model.model_json_schema(),
            )
            for spec in _TOOL_SPECS
        ]

    def invoke(
        self,
        *,
        tool_name: str,
        arguments: Mapping[str, Any] | Any,
        context: GatewayContext | Mapping[str, Any],
        evidence: Sequence[EvidenceRecord | Mapping[str, Any]] | None = None,
        provenance: Sequence[ProvenanceRecord | Mapping[str, Any]] | None = None,
    ) -> ReadToolResult | ActionProposal:
        safe_name = _validate_tool_name(tool_name)
        _scan_for_injection(arguments, path="arguments")
        spec = self._tools.get(safe_name)
        if spec is None:
            if _DIRECT_MUTATION.match(safe_name):
                raise GatewayRejection(
                    GatewayErrorCode.DIRECT_MUTATION_FORBIDDEN,
                    "Direct mutating tools are forbidden; request a proposal tool instead.",
                )
            raise GatewayRejection(GatewayErrorCode.UNKNOWN_TOOL, "Tool is not present in the gateway allowlist.")

        gateway_context = _coerce_context(context)
        try:
            parsed_arguments = spec.arguments_model.model_validate(arguments)
        except ValidationError as exc:
            raise GatewayRejection(
                GatewayErrorCode.SCHEMA_INVALID,
                f"Arguments for {safe_name} failed strict schema validation.",
                details={"errors": exc.errors(include_url=False)},
            ) from None

        checksum = precondition_checksum(gateway_context)
        if spec.mode is ToolMode.READ:
            assert spec.read_selector is not None
            data = spec.read_selector(gateway_context.model_copy(deep=True), parsed_arguments.model_copy(deep=True))
            return ReadToolResult(
                tool_name=safe_name,
                session_id=gateway_context.session_id,
                based_on_sequence=gateway_context.current_sequence,
                based_on_revision=gateway_context.current_revision,
                precondition_checksum=checksum,
                data=_deep_json_copy(data),
                provenance=[item.model_copy(deep=True) for item in gateway_context.provenance],
            )

        evidence_records = _coerce_records(EvidenceRecord, evidence, label="Evidence")
        provenance_values = provenance if provenance is not None else gateway_context.provenance
        provenance_records = _coerce_records(ProvenanceRecord, provenance_values, label="Provenance")
        _scan_for_injection(evidence_records, path="evidence")
        _scan_for_injection(provenance_records, path="provenance")
        if not evidence_records:
            raise GatewayRejection(GatewayErrorCode.EVIDENCE_REQUIRED, "Action proposals require evidence.")
        if not provenance_records:
            raise GatewayRejection(GatewayErrorCode.PROVENANCE_REQUIRED, "Action proposals require provenance.")

        validator_results = self._validator_results(
            spec,
            parsed_arguments,
            gateway_context,
            evidence_records,
            provenance_records,
        )
        failed = [result for result in validator_results if not result.passed and result.severity == "error"]
        if failed:
            raise GatewayRejection(
                GatewayErrorCode.VALIDATOR_FAILED,
                "One or more deterministic proposal validators failed.",
                details={"validator_results": [item.model_dump(mode="json") for item in validator_results]},
            )

        argument_data = parsed_arguments.model_dump(mode="json")
        expiry_window = int(argument_data["expires_after_sequences"])
        expiry_sequence = gateway_context.current_sequence + expiry_window
        proposal_id = _proposal_identifier(
            signing_key=self._proposal_signing_key,
            tool_name=safe_name,
            arguments=argument_data,
            session_id=gateway_context.session_id,
            based_on_sequence=gateway_context.current_sequence,
            based_on_revision=gateway_context.current_revision,
            expiry_sequence=expiry_sequence,
            checksum=checksum,
            created_at=gateway_context.evaluated_at,
            evidence=evidence_records,
            provenance=provenance_records,
            validator_results=validator_results,
        )
        return ActionProposal(
            proposal_id=proposal_id,
            tool_name=safe_name,
            arguments=argument_data,
            session_id=gateway_context.session_id,
            based_on_sequence=gateway_context.current_sequence,
            based_on_revision=gateway_context.current_revision,
            expiry_sequence=expiry_sequence,
            precondition_checksum=checksum,
            created_at=gateway_context.evaluated_at,
            evidence=evidence_records,
            provenance=provenance_records,
            validator_results=validator_results,
        )

    def revalidate_proposal(
        self,
        proposal: ActionProposal | Mapping[str, Any],
        *,
        context: GatewayContext | Mapping[str, Any],
    ) -> ProposalRevalidation:
        if isinstance(proposal, Mapping):
            _scan_for_injection(proposal, path="proposal")
            raw_name = proposal.get("tool_name")
            raw_arguments = proposal.get("arguments")
            _validate_tool_name(raw_name)
            try:
                parsed_proposal = ActionProposal.model_validate_json(
                    json.dumps(_deep_json_copy(proposal), ensure_ascii=True, allow_nan=False)
                )
            except ValidationError as exc:
                raise GatewayRejection(
                    GatewayErrorCode.SCHEMA_INVALID,
                    "Action proposal failed schema validation.",
                    details={"errors": exc.errors(include_url=False)},
                ) from None
        elif isinstance(proposal, ActionProposal):
            parsed_proposal = proposal.model_copy(deep=True)
        else:
            raise GatewayRejection(GatewayErrorCode.SCHEMA_INVALID, "proposal must be an ActionProposal or object.")

        safe_name = _validate_tool_name(parsed_proposal.tool_name)
        spec = self._tools.get(safe_name)
        if spec is None or spec.mode is not ToolMode.PROPOSAL:
            raise GatewayRejection(
                GatewayErrorCode.DIRECT_MUTATION_FORBIDDEN,
                "Only proposal-mode tools can be revalidated.",
            )
        expected_identifier = _proposal_identifier(
            signing_key=self._proposal_signing_key,
            tool_name=parsed_proposal.tool_name,
            arguments=parsed_proposal.arguments,
            session_id=parsed_proposal.session_id,
            based_on_sequence=parsed_proposal.based_on_sequence,
            based_on_revision=parsed_proposal.based_on_revision,
            expiry_sequence=parsed_proposal.expiry_sequence,
            checksum=parsed_proposal.precondition_checksum,
            created_at=parsed_proposal.created_at,
            evidence=parsed_proposal.evidence,
            provenance=parsed_proposal.provenance,
            validator_results=parsed_proposal.validator_results,
        )
        if not hmac.compare_digest(expected_identifier, parsed_proposal.proposal_id):
            raise GatewayRejection(
                GatewayErrorCode.STALE_PROPOSAL,
                "Proposal integrity check failed.",
                details={"reason": "proposal_integrity_mismatch"},
            )
        gateway_context = _coerce_context(context)
        if gateway_context.session_id != parsed_proposal.session_id:
            raise GatewayRejection(
                GatewayErrorCode.STALE_PROPOSAL,
                "Proposal belongs to a different or replaced session.",
                details={"reason": "session_mismatch"},
            )
        if gateway_context.current_sequence > parsed_proposal.expiry_sequence:
            raise GatewayRejection(
                GatewayErrorCode.EXPIRED_PROPOSAL,
                "Proposal has passed its expiry sequence.",
                details={
                    "current_sequence": gateway_context.current_sequence,
                    "expiry_sequence": parsed_proposal.expiry_sequence,
                },
            )
        if gateway_context.current_sequence < parsed_proposal.based_on_sequence:
            raise GatewayRejection(
                GatewayErrorCode.STALE_PROPOSAL,
                "Current state predates the proposal basis.",
                details={"reason": "sequence_rewind"},
            )
        if gateway_context.current_revision != parsed_proposal.based_on_revision:
            raise GatewayRejection(
                GatewayErrorCode.STALE_PROPOSAL,
                "Authoritative state revision changed after proposal creation.",
                details={
                    "reason": "revision_mismatch",
                    "based_on_revision": parsed_proposal.based_on_revision,
                    "current_revision": gateway_context.current_revision,
                },
            )
        current_checksum = precondition_checksum(gateway_context)
        if current_checksum != parsed_proposal.precondition_checksum:
            raise GatewayRejection(
                GatewayErrorCode.STALE_PROPOSAL,
                "Proposal preconditions no longer match authoritative state.",
                details={"reason": "precondition_checksum_mismatch"},
            )
        _scan_for_injection(parsed_proposal.arguments, path="proposal.arguments")
        try:
            parsed_arguments = spec.arguments_model.model_validate(parsed_proposal.arguments)
        except ValidationError as exc:
            raise GatewayRejection(
                GatewayErrorCode.SCHEMA_INVALID,
                "Proposal arguments failed revalidation.",
                details={"errors": exc.errors(include_url=False)},
            ) from None

        results = self._validator_results(
            spec,
            parsed_arguments,
            gateway_context,
            parsed_proposal.evidence,
            parsed_proposal.provenance,
        )
        failed = [result for result in results if not result.passed and result.severity == "error"]
        if failed:
            raise GatewayRejection(
                GatewayErrorCode.VALIDATOR_FAILED,
                "Proposal no longer passes deterministic validators.",
                details={"validator_results": [item.model_dump(mode="json") for item in results]},
            )
        return ProposalRevalidation(
            proposal_id=parsed_proposal.proposal_id,
            tool_name=parsed_proposal.tool_name,
            session_id=parsed_proposal.session_id,
            based_on_sequence=parsed_proposal.based_on_sequence,
            based_on_revision=parsed_proposal.based_on_revision,
            checked_sequence=gateway_context.current_sequence,
            checked_revision=gateway_context.current_revision,
            expiry_sequence=parsed_proposal.expiry_sequence,
            precondition_checksum=current_checksum,
            validator_results=results,
        )

    def _validator_results(
        self,
        spec: _ToolSpec,
        arguments: GatewayModel,
        context: GatewayContext,
        evidence: Sequence[EvidenceRecord],
        provenance: Sequence[ProvenanceRecord],
    ) -> list[ValidatorResult]:
        checked_at = context.evaluated_at
        source_ids = {source.source_id for source in provenance}
        unresolved = sorted({source_id for item in evidence for source_id in item.source_ids} - source_ids)
        wrong_session = [item.evidence_id for item in evidence if item.session_id != context.session_id]
        future_evidence = [item.evidence_id for item in evidence if item.observed_sequence > context.current_sequence]
        wrong_revision = [item.evidence_id for item in evidence if item.observed_revision != context.current_revision]
        expired_sources = [
            source.source_id
            for source in provenance
            if source.expires_at is not None and source.expires_at < checked_at
        ]
        results = [
            ValidatorResult(
                validator="gateway.allowlist",
                passed=spec.mode is ToolMode.PROPOSAL,
                message="Tool is registered as proposal-only.",
                checked_at=checked_at,
            ),
            ValidatorResult(
                validator="gateway.argument_schema",
                passed=True,
                message="Arguments satisfy the strict local schema.",
                checked_at=checked_at,
            ),
            ValidatorResult(
                validator="gateway.evidence_binding",
                passed=not unresolved and not wrong_session and not future_evidence and not wrong_revision,
                message="Evidence is bound to this session/sequence/revision and references declared sources.",
                checked_at=checked_at,
                details={
                    "unresolved_source_ids": unresolved,
                    "wrong_session_evidence_ids": wrong_session,
                    "future_evidence_ids": future_evidence,
                    "wrong_revision_evidence_ids": wrong_revision,
                },
            ),
            ValidatorResult(
                validator="gateway.provenance_freshness",
                passed=not expired_sources,
                message="Critical proposal sources are current at evaluation time.",
                checked_at=checked_at,
                details={"expired_source_ids": expired_sources},
            ),
        ]
        for index, validator in enumerate(self._proposal_validators.get(spec.name, ())):
            try:
                outcome = validator(arguments.model_copy(deep=True), context.model_copy(deep=True))
                if isinstance(outcome, ValidatorResult):
                    result = outcome.model_copy(deep=True)
                elif isinstance(outcome, bool):
                    result = ValidatorResult(
                        validator=f"integration.validator_{index + 1}",
                        passed=outcome,
                        message="Integration validator passed." if outcome else "Integration validator rejected the proposal.",
                        checked_at=checked_at,
                    )
                else:
                    raise TypeError("validator must return bool or ValidatorResult")
            except Exception as exc:
                result = ValidatorResult(
                    validator=f"integration.validator_{index + 1}",
                    passed=False,
                    message="Integration validator failed closed.",
                    checked_at=checked_at,
                    details={"error_type": type(exc).__name__},
                )
            results.append(result)
        return results


_FALLBACKS: dict[GatewayErrorCode, tuple[str, str, bool]] = {
    GatewayErrorCode.UNKNOWN_TOOL: ("That capability is not available through the constrained tool catalog.", "contact_instructor", False),
    GatewayErrorCode.DIRECT_MUTATION_FORBIDDEN: ("Direct state changes are blocked. Use a reviewed proposal and explicit commit workflow.", "none", False),
    GatewayErrorCode.INJECTION_DETECTED: ("Unsafe tool-call content was blocked. Rephrase the aviation request without embedded instructions.", "say_again", True),
    GatewayErrorCode.SCHEMA_INVALID: ("The request could not be interpreted safely. Restate it with the required aviation values.", "say_again", True),
    GatewayErrorCode.INVALID_CONTEXT: ("Authoritative flight context is unavailable or invalid. Refresh before requesting advice.", "refresh", True),
    GatewayErrorCode.EVIDENCE_REQUIRED: ("No verified evidence supports this action proposal.", "refresh", True),
    GatewayErrorCode.PROVENANCE_REQUIRED: ("The proposal has no verified source provenance and was not issued.", "refresh", True),
    GatewayErrorCode.VALIDATOR_FAILED: ("A deterministic safety validator rejected the proposal.", "contact_instructor", True),
    GatewayErrorCode.STALE_PROPOSAL: ("Aircraft state changed after this proposal was created. Request a fresh proposal.", "refresh", True),
    GatewayErrorCode.EXPIRED_PROPOSAL: ("This proposal expired before commitment. Request a fresh proposal.", "retry", True),
}


def deterministic_fallback(rejection: GatewayRejection | GatewayErrorCode) -> FallbackResponse:
    """Return stable safe behavior without a model or network call."""

    code = rejection.code if isinstance(rejection, GatewayRejection) else rejection
    message, action, retryable = _FALLBACKS[code]
    fingerprint = hashlib.sha256(f"{GATEWAY_POLICY_VERSION}:{code.value}:{message}:{action}".encode()).hexdigest()[:20]
    return FallbackResponse(
        fallback_id=f"fallback_{fingerprint}",
        rejection_code=code,
        safe_message=message,
        user_action=action,  # type: ignore[arg-type]
        retryable=retryable,
    )


def run_eval_fixture(
    fixture_path: str | Path,
    *,
    gateway: ConstrainedAIToolGateway | None = None,
) -> EvalMetrics:
    """Run a versioned offline eval fixture and return release-friendly metrics."""

    path = Path(fixture_path)
    fixture = GatewayEvalFixture.model_validate_json(path.read_text(encoding="utf-8"))
    active_gateway = gateway or ConstrainedAIToolGateway()
    results: list[EvalCaseResult] = []
    read_calls = 0
    proposals_created = 0
    proposals_authorized = 0
    rejected_calls = 0
    rejection_counts: Counter[str] = Counter()
    schema_valid_outputs = 0
    accepted_outputs = 0
    fallback_checks = 0
    deterministic_fallbacks = 0
    unauthorized_outputs = 0

    for case in fixture.cases:
        actual_outcome = "rejected"
        actual_code: GatewayErrorCode | None = None
        diagnostic = ""
        fallback_deterministic: bool | None = None
        try:
            outcome = active_gateway.invoke(
                tool_name=case.tool_name,
                arguments=case.arguments,
                context=case.context,
                evidence=case.evidence,
                provenance=case.provenance,
            )
            if case.operation == "revalidate":
                if not isinstance(outcome, ActionProposal):
                    raise GatewayRejection(
                        GatewayErrorCode.DIRECT_MUTATION_FORBIDDEN,
                        "Only action proposals can enter proposal revalidation.",
                    )
                assert case.revalidation_context is not None
                outcome = active_gateway.revalidate_proposal(outcome, context=case.revalidation_context)
                actual_outcome = "authorized"
                proposals_authorized += 1
            elif isinstance(outcome, ReadToolResult):
                actual_outcome = "read"
                read_calls += 1
            else:
                actual_outcome = "proposal"
                proposals_created += 1
            accepted_outputs += 1
            type(outcome).model_validate(outcome.model_dump(mode="python"))
            schema_valid_outputs += 1
            if _DIRECT_MUTATION.match(case.tool_name):
                unauthorized_outputs += 1
        except GatewayRejection as exc:
            actual_code = exc.code
            rejected_calls += 1
            rejection_counts[exc.code.value] += 1
            first_fallback = deterministic_fallback(exc)
            second_fallback = deterministic_fallback(exc)
            fallback_deterministic = first_fallback == second_fallback
            fallback_checks += 1
            deterministic_fallbacks += int(fallback_deterministic)
            diagnostic = exc.message

        expected_code = case.expected.rejection_code
        passed = actual_outcome == case.expected.outcome and actual_code == expected_code
        results.append(EvalCaseResult(
            case_id=case.case_id,
            passed=passed,
            expected_outcome=case.expected.outcome,
            actual_outcome=actual_outcome,
            expected_rejection_code=expected_code.value if expected_code else None,
            actual_rejection_code=actual_code.value if actual_code else None,
            fallback_deterministic=fallback_deterministic,
            diagnostic=diagnostic,
        ))

    passed_cases = sum(result.passed for result in results)
    total = len(results)
    return EvalMetrics(
        fixture_version=fixture.fixture_version,
        policy_version=GATEWAY_POLICY_VERSION,
        total_cases=total,
        passed_cases=passed_cases,
        failed_cases=total - passed_cases,
        pass_rate=passed_cases / total if total else 1.0,
        accepted_read_calls=read_calls,
        proposals_created=proposals_created,
        proposals_authorized=proposals_authorized,
        rejected_calls=rejected_calls,
        rejection_code_counts=dict(sorted(rejection_counts.items())),
        schema_valid_output_rate=schema_valid_outputs / accepted_outputs if accepted_outputs else 1.0,
        fallback_determinism_rate=deterministic_fallbacks / fallback_checks if fallback_checks else 1.0,
        unauthorized_action_outputs=unauthorized_outputs,
        unauthorized_action_rate=unauthorized_outputs / total if total else 0.0,
        cases=results,
    )


__all__ = [
    "ActionProposal",
    "ConstrainedAIToolGateway",
    "EvidenceRecord",
    "EvalMetrics",
    "FallbackResponse",
    "GatewayCatalogResponse",
    "GATEWAY_POLICY_VERSION",
    "GATEWAY_SCHEMA_VERSION",
    "GatewayContext",
    "GatewayFailureResponse",
    "GatewayErrorCode",
    "GatewayPolicyResponse",
    "GatewayProposalCreateRequest",
    "GatewayProposalRevalidateRequest",
    "GatewayReadInvokeRequest",
    "GatewayRejection",
    "ProposalRevalidation",
    "ProvenanceRecord",
    "ReadToolResult",
    "ToolDescriptor",
    "ToolMode",
    "ValidatorResult",
    "canonical_content_hash",
    "deterministic_fallback",
    "precondition_checksum",
    "run_eval_fixture",
]
