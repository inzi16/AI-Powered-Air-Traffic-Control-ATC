from conflicts import predict_conflicts


def test_head_on_traffic_predicts_cpa_before_current_threshold():
    ownship = {
        "lat": 0.0, "lon": 0.0, "altitude": 10000, "ground_speed": 300,
        "heading_mag": 90, "vertical_speed_fpm": 0,
    }
    traffic = [{
        "callsign": "TST1", "type": "A320", "lat": 0.0, "lon": 0.2,
        "altitude": 10300, "heading": 270, "speed": 300,
        "vertical_speed_fpm": 0, "squawk": "2000", "on_ground": False,
        "range_nm": 12, "bearing": 90,
    }]
    conflicts = predict_conflicts(ownship, traffic, lookahead_seconds=600)
    assert len(conflicts) == 1
    assert conflicts[0].time_to_cpa_seconds > 0
    assert conflicts[0].cpa_distance_nm < 0.2
    assert conflicts[0].severity.value == "critical"


def test_diverging_traffic_is_not_a_predicted_conflict():
    ownship = {
        "lat": 0.0, "lon": 0.0, "altitude": 10000, "ground_speed": 300,
        "heading_mag": 270, "vertical_speed_fpm": 0,
    }
    traffic = [{
        "callsign": "TST2", "type": "A320", "lat": 0.0, "lon": 0.2,
        "altitude": 10300, "heading": 90, "speed": 300,
        "vertical_speed_fpm": 0, "squawk": "2000", "on_ground": False,
        "range_nm": 12, "bearing": 90,
    }]
    assert predict_conflicts(ownship, traffic) == []

