from navigation import AirportCatalog, AirportResolutionError, RouteAutopilot, haversine_nm
from schemas import ManualAirport, RouteDemoRequest


def state():
    return {
        "connected": False, "lat": 0.0, "lon": 0.0, "altitude": 0.0,
        "ground_speed": 0.0, "true_airspeed": 0.0, "vertical_speed_fpm": 0.0,
        "heading_mag": 0.0, "on_ground": True, "atc_id": "", "atc_flight_number": "",
    }


def test_catalog_unknown_requires_honest_manual_coordinates():
    catalog = AirportCatalog()
    try:
        catalog.resolve("ZZZZ")
        assert False, "unknown airport should not receive invented coordinates"
    except AirportResolutionError:
        pass
    airport = catalog.resolve("ZZZZ", ManualAirport(name="Test field", lat=1.2, lon=3.4))
    assert airport.icao == "ZZZZ"
    assert airport.catalog_source == "manual"


def test_route_starts_at_origin_and_progresses_without_destination_teleport():
    catalog = AirportCatalog()
    autopilot = RouteAutopilot()
    aircraft = state()
    route = autopilot.create(RouteDemoRequest(
        origin_icao="VOMM", destination_icao="VABB", time_scale=20, auto_start=True,
    ), catalog, aircraft)
    assert aircraft["lat"] == route.origin.lat
    assert aircraft["lon"] == route.origin.lon
    assert haversine_nm(aircraft["lat"], aircraft["lon"], route.destination.lat, route.destination.lon) > 500
    targets = autopilot.targets(aircraft, 5.0)
    assert targets["phase"] in {"AT_GATE", "PUSHBACK", "TAXI", "HOLDING_SHORT"}
    assert 0 <= autopilot.to_state(aircraft).progress < 0.01


def test_long_route_uses_real_distance_and_bounded_profile():
    catalog = AirportCatalog()
    autopilot = RouteAutopilot()
    aircraft = state()
    route = autopilot.create(RouteDemoRequest(
        origin_icao="KLAX", destination_icao="RJTT", cruise_altitude_ft=39000,
    ), catalog, aircraft)
    assert 4500 < route.total_distance_nm < 5000
    assert route.cruise_altitude_ft == 39000
    assert route.eta_seconds and route.eta_seconds > 30000

