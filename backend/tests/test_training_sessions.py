import asyncio
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import main
from schemas import TrainingSessionCreateRequest
from session_registry import SessionRegistry, TrainingSessionNotFound, TrainingSessionQuotaExceeded, utc_now


def _create_room(client: TestClient, name: str) -> str:
    response = client.post("/training-sessions", json={"name": name, "idle_timeout_seconds": 600})
    assert response.status_code == 201
    return response.json()["session_id"]


def _room_headers(session_id: str) -> dict[str, str]:
    return {"X-Session-ID": session_id}


def test_training_session_crud_default_compatibility_and_resolution_contract():
    with TestClient(main.app) as client:
        legacy = client.get("/sim/state")
        assert legacy.status_code == 200
        assert legacy.headers["X-Session-ID"] == "default"
        assert legacy.headers["X-Runtime-Session-ID"] == legacy.json()["session_id"]

        room_id = _create_room(client, "Approach training")
        listed = client.get("/training-sessions")
        assert listed.status_code == 200
        payload = listed.json()
        assert {item["session_id"] for item in payload["sessions"]} >= {"default", room_id}
        assert payload["quota"]["active_sessions"] >= 2
        assert payload["quota"]["remaining_sessions"] == (
            payload["quota"]["max_sessions"] - payload["quota"]["active_sessions"]
        )

        metadata = client.get(f"/training-sessions/{room_id}").json()
        assert metadata["name"] == "Approach training"
        assert metadata["is_default"] is False
        assert metadata["status"] == "running"
        assert metadata["idle_timeout_seconds"] == 600
        assert metadata["expires_at"] is not None
        assert metadata["journal_session_count"] == 1

        touched = client.post(f"/training-sessions/{room_id}/touch")
        assert touched.status_code == 200
        assert touched.json()["idle_seconds"] < 1

        by_header = client.get("/sim/state", headers=_room_headers(room_id))
        by_query = client.get("/sim/state", params={"session_id": room_id})
        assert by_header.status_code == by_query.status_code == 200
        assert by_header.json()["session_id"] == by_query.json()["session_id"]
        assert by_header.headers["X-Session-ID"] == room_id

        runtime_id_before_reset = by_header.json()["session_id"]
        reset = client.post("/session/reset", headers=_room_headers(room_id))
        assert reset.status_code == 200
        assert reset.headers["X-Session-ID"] == room_id
        assert reset.headers["X-Runtime-Session-ID"] != runtime_id_before_reset
        assert client.get(f"/training-sessions/{room_id}").json()["runtime_session_id"] == reset.headers["X-Runtime-Session-ID"]

        mismatch = client.get(
            "/sim/state",
            headers=_room_headers(room_id),
            params={"session_id": "default"},
        )
        assert mismatch.status_code == 400
        assert client.get("/sim/state", headers=_room_headers("missing-room")).status_code == 404
        assert client.delete("/training-sessions/default").status_code == 409

        deleted = client.delete(f"/training-sessions/{room_id}")
        assert deleted.status_code == 204
        assert client.get("/sim/state", headers=_room_headers(room_id)).status_code == 404


def test_two_rooms_isolate_route_emergency_runtime_and_journal_state():
    with TestClient(main.app) as client:
        room_a = _create_room(client, "Engine failure room")
        room_b = _create_room(client, "Normal route room")
        headers_a = _room_headers(room_a)
        headers_b = _room_headers(room_b)
        try:
            context_a = main.session_registry._sessions[room_a]
            context_b = main.session_registry._sessions[room_b]
            assert context_a.runtime is not context_b.runtime
            for attribute in ("route", "traffic", "weather", "clearances", "emergencies", "journal"):
                assert getattr(context_a.runtime, attribute) is not getattr(context_b.runtime, attribute)
            assert context_a.brain is not context_b.brain

            route_a = client.post("/routes/demo", headers=headers_a, json={
                "origin_icao": "VOMM",
                "destination_icao": "VABB",
                "callsign": "AI101",
                "time_scale": 10,
            })
            assert route_a.status_code == 200
            emergency_a = client.post("/emergencies/activate", headers=headers_a, json={
                "type": "engine_failure",
                "auto_divert": False,
            })
            assert emergency_a.status_code == 200

            untouched_b = client.get("/sim/state", headers=headers_b).json()
            assert untouched_b["callsign"] == ""
            assert untouched_b["route"] is None
            assert untouched_b["emergency"] is None
            assert untouched_b["emergency_active"] is False

            route_b = client.post("/routes/demo", headers=headers_b, json={
                "origin_icao": "EGLL",
                "destination_icao": "KJFK",
                "callsign": "BA202",
                "time_scale": 20,
            })
            assert route_b.status_code == 200
            state_a = client.get("/sim/state", headers=headers_a).json()
            state_b = client.get("/sim/state", headers=headers_b).json()
            assert state_a["callsign"] == "AI101"
            assert state_a["route"]["destination"]["icao"] == "VABB"
            assert state_a["emergency"]["type"] == "engine_failure"
            assert state_b["callsign"] == "BA202"
            assert state_b["route"]["destination"]["icao"] == "KJFK"
            assert state_b["emergency"] is None
            assert state_a["session_id"] != state_b["session_id"]

            journal_a = client.get(f"/sessions/{state_a['session_id']}/events", headers=headers_a).json()
            journal_b = client.get(f"/sessions/{state_b['session_id']}/events", headers=headers_b).json()
            types_a = [event["metadata"]["event_type"] for event in journal_a["events"]]
            types_b = [event["metadata"]["event_type"] for event in journal_b["events"]]
            assert types_a == ["route.created", "emergency.activated"]
            assert types_b == ["route.created"]
            assert client.get(f"/sessions/{state_a['session_id']}/events", headers=headers_b).status_code == 404
        finally:
            client.delete(f"/training-sessions/{room_a}")
            client.delete(f"/training-sessions/{room_b}")


def test_two_rooms_isolate_ai_history_requests_and_clearance_lifecycle(monkeypatch):
    async def fake_chat(self, message, _flight_state, _phase_info):
        if self.callsign == "AI303":
            reply = "AI303, climb and maintain flight level three five zero, heading two seven zero"
        else:
            reply = "BA404, climb and maintain flight level two eight zero, heading zero niner zero"
        return reply

    monkeypatch.setattr(main.ATCBrain, "chat", fake_chat)
    with TestClient(main.app) as client:
        room_a = _create_room(client, "AI room A")
        room_b = _create_room(client, "AI room B")
        headers_a = _room_headers(room_a)
        headers_b = _room_headers(room_b)
        try:
            assert client.post("/callsign", headers=headers_a, json={"callsign": "AI303"}).status_code == 200
            assert client.post("/callsign", headers=headers_b, json={"callsign": "BA404"}).status_code == 200
            chat_a = client.post("/chat", headers=headers_a, json={"message": "AI303 request higher"})
            chat_b = client.post("/chat", headers=headers_b, json={"message": "BA404 request higher"})
            assert chat_a.status_code == chat_b.status_code == 200
            clearance_a = chat_a.json()["clearance"]
            clearance_b = chat_b.json()["clearance"]
            assert clearance_a["callsign"] == "AI303"
            assert clearance_b["callsign"] == "BA404"
            assert clearance_a["clearance_id"] != clearance_b["clearance_id"]

            accepted_a = client.post(
                f"/clearances/{clearance_a['clearance_id']}/accept",
                headers=headers_a,
                json={"readback": "AI303 flight level three five zero, heading two seven zero"},
            )
            assert accepted_a.status_code == 200
            assert client.post(
                f"/clearances/{clearance_a['clearance_id']}/accept",
                headers=headers_b,
                json={"readback": "flight level three five zero, heading two seven zero"},
            ).status_code == 404

            clearances_a = client.get("/clearances", headers=headers_a).json()["clearances"]
            clearances_b = client.get("/clearances", headers=headers_b).json()["clearances"]
            assert any(item["clearance_id"] == clearance_a["clearance_id"] and item["status"] == "executing" for item in clearances_a)
            assert any(item["clearance_id"] == clearance_b["clearance_id"] and item["status"] == "issued" for item in clearances_b)
            assert all(item["clearance_id"] != clearance_b["clearance_id"] for item in clearances_a)

            metadata_a = client.get(f"/training-sessions/{room_a}").json()
            metadata_b = client.get(f"/training-sessions/{room_b}").json()
            assert metadata_a["ai_history_messages"] == 2
            assert metadata_b["ai_history_messages"] == 2
            context_a = main.session_registry._sessions[room_a]
            context_b = main.session_registry._sessions[room_b]
            assert context_a.brain is not context_b.brain
            assert context_a.brain.conversation_history == [
                {"role": "user", "content": "AI303 request higher"},
                {
                    "role": "assistant",
                    "content": "AI303, climb and maintain flight level three five zero, heading two seven zero",
                },
            ]
            assert context_b.brain.conversation_history == [
                {"role": "user", "content": "BA404 request higher"},
                {
                    "role": "assistant",
                    "content": "BA404, climb and maintain flight level two eight zero, heading zero niner zero",
                },
            ]
        finally:
            client.delete(f"/training-sessions/{room_a}")
            client.delete(f"/training-sessions/{room_b}")


def test_websocket_stream_is_resolved_to_the_selected_room():
    with TestClient(main.app) as client:
        room_a = _create_room(client, "WebSocket A")
        room_b = _create_room(client, "WebSocket B")
        headers_a = _room_headers(room_a)
        headers_b = _room_headers(room_b)
        try:
            client.post("/callsign", headers=headers_a, json={"callsign": "AI505"})
            client.post("/callsign", headers=headers_b, json={"callsign": "BA606"})
            state_a = client.get("/sim/state", headers=headers_a).json()
            state_b = client.get("/sim/state", headers=headers_b).json()

            with client.websocket_connect(f"/ws/state?session_id={room_a}") as websocket_a:
                stream_a = websocket_a.receive_json()
            with client.websocket_connect("/ws/state", headers=headers_b) as websocket_b:
                stream_b = websocket_b.receive_json()

            assert stream_a["session_id"] == state_a["session_id"]
            assert stream_a["callsign"] == "AI505"
            assert stream_b["session_id"] == state_b["session_id"]
            assert stream_b["callsign"] == "BA606"
            assert stream_a["session_id"] != stream_b["session_id"]
            assert client.get(f"/training-sessions/{room_a}").json()["connected_websocket_clients"] == 0
            assert client.get(f"/training-sessions/{room_b}").json()["connected_websocket_clients"] == 0
        finally:
            client.delete(f"/training-sessions/{room_a}")
            client.delete(f"/training-sessions/{room_b}")


def test_registry_enforces_total_session_quota_and_reports_idle_metadata():
    registry = SessionRegistry(max_sessions=2, default_idle_timeout_seconds=60, max_idle_timeout_seconds=120)

    async def exercise_registry():
        room = await registry.create(TrainingSessionCreateRequest(name="Quota room", idle_timeout_seconds=60))
        assert room.expires_at is not None
        assert room.idle_seconds < 1
        try:
            await registry.create(TrainingSessionCreateRequest(name="Over quota"))
            raise AssertionError("Expected session quota enforcement")
        except TrainingSessionQuotaExceeded:
            pass
        listing = await registry.list()
        assert listing.quota.active_sessions == 2
        assert listing.quota.remaining_sessions == 0
        await registry.delete(room.session_id)

        expiring = await registry.create(TrainingSessionCreateRequest(name="Idle room", idle_timeout_seconds=60))
        context = await registry.context_for_testing(expiring.session_id)
        context.last_accessed_at = utc_now() - timedelta(seconds=61)
        try:
            await registry.resolve(expiring.session_id)
            raise AssertionError("Expected idle session expiry")
        except TrainingSessionNotFound:
            pass

    asyncio.run(exercise_registry())


def test_authentication_precedes_room_existence_disclosure(monkeypatch):
    monkeypatch.setenv("ATC_API_KEY", "test-secret")
    with TestClient(main.app) as client:
        unauthenticated = client.get("/sim/state", headers=_room_headers("missing-room"))
        assert unauthenticated.status_code == 401
        authenticated = client.get("/sim/state", headers={
            "X-API-Key": "test-secret",
            "X-Session-ID": "missing-room",
        })
        assert authenticated.status_code == 404

        with pytest.raises(WebSocketDisconnect) as query_rejected:
            with client.websocket_connect("/ws/state?api_key=test-secret"):
                pass
        assert query_rejected.value.code == 4401

        with client.websocket_connect(
            "/ws/state",
            headers={"X-API-Key": "test-secret"},
        ) as websocket:
            assert websocket.receive_json()["schema_version"] == "3.0.0"


def test_production_startup_requires_a_strong_header_safe_api_key(monkeypatch):
    monkeypatch.setenv("ATC_ENV", " Production ")

    for unsafe_key, expected_message in (
        ("", "ATC_API_KEY is required"),
        ("short-nonempty-key", "at least 43 characters"),
        ("x" * 42, "at least 43 characters"),
        (("x" * 42) + " ", "whitespace-free ASCII token"),
        ("é" * 43, "whitespace-free ASCII token"),
    ):
        monkeypatch.setenv("ATC_API_KEY", unsafe_key)
        with pytest.raises(RuntimeError, match=expected_message):
            with TestClient(main.app):
                pass

    valid_key = "0123456789abcdef0123456789abcdef0123456789a"
    assert len(valid_key) == main.MIN_PRODUCTION_API_KEY_CHARACTERS
    monkeypatch.setenv("ATC_API_KEY", valid_key)
    with TestClient(main.app) as client:
        assert client.get("/sim/state", headers={"X-API-Key": valid_key}).status_code == 200
