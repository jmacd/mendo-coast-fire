import math
from collections import defaultdict

import pytest
from shapely.geometry import LineString, Point, box, mapping

from coast_fire.analysis import group_parcels
from coast_fire.network import (
    MILE,
    Network,
    access_allowed,
    adjacency,
    dijkstra,
    parcel_distance,
    source_seeds,
)


def test_exact_five_miles_and_same_edge_without_visiting_endpoint():
    edges = [[0, 1, 20000, 3]]
    starts = [[0, 0.5, 0]]
    distances = dijkstra(adjacency([0, 1], edges), source_seeds(edges, starts), 5 * MILE)
    assert all(math.isinf(distance) for distance in distances)
    start_map = {0: [(0.5, 0)]}
    endpoint = 0.5 + 5 * MILE / 20000
    assert parcel_distance(edges, distances, [[0, endpoint, endpoint]], start_map) == pytest.approx(
        5 * MILE
    )
    assert (
        parcel_distance(edges, distances, [[0, endpoint + 0.001, endpoint + 0.001]], start_map)
        > 5 * MILE
    )


def test_one_way_and_connector_cost():
    edges = [[0, 1, 1000, 1]]
    starts = [[0, 0.5, 25]]
    distances = dijkstra(adjacency([0, 1], edges), source_seeds(edges, starts), 1000)
    assert parcel_distance(edges, distances, [[0, 0.4, 0.4]], {0: [(0.5, 25)]}) == math.inf
    assert parcel_distance(edges, distances, [[0, 0.6, 0.6]], {0: [(0.5, 25)]}) == pytest.approx(
        125
    )
    reverse = dijkstra(adjacency([0, 1], edges, reverse=True), [(1, 0)], 1000)
    assert reverse == [1000, 0]


def test_detour_not_euclidean_distance_and_disconnected_roads():
    edges = [[0, 1, 4000, 3], [1, 2, 4100, 3], [3, 4, 50, 3]]
    distances = dijkstra(adjacency(range(5), edges), [(0, 0)], 5 * MILE)
    assert parcel_distance(edges, distances, [[1, 1, 1]], {}) > 5 * MILE
    assert parcel_distance(edges, distances, [[2, 0, 1]], {}) == math.inf


def test_multiple_stations_and_frontages_take_shortest_route():
    edges = [[0, 1, 100, 3], [1, 2, 100, 3]]
    starts = [[0, 0, 10], [1, 0.75, 0]]
    distances = dijkstra(adjacency(range(3), edges), source_seeds(edges, starts), 500)
    indexed = defaultdict(list)
    for edge, fraction, gap in starts:
        indexed[edge].append((fraction, gap))
    assert parcel_distance(
        edges, distances, [[0, 0.5, 0.6], [1, 0.8, 0.9]], indexed
    ) == pytest.approx(5)


def test_motor_vehicle_access_precedence():
    assert not access_allowed({"access": "private"})
    assert access_allowed({"access": "private", "motor_vehicle": "yes"})
    assert not access_allowed({"access": "yes", "motor_vehicle": "no"})
    assert access_allowed({"access": "destination"})


def test_osm_crossings_do_not_connect_and_reverse_oneway_is_preserved():
    study = {"highway_south": 39, "highway_north": 40, "distance_miles": 5}
    osm = {
        "elements": [
            {"type": "node", "id": 1, "lon": -123.8, "lat": 39.3},
            {"type": "node", "id": 2, "lon": -123.7, "lat": 39.3},
            {"type": "node", "id": 3, "lon": -123.75, "lat": 39.25},
            {"type": "node", "id": 4, "lon": -123.75, "lat": 39.35},
            {"type": "way", "id": 10, "nodes": [1, 2], "tags": {"ref": "CA 1"}},
            {"type": "way", "id": 11, "nodes": [3, 4], "tags": {"oneway": "-1"}},
            {"type": "way", "id": 12, "nodes": [1, 3], "tags": {"access": "private"}},
        ]
    }
    network = Network(osm, study)
    assert len(network.edges) == 2
    assert network.edges[1][3] == 2
    assert network.to_highway[2:] == [math.inf, math.inf]
    assert network.diagnostics["restricted_ways_excluded"] == 1


def test_parcel_access_preserves_separate_intervals_on_one_road():
    network = Network.__new__(Network)
    network.lines = [LineString([(0, 0), (1000, 0)])]
    from shapely import STRtree

    network.tree = STRtree(network.lines)
    parcel = box(100, -10, 200, 10).union(box(800, -10, 900, 10))
    accesses = network.parcel_access(parcel, 0)
    assert accesses == [[0, 0.1, 0.2], [0, 0.8, 0.9]]
    assert network.snap(Point(500, 101), 100) is None


def test_count_duplicate_apns_once_but_keep_missing_apns_distinct():
    features = [
        {
            "properties": {"FID": i, "APNFULL": apn},
            "geometry": mapping(box(-123.8 + i * 0.001, 39.3, -123.799 + i * 0.001, 39.301)),
        }
        for i, apn in enumerate(["123", "123", None, None])
    ]
    parcels = group_parcels(features, box(-1e7, -1e7, 1e7, 1e7))
    assert [apn for apn, _, _, _ in parcels] == ["123", "FID:2", "FID:3"]


def test_inferred_parcel_connector_counts_on_same_edge_and_via_endpoint():
    edges = [[0, 1, 20000, 3]]
    limit = 5 * MILE
    distances = dijkstra(adjacency(range(2), edges), source_seeds(edges, [[0, 0.5, 25]]), limit)
    starts = {0: [(0.5, 25)]}
    assert parcel_distance(edges, distances, [[0, 0.5, 0.5, limit - 25]], starts) == limit
    assert parcel_distance(edges, distances, [[0, 0.5, 0.5, limit - 24]], starts) > limit
    edges = [[0, 1, 5000, 3], [1, 2, 5000, 3]]
    distances = dijkstra(adjacency(range(3), edges), [(0, 0)], limit)
    assert parcel_distance(edges, distances, [[1, 0.6, 0.6, 100]], {}) == 8100
