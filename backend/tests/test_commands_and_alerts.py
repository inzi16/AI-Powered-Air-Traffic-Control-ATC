import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

import main
from command_ledger import CommandLedger, CommandRejected
from runtime import SimulationRuntime
from schemas import CommandRequestMetadata, TrainingSessionCreateRequest
from session_registry import SessionRegistry


def _command(
    command_id: str,
    expected_sequence: int,
    expected_revision: int,
    *,
    expired: bool = False,
) -> CommandRequestMetadata:
    now = datetime.now(timezone.utc)
    issued_at = now - timedelta(minutes=2) if expired else now
    expires_at = now - timedelta(minutes=1) if expired else now + timedelta(minutes=5)
    return CommandRequestMetadata(
        command_id=command_id,
        idempotency_key=f"idem:{command_id}",
        expected_sequence=expected_sequence,
        expected_revision=expected_revision,
        issued_at=issued_at,
        expires_at=expires_at,
        actor="test-controller",
    )


def _event_response(runtime: SimulationRuntime, event_type: str, data: dict) -> dict:
    return runtime.record_event(event_type, data).model_dump(mode="json")


def test_one_hundred_concurrent_retries_execute_exactly_once():
    runtime = SimulationRuntime()
    ledger = CommandLedger(max_entries=200)
    command = _command("command-concurrent-001", runtime.sequence, runtime.state_revision)
    executions = 0

    async def executor(_metadata):
        nonlocal executions
        executions += 1
        await asyncio.sleep(0.005)
        runtime.callsign = "AI100"
        runtime.advance_state_revision()
        runtime.tick_once(0.0)
        return _event_response(runtime, "callsign.updated", {"callsign": runtime.callsign})

    async def run():
        return await asyncio.gather(*(
            ledger.execute(
                command,
                operation="callsign.set",
                payload={"callsign": "AI100"},
                runtime=runtime,
                executor=executor,
            )
            for _ in range(100)
        ))

    responses = asyncio.run(run())
    assert executions == 1
    assert runtime.callsign == "AI100"
    assert len({response["event"]["event_id"] for response in responses}) == 1
    assert sum(response["command"]["deduplicated"] is False for response in responses) == 1
    assert sum(response["command"]["deduplicated"] is True for response in responses) == 99
    audit = asyncio.run(ledger.get(command.command_id))
    assert audit.status == "succeeded"
    assert audit.deduplicated_count == 99
    assert audit.sequence_before == command.expected_sequence
    assert audit.sequence_after == command.expected_sequence + 1
    assert audit.revision_before == command.expected_revision
    assert audit.revision_after == command.expected_revision + 1


def test_heartbeat_latency_is_accepted_but_stale_and_expired_mutations_are_rejected():
    runtime = SimulationRuntime()
    ledger = CommandLedger()
    initial_snapshot = runtime.current_snapshot()
    executions = 0

    async def executor(_metadata):
        nonlocal executions
        executions += 1
        runtime.callsign = "MUTATED"
        runtime.advance_state_revision()
        runtime.tick_once(0.0)
        return _event_response(runtime, "callsign.updated", {"callsign": runtime.callsign})

    async def reject(command):
        with pytest.raises(CommandRejected) as captured:
            await ledger.execute(
                command,
                operation="callsign.set",
                payload={"callsign": "MUTATED"},
                runtime=runtime,
                executor=executor,
            )
        return captured.value

    # Three 5 Hz heartbeats model 600 ms of network/UI latency. The delivered
    # snapshot remains safe because no semantic mutation committed meanwhile.
    runtime.tick_once(0.2)
    runtime.tick_once(0.2)
    runtime.tick_once(0.2)
    accepted = asyncio.run(ledger.execute(
        _command("command-latency-001", initial_snapshot.sequence, initial_snapshot.state_revision),
        operation="callsign.set",
        payload={"callsign": "MUTATED"},
        runtime=runtime,
        executor=executor,
    ))
    assert accepted["command"]["revision_before"] == initial_snapshot.state_revision
    assert accepted["command"]["revision_after"] == initial_snapshot.state_revision + 1
    committed_snapshot = runtime.current_snapshot()

    stale = asyncio.run(reject(_command(
        "command-stale-001",
        initial_snapshot.sequence,
        initial_snapshot.state_revision,
    )))
    assert stale.code == "stale_revision"
    assert stale.current_sequence == committed_snapshot.sequence
    assert stale.current_revision == committed_snapshot.state_revision
    expired = asyncio.run(reject(_command(
        "command-expired-001",
        committed_snapshot.sequence,
        committed_snapshot.state_revision,
        expired=True,
    )))
    assert expired.code == "command_expired"
    assert expired.current_sequence == committed_snapshot.sequence
    assert executions == 1
    assert runtime.callsign == "MUTATED"
    assert runtime.sequence == committed_snapshot.sequence
    assert runtime.event_sequence == 1


def test_same_command_identity_is_scoped_per_training_room():
    registry = SessionRegistry(max_sessions=3, default_idle_timeout_seconds=60, max_idle_timeout_seconds=120)

    async def run():
        room_a = await registry.create(TrainingSessionCreateRequest(name="Command A"))
        room_b = await registry.create(TrainingSessionCreateRequest(name="Command B"))
        context_a = await registry.context_for_testing(room_a.session_id)
        context_b = await registry.context_for_testing(room_b.session_id)
        command = _command(
            "command-shared-001",
            context_a.runtime.sequence,
            context_a.runtime.state_revision,
        )

        def executor_for(context, callsign):
            async def executor(_metadata):
                context.runtime.callsign = callsign
                context.runtime.advance_state_revision()
                context.runtime.tick_once(0.0)
                return _event_response(context.runtime, "callsign.updated", {"callsign": callsign})
            return executor

        response_a = await context_a.commands.execute(
            command,
            operation="callsign.set",
            payload={"callsign": "AI111"},
            runtime=context_a.runtime,
            executor=executor_for(context_a, "AI111"),
        )
        response_b = await context_b.commands.execute(
            command,
            operation="callsign.set",
            payload={"callsign": "BA222"},
            runtime=context_b.runtime,
            executor=executor_for(context_b, "BA222"),
        )
        return context_a, context_b, response_a, response_b

    context_a, context_b, response_a, response_b = asyncio.run(run())
    assert context_a.runtime.callsign == "AI111"
    assert context_b.runtime.callsign == "BA222"
    assert response_a["command"]["deduplicated"] is False
    assert response_b["command"]["deduplicated"] is False
    assert context_a.commands.count == context_b.commands.count == 1


def test_legacy_and_explicit_http_commands_have_additive_receipts_and_audit():
    with TestClient(main.app) as client:
        room = client.post("/training-sessions", json={"name": "Command API"}).json()["session_id"]
        headers = {"X-Session-ID": room}
        try:
            legacy = client.post("/callsign", headers=headers, json={"callsign": "AI701"})
            assert legacy.status_code == 200
            legacy_receipt = legacy.json()["command"]
            assert legacy_receipt["legacy"] is True
            assert legacy_receipt["deduplicated"] is False
            assert legacy_receipt["operation"] == "callsign.set"

            current = client.get("/sim/state", headers=headers).json()
            now = datetime.now(timezone.utc)
            envelope = {
                "command_id": "command-http-stale-001",
                "idempotency_key": "idem:command-http-stale-001",
                "expected_sequence": 0,
                "expected_revision": current["state_revision"],
                "issued_at": now.isoformat(),
                "expires_at": (now + timedelta(minutes=5)).isoformat(),
                "actor": "http-test",
            }
            stale = client.post("/callsign", headers=headers, json={
                "callsign": "SHOULDNOTSET",
                "command": envelope,
            })
            assert stale.status_code == 409
            detail = stale.json()["detail"]
            assert detail["code"] == "snapshot_revision_unavailable"
            assert detail["current_sequence"] >= current["sequence"]
            assert detail["current_revision"] == current["state_revision"]
            assert client.get("/sim/state", headers=headers).json()["callsign"] == "AI701"

            audit = client.get("/commands", headers=headers).json()
            assert audit["retained_count"] == 2
            assert {item["status"] for item in audit["commands"]} == {"succeeded", "rejected"}
            status = client.get(f"/commands/{legacy_receipt['command_id']}", headers=headers)
            assert status.status_code == 200
            assert status.json()["legacy"] is True
            assert client.get(f"/commands/{legacy_receipt['command_id']}").status_code == 404
        finally:
            client.delete(f"/training-sessions/{room}")


def test_alert_acknowledgement_is_persistent_idempotent_and_evented_once():
    with TestClient(main.app) as client:
        room = client.post("/training-sessions", json={"name": "Alert ACK"}).json()["session_id"]
        headers = {"X-Session-ID": room}
        try:
            activated = client.post("/emergencies/activate", headers=headers, json={
                "type": "engine_failure",
                "auto_divert": False,
            })
            assert activated.status_code == 200
            state = client.get("/sim/state", headers=headers).json()
            alert = next(item for item in state["alerts"] if item["category"] == "emergency")
            alert_id = alert["alert_id"]
            assert alert["acknowledged"] is False

            first = client.post(f"/alerts/{alert_id}/ack", headers=headers, json={"actor": "instructor"})
            duplicate = client.post(f"/alerts/{alert_id}/ack", headers=headers, json={"actor": "instructor"})
            assert first.status_code == duplicate.status_code == 200
            assert first.json()["changed"] is True
            assert first.json()["event"]["event_type"] == "alert.acknowledged"
            assert duplicate.json()["changed"] is False
            assert duplicate.json()["event"] is None
            assert duplicate.json()["acknowledgement"] == first.json()["acknowledgement"]
            acknowledged = client.get("/sim/state", headers=headers).json()
            persisted = next(item for item in acknowledged["alerts"] if item["alert_id"] == alert_id)
            assert persisted["acknowledged"] is True
            assert persisted["acknowledged_by"] == "instructor"

            runtime_session_id = acknowledged["session_id"]
            ack_events = client.get(
                f"/sessions/{runtime_session_id}/events",
                headers=headers,
                params={"event_type": "alert.acknowledged"},
            ).json()["events"]
            assert len(ack_events) == 1
            assert ack_events[0]["payload"]["alert_id"] == alert_id

            unack = client.post(f"/alerts/{alert_id}/unack", headers=headers, json={"actor": "supervisor"})
            duplicate_unack = client.post(f"/alerts/{alert_id}/unack", headers=headers, json={"actor": "supervisor"})
            assert unack.json()["changed"] is True
            assert duplicate_unack.json()["changed"] is False
            final_state = client.get("/sim/state", headers=headers).json()
            final_alert = next(item for item in final_state["alerts"] if item["alert_id"] == alert_id)
            assert final_alert["acknowledged"] is False
            assert final_alert["acknowledged_at"] is None
        finally:
            client.delete(f"/training-sessions/{room}")


def test_route_creation_uses_revision_bound_idempotent_command_ledger():
    with TestClient(main.app) as client:
        room = client.post("/training-sessions", json={"name": "Route command"}).json()["session_id"]
        headers = {"X-Session-ID": room}
        try:
            initial = client.get("/sim/state", headers=headers).json()
            command = _command(
                "command-route-create-001",
                initial["sequence"],
                initial["state_revision"],
            ).model_dump(mode="json")
            request = {
                "origin_icao": "VOMM",
                "destination_icao": "VABB",
                "callsign": "AI801",
                "time_scale": 10,
                "command": command,
            }

            first = client.post("/routes/demo", headers=headers, json=request)
            duplicate = client.post("/routes/demo", headers=headers, json=request)
            assert first.status_code == duplicate.status_code == 200
            first_body = first.json()
            duplicate_body = duplicate.json()
            assert first_body["event"]["event_id"] == duplicate_body["event"]["event_id"]
            assert first_body["data"]["route"]["route_id"] == duplicate_body["data"]["route"]["route_id"]
            assert first_body["command"]["operation"] == "route.create"
            assert first_body["command"]["legacy"] is False
            assert first_body["command"]["deduplicated"] is False
            assert duplicate_body["command"]["deduplicated"] is True
            assert first_body["command"]["revision_after"] == initial["state_revision"] + 1

            after_route = client.get("/sim/state", headers=headers).json()
            stale_command = _command(
                "command-route-create-stale-001",
                after_route["sequence"],
                after_route["state_revision"],
            ).model_dump(mode="json")
            assert client.post("/callsign", headers=headers, json={"callsign": "AI802"}).status_code == 200
            stale = client.post("/routes/demo", headers=headers, json={
                "origin_icao": "EGLL",
                "destination_icao": "KJFK",
                "command": stale_command,
            })
            assert stale.status_code == 409
            assert stale.json()["detail"]["code"] == "stale_revision"
            unchanged = client.get("/sim/state", headers=headers).json()
            assert unchanged["route"]["destination"]["icao"] == "VABB"

            events = client.get(
                f"/sessions/{unchanged['session_id']}/events",
                headers=headers,
                params={"event_type": "route.created"},
            ).json()["events"]
            assert len(events) == 1
            audit = client.get(
                "/commands/command-route-create-001",
                headers=headers,
            ).json()
            assert audit["status"] == "succeeded"
            assert audit["deduplicated_count"] == 1
        finally:
            client.delete(f"/training-sessions/{room}")


def test_get_session_reset_is_non_mutating_gone_and_hidden_from_openapi():
    client = TestClient(main.app)
    room = client.post("/training-sessions", json={"name": "Safe reset"}).json()["session_id"]
    headers = {"X-Session-ID": room}
    try:
        assert client.post("/callsign", headers=headers, json={"callsign": "AI901"}).status_code == 200
        before = client.get("/sim/state", headers=headers).json()
        command_count_before = client.get("/commands", headers=headers).json()["retained_count"]

        rejected = client.get("/session/reset", headers=headers)
        assert rejected.status_code == 410
        assert rejected.headers["allow"] == "POST"
        assert rejected.headers["deprecation"] == "true"
        assert "use POST" in rejected.json()["detail"]

        after = client.get("/sim/state", headers=headers).json()
        assert after["session_id"] == before["session_id"]
        assert after["state_revision"] == before["state_revision"]
        assert after["callsign"] == "AI901"
        assert client.get("/commands", headers=headers).json()["retained_count"] == command_count_before
        assert set(main.app.openapi()["paths"]["/session/reset"]) == {"post"}
    finally:
        client.delete(f"/training-sessions/{room}")
