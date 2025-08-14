from aviation_numbers import parse_altitude, parse_frequency, parse_heading, parse_squawk, parse_speed
from clearances import ClearanceManager
from runtime import SimulationRuntime
import pytest


def test_spoken_aviation_numbers():
    assert parse_heading("turn left heading two seven zero") == 270
    assert parse_altitude("climb and maintain flight level three five zero") == 35000
    assert parse_altitude("descend to five thousand feet") == 5000
    assert parse_speed("reduce speed two one zero knots") == 210
    assert parse_squawk("squawk seven seven zero zero") == "7700"
    assert parse_frequency("contact tower on one one eight decimal one") == 118.1


def test_pilot_request_does_not_execute_until_issued_and_accepted():
    runtime = SimulationRuntime()
    start_heading = runtime.state["heading_mag"]
    request = runtime.clearances.record_request("request heading two seven zero", "EK547")
    assert request is not None
    runtime.tick_once(1.0)
    assert runtime.state["heading_mag"] == start_heading

    issued = runtime.clearances.issue_from_atc("EK547, turn left heading two seven zero", "EK547")
    assert issued is not None and issued.status == "issued"
    runtime.tick_once(1.0)
    assert runtime.state["heading_mag"] == start_heading

    with pytest.raises(ValueError, match="Readback mismatch"):
        runtime.accept_clearance(issued.clearance_id, "heading two six zero, EK547")

    runtime.accept_clearance(issued.clearance_id, "heading two seven zero, EK547")
    runtime.tick_once(1.0)
    assert runtime.state["heading_mag"] != start_heading


def test_airport_words_in_chat_have_no_position_side_effect():
    runtime = SimulationRuntime()
    position = runtime.state["lat"], runtime.state["lon"]
    runtime.clearances.record_request("request direct Mumbai VABB", "EK547")
    runtime.tick_once(0.0)
    assert (runtime.state["lat"], runtime.state["lon"]) == position
