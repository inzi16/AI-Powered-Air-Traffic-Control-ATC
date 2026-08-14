"""Revision-bound, bounded idempotency ledger for one training room."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

try:
    from .schemas import (
        CommandAuditPage,
        CommandAuditRecord,
        CommandReceipt,
        CommandRequestMetadata,
    )
except ImportError:  # pragma: no cover
    from schemas import CommandAuditPage, CommandAuditRecord, CommandReceipt, CommandRequestMetadata


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def payload_checksum(operation: str, payload: dict[str, Any]) -> str:
    encoded = json.dumps(
        {"operation": operation, "payload": payload},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class CommandLedgerError(RuntimeError):
    pass


class CommandNotFound(CommandLedgerError):
    pass


class CommandRejected(CommandLedgerError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        command_id: str | None,
        expected_sequence: int | None,
        expected_revision: int | None,
        current_sequence: int,
        current_revision: int,
        status_code: int = 409,
        original_detail: Any = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.command_id = command_id
        self.expected_sequence = expected_sequence
        self.expected_revision = expected_revision
        self.current_sequence = current_sequence
        self.current_revision = current_revision
        self.status_code = status_code
        self.original_detail = original_detail

    def detail(self) -> dict[str, Any]:
        detail: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "command_id": self.command_id,
            "expected_sequence": self.expected_sequence,
            "current_sequence": self.current_sequence,
            "expected_revision": self.expected_revision,
            "current_revision": self.current_revision,
        }
        if self.original_detail is not None:
            detail["cause"] = self.original_detail
        return detail


@dataclass
class _StoredCommand:
    request: CommandRequestMetadata
    operation: str
    checksum: str
    audit: CommandAuditRecord
    response: dict[str, Any] | None = None
    error_status_code: int = 409
    error_detail: Any = None


CommandExecutor = Callable[[CommandRequestMetadata], Awaitable[dict[str, Any]]]


class CommandLedger:
    """Serializes revision checks and mutations, caching successful responses."""

    def __init__(self, *, max_entries: int = 500) -> None:
        if max_entries < 1:
            raise ValueError("max_entries must be at least one.")
        self.max_entries = max_entries
        self._entries: OrderedDict[str, _StoredCommand] = OrderedDict()
        self._by_idempotency_key: dict[str, str] = {}
        self._lock = asyncio.Lock()

    @property
    def count(self) -> int:
        return len(self._entries)

    async def execute(
        self,
        command: CommandRequestMetadata | None,
        *,
        operation: str,
        payload: dict[str, Any],
        runtime: Any,
        executor: CommandExecutor,
    ) -> dict[str, Any]:
        checksum = payload_checksum(operation, payload)
        async with self._lock:
            if command is not None:
                existing = self._find_existing(command)
                if existing:
                    return self._replay_or_reject(existing, command, operation, checksum, runtime)

            async with runtime.lock:
                current_sequence = int(runtime.sequence)
                current_revision = int(runtime.state_revision)
                now = utc_now()
                legacy = command is None
                if command is None:
                    generated_id = str(uuid.uuid4())
                    command = CommandRequestMetadata(
                        command_id=generated_id,
                        idempotency_key=f"legacy:{generated_id}",
                        expected_sequence=current_sequence,
                        expected_revision=current_revision,
                        issued_at=now,
                        expires_at=now + timedelta(minutes=5),
                        actor="legacy-api",
                    )
                rejection = self._validate(command, runtime, now)
                if rejection:
                    code, message = rejection
                    self._store_rejection(
                        command,
                        operation,
                        checksum,
                        legacy,
                        current_sequence,
                        current_revision,
                        code,
                        message,
                    )
                    raise CommandRejected(
                        code,
                        message,
                        command_id=command.command_id,
                        expected_sequence=command.expected_sequence,
                        expected_revision=command.expected_revision,
                        current_sequence=current_sequence,
                        current_revision=current_revision,
                    )

                received_at = utc_now()
                audit = CommandAuditRecord(
                    command=command,
                    operation=operation,
                    payload_checksum=checksum,
                    status="pending",
                    legacy=legacy,
                    deduplicated_count=0,
                    received_at=received_at,
                    sequence_before=current_sequence,
                    revision_before=current_revision,
                )
                stored = _StoredCommand(command, operation, checksum, audit)
                self._store(stored)
                try:
                    response = await executor(command)
                except Exception as exc:
                    status_code = int(getattr(exc, "status_code", 500))
                    original_detail = getattr(exc, "detail", None)
                    error_detail = self._safe_error_detail(original_detail if original_detail is not None else str(exc))
                    stored.error_status_code = status_code
                    stored.error_detail = original_detail
                    stored.audit = stored.audit.model_copy(update={
                        "status": "rejected",
                        "completed_at": utc_now(),
                        "sequence_after": int(runtime.sequence),
                        "revision_after": int(runtime.state_revision),
                        "error_code": "execution_rejected",
                        "error_detail": error_detail,
                    })
                    raise

                executed_at = utc_now()
                sequence_after = int(runtime.sequence)
                revision_after = int(runtime.state_revision)
                event_id = None
                if isinstance(response.get("event"), dict):
                    event_id = response["event"].get("event_id")
                receipt = CommandReceipt(
                    command_id=command.command_id,
                    idempotency_key=command.idempotency_key,
                    operation=operation,
                    expected_sequence=command.expected_sequence,
                    expected_revision=command.expected_revision,
                    sequence_before=current_sequence,
                    sequence_after=sequence_after,
                    revision_before=current_revision,
                    revision_after=revision_after,
                    issued_at=command.issued_at,
                    expires_at=command.expires_at,
                    executed_at=executed_at,
                    actor=command.actor,
                    legacy=legacy,
                    deduplicated=False,
                )
                response = copy.deepcopy(response)
                response["command"] = receipt.model_dump(mode="json")
                stored.response = copy.deepcopy(response)
                stored.audit = stored.audit.model_copy(update={
                    "status": "succeeded",
                    "completed_at": executed_at,
                    "sequence_after": sequence_after,
                    "revision_after": revision_after,
                    "response_event_id": event_id,
                })
                return response

    async def list(
        self,
        *,
        limit: int = 100,
        status: str | None = None,
        operation: str | None = None,
    ) -> CommandAuditPage:
        async with self._lock:
            records = [stored.audit for stored in reversed(self._entries.values())]
            if status:
                records = [record for record in records if record.status == status]
            if operation:
                records = [record for record in records if record.operation == operation]
            return CommandAuditPage(
                commands=[record.model_copy(deep=True) for record in records[:limit]],
                retained_count=len(self._entries),
                max_retained=self.max_entries,
            )

    async def get(self, command_id: str) -> CommandAuditRecord:
        async with self._lock:
            stored = self._entries.get(command_id)
            if not stored:
                raise CommandNotFound("Command not found in this training room.")
            return stored.audit.model_copy(deep=True)

    async def get_by_idempotency_key(self, idempotency_key: str) -> CommandAuditRecord:
        async with self._lock:
            command_id = self._by_idempotency_key.get(idempotency_key)
            stored = self._entries.get(command_id) if command_id else None
            if not stored:
                raise CommandNotFound("Idempotency key not found in this training room.")
            return stored.audit.model_copy(deep=True)

    def _find_existing(self, command: CommandRequestMetadata) -> _StoredCommand | None:
        by_id = self._entries.get(command.command_id)
        keyed_id = self._by_idempotency_key.get(command.idempotency_key)
        by_key = self._entries.get(keyed_id) if keyed_id else None
        if by_id and by_key and by_id is not by_key:
            return by_id
        return by_id or by_key

    def _replay_or_reject(
        self,
        stored: _StoredCommand,
        command: CommandRequestMetadata,
        operation: str,
        checksum: str,
        runtime: Any,
    ) -> dict[str, Any]:
        current_sequence = int(runtime.sequence)
        current_revision = int(runtime.state_revision)
        if stored.request != command or stored.operation != operation or stored.checksum != checksum:
            raise CommandRejected(
                "idempotency_conflict",
                "command_id or idempotency_key was already used for a different command.",
                command_id=command.command_id,
                expected_sequence=command.expected_sequence,
                expected_revision=command.expected_revision,
                current_sequence=current_sequence,
                current_revision=current_revision,
            )
        stored.audit = stored.audit.model_copy(update={
            "deduplicated_count": stored.audit.deduplicated_count + 1,
        })
        if stored.audit.status == "succeeded" and stored.response is not None:
            response = copy.deepcopy(stored.response)
            response["command"]["deduplicated"] = True
            return response
        raise CommandRejected(
            stored.audit.error_code or "command_rejected",
            stored.audit.error_detail or "Command was previously rejected.",
            command_id=command.command_id,
            expected_sequence=command.expected_sequence,
            expected_revision=command.expected_revision,
            current_sequence=current_sequence,
            current_revision=current_revision,
            status_code=stored.error_status_code,
            original_detail=stored.error_detail,
        )

    @staticmethod
    def _validate(
        command: CommandRequestMetadata,
        runtime: Any,
        now: datetime,
    ) -> tuple[str, str] | None:
        issued_at = command.issued_at.astimezone(timezone.utc)
        expires_at = command.expires_at.astimezone(timezone.utc)
        if issued_at > now + timedelta(minutes=5):
            return "command_not_yet_valid", "issued_at is more than five minutes in the future."
        if expires_at <= now:
            return "command_expired", "The command envelope has expired."
        current_sequence = int(runtime.sequence)
        current_revision = int(runtime.state_revision)
        if command.expected_sequence > current_sequence:
            return (
                "future_snapshot",
                f"Expected snapshot sequence {command.expected_sequence} is ahead of current sequence {current_sequence}.",
            )
        observed_revision = runtime.revision_for_sequence(command.expected_sequence)
        if observed_revision is None:
            return (
                "snapshot_revision_unavailable",
                "The expected snapshot is no longer retained; refresh state before retrying.",
            )
        if observed_revision != command.expected_revision:
            return (
                "envelope_revision_mismatch",
                f"Snapshot sequence {command.expected_sequence} carried revision {observed_revision}, not {command.expected_revision}.",
            )
        if command.expected_revision != current_revision:
            return (
                "stale_revision",
                f"Expected state revision {command.expected_revision}, current revision is {current_revision}.",
            )
        return None

    def _store_rejection(
        self,
        command: CommandRequestMetadata,
        operation: str,
        checksum: str,
        legacy: bool,
        current_sequence: int,
        current_revision: int,
        code: str,
        message: str,
    ) -> None:
        now = utc_now()
        audit = CommandAuditRecord(
            command=command,
            operation=operation,
            payload_checksum=checksum,
            status="rejected",
            legacy=legacy,
            deduplicated_count=0,
            received_at=now,
            completed_at=now,
            sequence_before=current_sequence,
            sequence_after=current_sequence,
            revision_before=current_revision,
            revision_after=current_revision,
            error_code=code,
            error_detail=message,
        )
        self._store(_StoredCommand(command, operation, checksum, audit))

    def _store(self, stored: _StoredCommand) -> None:
        self._entries[stored.request.command_id] = stored
        self._by_idempotency_key[stored.request.idempotency_key] = stored.request.command_id
        while len(self._entries) > self.max_entries:
            command_id, removed = self._entries.popitem(last=False)
            if self._by_idempotency_key.get(removed.request.idempotency_key) == command_id:
                del self._by_idempotency_key[removed.request.idempotency_key]

    @staticmethod
    def _safe_error_detail(detail: Any) -> str:
        if isinstance(detail, str):
            return detail[:2_000]
        try:
            return json.dumps(detail, ensure_ascii=False, sort_keys=True, default=str)[:2_000]
        except Exception:
            return "Command execution rejected."
