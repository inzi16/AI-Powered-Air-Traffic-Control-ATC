from fastapi.testclient import TestClient

import main
from runtime import SimulationRuntime
from schemas import RouteDemoRequest


def test_pause_freezes_authoritative_simulation_but_not_snapshot_heartbeat():
    runtime = SimulationRuntime()
    runtime.route.create(RouteDemoRequest(
        origin_icao="VOMM",
        destination_icao="VABB",
        time_scale=10,
    ), runtime.catalog, runtime.state)
    moving = runtime.tick_once(2.0)

    runtime.set_control(paused=True)
    paused = runtime.tick_once(100.0)
    assert paused.sequence == moving.sequence + 1
    assert paused.lat == moving.lat
    assert paused.lon == moving.lon
    assert paused.altitude == moving.altitude
    assert paused.ground_speed == moving.ground_speed
    assert paused.scenario_control.simulation_time_seconds == moving.scenario_control.simulation_time_seconds
    assert paused.scenario_control.status == "paused"

    runtime.set_control(paused=False)
    resumed = runtime.tick_once(1.0)
    assert resumed.scenario_control.status == "running"
    assert resumed.scenario_control.simulation_time_seconds == moving.scenario_control.simulation_time_seconds + 10


def test_global_time_scale_controls_non_route_simulation_clock():
    runtime = SimulationRuntime()
    baseline = runtime.simulation_time_seconds
    runtime.set_control(time_scale=2.5)
    snapshot = runtime.tick_once(4.0)
    assert snapshot.scenario_control.time_scale == 2.5
    assert snapshot.scenario_control.simulation_time_seconds == baseline + 10


def test_control_journal_replay_export_and_bookmark_http_contracts():
    with TestClient(main.app) as client:
        reset = client.post("/session/reset")
        assert reset.status_code == 200
        session_id = reset.json()["event"]["session_id"]

        scaled = client.post("/scenario/time-scale", json={"time_scale": 8})
        paused = client.post("/scenario/pause")
        assert scaled.status_code == 200
        assert paused.status_code == 200
        assert paused.json()["data"]["control"]["status"] == "paused"
        control = client.get("/scenario/control").json()
        assert control["time_scale"] == 8
        assert control["paused"] is True

        events = client.get(f"/sessions/{session_id}/events", params={"limit": 2}).json()
        assert events["session"]["session_id"] == session_id
        assert events["has_more"] is True
        assert [item["metadata"]["event_type"] for item in events["events"]] == [
            "session.reset", "scenario.time_scale_changed",
        ]
        next_page = client.get(
            f"/sessions/{session_id}/events",
            params={"after_event_sequence": events["next_after_event_sequence"]},
        ).json()
        assert next_page["events"][0]["metadata"]["event_type"] == "scenario.paused"

        pause_event = paused.json()["event"]
        bookmark_response = client.post(f"/sessions/{session_id}/bookmarks", json={
            "event_id": pause_event["event_id"],
            "event_sequence": pause_event["event_sequence"],
            "title": "Emergency pause",
            "annotation": "Discuss controller priorities",
            "category": "training",
            "tags": ["CRM", "Pause"],
        })
        assert bookmark_response.status_code == 201
        bookmark = bookmark_response.json()
        assert bookmark["session_id"] == session_id
        assert bookmark["tags"] == ["crm", "pause"]

        patched = client.patch(
            f"/sessions/{session_id}/bookmarks/{bookmark['bookmark_id']}",
            json={"annotation": "Reviewed"},
        )
        assert patched.status_code == 200
        assert patched.json()["annotation"] == "Reviewed"

        replay = client.get(f"/sessions/{session_id}/replay", params={"limit": 2}).json()
        assert replay["checkpoint"]["event_sequence"] == 0
        assert replay["has_more"] is True
        replay_page_2 = client.get(f"/sessions/{session_id}/replay", params={
            "limit": 2,
            "after_event_sequence": replay["next_after_event_sequence"],
        }).json()
        assert replay_page_2["events"][0]["metadata"]["event_type"] == "scenario.paused"

        exported = client.get(f"/sessions/{session_id}/export")
        assert exported.status_code == 200
        assert exported.headers["content-type"].startswith("application/vnd.smart-atc.session+json")
        assert "attachment" in exported.headers["content-disposition"]
        assert "smart-atc-" in exported.headers["content-disposition"]
        assert exported.json()["format_version"] == "smart-atc.session.v1"
        assert len(exported.json()["manifest_checksum"]) == 64

        deleted = client.delete(f"/sessions/{session_id}/bookmarks/{bookmark['bookmark_id']}")
        assert deleted.status_code == 204


def test_reset_keeps_old_session_readable_and_rejects_cross_session_targets():
    with TestClient(main.app) as client:
        first = client.post("/session/reset").json()
        old_session = first["event"]["session_id"]
        event = client.post("/scenario/pause").json()["event"]
        new_session = client.post("/session/reset").json()["event"]["session_id"]

        assert new_session != old_session
        old_summary = client.get(f"/sessions/{old_session}")
        assert old_summary.status_code == 200
        assert old_summary.json()["current"] is False
        assert client.get(f"/sessions/{old_session}/export").status_code == 200

        cross_session = client.post(f"/sessions/{new_session}/bookmarks", json={
            "event_id": event["event_id"],
            "event_sequence": event["event_sequence"],
            "title": "Wrong session",
        })
        assert cross_session.status_code == 422
        assert client.get("/sessions/not-a-session").status_code == 404


def test_control_validation_is_strict():
    with TestClient(main.app) as client:
        client.post("/session/reset")
        assert client.post("/scenario/control", json={}).status_code == 422
        assert client.post("/scenario/time-scale", json={"time_scale": 0}).status_code == 422
        assert client.post("/scenario/time-scale", json={"time_scale": 121}).status_code == 422
        assert client.post("/sessions/bad/bookmarks", json={"title": "   "}).status_code in {404, 422}
