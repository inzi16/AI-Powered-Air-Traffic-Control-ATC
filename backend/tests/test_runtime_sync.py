from datetime import datetime, timedelta, timezone

from runtime import SimulationRuntime


def test_reads_do_not_mutate_sequence_or_phase():
    runtime = SimulationRuntime(tick_hz=5)
    before = runtime.current_snapshot()
    for _ in range(10):
        current = runtime.current_snapshot()
        assert current.sequence == before.sequence
        assert current.phase == before.phase
        assert current.snapshot_id == before.snapshot_id


def test_one_tick_one_sequence_and_utc_metadata():
    runtime = SimulationRuntime(tick_hz=5)
    before = runtime.current_snapshot()
    timestamp = datetime(2026, 8, 14, 12, 0, tzinfo=timezone.utc)
    after = runtime.tick_once(0.2, now=timestamp)
    assert after.sequence == before.sequence + 1
    assert after.server_time == timestamp
    assert after.observed_at.tzinfo is not None
    assert after.schema_version == "3.0.0"
    assert after.snapshot_id.endswith(f":{after.sequence}")


def test_external_data_age_and_source_are_explicit():
    runtime = SimulationRuntime()
    server_time = datetime(2026, 8, 14, 12, 0, tzinfo=timezone.utc)
    observed = server_time - timedelta(seconds=2)
    snapshot = runtime.tick_once(0.2, now=server_time, external_state={
        "connected": True, "lat": 10, "lon": 20, "altitude": 10000,
        "ground_speed": 250, "heading_mag": 90, "on_ground": False,
        "observed_at": observed.isoformat(),
    })
    assert snapshot.source.value == "simconnect"
    assert snapshot.data_age_ms == 2000


def test_snapshot_json_is_identical_cached_broadcast_payload():
    runtime = SimulationRuntime()
    snapshot = runtime.current_snapshot()
    assert snapshot.model_dump_json() == runtime.current_json

