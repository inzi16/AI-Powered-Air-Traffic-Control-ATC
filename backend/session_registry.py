"""In-process training-room registry with isolated simulation and AI state."""

from __future__ import annotations

import asyncio
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable

try:
    from .atc_brain import ATCBrain
    from .command_ledger import CommandLedger
    from .runtime import SimulationRuntime
    from .schemas import (
        TrainingSessionCreateRequest,
        TrainingSessionList,
        TrainingSessionMetadata,
        TrainingSessionQuotaState,
    )
except ImportError:  # pragma: no cover - direct module execution compatibility
    from atc_brain import ATCBrain
    from command_ledger import CommandLedger
    from runtime import SimulationRuntime
    from schemas import (
        TrainingSessionCreateRequest,
        TrainingSessionList,
        TrainingSessionMetadata,
        TrainingSessionQuotaState,
    )


DEFAULT_TRAINING_SESSION_ID = "default"
SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class TrainingSessionError(RuntimeError):
    pass


class TrainingSessionNotFound(TrainingSessionError):
    pass


class TrainingSessionConflict(TrainingSessionError):
    pass


class TrainingSessionQuotaExceeded(TrainingSessionError):
    pass


class InvalidTrainingSessionId(TrainingSessionError):
    pass


RuntimeFactory = Callable[[str, bool], SimulationRuntime]


@dataclass
class TrainingSessionContext:
    session_id: str
    name: str
    is_default: bool
    runtime: SimulationRuntime
    brain: ATCBrain
    brain_lock: asyncio.Lock
    commands: CommandLedger
    created_at: datetime
    last_accessed_at: datetime
    idle_timeout_seconds: int
    active_requests: int = 0
    websocket_clients: int = 0


class SessionRegistry:
    """Owns isolated runtime/brain pairs and their lifecycle.

    The registry is deliberately in-process for SC-001. Its public metadata and
    stable room IDs are independent from SimulationRuntime.session_id, which may
    rotate when a room resets its exercise and journal timeline.
    """

    def __init__(
        self,
        runtime_factory: RuntimeFactory | None = None,
        *,
        max_sessions: int = 25,
        default_idle_timeout_seconds: int = 3_600,
        max_idle_timeout_seconds: int = 86_400,
        max_websocket_clients_per_session: int = 8,
        max_commands_per_session: int = 500,
        sweep_interval_seconds: float = 30.0,
    ) -> None:
        if max_sessions < 1:
            raise ValueError("max_sessions must be at least one.")
        if default_idle_timeout_seconds < 60:
            raise ValueError("default_idle_timeout_seconds must be at least 60.")
        if max_idle_timeout_seconds < default_idle_timeout_seconds:
            raise ValueError("max_idle_timeout_seconds must not be below the default.")
        if max_websocket_clients_per_session < 1:
            raise ValueError("max_websocket_clients_per_session must be at least one.")
        if max_commands_per_session < 1:
            raise ValueError("max_commands_per_session must be at least one.")
        self.max_sessions = max_sessions
        self.default_idle_timeout_seconds = default_idle_timeout_seconds
        self.max_idle_timeout_seconds = max_idle_timeout_seconds
        self.max_websocket_clients_per_session = max_websocket_clients_per_session
        self.max_commands_per_session = max_commands_per_session
        self.sweep_interval_seconds = max(0.05, sweep_interval_seconds)
        self._runtime_factory = runtime_factory or (lambda _session_id, _is_default: SimulationRuntime())
        self._sessions: dict[str, TrainingSessionContext] = {}
        self._lock = asyncio.Lock()
        self._running = False
        self._sweeper: asyncio.Task | None = None

        now = utc_now()
        default_context = TrainingSessionContext(
            session_id=DEFAULT_TRAINING_SESSION_ID,
            name="Legacy default room",
            is_default=True,
            runtime=self._runtime_factory(DEFAULT_TRAINING_SESSION_ID, True),
            brain=ATCBrain(),
            brain_lock=asyncio.Lock(),
            commands=CommandLedger(max_entries=max_commands_per_session),
            created_at=now,
            last_accessed_at=now,
            idle_timeout_seconds=0,
        )
        self._sessions[default_context.session_id] = default_context

    @property
    def default_context(self) -> TrainingSessionContext:
        return self._sessions[DEFAULT_TRAINING_SESSION_ID]

    async def start(self) -> None:
        async with self._lock:
            if self._running:
                return
            self._running = True
            contexts = list(self._sessions.values())
        await asyncio.gather(*(context.runtime.start() for context in contexts))
        self._sweeper = asyncio.create_task(self._sweep_loop(), name="training-session-idle-sweeper")

    async def stop(self) -> None:
        async with self._lock:
            if not self._running:
                return
            self._running = False
            sweeper = self._sweeper
            self._sweeper = None
            contexts = list(self._sessions.values())
        if sweeper:
            sweeper.cancel()
            try:
                await sweeper
            except asyncio.CancelledError:
                pass
        await asyncio.gather(*(context.runtime.stop() for context in contexts))

    async def create(self, request: TrainingSessionCreateRequest) -> TrainingSessionMetadata:
        idle_timeout = request.idle_timeout_seconds or self.default_idle_timeout_seconds
        if idle_timeout > self.max_idle_timeout_seconds:
            raise TrainingSessionQuotaExceeded(
                f"idle_timeout_seconds exceeds the configured maximum of {self.max_idle_timeout_seconds}."
            )
        async with self._lock:
            if len(self._sessions) >= self.max_sessions:
                raise TrainingSessionQuotaExceeded(f"Training-session quota of {self.max_sessions} is exhausted.")
            session_id = str(uuid.uuid4())
            now = utc_now()
            context = TrainingSessionContext(
                session_id=session_id,
                name=request.name,
                is_default=False,
                runtime=self._runtime_factory(session_id, False),
                brain=ATCBrain(),
                brain_lock=asyncio.Lock(),
                commands=CommandLedger(max_entries=self.max_commands_per_session),
                created_at=now,
                last_accessed_at=now,
                idle_timeout_seconds=idle_timeout,
            )
            self._sessions[session_id] = context
            should_start = self._running
        if should_start:
            try:
                await context.runtime.start()
            except Exception:
                async with self._lock:
                    self._sessions.pop(session_id, None)
                raise
        return self._metadata(context)

    async def list(self) -> TrainingSessionList:
        async with self._lock:
            sessions = sorted(self._sessions.values(), key=lambda item: item.created_at)
            return TrainingSessionList(
                sessions=[self._metadata(context) for context in sessions],
                quota=self._quota(),
            )

    async def metadata(self, session_id: str) -> TrainingSessionMetadata:
        normalized = self.validate_session_id(session_id)
        async with self._lock:
            context = self._sessions.get(normalized)
            if not context:
                raise TrainingSessionNotFound("Training session not found.")
            return self._metadata(context)

    async def resolve(self, session_id: str | None, *, touch: bool = True) -> TrainingSessionContext:
        normalized = self.validate_session_id(session_id or DEFAULT_TRAINING_SESSION_ID)
        expired: TrainingSessionContext | None = None
        async with self._lock:
            context = self._sessions.get(normalized)
            if not context:
                raise TrainingSessionNotFound("Training session not found.")
            if (
                not context.is_default
                and context.active_requests == 0
                and context.websocket_clients == 0
                and self._is_expired(context)
            ):
                expired = self._sessions.pop(normalized)
            else:
                if touch:
                    context.last_accessed_at = utc_now()
                return context
        if expired:
            await expired.runtime.stop()
        raise TrainingSessionNotFound("Training session expired due to inactivity.")

    async def touch(self, session_id: str) -> TrainingSessionMetadata:
        context = await self.resolve(session_id, touch=True)
        return self._metadata(context)

    async def acquire_request(self, session_id: str | None) -> TrainingSessionContext:
        context = await self.resolve(session_id, touch=True)
        async with self._lock:
            current = self._sessions.get(context.session_id)
            if current is not context:
                raise TrainingSessionNotFound("Training session is no longer available.")
            context.active_requests += 1
            return context

    async def release_request(self, context: TrainingSessionContext) -> None:
        async with self._lock:
            context.active_requests = max(0, context.active_requests - 1)
            if context.session_id in self._sessions:
                context.last_accessed_at = utc_now()

    async def delete(self, session_id: str) -> None:
        normalized = self.validate_session_id(session_id)
        if normalized == DEFAULT_TRAINING_SESSION_ID:
            raise TrainingSessionConflict("The legacy default training session cannot be deleted.")
        async with self._lock:
            context = self._sessions.get(normalized)
            if not context:
                raise TrainingSessionNotFound("Training session not found.")
            if context.active_requests or context.websocket_clients:
                raise TrainingSessionConflict("Wait for active requests and disconnect WebSocket clients before deleting this training session.")
            self._sessions.pop(normalized)
        await context.runtime.stop()

    async def acquire_websocket(self, session_id: str | None) -> TrainingSessionContext:
        context = await self.resolve(session_id, touch=True)
        async with self._lock:
            current = self._sessions.get(context.session_id)
            if current is not context:
                raise TrainingSessionNotFound("Training session is no longer available.")
            if context.websocket_clients >= self.max_websocket_clients_per_session:
                raise TrainingSessionQuotaExceeded("WebSocket client quota is exhausted for this training session.")
            context.websocket_clients += 1
            return context

    async def release_websocket(self, context: TrainingSessionContext) -> None:
        async with self._lock:
            context.websocket_clients = max(0, context.websocket_clients - 1)
            if context.session_id in self._sessions:
                context.last_accessed_at = utc_now()

    async def context_for_testing(self, session_id: str) -> TrainingSessionContext:
        """Return the resolved context for isolation assertions without exposing mutation APIs."""
        return await self.resolve(session_id, touch=False)

    def validate_session_id(self, session_id: str) -> str:
        normalized = session_id.strip()
        if not SESSION_ID_PATTERN.fullmatch(normalized):
            raise InvalidTrainingSessionId(
                "Training session IDs must contain 1-64 letters, numbers, underscores, or hyphens."
            )
        return normalized

    def _metadata(self, context: TrainingSessionContext) -> TrainingSessionMetadata:
        now = utc_now()
        idle_seconds = max(0.0, (now - context.last_accessed_at).total_seconds())
        expires_at = None
        if not context.is_default:
            expires_at = context.last_accessed_at + timedelta(seconds=context.idle_timeout_seconds)
        emergency = context.runtime.emergencies.active
        return TrainingSessionMetadata(
            session_id=context.session_id,
            name=context.name,
            is_default=context.is_default,
            status="running" if context.runtime.running else "stopped",
            created_at=context.created_at,
            last_accessed_at=context.last_accessed_at,
            idle_timeout_seconds=context.idle_timeout_seconds,
            idle_seconds=round(idle_seconds, 3),
            expires_at=expires_at,
            runtime_session_id=context.runtime.session_id,
            snapshot_sequence=context.runtime.sequence,
            active_requests=context.active_requests,
            connected_websocket_clients=context.websocket_clients,
            callsign=context.runtime.callsign,
            route_id=context.runtime.route.route_id,
            emergency_id=(
                emergency.emergency_id
                if emergency and emergency.status != "resolved"
                else None
            ),
            ai_history_messages=len(context.brain.conversation_history),
            journal_session_count=len(
                context.runtime.journal.list_sessions(limit=context.runtime.journal.max_sessions)
            ),
            command_count=context.commands.count,
        )

    def _quota(self) -> TrainingSessionQuotaState:
        active = len(self._sessions)
        return TrainingSessionQuotaState(
            max_sessions=self.max_sessions,
            active_sessions=active,
            remaining_sessions=max(0, self.max_sessions - active),
            default_idle_timeout_seconds=self.default_idle_timeout_seconds,
            max_idle_timeout_seconds=self.max_idle_timeout_seconds,
            max_websocket_clients_per_session=self.max_websocket_clients_per_session,
            max_commands_per_session=self.max_commands_per_session,
        )

    def _is_expired(self, context: TrainingSessionContext) -> bool:
        if context.is_default:
            return False
        return utc_now() >= context.last_accessed_at + timedelta(seconds=context.idle_timeout_seconds)

    async def _sweep_loop(self) -> None:
        while self._running:
            await asyncio.sleep(self.sweep_interval_seconds)
            expired: list[TrainingSessionContext] = []
            async with self._lock:
                for session_id, context in tuple(self._sessions.items()):
                    if (
                        not context.is_default
                        and context.active_requests == 0
                        and context.websocket_clients == 0
                        and self._is_expired(context)
                    ):
                        expired.append(self._sessions.pop(session_id))
            if expired:
                await asyncio.gather(*(context.runtime.stop() for context in expired))
