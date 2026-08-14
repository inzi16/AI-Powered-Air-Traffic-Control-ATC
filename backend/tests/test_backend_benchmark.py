from __future__ import annotations

from pathlib import Path

from scripts.benchmark_backend import (
    BenchmarkConfig,
    BenchmarkResult,
    latency_summary,
    run_fixed_step_pass,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def test_committed_local_baseline_has_strict_schema_and_correctness_evidence():
    baseline = BenchmarkResult.model_validate_json(
        (REPOSITORY_ROOT / "benchmarks" / "local-baseline.json").read_text(encoding="utf-8")
    )
    assert baseline.production_capacity_claim is False
    assert baseline.gate_passed is True
    assert baseline.failure_count == 0
    assert baseline.throughput.sample_count == 2_400
    assert baseline.isolation.deterministic_divergence_count == 0
    assert baseline.isolation.shared_mutable_object_count == 0
    assert baseline.route_completion.completed is True
    assert baseline.route_completion.missing_phases == []
    assert baseline.route_completion.final_position_error_nm <= 0.1
    assert baseline.duplicate_command.request_count == 100
    assert baseline.duplicate_command.executor_mutations == 1
    assert baseline.duplicate_command.duplicate_mutations == 0
    assert baseline.duplicate_command.deduplicated_receipts == 99


def test_small_fixed_step_workload_replays_to_identical_room_checksums():
    config = BenchmarkConfig(
        rooms=2,
        ticks_per_room=8,
        warmup_ticks=2,
        fixed_step_seconds=0.2,
        duplicate_requests=10,
        quick_mode=True,
    )
    first = run_fixed_step_pass(config, collect_timings=False)
    second = run_fixed_step_pass(config, collect_timings=False)
    assert first.failures == second.failures == []
    assert first.checksums == second.checksums
    assert len(set(first.checksums.values())) == config.rooms
    assert first.shared_mutable_object_count == 0
    assert first.isolation_changed_target is True
    assert first.isolation_peer_divergence_count == 0


def test_latency_summary_uses_reproducible_nearest_rank_percentiles():
    summary = latency_summary([float(value) for value in range(1, 101)])
    assert summary.sample_count == 100
    assert summary.p50_ms == 50.0
    assert summary.p95_ms == 95.0
    assert summary.p99_ms == 99.0

