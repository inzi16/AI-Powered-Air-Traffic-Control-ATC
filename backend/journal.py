"""Bounded, session-scoped event journal with a persistence-ready repository seam.

The in-memory implementation survives simulation session resets, but intentionally
does not claim process durability.  Its models and methods map cleanly to a future
Postgres event/checkpoint/bookmark repository.
"""

from __future__ import annotations

import hashlib
import json
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Protocol

from pydantic import BaseModel

try:
    from .schemas import (
        BookmarkCreateRequest,
        BookmarkUpdateRequest,
        EventMetadata,
        JournalCheckpoint,
        JournalEventPage,
        JournalEventRecord,
        JournalExport,
        JournalReplayResponse,
        JournalSessionSummary,
        Snapshot,
        TimelineBookmark,
    )
except ImportError:  # pragma: no cover - direct module execution compatibility
    from schemas import (
        BookmarkCreateRequest,
        BookmarkUpdateRequest,
        EventMetadata,
        JournalCheckpoint,
        JournalEventPage,
        JournalEventRecord,
        JournalExport,
        JournalReplayResponse,
        JournalSessionSummary,
        Snapshot,
        TimelineBookmark,
    )


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class JournalError(RuntimeError):
    """Base class for repository errors that API adapters can map safely."""


class JournalSessionNotFound(JournalError):
    pass


class JournalBookmarkNotFound(JournalError):
    pass


class JournalTargetError(JournalError):
    pass


def _json_value(value: Any) -> Any:
    """Return a detached JSON-compatible value with deterministic key handling."""
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, set):
        return [_json_value(item) for item in sorted(value, key=repr)]
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        _json_value(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def state_checksum(state: Any) -> str:
    return hashlib.sha256(_canonical_bytes(state)).hexdigest()


class EventJournalRepository(Protocol):
    """Storage boundary implemented by memory today and Postgres later."""

    def start_session(self, session_id: str, snapshot: Snapshot, simulation_time_seconds: float) -> JournalSessionSummary: ...

    def append(
        self,
        metadata: EventMetadata,
        payload: dict[str, Any],
        snapshot: Snapshot,
        simulation_time_seconds: float,
    ) -> JournalEventRecord: ...

    def replay(
        self,
        session_id: str,
        *,
        from_event_sequence: int = 1,
        to_event_sequence: int | None = None,
        after_event_sequence: int = 0,
        limit: int = 500,
    ) -> JournalReplayResponse: ...

    def export(self, session_id: str) -> JournalExport: ...


@dataclass
class _SessionData:
    session_id: str
    created_at: datetime
    current: bool
    latest_snapshot_sequence: int
    simulation_time_seconds: float
    closed_at: datetime | None = None
    total_event_count: int = 0
    truncated_before_event_sequence: int = 0
    events: list[JournalEventRecord] = field(default_factory=list)
    checkpoints: list[JournalCheckpoint] = field(default_factory=list)
    bookmarks: dict[str, TimelineBookmark] = field(default_factory=dict)


class InMemoryEventJournal:
    """Thread-safe bounded journal retaining closed simulation sessions.

    Retention is deterministic and observable through session summaries.  Events
    are immutable; annotations are stored separately so replay data never changes.
    """

    def __init__(
        self,
        *,
        max_sessions: int = 20,
        max_events_per_session: int = 2_000,
        checkpoint_interval: int = 20,
        max_payload_bytes: int = 256 * 1024,
    ) -> None:
        if max_sessions < 1 or max_events_per_session < 1 or checkpoint_interval < 1 or max_payload_bytes < 512:
            raise ValueError("Journal retention settings are below safe minimums.")
        self.max_sessions = max_sessions
        self.max_events_per_session = max_events_per_session
        self.checkpoint_interval = checkpoint_interval
        self.max_payload_bytes = max_payload_bytes
        self._sessions: dict[str, _SessionData] = {}
        self._order: list[str] = []
        self._lock = threading.RLock()

    def start_session(
        self,
        session_id: str,
        snapshot: Snapshot,
        simulation_time_seconds: float,
    ) -> JournalSessionSummary:
        with self._lock:
            if session_id in self._sessions:
                raise JournalError("Session already exists in the journal.")
            now = utc_now()
            for item in self._sessions.values():
                if item.current:
                    item.current = False
                    item.closed_at = now
            data = _SessionData(
                session_id=session_id,
                created_at=now,
                current=True,
                latest_snapshot_sequence=snapshot.sequence,
                simulation_time_seconds=max(0.0, simulation_time_seconds),
            )
            data.checkpoints.append(self._checkpoint(snapshot, simulation_time_seconds, event_sequence=0))
            self._sessions[session_id] = data
            self._order.append(session_id)
            self._evict_sessions()
            return self._summary(data)

    def close_session(
        self,
        session_id: str,
        *,
        snapshot_sequence: int | None = None,
        simulation_time_seconds: float | None = None,
    ) -> JournalSessionSummary:
        with self._lock:
            data = self._get(session_id)
            data.current = False
            data.closed_at = data.closed_at or utc_now()
            if snapshot_sequence is not None:
                data.latest_snapshot_sequence = max(data.latest_snapshot_sequence, snapshot_sequence)
            if simulation_time_seconds is not None:
                data.simulation_time_seconds = max(0.0, simulation_time_seconds)
            return self._summary(data)

    def append(
        self,
        metadata: EventMetadata,
        payload: dict[str, Any],
        snapshot: Snapshot,
        simulation_time_seconds: float,
    ) -> JournalEventRecord:
        with self._lock:
            data = self._get(metadata.session_id)
            if not data.current:
                raise JournalTargetError("Cannot append an event to a closed session.")
            previous_sequence = (
                data.events[-1].metadata.event_sequence
                if data.events
                else data.truncated_before_event_sequence
            )
            if metadata.event_sequence <= previous_sequence:
                raise JournalTargetError("Event sequence must be strictly monotonic within the session.")
            if metadata.sequence != snapshot.sequence or snapshot.session_id != metadata.session_id:
                raise JournalTargetError("Event metadata and snapshot must belong to the same authoritative state.")

            raw_payload = _json_value(payload)
            payload_bytes = _canonical_bytes(raw_payload)
            truncated = len(payload_bytes) > self.max_payload_bytes
            stored_payload = raw_payload
            if truncated:
                stored_payload = {
                    "_truncated": True,
                    "original_size_bytes": len(payload_bytes),
                    "sha256": hashlib.sha256(payload_bytes).hexdigest(),
                    "keys": sorted(raw_payload.keys())[:50],
                }
            state = snapshot.model_dump(mode="json")
            recorded_at = utc_now()
            record = JournalEventRecord(
                metadata=metadata,
                snapshot_sequence=snapshot.sequence,
                simulation_time_seconds=max(0.0, simulation_time_seconds),
                recorded_at=recorded_at,
                state_checksum=state_checksum(state),
                payload_size_bytes=len(payload_bytes),
                payload_truncated=truncated,
                payload=stored_payload,
            )
            data.events.append(record)
            data.total_event_count += 1
            data.latest_snapshot_sequence = snapshot.sequence
            data.simulation_time_seconds = max(0.0, simulation_time_seconds)
            if metadata.event_sequence % self.checkpoint_interval == 0:
                data.checkpoints.append(
                    self._checkpoint(snapshot, simulation_time_seconds, event_sequence=metadata.event_sequence)
                )
            while len(data.events) > self.max_events_per_session:
                removed = data.events.pop(0)
                data.truncated_before_event_sequence = max(
                    data.truncated_before_event_sequence,
                    removed.metadata.event_sequence,
                )
            return record.model_copy(deep=True)

    def list_sessions(self, *, limit: int = 20) -> list[JournalSessionSummary]:
        with self._lock:
            session_ids = list(reversed(self._order))[:limit]
            return [self._summary(self._sessions[session_id]) for session_id in session_ids]

    def session(self, session_id: str) -> JournalSessionSummary:
        with self._lock:
            return self._summary(self._get(session_id))

    def advance_head(
        self,
        session_id: str,
        *,
        snapshot_sequence: int,
        simulation_time_seconds: float,
    ) -> None:
        """Update a session cursor without retaining high-frequency telemetry."""
        with self._lock:
            data = self._sessions.get(session_id)
            if data and data.current:
                data.latest_snapshot_sequence = max(data.latest_snapshot_sequence, snapshot_sequence)
                data.simulation_time_seconds = max(0.0, simulation_time_seconds)

    def events(
        self,
        session_id: str,
        *,
        after_event_sequence: int = 0,
        limit: int = 200,
        event_type: str | None = None,
    ) -> JournalEventPage:
        with self._lock:
            data = self._get(session_id)
            matching = [
                event for event in data.events
                if event.metadata.event_sequence > after_event_sequence
                and (event_type is None or event.metadata.event_type == event_type)
            ]
            selected = matching[:limit]
            has_more = len(matching) > len(selected)
            next_after = selected[-1].metadata.event_sequence if has_more and selected else None
            return JournalEventPage(
                session=self._summary(data),
                events=[event.model_copy(deep=True) for event in selected],
                next_after_event_sequence=next_after,
                has_more=has_more,
            )

    def replay(
        self,
        session_id: str,
        *,
        from_event_sequence: int = 1,
        to_event_sequence: int | None = None,
        after_event_sequence: int = 0,
        limit: int = 500,
    ) -> JournalReplayResponse:
        with self._lock:
            data = self._get(session_id)
            if to_event_sequence is not None and to_event_sequence < from_event_sequence:
                raise JournalTargetError("to_event_sequence must be greater than or equal to from_event_sequence.")

            target_before = max(0, from_event_sequence - 1)
            candidates = [item for item in data.checkpoints if item.event_sequence <= target_before]
            checkpoint = max(candidates, key=lambda item: item.event_sequence) if candidates else data.checkpoints[0]
            upper = to_event_sequence if to_event_sequence is not None else 2**63 - 1
            replay_events = [
                event for event in data.events
                if max(checkpoint.event_sequence, after_event_sequence) < event.metadata.event_sequence <= upper
            ]
            selected = replay_events[:limit]
            has_more = len(replay_events) > len(selected)
            next_after = selected[-1].metadata.event_sequence if has_more and selected else None
            complete = checkpoint.event_sequence >= data.truncated_before_event_sequence
            return JournalReplayResponse(
                session=self._summary(data),
                requested_from_event_sequence=from_event_sequence,
                requested_to_event_sequence=to_event_sequence,
                complete_from_requested_sequence=complete,
                checkpoint=checkpoint.model_copy(deep=True),
                events=[event.model_copy(deep=True) for event in selected],
                next_after_event_sequence=next_after,
                has_more=has_more,
            )

    def export(self, session_id: str) -> JournalExport:
        with self._lock:
            data = self._get(session_id)
            exported_at = utc_now()
            content = {
                "format_version": "smart-atc.session.v1",
                "exported_at": exported_at.isoformat(),
                "session": self._summary(data).model_dump(mode="json"),
                "events": [item.model_dump(mode="json") for item in data.events],
                "checkpoints": [item.model_dump(mode="json") for item in data.checkpoints],
                "bookmarks": [item.model_dump(mode="json") for item in data.bookmarks.values()],
            }
            return JournalExport(
                **content,
                manifest_checksum=state_checksum(content),
            )

    def list_bookmarks(self, session_id: str) -> list[TimelineBookmark]:
        with self._lock:
            data = self._get(session_id)
            return [item.model_copy(deep=True) for item in data.bookmarks.values()]

    def create_bookmark(self, session_id: str, request: BookmarkCreateRequest) -> TimelineBookmark:
        with self._lock:
            data = self._get(session_id)
            event = self._resolve_event_target(data, request.event_id, request.event_sequence)
            if event:
                event_id = event.metadata.event_id
                event_sequence = event.metadata.event_sequence
                snapshot_sequence = event.snapshot_sequence
            else:
                event_id = None
                event_sequence = None
                snapshot_sequence = (
                    request.snapshot_sequence
                    if request.snapshot_sequence is not None
                    else data.latest_snapshot_sequence
                )
            if snapshot_sequence > data.latest_snapshot_sequence:
                raise JournalTargetError("Bookmark snapshot_sequence is newer than the session.")
            now = utc_now()
            bookmark = TimelineBookmark(
                bookmark_id=str(uuid.uuid4()),
                session_id=session_id,
                event_id=event_id,
                event_sequence=event_sequence,
                snapshot_sequence=snapshot_sequence,
                title=request.title.strip(),
                annotation=request.annotation.strip(),
                category=request.category,
                tags=request.tags,
                created_by=request.created_by.strip(),
                created_at=now,
                updated_at=now,
            )
            data.bookmarks[bookmark.bookmark_id] = bookmark
            return bookmark.model_copy(deep=True)

    def update_bookmark(
        self,
        session_id: str,
        bookmark_id: str,
        request: BookmarkUpdateRequest,
    ) -> TimelineBookmark:
        with self._lock:
            data = self._get(session_id)
            existing = data.bookmarks.get(bookmark_id)
            if not existing:
                raise JournalBookmarkNotFound("Bookmark not found in this session.")
            changes = request.model_dump(exclude_none=True)
            if "title" in changes:
                changes["title"] = changes["title"].strip()
            if "annotation" in changes:
                changes["annotation"] = changes["annotation"].strip()
            changes["updated_at"] = utc_now()
            updated = TimelineBookmark.model_validate({
                **existing.model_dump(mode="python"),
                **changes,
            })
            data.bookmarks[bookmark_id] = updated
            return updated.model_copy(deep=True)

    def delete_bookmark(self, session_id: str, bookmark_id: str) -> None:
        with self._lock:
            data = self._get(session_id)
            if bookmark_id not in data.bookmarks:
                raise JournalBookmarkNotFound("Bookmark not found in this session.")
            del data.bookmarks[bookmark_id]

    def _resolve_event_target(
        self,
        data: _SessionData,
        event_id: str | None,
        event_sequence: int | None,
    ) -> JournalEventRecord | None:
        if event_id is None and event_sequence is None:
            return None
        matches = [
            event for event in data.events
            if (event_id is None or event.metadata.event_id == event_id)
            and (event_sequence is None or event.metadata.event_sequence == event_sequence)
        ]
        if not matches:
            raise JournalTargetError("Bookmark event is unavailable or does not belong to this session.")
        return matches[0]

    def _checkpoint(
        self,
        snapshot: Snapshot,
        simulation_time_seconds: float,
        *,
        event_sequence: int,
    ) -> JournalCheckpoint:
        state = snapshot.model_dump(mode="json")
        return JournalCheckpoint(
            checkpoint_id=str(uuid.uuid4()),
            session_id=snapshot.session_id,
            event_sequence=event_sequence,
            snapshot_sequence=snapshot.sequence,
            simulation_time_seconds=max(0.0, simulation_time_seconds),
            created_at=utc_now(),
            state_checksum=state_checksum(state),
            state=state,
        )

    def _summary(self, data: _SessionData) -> JournalSessionSummary:
        first = data.events[0].metadata.event_sequence if data.events else None
        last = data.events[-1].metadata.event_sequence if data.events else None
        return JournalSessionSummary(
            session_id=data.session_id,
            created_at=data.created_at,
            closed_at=data.closed_at,
            current=data.current,
            event_count=data.total_event_count,
            retained_event_count=len(data.events),
            checkpoint_count=len(data.checkpoints),
            bookmark_count=len(data.bookmarks),
            first_event_sequence=first,
            last_event_sequence=last,
            truncated_before_event_sequence=data.truncated_before_event_sequence,
            latest_snapshot_sequence=data.latest_snapshot_sequence,
            simulation_time_seconds=data.simulation_time_seconds,
        )

    def _get(self, session_id: str) -> _SessionData:
        data = self._sessions.get(session_id)
        if not data:
            raise JournalSessionNotFound("Session not found.")
        return data

    def _evict_sessions(self) -> None:
        while len(self._order) > self.max_sessions:
            candidate = self._order[0]
            data = self._sessions[candidate]
            if data.current:
                break
            self._order.pop(0)
            del self._sessions[candidate]
