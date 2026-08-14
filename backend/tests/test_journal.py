from journal import InMemoryEventJournal
from runtime import SimulationRuntime
from schemas import BookmarkCreateRequest, BookmarkUpdateRequest


def _append(runtime, journal, event_type, payload=None):
    snapshot = runtime.current_snapshot()
    return journal.append(
        runtime.event(event_type),
        payload or {"event_type": event_type},
        snapshot,
        runtime.simulation_time_seconds,
    )


def test_journal_retains_ordered_events_and_periodic_replay_checkpoints():
    runtime = SimulationRuntime()
    journal = InMemoryEventJournal(checkpoint_interval=2)
    journal.start_session(runtime.session_id, runtime.current_snapshot(), 0)

    first = _append(runtime, journal, "route.created")
    second = _append(runtime, journal, "scenario.paused")
    third = _append(runtime, journal, "scenario.resumed")

    page = journal.events(runtime.session_id, limit=2)
    assert [item.metadata.event_sequence for item in page.events] == [1, 2]
    assert page.has_more is True
    assert page.next_after_event_sequence == 2
    assert first.metadata.event_id != second.metadata.event_id != third.metadata.event_id

    replay = journal.replay(runtime.session_id, from_event_sequence=3)
    assert replay.checkpoint.event_sequence == 2
    assert [item.metadata.event_sequence for item in replay.events] == [3]
    assert replay.complete_from_requested_sequence is True
    assert replay.checkpoint.state_checksum == second.state_checksum


def test_bounded_retention_is_explicit_and_replay_never_claims_missing_history():
    runtime = SimulationRuntime()
    journal = InMemoryEventJournal(max_events_per_session=2, checkpoint_interval=2)
    journal.start_session(runtime.session_id, runtime.current_snapshot(), 0)
    for index in range(4):
        _append(runtime, journal, f"test.event_{index}")

    summary = journal.session(runtime.session_id)
    assert summary.event_count == 4
    assert summary.retained_event_count == 2
    assert summary.truncated_before_event_sequence == 2
    assert summary.first_event_sequence == 3

    incomplete = journal.replay(runtime.session_id, from_event_sequence=1)
    assert incomplete.complete_from_requested_sequence is False
    reconstructable = journal.replay(runtime.session_id, from_event_sequence=3)
    assert reconstructable.checkpoint.event_sequence == 2
    assert reconstructable.complete_from_requested_sequence is True


def test_payload_bounds_preserve_digest_and_export_integrity_manifest():
    runtime = SimulationRuntime()
    journal = InMemoryEventJournal(max_payload_bytes=512)
    journal.start_session(runtime.session_id, runtime.current_snapshot(), 0)
    record = _append(runtime, journal, "large.payload", {"value": "x" * 2_000})

    assert record.payload_truncated is True
    assert record.payload["_truncated"] is True
    assert len(record.payload["sha256"]) == 64
    exported = journal.export(runtime.session_id)
    assert exported.format_version == "smart-atc.session.v1"
    assert len(exported.manifest_checksum) == 64
    assert exported.events[0].state_checksum == record.state_checksum


def test_bookmarks_are_session_scoped_immutable_event_annotations():
    runtime = SimulationRuntime()
    journal = InMemoryEventJournal()
    journal.start_session(runtime.session_id, runtime.current_snapshot(), 0)
    event = _append(runtime, journal, "emergency.activated")

    bookmark = journal.create_bookmark(runtime.session_id, BookmarkCreateRequest(
        event_id=event.metadata.event_id,
        event_sequence=event.metadata.event_sequence,
        title="  Engine-out decision point  ",
        annotation="Review diversion timing",
        category="training",
        tags=["CRM", "crm", "engine-out"],
        created_by="instructor",
    ))
    assert bookmark.title == "Engine-out decision point"
    assert bookmark.tags == ["crm", "engine-out"]
    assert bookmark.snapshot_sequence == event.snapshot_sequence

    updated = journal.update_bookmark(runtime.session_id, bookmark.bookmark_id, BookmarkUpdateRequest(
        annotation="Good stabilization; earlier MAYDAY recommended.",
        category="review",
    ))
    assert updated.event_id == event.metadata.event_id
    assert updated.category == "review"
    assert journal.events(runtime.session_id).events[0].payload == event.payload

    journal.delete_bookmark(runtime.session_id, bookmark.bookmark_id)
    assert journal.list_bookmarks(runtime.session_id) == []


def test_closed_session_survives_runtime_reset_with_new_session_isolation():
    runtime = SimulationRuntime()
    old_session = runtime.session_id
    runtime.record_event("before.reset", {"value": 1})

    runtime.reset()
    new_session = runtime.session_id
    runtime.record_event("after.reset", {"value": 2})

    assert new_session != old_session
    assert runtime.journal.session(old_session).current is False
    assert runtime.journal.session(new_session).current is True
    assert runtime.journal.events(old_session).events[0].payload == {"value": 1}
    assert runtime.journal.events(new_session).events[0].metadata.event_sequence == 1
