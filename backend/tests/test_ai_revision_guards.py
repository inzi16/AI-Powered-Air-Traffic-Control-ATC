from __future__ import annotations

import asyncio
import hashlib

import pytest
from fastapi import HTTPException

import main
from schemas import CallsignRequest, ChatRequest, ScenarioRequest, TrainingSessionCreateRequest


def _discarded_event(context, event_type: str):
    page = context.runtime.journal.events(
        context.runtime.session_id,
        event_type=event_type,
    )
    assert len(page.events) == 1
    return page.events[0]


def test_chat_discards_delayed_ai_clearance_after_authoritative_revision_change():
    async def exercise() -> None:
        room = await main.session_registry.create(
            TrainingSessionCreateRequest(name="Delayed chat revision guard")
        )
        context = await main.session_registry.context_for_testing(room.session_id)
        entered_ai = asyncio.Event()
        release_ai = asyncio.Event()
        reply = "GUARD71, turn left heading two seven zero"

        async def delayed_chat(_message: str, _flight_state: dict, _phase: dict) -> str:
            entered_ai.set()
            await release_ai.wait()
            return reply

        context.brain.chat = delayed_chat
        token = main._training_context.set(context)
        task: asyncio.Task | None = None
        try:
            clearances_before = context.runtime.clearances.list()
            task = asyncio.create_task(main.chat(ChatRequest(message="Hello controller")))
            await asyncio.wait_for(entered_ai.wait(), timeout=2.0)

            expected_session_id = context.runtime.session_id
            expected_revision = context.runtime.state_revision
            mutation = await main.set_callsign(CallsignRequest(callsign="GUARD71"))
            revision_after_mutation = context.runtime.state_revision
            assert mutation["event"]["event_type"] == "callsign.updated"
            assert revision_after_mutation == expected_revision + 1

            release_ai.set()
            with pytest.raises(HTTPException) as caught:
                await task

            assert caught.value.status_code == 409
            assert context.runtime.session_id == expected_session_id
            assert context.runtime.state_revision == revision_after_mutation
            assert context.runtime.current_snapshot().state_revision == revision_after_mutation
            assert context.runtime.clearances.list() == clearances_before
            assert context.runtime.clearances.latest_issued() is None
            assert context.brain.conversation_history == []

            discarded = _discarded_event(context, "chat.response_discarded")
            assert discarded.metadata.state_revision == revision_after_mutation
            assert discarded.payload == {
                "reason": ["state_revision_changed"],
                "scenario_id": None,
                "expected_session_id": expected_session_id,
                "current_session_id": expected_session_id,
                "expected_state_revision": expected_revision,
                "current_state_revision": revision_after_mutation,
                "reply_sha256": hashlib.sha256(reply.encode("utf-8")).hexdigest(),
                "reply_length": len(reply),
                "clearance_committed": False,
            }
        finally:
            release_ai.set()
            if task is not None and not task.done():
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
            main._training_context.reset(token)
            await main.session_registry.delete(room.session_id)

    asyncio.run(exercise())


def test_scenario_load_discards_delayed_ai_clearance_after_authoritative_revision_change():
    async def exercise() -> None:
        room = await main.session_registry.create(
            TrainingSessionCreateRequest(name="Delayed scenario revision guard")
        )
        context = await main.session_registry.context_for_testing(room.session_id)
        entered_ai = asyncio.Event()
        release_ai = asyncio.Event()
        reply = "GUARD72, pushback approved"

        async def delayed_chat(_message: str, _flight_state: dict, _phase: dict) -> str:
            entered_ai.set()
            await release_ai.wait()
            return reply

        context.brain.chat = delayed_chat
        token = main._training_context.set(context)
        task: asyncio.Task | None = None
        try:
            task = asyncio.create_task(
                main.load_scenario(ScenarioRequest(scenario_id="ground_taxi"))
            )
            await asyncio.wait_for(entered_ai.wait(), timeout=2.0)

            expected_session_id = context.runtime.session_id
            expected_revision = context.runtime.state_revision
            clearances_before = context.runtime.clearances.list()
            mutation = await main.set_callsign(CallsignRequest(callsign="GUARD72"))
            revision_after_mutation = context.runtime.state_revision
            assert mutation["event"]["event_type"] == "callsign.updated"
            assert revision_after_mutation == expected_revision + 1

            release_ai.set()
            with pytest.raises(HTTPException) as caught:
                await task

            assert caught.value.status_code == 409
            assert context.runtime.session_id == expected_session_id
            assert context.runtime.state_revision == revision_after_mutation
            assert context.runtime.current_snapshot().state_revision == revision_after_mutation
            assert context.runtime.clearances.list() == clearances_before
            assert context.runtime.clearances.latest_issued() is None
            assert context.brain.conversation_history == []

            discarded = _discarded_event(context, "scenario.response_discarded")
            assert discarded.metadata.state_revision == revision_after_mutation
            assert discarded.payload == {
                "reason": ["state_revision_changed"],
                "scenario_id": "ground_taxi",
                "expected_session_id": expected_session_id,
                "current_session_id": expected_session_id,
                "expected_state_revision": expected_revision,
                "current_state_revision": revision_after_mutation,
                "reply_sha256": hashlib.sha256(reply.encode("utf-8")).hexdigest(),
                "reply_length": len(reply),
                "clearance_committed": False,
            }

            event_types = [
                event.metadata.event_type
                for event in context.runtime.journal.events(expected_session_id).events
            ]
            assert event_types == [
                "scenario.loaded",
                "callsign.updated",
                "scenario.response_discarded",
            ]
        finally:
            release_ai.set()
            if task is not None and not task.done():
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
            main._training_context.reset(token)
            await main.session_registry.delete(room.session_id)

    asyncio.run(exercise())


def test_scenario_load_commits_exchange_only_after_successful_guard():
    async def exercise() -> None:
        room = await main.session_registry.create(
            TrainingSessionCreateRequest(name="Successful scenario history commit")
        )
        context = await main.session_registry.context_for_testing(room.session_id)
        initial = "Chennai Ground, Emirates 547, request pushback and start."
        reply = "EK547, pushback approved, face south"

        async def deterministic_chat(_message: str, _flight_state: dict, _phase: dict) -> str:
            assert _message == initial
            assert context.brain.conversation_history == []
            return reply

        context.brain.chat = deterministic_chat
        token = main._training_context.set(context)
        try:
            response = await main.load_scenario(ScenarioRequest(scenario_id="ground_taxi"))
            assert response["atc_reply"] == reply
            assert context.brain.conversation_history == [
                {"role": "user", "content": initial},
                {"role": "assistant", "content": reply},
            ]
        finally:
            main._training_context.reset(token)
            await main.session_registry.delete(room.session_id)

    asyncio.run(exercise())
