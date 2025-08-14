import pytest

from emergencies import EMERGENCY_CATALOG, EmergencyManager
from navigation import AirportCatalog
from runtime import DEFAULT_STATE


EXPECTED = {"engine_failure", "medical", "hydraulic", "bird_strike", "fuel", "comm_failure", "smoke_fire", "gear"}


def test_complete_deterministic_emergency_catalog():
    assert set(EMERGENCY_CATALOG) == EXPECTED
    for definition in EMERGENCY_CATALOG.values():
        assert [step[0] for step in definition.steps] == ["stabilize", "navigate", "communicate", "divert", "land"]


@pytest.mark.parametrize("kind", sorted(EXPECTED))
def test_activation_has_alert_actions_and_squawk(kind):
    manager = EmergencyManager()
    state = dict(DEFAULT_STATE)
    emergency = manager.activate(kind, state, AirportCatalog())
    assert emergency.status == "active"
    assert emergency.alert_message
    assert len(emergency.actions) == 5
    assert state["squawk"] == emergency.squawk
    assert emergency.recommended_diversion is not None


def test_resolution_requires_actions_and_landing():
    manager = EmergencyManager()
    state = dict(DEFAULT_STATE)
    state["on_ground"] = False
    emergency = manager.activate("engine_failure", state, AirportCatalog())
    with pytest.raises(PermissionError):
        manager.resolve(state)
    for action in emergency.actions:
        manager.complete_action(action.action_id, True, state)
    assert manager.active and not manager.active.can_resolve
    state["on_ground"] = True
    manager.refresh(state)
    assert manager.active and manager.active.can_resolve
    resolved = manager.resolve(state)
    assert resolved.status == "resolved"
    assert state["squawk"] == "2000"

