from flight_phase import FlightPhaseDetector


def test_high_elevation_initial_climb_uses_agl():
    detector = FlightPhaseDetector()
    phase = detector.get_phase_info({
        "on_ground": False, "altitude": 6500, "ground_speed": 180,
        "vertical_speed_fpm": 1400,
    }, field_elevation_ft=5558)
    assert phase["phase"] == "INITIAL_CLIMB"


def test_authoritative_route_phase_is_stable():
    detector = FlightPhaseDetector()
    state = {"on_ground": False, "altitude": 30000, "ground_speed": 400, "vertical_speed_fpm": -500}
    for _ in range(10):
        assert detector.get_phase_info(state, authoritative_phase="CRUISE")["phase"] == "CRUISE"

