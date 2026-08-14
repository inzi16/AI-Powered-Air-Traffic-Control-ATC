"""Strict API contracts for the authoritative ATC simulation runtime."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


SCHEMA_VERSION = "3.0.0"


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class SourceKind(str, Enum):
    DEMO = "demo"
    SIMCONNECT = "simconnect"


class Severity(str, Enum):
    INFO = "info"
    CAUTION = "caution"
    WARNING = "warning"
    CRITICAL = "critical"


class SnapshotMetadata(ApiModel):
    schema_version: Literal["3.0.0"] = SCHEMA_VERSION
    session_id: str = Field(min_length=8, max_length=64)
    sequence: int = Field(ge=0)
    state_revision: int = Field(
        ge=0,
        description="Semantic room revision; changes only when a mutation commits.",
    )
    snapshot_id: str = Field(min_length=8, max_length=128)
    observed_at: datetime
    server_time: datetime
    source: SourceKind
    data_age_ms: int = Field(ge=0)


class EventMetadata(ApiModel):
    schema_version: Literal["3.0.0"] = SCHEMA_VERSION
    event_id: str = Field(min_length=8, max_length=64)
    event_type: str = Field(min_length=1, max_length=80)
    session_id: str = Field(min_length=8, max_length=64)
    sequence: int = Field(ge=0, description="Snapshot sequence on which the event was based")
    state_revision: int = Field(ge=0)
    event_sequence: int = Field(ge=1)
    observed_at: datetime
    server_time: datetime
    source: SourceKind
    data_age_ms: int = Field(ge=0)


class CommandRequestMetadata(ApiModel):
    command_id: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
    idempotency_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
    expected_sequence: int = Field(ge=0)
    expected_revision: int = Field(
        ge=0,
        description="Semantic state_revision observed with expected_sequence.",
    )
    issued_at: datetime
    expires_at: datetime
    actor: str = Field(min_length=1, max_length=100)

    @field_validator("issued_at", "expires_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Command timestamps must include a UTC offset.")
        return value

    @field_validator("actor")
    @classmethod
    def normalize_actor(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Actor must not be blank.")
        return value

    @model_validator(mode="after")
    def validate_expiry_window(self):
        if self.expires_at <= self.issued_at:
            raise ValueError("expires_at must be later than issued_at.")
        if (self.expires_at - self.issued_at).total_seconds() > 86_400:
            raise ValueError("Command expiry window must not exceed 24 hours.")
        return self


class CommandOnlyRequest(ApiModel):
    command: CommandRequestMetadata | None = None


class CommandReceipt(ApiModel):
    command_id: str
    idempotency_key: str
    operation: str
    expected_sequence: int = Field(ge=0)
    expected_revision: int = Field(ge=0)
    sequence_before: int = Field(ge=0)
    sequence_after: int = Field(ge=0)
    revision_before: int = Field(ge=0)
    revision_after: int = Field(ge=0)
    issued_at: datetime
    expires_at: datetime
    executed_at: datetime
    actor: str
    legacy: bool
    deduplicated: bool
    status: Literal["succeeded"] = "succeeded"


class CommandAuditRecord(ApiModel):
    command: CommandRequestMetadata
    operation: str = Field(min_length=1, max_length=100)
    payload_checksum: str = Field(pattern=r"^[a-f0-9]{64}$")
    status: Literal["pending", "succeeded", "rejected"]
    legacy: bool
    deduplicated_count: int = Field(ge=0)
    received_at: datetime
    completed_at: datetime | None = None
    sequence_before: int = Field(ge=0)
    sequence_after: int | None = Field(default=None, ge=0)
    revision_before: int = Field(ge=0)
    revision_after: int | None = Field(default=None, ge=0)
    response_event_id: str | None = None
    error_code: str | None = None
    error_detail: str | None = None


class CommandAuditPage(ApiModel):
    commands: list[CommandAuditRecord]
    retained_count: int = Field(ge=0)
    max_retained: int = Field(ge=1)


class EventEnvelope(ApiModel):
    event: EventMetadata
    data: dict[str, Any] = Field(default_factory=dict)
    command: CommandReceipt | None = None


class ScenarioControlState(ApiModel):
    session_id: str = Field(min_length=8, max_length=64)
    status: Literal["running", "paused"]
    paused: bool
    time_scale: float = Field(ge=0.25, le=120.0)
    simulation_time_seconds: float = Field(ge=0)
    changed_at: datetime
    snapshot_sequence: int = Field(ge=0)


class ScenarioControlRequest(ApiModel):
    paused: bool | None = None
    time_scale: float | None = Field(default=None, ge=0.25, le=120.0)
    command: CommandRequestMetadata | None = None

    @model_validator(mode="after")
    def require_change(self):
        if self.paused is None and self.time_scale is None:
            raise ValueError("At least one of paused or time_scale is required.")
        return self


class ScenarioTimeScaleRequest(ApiModel):
    time_scale: float = Field(ge=0.25, le=120.0)
    command: CommandRequestMetadata | None = None


class JournalEventRecord(ApiModel):
    metadata: EventMetadata
    snapshot_sequence: int = Field(ge=0)
    simulation_time_seconds: float = Field(ge=0)
    recorded_at: datetime
    state_checksum: str = Field(pattern=r"^[a-f0-9]{64}$")
    payload_size_bytes: int = Field(ge=0)
    payload_truncated: bool = False
    payload: dict[str, Any] = Field(default_factory=dict)


class JournalCheckpoint(ApiModel):
    checkpoint_id: str = Field(min_length=8, max_length=64)
    session_id: str = Field(min_length=8, max_length=64)
    event_sequence: int = Field(ge=0)
    snapshot_sequence: int = Field(ge=0)
    simulation_time_seconds: float = Field(ge=0)
    created_at: datetime
    state_checksum: str = Field(pattern=r"^[a-f0-9]{64}$")
    state: dict[str, Any]


class TimelineBookmark(ApiModel):
    bookmark_id: str = Field(min_length=8, max_length=64)
    session_id: str = Field(min_length=8, max_length=64)
    event_id: str | None = Field(default=None, min_length=8, max_length=64)
    event_sequence: int | None = Field(default=None, ge=1)
    snapshot_sequence: int = Field(ge=0)
    title: str = Field(min_length=1, max_length=120)
    annotation: str = Field(default="", max_length=4000)
    category: Literal["bookmark", "incident", "training", "review"] = "bookmark"
    tags: list[str] = Field(default_factory=list, max_length=20)
    created_by: str = Field(default="operator", min_length=1, max_length=80)
    created_at: datetime
    updated_at: datetime


class BookmarkCreateRequest(ApiModel):
    event_id: str | None = Field(default=None, min_length=8, max_length=64)
    event_sequence: int | None = Field(default=None, ge=1)
    snapshot_sequence: int | None = Field(default=None, ge=0)
    title: str = Field(min_length=1, max_length=120)
    annotation: str = Field(default="", max_length=4000)
    category: Literal["bookmark", "incident", "training", "review"] = "bookmark"
    tags: list[str] = Field(default_factory=list, max_length=20)
    created_by: str = Field(default="operator", min_length=1, max_length=80)

    @field_validator("title", "created_by")
    @classmethod
    def normalize_required_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Value must not be blank.")
        return value

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, values: list[str]) -> list[str]:
        normalized: list[str] = []
        for value in values:
            tag = value.strip().lower()
            if not tag or len(tag) > 40:
                raise ValueError("Tags must contain 1-40 characters.")
            if tag not in normalized:
                normalized.append(tag)
        return normalized


class BookmarkUpdateRequest(ApiModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    annotation: str | None = Field(default=None, max_length=4000)
    category: Literal["bookmark", "incident", "training", "review"] | None = None
    tags: list[str] | None = Field(default=None, max_length=20)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("Title must not be blank.")
        return value

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, values: list[str] | None) -> list[str] | None:
        if values is None:
            return None
        normalized: list[str] = []
        for value in values:
            tag = value.strip().lower()
            if not tag or len(tag) > 40:
                raise ValueError("Tags must contain 1-40 characters.")
            if tag not in normalized:
                normalized.append(tag)
        return normalized

    @model_validator(mode="after")
    def require_change(self):
        if all(value is None for value in (self.title, self.annotation, self.category, self.tags)):
            raise ValueError("At least one bookmark field is required.")
        return self


class JournalSessionSummary(ApiModel):
    session_id: str = Field(min_length=8, max_length=64)
    created_at: datetime
    closed_at: datetime | None = None
    current: bool
    storage_backend: Literal["memory"] = "memory"
    event_count: int = Field(ge=0)
    retained_event_count: int = Field(ge=0)
    checkpoint_count: int = Field(ge=1)
    bookmark_count: int = Field(ge=0)
    first_event_sequence: int | None = Field(default=None, ge=1)
    last_event_sequence: int | None = Field(default=None, ge=1)
    truncated_before_event_sequence: int = Field(default=0, ge=0)
    latest_snapshot_sequence: int = Field(ge=0)
    simulation_time_seconds: float = Field(ge=0)


class JournalEventPage(ApiModel):
    session: JournalSessionSummary
    events: list[JournalEventRecord]
    next_after_event_sequence: int | None = Field(default=None, ge=1)
    has_more: bool


class JournalReplayResponse(ApiModel):
    session: JournalSessionSummary
    requested_from_event_sequence: int = Field(ge=1)
    requested_to_event_sequence: int | None = Field(default=None, ge=1)
    complete_from_requested_sequence: bool
    checkpoint: JournalCheckpoint
    events: list[JournalEventRecord]
    next_after_event_sequence: int | None = Field(default=None, ge=1)
    has_more: bool


class JournalExport(ApiModel):
    format_version: Literal["smart-atc.session.v1"] = "smart-atc.session.v1"
    exported_at: datetime
    session: JournalSessionSummary
    events: list[JournalEventRecord]
    checkpoints: list[JournalCheckpoint]
    bookmarks: list[TimelineBookmark]
    manifest_checksum: str = Field(pattern=r"^[a-f0-9]{64}$")


class TrainingSessionCreateRequest(ApiModel):
    name: str = Field(default="Training room", min_length=1, max_length=100)
    idle_timeout_seconds: int | None = Field(default=None, ge=60, le=86_400)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Session name must not be blank.")
        return value


class TrainingSessionQuotaState(ApiModel):
    max_sessions: int = Field(ge=1)
    active_sessions: int = Field(ge=1)
    remaining_sessions: int = Field(ge=0)
    default_idle_timeout_seconds: int = Field(ge=60)
    max_idle_timeout_seconds: int = Field(ge=60)
    max_websocket_clients_per_session: int = Field(ge=1)
    max_commands_per_session: int = Field(ge=1)


class TrainingSessionMetadata(ApiModel):
    session_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
    name: str = Field(min_length=1, max_length=100)
    is_default: bool
    status: Literal["running", "stopped"]
    created_at: datetime
    last_accessed_at: datetime
    idle_timeout_seconds: int = Field(ge=0)
    idle_seconds: float = Field(ge=0)
    expires_at: datetime | None = None
    runtime_session_id: str = Field(min_length=8, max_length=64)
    snapshot_sequence: int = Field(ge=0)
    active_requests: int = Field(ge=0)
    connected_websocket_clients: int = Field(ge=0)
    callsign: str
    route_id: str | None = None
    emergency_id: str | None = None
    ai_history_messages: int = Field(ge=0)
    journal_session_count: int = Field(ge=1)
    command_count: int = Field(ge=0)


class TrainingSessionList(ApiModel):
    sessions: list[TrainingSessionMetadata]
    quota: TrainingSessionQuotaState


class Frequencies(ApiModel):
    twr: float | None = Field(default=None, ge=108.0, le=137.0)
    gnd: float | None = Field(default=None, ge=108.0, le=137.0)
    app: float | None = Field(default=None, ge=108.0, le=137.0)
    dep: float | None = Field(default=None, ge=108.0, le=137.0)
    atis: float | None = Field(default=None, ge=108.0, le=137.0)


class Airport(ApiModel):
    icao: str = Field(pattern=r"^[A-Z0-9]{3,5}$")
    name: str = Field(min_length=1, max_length=160)
    city: str = Field(default="", max_length=100)
    country: str = Field(default="", max_length=100)
    lat: float = Field(ge=-90.0, le=90.0)
    lon: float = Field(ge=-180.0, le=180.0)
    elev: float = Field(default=0.0, ge=-1500.0, le=20000.0)
    rwys: list[str] = Field(default_factory=list, max_length=32)
    freq: Frequencies = Field(default_factory=Frequencies)
    distance_nm: float | None = Field(default=None, ge=0.0)
    catalog_source: str = Field(default="local", max_length=40)


class ManualAirport(ApiModel):
    name: str | None = Field(default=None, max_length=160)
    city: str = Field(default="", max_length=100)
    country: str = Field(default="", max_length=100)
    lat: float = Field(ge=-90.0, le=90.0)
    lon: float = Field(ge=-180.0, le=180.0)
    elev: float = Field(default=0.0, ge=-1500.0, le=20000.0)
    rwys: list[str] = Field(default_factory=list, max_length=32)
    freq: Frequencies = Field(default_factory=Frequencies)


class RouteDemoRequest(ApiModel):
    origin_icao: str = Field(min_length=3, max_length=5, pattern=r"^[A-Za-z0-9]{3,5}$")
    destination_icao: str = Field(min_length=3, max_length=5, pattern=r"^[A-Za-z0-9]{3,5}$")
    origin: ManualAirport | None = None
    destination: ManualAirport | None = None
    cruise_altitude_ft: int | None = Field(default=None, ge=3000, le=45000)
    cruise_speed_kts: int = Field(default=440, ge=120, le=560)
    time_scale: float = Field(default=12.0, ge=0.25, le=120.0)
    auto_start: bool = True
    callsign: str | None = Field(default=None, min_length=2, max_length=12, pattern=r"^[A-Za-z0-9-]+$")
    command: CommandRequestMetadata | None = None

    @field_validator("origin_icao", "destination_icao")
    @classmethod
    def uppercase_icao(cls, value: str) -> str:
        return value.upper()

    @field_validator("callsign")
    @classmethod
    def uppercase_callsign(cls, value: str | None) -> str | None:
        return value.upper() if value else value


class RouteEndpoint(ApiModel):
    icao: str
    name: str
    lat: float
    lon: float
    elevation_ft: float
    catalog_source: str


class RouteState(ApiModel):
    route_id: str
    status: Literal["ready", "active", "diverting", "completed", "cancelled"]
    autopilot_engaged: bool
    origin: RouteEndpoint
    destination: RouteEndpoint
    original_destination: RouteEndpoint | None = None
    waypoints: list[RouteEndpoint]
    total_distance_nm: float = Field(ge=0)
    distance_flown_nm: float = Field(ge=0)
    remaining_distance_nm: float = Field(ge=0)
    progress: float = Field(ge=0, le=1)
    bearing_deg: float = Field(ge=0, lt=360)
    eta_seconds: int | None = Field(default=None, ge=0)
    wall_clock_eta_seconds: int | None = Field(default=None, ge=0)
    cruise_altitude_ft: int
    cruise_speed_kts: int
    time_scale: float
    phase: str
    started_at: datetime
    diverted: bool = False
    diversion_reason: str | None = None


class TrafficTrack(ApiModel):
    callsign: str
    type: str
    lat: float
    lon: float
    altitude: float
    heading: float
    speed: float
    vertical_speed_fpm: float = 0.0
    squawk: str
    on_ground: bool
    range_nm: float
    bearing: float


class ConflictPrediction(ApiModel):
    conflict_id: str
    callsign: str
    severity: Severity
    current_range_nm: float = Field(ge=0)
    current_vertical_separation_ft: float = Field(ge=0)
    bearing_deg: float = Field(ge=0, lt=360)
    closing_rate_kts: float
    time_to_cpa_seconds: int = Field(ge=0)
    cpa_distance_nm: float = Field(ge=0)
    cpa_vertical_separation_ft: float = Field(ge=0)
    lookahead_seconds: int = Field(ge=1)
    advisory: str


class Alert(ApiModel):
    alert_id: str
    category: Literal["emergency", "traffic", "system", "clearance"]
    severity: Severity
    title: str
    message: str
    created_at: datetime
    requires_acknowledgement: bool = True
    acknowledged: bool = False
    acknowledged_at: datetime | None = None
    acknowledged_by: str | None = None


class AlertAcknowledgement(ApiModel):
    alert_id: str = Field(min_length=1, max_length=160)
    acknowledged: bool
    acknowledged_at: datetime | None = None
    acknowledged_by: str | None = Field(default=None, max_length=100)
    updated_at: datetime


class AlertAcknowledgementRequest(ApiModel):
    actor: str = Field(default="operator", min_length=1, max_length=100)

    @field_validator("actor")
    @classmethod
    def normalize_actor(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Actor must not be blank.")
        return value


class AlertAcknowledgementResponse(ApiModel):
    acknowledgement: AlertAcknowledgement
    alert: Alert
    changed: bool
    event: EventMetadata | None = None
    snapshot_sequence: int = Field(ge=0)


class EmergencyAction(ApiModel):
    action_id: str
    category: Literal["stabilize", "navigate", "communicate", "divert", "land"]
    priority: int = Field(ge=1, le=5)
    title: str
    instruction: str
    rationale: str
    required: bool = True
    completed: bool = False
    completed_at: datetime | None = None


class ResolutionCriterion(ApiModel):
    criterion_id: str
    description: str
    satisfied: bool


class EmergencyState(ApiModel):
    emergency_id: str
    type: Literal[
        "engine_failure", "medical", "hydraulic", "bird_strike", "fuel",
        "comm_failure", "smoke_fire", "gear",
    ]
    title: str
    severity: Severity
    status: Literal["active", "mitigating", "resolved"]
    declared_at: datetime
    resolved_at: datetime | None = None
    summary: str
    alert_message: str
    squawk: str
    recommended_diversion: Airport | None = None
    actions: list[EmergencyAction]
    resolution_criteria: list[ResolutionCriterion]
    can_resolve: bool = False


class EmergencyActivateRequest(ApiModel):
    type: Literal[
        "engine_failure", "medical", "hydraulic", "bird_strike", "fuel",
        "comm_failure", "smoke_fire", "gear",
    ]
    details: str | None = Field(default=None, max_length=500)
    auto_divert: bool = True
    command: CommandRequestMetadata | None = None


class ActionCompleteRequest(ApiModel):
    completed: bool = True
    command: CommandRequestMetadata | None = None


class EmergencyResolveRequest(ApiModel):
    force: bool = False
    command: CommandRequestMetadata | None = None


class ClearanceInstruction(ApiModel):
    instruction_type: Literal[
        "pushback", "taxi", "hold_short", "line_up", "takeoff", "land",
        "altitude", "heading", "speed", "frequency", "squawk", "direct",
    ]
    value: str | float | int | None = None
    unit: str | None = None


class Clearance(ApiModel):
    clearance_id: str
    status: Literal["requested", "issued", "accepted", "executing", "completed", "cancelled"]
    callsign: str
    raw_text: str
    instructions: list[ClearanceInstruction]
    issued_at: datetime
    accepted_at: datetime | None = None
    accepted_by: str | None = None
    readback: str | None = None


class ClearanceAcceptRequest(ApiModel):
    readback: str = Field(min_length=1, max_length=500)
    command: CommandRequestMetadata | None = None


class CallsignRequest(ApiModel):
    callsign: str = Field(min_length=2, max_length=12, pattern=r"^[A-Za-z0-9-]+$")
    command: CommandRequestMetadata | None = None

    @field_validator("callsign")
    @classmethod
    def normalize_callsign(cls, value: str) -> str:
        return value.upper()


class ChatRequest(ApiModel):
    message: str = Field(min_length=1, max_length=1000)


class TTSRequest(ApiModel):
    text: str = Field(min_length=1, max_length=1000)
    voice: str | None = Field(default=None, max_length=80)


class ScenarioRequest(ApiModel):
    scenario_id: str = Field(min_length=1, max_length=60)
    custom_message: str | None = Field(default=None, max_length=1000)


class CustomScenarioRequest(ApiModel):
    description: str = Field(min_length=3, max_length=1000)


class DemoStateUpdate(ApiModel):
    altitude: float | None = Field(default=None, ge=-1500, le=60000)
    ground_speed: float | None = Field(default=None, ge=0, le=700)
    heading_mag: float | None = Field(default=None, ge=0, lt=360)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    on_ground: bool | None = None
    fuel_kg: float | None = Field(default=None, ge=0, le=300000)


class WeatherState(ApiModel):
    wind_dir: int = Field(ge=0, lt=360)
    wind_kts: int = Field(ge=0)
    gust_kts: int = Field(ge=0)
    visibility_km: float = Field(ge=0)
    ceiling_ft: int | None = None
    qnh_hpa: int = Field(ge=850, le=1100)
    temp_c: int
    dewpoint_c: int


class Snapshot(SnapshotMetadata):
    connected: bool
    altitude: float
    ground_speed: float
    heading_mag: float = Field(ge=0, lt=360)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    com1_active: float
    com1_standby: float
    squawk: str
    xpdr_mode: str
    xpdr_ident: bool
    on_ground: bool
    atc_id: str
    atc_flight_number: str
    fuel_kg: float
    fuel_initial_kg: float
    vertical_speed_fpm: float
    true_airspeed: float
    wind_dir: int
    wind_kts: int
    phase: str
    phase_label: str
    vertical_rate: float
    nearest_airport: Airport | None
    callsign: str
    traffic: list[TrafficTrack]
    conflicts: list[ConflictPrediction]
    weather: WeatherState
    route: RouteState | None
    emergency: EmergencyState | None
    alerts: list[Alert]
    clearances: list[Clearance]
    emergency_active: bool
    active_scenario: str
    scenario_control: ScenarioControlState
