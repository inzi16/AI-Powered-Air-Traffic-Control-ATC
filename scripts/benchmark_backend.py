"""Reproducible, in-process evidence benchmark for the Smart ATC backend.

This is deliberately not an HTTP, WebSocket, distributed-load, or production
capacity benchmark. It exercises deterministic simulation and command-layer
code on one local Python process so regressions can be compared cheaply.

Examples from the repository root:

    python scripts/benchmark_backend.py --output benchmarks/local-baseline.json --check
    python scripts/benchmark_backend.py --quick --check
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import json
import math
import os
import platform
import statistics
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from backend.command_ledger import CommandLedger  # noqa: E402
from backend.navigation import haversine_nm  # noqa: E402
from backend.runtime import SimulationRuntime  # noqa: E402
from backend.schemas import (  # noqa: E402
    SCHEMA_VERSION,
    CommandRequestMetadata,
    RouteDemoRequest,
    Snapshot,
)


BENCHMARK_SCHEMA = "smart-atc.backend-benchmark.v1"
BENCHMARK_VERSION = "1.0.0"
CHECKSUM_ALGORITHM = "sha256-canonical-json-v1"
FIXED_EPOCH = datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)
REQUIRED_ROUTE_PHASES = (
    "AT_GATE",
    "PUSHBACK",
    "TAXI",
    "HOLDING_SHORT",
    "TAKEOFF_ROLL",
    "INITIAL_CLIMB",
    "CLIMB",
    "CRUISE",
    "DESCENT",
    "APPROACH",
    "FINAL_APPROACH",
    "LANDING",
    "LANDED",
)


class BenchmarkModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BenchmarkConfig(BenchmarkModel):
    rooms: int = Field(default=8, ge=1, le=100)
    ticks_per_room: int = Field(default=300, ge=1, le=100_000)
    warmup_ticks: int = Field(default=10, ge=0, le=10_000)
    fixed_step_seconds: float = Field(default=0.2, gt=0, le=30)
    seed: int = 7300
    route_origin: str = Field(default="VOMM", pattern=r"^[A-Z0-9]{3,5}$")
    route_destination: str = Field(default="VABB", pattern=r"^[A-Z0-9]{3,5}$")
    route_step_seconds: float = Field(default=0.25, gt=0, le=30)
    route_time_scale: float = Field(default=120.0, ge=0.25, le=120)
    route_max_ticks: int = Field(default=2_000, ge=10, le=100_000)
    duplicate_requests: int = Field(default=100, ge=2, le=10_000)
    quick_mode: bool = False


class LatencySummary(BenchmarkModel):
    sample_count: int = Field(ge=0)
    min_ms: float = Field(ge=0)
    mean_ms: float = Field(ge=0)
    p50_ms: float = Field(ge=0)
    p95_ms: float = Field(ge=0)
    p99_ms: float = Field(ge=0)
    max_ms: float = Field(ge=0)


class EnvironmentInfo(BenchmarkModel):
    captured_at_utc: datetime
    python_executable: str
    python_implementation: str
    python_version: str
    python_compiler: str
    platform: str
    system: str
    release: str
    machine: str
    processor: str
    logical_cpu_count: int | None
    git_head: str | None
    working_tree_dirty: bool | None


class ThroughputResult(BenchmarkModel):
    room_count: int = Field(ge=1)
    warmup_ticks_per_room: int = Field(ge=0)
    measured_ticks_per_room: int = Field(ge=1)
    sample_count: int = Field(ge=1)
    deterministic_verification_sample_count: int = Field(ge=1)
    fixed_step_seconds: float = Field(gt=0)
    wall_time_seconds: float = Field(gt=0)
    verification_wall_time_seconds: float = Field(gt=0)
    snapshots_per_second: float = Field(gt=0)
    latency: LatencySummary
    failure_count: int = Field(ge=0)
    failures: list[str]


class IsolationResult(BenchmarkModel):
    checksum_algorithm: Literal["sha256-canonical-json-v1"] = CHECKSUM_ALGORITHM
    room_checksums: dict[str, str]
    deterministic_replay_checksums: dict[str, str]
    deterministic_divergence_count: int = Field(ge=0)
    unique_room_checksum_count: int = Field(ge=0)
    unique_runtime_session_count: int = Field(ge=0)
    shared_mutable_object_count: int = Field(ge=0)
    isolation_probe_changed_target: bool
    isolation_probe_peer_divergence_count: int = Field(ge=0)


class PhaseObservation(BenchmarkModel):
    tick: int = Field(ge=0)
    simulation_time_seconds: float = Field(ge=0)
    phase: str


class RouteCompletionResult(BenchmarkModel):
    origin: str
    destination: str
    total_distance_nm: float = Field(gt=0)
    completed: bool
    ticks: int = Field(ge=0)
    simulated_time_seconds: float = Field(ge=0)
    wall_time_seconds: float = Field(ge=0)
    latency: LatencySummary
    phases_seen: list[str]
    phase_transitions: list[PhaseObservation]
    required_phases: list[str]
    missing_phases: list[str]
    final_position_error_nm: float = Field(ge=0)
    final_progress: float = Field(ge=0, le=1)
    final_on_ground: bool
    final_ground_speed_kts: float = Field(ge=0)
    final_altitude_ft: float
    destination_elevation_ft: float
    final_checksum: str
    failure_count: int = Field(ge=0)
    failures: list[str]


class DuplicateCommandResult(BenchmarkModel):
    request_count: int = Field(ge=2)
    wall_time_seconds: float = Field(ge=0)
    latency: LatencySummary
    successful_responses: int = Field(ge=0)
    failure_count: int = Field(ge=0)
    executor_mutations: int = Field(ge=0)
    duplicate_mutations: int = Field(ge=0)
    primary_receipts: int = Field(ge=0)
    deduplicated_receipts: int = Field(ge=0)
    unique_event_count: int = Field(ge=0)
    ledger_entry_count: int = Field(ge=0)
    sequence_delta: int
    revision_delta: int
    failures: list[str]


class RegressionGate(BenchmarkModel):
    name: str
    passed: bool
    observed: Any
    requirement: str


class BenchmarkResult(BenchmarkModel):
    benchmark_schema: Literal["smart-atc.backend-benchmark.v1"] = BENCHMARK_SCHEMA
    benchmark_version: Literal["1.0.0"] = BENCHMARK_VERSION
    api_schema_version: str
    scope: Literal["local_in_process_evidence"] = "local_in_process_evidence"
    production_capacity_claim: Literal[False] = False
    disclaimer: str
    environment: EnvironmentInfo
    config: BenchmarkConfig
    throughput: ThroughputResult
    isolation: IsolationResult
    route_completion: RouteCompletionResult
    duplicate_command: DuplicateCommandResult
    gates: list[RegressionGate]
    gate_passed: bool
    failure_count: int = Field(ge=0)
    failures: list[str]
    total_wall_time_seconds: float = Field(ge=0)


@dataclass
class _FixedPass:
    latencies_ms: list[float]
    wall_time_seconds: float
    checksums: dict[str, str]
    session_ids: list[str]
    shared_mutable_object_count: int
    isolation_changed_target: bool
    isolation_peer_divergence_count: int
    failures: list[str]


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


_VOLATILE_KEYS = {
    "acknowledged_at",
    "changed_at",
    "completed_at",
    "created_at",
    "declared_at",
    "event_id",
    "observed_at",
    "resolved_at",
    "route_id",
    "server_time",
    "session_id",
    "snapshot_id",
    "started_at",
    "updated_at",
}


def _stable_value(value: Any) -> Any:
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    if isinstance(value, dict):
        return {
            key: _stable_value(item)
            for key, item in sorted(value.items())
            if key not in _VOLATILE_KEYS
        }
    if isinstance(value, list):
        return [_stable_value(item) for item in value]
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Benchmark checksum input contains a non-finite number.")
        return round(value, 9)
    return value


def stable_snapshot_checksum(snapshot: Snapshot) -> str:
    stable = _stable_value(snapshot.model_dump(mode="json"))
    return hashlib.sha256(_canonical_json(stable)).hexdigest()


def percentile(values: list[float], percentage: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(1, math.ceil((percentage / 100.0) * len(ordered)))
    return ordered[min(rank - 1, len(ordered) - 1)]


def latency_summary(values: list[float]) -> LatencySummary:
    if not values:
        return LatencySummary(
            sample_count=0,
            min_ms=0,
            mean_ms=0,
            p50_ms=0,
            p95_ms=0,
            p99_ms=0,
            max_ms=0,
        )
    return LatencySummary(
        sample_count=len(values),
        min_ms=round(min(values), 6),
        mean_ms=round(statistics.fmean(values), 6),
        p50_ms=round(percentile(values, 50), 6),
        p95_ms=round(percentile(values, 95), 6),
        p99_ms=round(percentile(values, 99), 6),
        max_ms=round(max(values), 6),
    )


def _freeze_wall_clock_weather(runtime: SimulationRuntime) -> None:
    # WeatherEngine intentionally drifts on monotonic wall time in production.
    # This evidence harness freezes only that drift so identical fixed-step
    # inputs remain checksum-comparable across benchmark passes.
    runtime.weather._last_drift = float("inf")


def _new_runtime(seed: int, marker: str) -> SimulationRuntime:
    runtime = SimulationRuntime(seed=seed)
    _freeze_wall_clock_weather(runtime)
    runtime.callsign = marker
    runtime.state["atc_id"] = "BCH"
    runtime.state["atc_flight_number"] = marker[-2:]
    return runtime


def _shared_mutable_objects(rooms: list[SimulationRuntime]) -> int:
    attributes = ("state", "weather", "traffic", "route", "emergencies", "clearances", "journal", "lock")
    shared = 0
    for left_index, left in enumerate(rooms):
        for right in rooms[left_index + 1 :]:
            shared += sum(getattr(left, attribute) is getattr(right, attribute) for attribute in attributes)
    return shared


def run_fixed_step_pass(config: BenchmarkConfig, *, collect_timings: bool) -> _FixedPass:
    rooms = [
        _new_runtime(config.seed + index, f"BENCH{index:02d}")
        for index in range(config.rooms)
    ]
    failures: list[str] = []
    latencies: list[float] = []
    logical_tick = 0

    for _ in range(config.warmup_ticks):
        logical_tick += 1
        observed = FIXED_EPOCH + timedelta(seconds=logical_tick * config.fixed_step_seconds)
        for runtime in rooms:
            runtime.tick_once(config.fixed_step_seconds, now=observed)

    wall_started = time.perf_counter()
    for step in range(config.ticks_per_room):
        logical_tick += 1
        observed = FIXED_EPOCH + timedelta(seconds=logical_tick * config.fixed_step_seconds)
        for room_index, runtime in enumerate(rooms):
            expected_sequence = runtime.sequence + 1
            started = time.perf_counter_ns()
            try:
                snapshot = runtime.tick_once(config.fixed_step_seconds, now=observed)
            except Exception as exc:  # evidence should report, rather than hide, a failed sample
                failures.append(f"room {room_index} step {step}: {type(exc).__name__}")
                continue
            elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000.0
            if collect_timings:
                latencies.append(elapsed_ms)
            if snapshot.sequence != expected_sequence:
                failures.append(
                    f"room {room_index} step {step}: sequence {snapshot.sequence} != {expected_sequence}"
                )
            if snapshot.state_revision != 0:
                failures.append(f"room {room_index} step {step}: unexpected state revision")
            if not (-90 <= snapshot.lat <= 90 and -180 <= snapshot.lon <= 180):
                failures.append(f"room {room_index} step {step}: invalid position")
            if not 0 <= snapshot.heading_mag < 360:
                failures.append(f"room {room_index} step {step}: invalid heading")
    wall_time = max(time.perf_counter() - wall_started, 1e-12)

    peer_before = [stable_snapshot_checksum(runtime.current_snapshot()) for runtime in rooms[1:]]
    target_before = stable_snapshot_checksum(rooms[0].current_snapshot())
    rooms[0].state["com1_standby"] = round(float(rooms[0].state["com1_standby"]) + 0.025, 3)
    logical_tick += 1
    rooms[0].tick_once(
        0.0,
        now=FIXED_EPOCH + timedelta(seconds=logical_tick * config.fixed_step_seconds),
    )
    target_after = stable_snapshot_checksum(rooms[0].current_snapshot())
    peer_after = [stable_snapshot_checksum(runtime.current_snapshot()) for runtime in rooms[1:]]

    return _FixedPass(
        latencies_ms=latencies,
        wall_time_seconds=wall_time,
        checksums={
            f"room_{index:02d}": stable_snapshot_checksum(runtime.current_snapshot())
            for index, runtime in enumerate(rooms)
        },
        session_ids=[runtime.session_id for runtime in rooms],
        shared_mutable_object_count=_shared_mutable_objects(rooms),
        isolation_changed_target=target_before != target_after,
        isolation_peer_divergence_count=sum(before != after for before, after in zip(peer_before, peer_after)),
        failures=failures,
    )


def benchmark_fixed_step(config: BenchmarkConfig) -> tuple[ThroughputResult, IsolationResult]:
    measured = run_fixed_step_pass(config, collect_timings=True)
    verification = run_fixed_step_pass(config, collect_timings=False)
    sample_count = config.rooms * config.ticks_per_room
    divergence = sum(
        measured.checksums.get(room) != verification.checksums.get(room)
        for room in sorted(set(measured.checksums) | set(verification.checksums))
    )
    failures = measured.failures + verification.failures
    throughput = ThroughputResult(
        room_count=config.rooms,
        warmup_ticks_per_room=config.warmup_ticks,
        measured_ticks_per_room=config.ticks_per_room,
        sample_count=sample_count,
        deterministic_verification_sample_count=sample_count,
        fixed_step_seconds=config.fixed_step_seconds,
        wall_time_seconds=round(measured.wall_time_seconds, 6),
        verification_wall_time_seconds=round(verification.wall_time_seconds, 6),
        snapshots_per_second=round(sample_count / measured.wall_time_seconds, 3),
        latency=latency_summary(measured.latencies_ms),
        failure_count=len(failures),
        failures=failures[:100],
    )
    isolation = IsolationResult(
        room_checksums=measured.checksums,
        deterministic_replay_checksums=verification.checksums,
        deterministic_divergence_count=divergence,
        unique_room_checksum_count=len(set(measured.checksums.values())),
        unique_runtime_session_count=len(set(measured.session_ids)),
        shared_mutable_object_count=measured.shared_mutable_object_count,
        isolation_probe_changed_target=measured.isolation_changed_target,
        isolation_probe_peer_divergence_count=measured.isolation_peer_divergence_count,
    )
    return throughput, isolation


def benchmark_route_completion(config: BenchmarkConfig) -> RouteCompletionResult:
    runtime = _new_runtime(config.seed + 50_000, "ROUTE01")
    request = RouteDemoRequest(
        origin_icao=config.route_origin,
        destination_icao=config.route_destination,
        cruise_speed_kts=440,
        time_scale=config.route_time_scale,
        auto_start=True,
        callsign="BENCH01",
    )
    route = runtime.route.create(request, runtime.catalog, runtime.state)
    destination = route.destination
    phases_seen: list[str] = []
    transitions: list[PhaseObservation] = []
    latencies: list[float] = []
    failures: list[str] = []
    previous_phase: str | None = None
    final_snapshot = runtime.current_snapshot()

    wall_started = time.perf_counter()
    for tick in range(1, config.route_max_ticks + 1):
        observed = FIXED_EPOCH + timedelta(seconds=tick * config.route_step_seconds)
        started = time.perf_counter_ns()
        final_snapshot = runtime.tick_once(config.route_step_seconds, now=observed)
        latencies.append((time.perf_counter_ns() - started) / 1_000_000.0)
        route_state = final_snapshot.route
        phase = route_state.phase if route_state else final_snapshot.phase
        if phase not in phases_seen:
            phases_seen.append(phase)
        if phase != previous_phase:
            transitions.append(PhaseObservation(
                tick=tick,
                simulation_time_seconds=round(runtime.simulation_time_seconds, 3),
                phase=phase,
            ))
            previous_phase = phase
        if route_state and route_state.status == "completed":
            break
    wall_time = time.perf_counter() - wall_started

    route_state = final_snapshot.route
    completed = bool(route_state and route_state.status == "completed")
    missing = [phase for phase in REQUIRED_ROUTE_PHASES if phase not in phases_seen]
    position_error = haversine_nm(
        final_snapshot.lat,
        final_snapshot.lon,
        destination.lat,
        destination.lon,
    )
    if not completed:
        failures.append("route did not complete within route_max_ticks")
    if missing:
        failures.append(f"missing required phases: {', '.join(missing)}")
    if position_error > 0.1:
        failures.append(f"final position error {position_error:.3f} NM exceeds 0.1 NM")
    if not final_snapshot.on_ground:
        failures.append("final snapshot is not on ground")
    if final_snapshot.ground_speed > 0.5:
        failures.append("final ground speed exceeds 0.5 kt")
    final_progress = route_state.progress if route_state else 0.0
    if final_progress < 1.0:
        failures.append("final route progress is below 1.0")

    return RouteCompletionResult(
        origin=config.route_origin,
        destination=config.route_destination,
        total_distance_nm=route.total_distance_nm,
        completed=completed,
        ticks=len(latencies),
        simulated_time_seconds=round(runtime.simulation_time_seconds, 3),
        wall_time_seconds=round(wall_time, 6),
        latency=latency_summary(latencies),
        phases_seen=phases_seen,
        phase_transitions=transitions,
        required_phases=list(REQUIRED_ROUTE_PHASES),
        missing_phases=missing,
        final_position_error_nm=round(position_error, 6),
        final_progress=final_progress,
        final_on_ground=final_snapshot.on_ground,
        final_ground_speed_kts=final_snapshot.ground_speed,
        final_altitude_ft=final_snapshot.altitude,
        destination_elevation_ft=destination.elevation_ft,
        final_checksum=stable_snapshot_checksum(final_snapshot),
        failure_count=len(failures),
        failures=failures,
    )


async def _benchmark_duplicate_command_async(config: BenchmarkConfig) -> DuplicateCommandResult:
    runtime = _new_runtime(config.seed + 60_000, "DUPL01")
    ledger = CommandLedger(max_entries=max(config.duplicate_requests + 10, 200))
    now = datetime.now(timezone.utc)
    command = CommandRequestMetadata(
        command_id="benchmark-command-duplicate-001",
        idempotency_key="benchmark-idempotency-duplicate-001",
        expected_sequence=runtime.sequence,
        expected_revision=runtime.state_revision,
        issued_at=now,
        expires_at=now + timedelta(minutes=5),
        actor="local-benchmark",
    )
    sequence_before = runtime.sequence
    revision_before = runtime.state_revision
    executor_mutations = 0

    async def executor(_command: CommandRequestMetadata) -> dict[str, Any]:
        nonlocal executor_mutations
        executor_mutations += 1
        await asyncio.sleep(0)
        runtime.callsign = "DUPL01"
        runtime.advance_state_revision()
        runtime.tick_once(0.0, now=FIXED_EPOCH)
        return runtime.record_event(
            "benchmark.command_executed",
            {"callsign": runtime.callsign},
        ).model_dump(mode="json")

    async def invoke() -> tuple[float, dict[str, Any] | None, str | None]:
        started = time.perf_counter_ns()
        try:
            response = await ledger.execute(
                command,
                operation="benchmark.callsign.set",
                payload={"callsign": "DUPL01"},
                runtime=runtime,
                executor=executor,
            )
            return (time.perf_counter_ns() - started) / 1_000_000.0, response, None
        except Exception as exc:  # return all failures as evidence
            return (time.perf_counter_ns() - started) / 1_000_000.0, None, type(exc).__name__

    wall_started = time.perf_counter()
    outcomes = await asyncio.gather(*(invoke() for _ in range(config.duplicate_requests)))
    wall_time = time.perf_counter() - wall_started
    latencies = [latency for latency, _response, _error in outcomes]
    responses = [response for _latency, response, error in outcomes if response is not None and error is None]
    errors = [error for _latency, _response, error in outcomes if error is not None]
    primary = sum(response["command"]["deduplicated"] is False for response in responses)
    deduplicated = sum(response["command"]["deduplicated"] is True for response in responses)
    event_ids = {
        response.get("event", {}).get("event_id")
        for response in responses
        if response.get("event", {}).get("event_id")
    }
    audit = await ledger.get(command.command_id)
    failures = [str(error) for error in errors]
    if audit.deduplicated_count != max(0, config.duplicate_requests - 1):
        failures.append("ledger deduplicated_count differs from request_count - 1")

    return DuplicateCommandResult(
        request_count=config.duplicate_requests,
        wall_time_seconds=round(wall_time, 6),
        latency=latency_summary(latencies),
        successful_responses=len(responses),
        failure_count=len(failures),
        executor_mutations=executor_mutations,
        duplicate_mutations=max(0, executor_mutations - 1),
        primary_receipts=primary,
        deduplicated_receipts=deduplicated,
        unique_event_count=len(event_ids),
        ledger_entry_count=ledger.count,
        sequence_delta=runtime.sequence - sequence_before,
        revision_delta=runtime.state_revision - revision_before,
        failures=failures[:100],
    )


def benchmark_duplicate_command(config: BenchmarkConfig) -> DuplicateCommandResult:
    return asyncio.run(_benchmark_duplicate_command_async(config))


def _git_value(*arguments: str) -> str | None:
    try:
        completed = subprocess.run(
            ["git", *arguments],
            cwd=REPOSITORY_ROOT,
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    return completed.stdout.strip()


def environment_info() -> EnvironmentInfo:
    status = _git_value("status", "--porcelain")
    return EnvironmentInfo(
        captured_at_utc=datetime.now(timezone.utc),
        # Keep benchmark artifacts reproducible without publishing a developer's
        # home directory or other machine-specific path information.
        python_executable=Path(sys.executable).name,
        python_implementation=platform.python_implementation(),
        python_version=platform.python_version(),
        python_compiler=platform.python_compiler(),
        platform=platform.platform(),
        system=platform.system(),
        release=platform.release(),
        machine=platform.machine(),
        processor=platform.processor(),
        logical_cpu_count=os.cpu_count(),
        git_head=_git_value("rev-parse", "HEAD"),
        working_tree_dirty=None if status is None else bool(status),
    )


def evaluate_gates(
    config: BenchmarkConfig,
    throughput: ThroughputResult,
    isolation: IsolationResult,
    route: RouteCompletionResult,
    duplicate: DuplicateCommandResult,
) -> list[RegressionGate]:
    min_throughput = 50.0
    max_p95_ms = 50.0
    max_p99_ms = 100.0
    max_route_wall_seconds = 15.0 if config.quick_mode else 30.0
    return [
        RegressionGate(
            name="fixed_step_no_failures",
            passed=throughput.failure_count == 0,
            observed=throughput.failure_count,
            requirement="failure_count == 0",
        ),
        RegressionGate(
            name="fixed_step_throughput",
            passed=throughput.snapshots_per_second >= min_throughput,
            observed=throughput.snapshots_per_second,
            requirement=f">= {min_throughput:.0f} snapshots/second",
        ),
        RegressionGate(
            name="fixed_step_p95_latency",
            passed=throughput.latency.p95_ms <= max_p95_ms,
            observed=throughput.latency.p95_ms,
            requirement=f"<= {max_p95_ms:.0f} ms",
        ),
        RegressionGate(
            name="fixed_step_p99_latency",
            passed=throughput.latency.p99_ms <= max_p99_ms,
            observed=throughput.latency.p99_ms,
            requirement=f"<= {max_p99_ms:.0f} ms",
        ),
        RegressionGate(
            name="deterministic_replay",
            passed=isolation.deterministic_divergence_count == 0,
            observed=isolation.deterministic_divergence_count,
            requirement="0 checksum divergences",
        ),
        RegressionGate(
            name="room_isolation",
            passed=(
                isolation.unique_room_checksum_count == config.rooms
                and isolation.unique_runtime_session_count == config.rooms
                and isolation.shared_mutable_object_count == 0
                and isolation.isolation_probe_changed_target
                and isolation.isolation_probe_peer_divergence_count == 0
            ),
            observed={
                "unique_checksums": isolation.unique_room_checksum_count,
                "unique_sessions": isolation.unique_runtime_session_count,
                "shared_mutables": isolation.shared_mutable_object_count,
                "target_changed": isolation.isolation_probe_changed_target,
                "peer_divergences": isolation.isolation_probe_peer_divergence_count,
            },
            requirement="unique checksums/sessions, no shared mutables, target-only probe change",
        ),
        RegressionGate(
            name="route_completion_and_phase_coverage",
            passed=route.completed and not route.missing_phases and route.failure_count == 0,
            observed={
                "completed": route.completed,
                "missing_phases": route.missing_phases,
                "failure_count": route.failure_count,
            },
            requirement="completed with every required phase and zero route failures",
        ),
        RegressionGate(
            name="route_local_wall_time",
            passed=route.wall_time_seconds <= max_route_wall_seconds,
            observed=route.wall_time_seconds,
            requirement=f"<= {max_route_wall_seconds:.0f} seconds",
        ),
        RegressionGate(
            name="duplicate_command_exactly_once",
            passed=(
                duplicate.failure_count == 0
                and duplicate.successful_responses == config.duplicate_requests
                and duplicate.executor_mutations == 1
                and duplicate.duplicate_mutations == 0
                and duplicate.primary_receipts == 1
                and duplicate.deduplicated_receipts == config.duplicate_requests - 1
                and duplicate.unique_event_count == 1
                and duplicate.ledger_entry_count == 1
                and duplicate.sequence_delta == 1
                and duplicate.revision_delta == 1
            ),
            observed={
                "responses": duplicate.successful_responses,
                "executor_mutations": duplicate.executor_mutations,
                "duplicate_mutations": duplicate.duplicate_mutations,
                "deduplicated_receipts": duplicate.deduplicated_receipts,
                "unique_events": duplicate.unique_event_count,
            },
            requirement="one mutation/event/ledger entry and all retries deduplicated",
        ),
    ]


def run_benchmark(config: BenchmarkConfig) -> BenchmarkResult:
    total_started = time.perf_counter()
    throughput, isolation = benchmark_fixed_step(config)
    route = benchmark_route_completion(config)
    duplicate = benchmark_duplicate_command(config)
    gates = evaluate_gates(config, throughput, isolation, route, duplicate)
    failures = list(throughput.failures) + list(route.failures) + list(duplicate.failures)
    if isolation.deterministic_divergence_count:
        failures.append("deterministic fixed-step checksum divergence")
    if isolation.isolation_probe_peer_divergence_count:
        failures.append("isolation probe changed a peer room")
    failed_gate_names = [gate.name for gate in gates if not gate.passed]
    failures.extend(f"regression gate failed: {name}" for name in failed_gate_names)
    return BenchmarkResult(
        api_schema_version=SCHEMA_VERSION,
        disclaimer=(
            "Local single-process evidence only. Results exclude HTTP/WebSocket, network, database, "
            "multi-process scheduling, and production infrastructure overhead; they are not a capacity claim."
        ),
        environment=environment_info(),
        config=config,
        throughput=throughput,
        isolation=isolation,
        route_completion=route,
        duplicate_command=duplicate,
        gates=gates,
        gate_passed=not failed_gate_names and not failures,
        failure_count=len(failures),
        failures=failures[:200],
        total_wall_time_seconds=round(time.perf_counter() - total_started, 6),
    )


def canonical_result_json(result: BenchmarkResult) -> str:
    return json.dumps(
        result.model_dump(mode="json"),
        ensure_ascii=False,
        allow_nan=False,
        indent=2,
        sort_keys=True,
    ) + "\n"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quick", action="store_true", help="Use a short CI-friendly fixed-step workload.")
    parser.add_argument("--rooms", type=int, default=None)
    parser.add_argument("--ticks-per-room", type=int, default=None)
    parser.add_argument("--warmup-ticks", type=int, default=None)
    parser.add_argument("--fixed-step-seconds", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=7300)
    parser.add_argument("--route-origin", default="VOMM")
    parser.add_argument("--route-destination", default="VABB")
    parser.add_argument("--route-step-seconds", type=float, default=0.25)
    parser.add_argument("--route-time-scale", type=float, default=120.0)
    parser.add_argument("--route-max-ticks", type=int, default=2_000)
    parser.add_argument("--duplicates", type=int, default=100)
    parser.add_argument("--output", type=Path, default=None, help="Write canonical JSON to this path instead of stdout.")
    parser.add_argument("--check", action="store_true", help="Exit non-zero when a conservative regression gate fails.")
    return parser


def config_from_args(args: argparse.Namespace) -> BenchmarkConfig:
    return BenchmarkConfig(
        rooms=args.rooms if args.rooms is not None else (3 if args.quick else 8),
        ticks_per_room=args.ticks_per_room if args.ticks_per_room is not None else (75 if args.quick else 300),
        warmup_ticks=args.warmup_ticks if args.warmup_ticks is not None else (5 if args.quick else 10),
        fixed_step_seconds=args.fixed_step_seconds,
        seed=args.seed,
        route_origin=str(args.route_origin).upper(),
        route_destination=str(args.route_destination).upper(),
        route_step_seconds=args.route_step_seconds,
        route_time_scale=args.route_time_scale,
        route_max_ticks=args.route_max_ticks,
        duplicate_requests=args.duplicates,
        quick_mode=args.quick,
    )


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    result = run_benchmark(config_from_args(args))
    rendered = canonical_result_json(result)
    if args.output is None:
        sys.stdout.write(rendered)
    else:
        output = args.output if args.output.is_absolute() else REPOSITORY_ROOT / args.output
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered, encoding="utf-8", newline="\n")
        print(
            f"wrote {output} | gates={'PASS' if result.gate_passed else 'FAIL'} | "
            f"samples={result.throughput.sample_count} | "
            f"throughput={result.throughput.snapshots_per_second:.1f}/s"
        )
    return 1 if args.check and not result.gate_passed else 0


if __name__ == "__main__":
    raise SystemExit(main())
