from fastapi.testclient import TestClient

import main


def test_snapshot_and_route_contracts_are_available_over_http():
    with TestClient(main.app) as client:
        assert client.post("/session/reset").status_code == 200
        state = client.get("/sim/state")
        assert state.status_code == 200
        payload = state.json()
        assert payload["schema_version"] == "3.0.0"
        assert payload["session_id"]
        assert isinstance(payload["sequence"], int)
        assert payload["observed_at"].endswith("Z")
        assert payload["server_time"].endswith("Z")

        response = client.post("/routes/demo", json={
            "origin_icao": "VOMM",
            "destination_icao": "VABB",
            "time_scale": 20,
            "callsign": "6E204",
        })
        assert response.status_code == 200
        event = response.json()
        assert event["event"]["event_type"] == "route.created"
        assert event["data"]["route"]["destination"]["icao"] == "VABB"


def test_websocket_opens_with_the_same_authoritative_snapshot_contract():
    with TestClient(main.app) as client:
        assert client.post("/session/reset").status_code == 200
        http_snapshot = client.get("/sim/state").json()

        with client.websocket_connect("/ws/state") as websocket:
            stream_snapshot = websocket.receive_json()

        assert stream_snapshot["schema_version"] == "3.0.0"
        assert stream_snapshot["session_id"] == http_snapshot["session_id"]
        assert stream_snapshot["snapshot_id"] == http_snapshot["snapshot_id"]
        assert stream_snapshot["sequence"] == http_snapshot["sequence"]


def test_unknown_airport_is_rejected_without_manual_coordinates():
    with TestClient(main.app) as client:
        client.post("/session/reset")
        response = client.post("/routes/demo", json={
            "origin_icao": "VOMM",
            "destination_icao": "ZZZZ",
        })
        assert response.status_code == 422
        assert "manual coordinates" in response.json()["detail"]


def test_emergency_actions_and_resolution_are_structured():
    with TestClient(main.app) as client:
        client.post("/session/reset")
        catalog = client.get("/emergencies/catalog")
        assert catalog.status_code == 200
        assert len(catalog.json()["emergencies"]) == 8
        response = client.post("/emergencies/activate", json={
            "type": "engine_failure",
            "auto_divert": False,
        })
        assert response.status_code == 200
        emergency = response.json()["data"]["emergency"]
        assert [action["category"] for action in emergency["actions"]] == [
            "stabilize", "navigate", "communicate", "divert", "land",
        ]
        blocked = client.post(f"/emergencies/{emergency['emergency_id']}/resolve", json={})
        assert blocked.status_code == 409
