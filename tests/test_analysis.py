import json
import tomllib
from pathlib import Path

import pytest
from shapely.geometry import box, mapping

from coast_fire.analysis import analyze, group_parcels, zoning_status
from coast_fire.network import MILE


@pytest.mark.parametrize(
    ("zones", "expected"),
    [
        (["RR", "R1"], "residential"),
        ([" r-r "], "residential"),
        (["RL", "TPZ"], "other"),
        (["RC", "MMU"], "other"),
        (["RR", "TP"], "unknown"),
        (["RR", ""], "unknown"),
        ([""], "unknown"),
        (["RR5 [RR1]"], "unknown"),
        (["UNRECOGNIZED"], "unknown"),
    ],
)
def test_zoning_requires_confirmed_residential_codes_on_every_part(zones, expected):
    assert zoning_status(zones, ["RR", "R1"]) == expected


@pytest.fixture
def analysis_inputs(monkeypatch):
    config = tomllib.loads(Path("config/mendocino.toml").read_text())
    config["additional_stations"] = []
    parcels = [
        {
            "properties": {"FID": index, "APNFULL": apn, "BASEZONE": zone, "IMPV": value},
            "geometry": mapping(box(lon, lat, lon + 0.001, lat + 0.0001)),
        }
        for index, (apn, zone, value, lon, lat) in enumerate(
            [
                ("0", "RR", 10000, -123.79, 39.3),
                ("1", "R1", 10000, -123.702, 39.3),
                ("2", "RL", 100000, -123.702, 39.3002),
                ("3", None, 100000, -123.704, 39.2998),
                ("4", "RR", 10000, -123.75, 39.31),
                ("5", "RR", 10000, -123.75, 39.305),
                ("6", "RR", 10000, -123.704, 39.3),
                ("6", "TP", 10000, -123.706, 39.3),
                ("7", "RR", 10000, -123.702, 39.31),
                ("8", "RR", 9999, -123.75, 39.31),
                ("9", "RR", None, -123.75, 39.31),
                ("A", "RR", 6000, -123.79, 39.3),
                ("A", "RR", 8000, -123.78, 39.3),
            ]
        )
    ]
    sources = {
        "parcels": {"features": parcels},
        "stations": {"features": []},
        "osm_stations": {"elements": [{"type": "node", "id": 20, "lon": -123.8, "lat": 39.3}]},
        "roads": {
            "elements": [
                {"type": "node", "id": 1, "lon": -123.8, "lat": 39.3},
                {"type": "node", "id": 2, "lon": -123.7, "lat": 39.3},
                {"type": "node", "id": 3, "lon": -123.755, "lat": 39.305},
                {"type": "node", "id": 4, "lon": -123.745, "lat": 39.305},
                {"type": "way", "id": 10, "nodes": [1, 2], "tags": {"ref": "CA 1"}},
                {"type": "way", "id": 11, "nodes": [3, 4], "tags": {}},
            ]
        },
    }
    monkeypatch.setattr("coast_fire.analysis.load_sources", lambda *_: (sources, {}))
    return config, sources


def test_analysis_scopes_counts_and_candidate_access_without_discarding_other_parcels(
    analysis_inputs, tmp_path
):
    config, _ = analysis_inputs
    summary = analyze(config, tmp_path, tmp_path)
    graph = json.loads((tmp_path / "graph.json").read_text())
    results = json.loads((tmp_path / "parcels.geojson").read_text())["features"]
    assert summary["parcels"] == 11
    assert summary["focus"]["counts"] == {"covered": 3, "uncovered": 2}
    assert summary["focus"]["inferred_counts"] == {"covered": 2, "uncovered": 1}
    assert summary["focus"]["parcels"] == 5
    assert summary["focus"]["uncertain"] == 3
    assert summary["focus"]["excluded"] == 3
    assert [parcel["id"] for parcel in graph["parcels"]] == [0, 1, 4, 5, 7]
    assert [parcel["properties"]["focus_status"] for parcel in results] == [
        "included",
        "included",
        "excluded",
        "uncertain",
        "included",
        "included",
        "uncertain",
        "included",
        "excluded",
        "uncertain",
        "excluded",
    ]
    assert results[2]["properties"]["coverage"] == "uncovered"
    assert results[4]["properties"]["mapped_access"] == "no_mapped_road"
    assert results[5]["properties"]["mapped_access"] == "disconnected_roads"
    assert results[6]["properties"]["base_zones"] == "RR; TP"
    assert results[8]["properties"]["access"] == "no_mapped_road"
    assert results[10]["properties"]["improvement_value"] == 8000
    assert results[0]["properties"]["access"] == "estimated"
    assert "access_connector" not in results[0]["properties"]
    assert len(graph["parcels"][0]["access"][0]) == 3
    assert len(graph["edges"]) == 2, "inference must not create through-roads"
    for parcel in graph["parcels"][2:]:
        edge, low, high, gap = parcel["access"][0]
        assert edge == 0, "use the connected highway, not the nearer disconnected road"
        assert low == high
        assert gap > 500
        p = results[parcel["id"]]["properties"]
        assert p["access"] == "inferred_straight_line"
        assert p["access_gap_m"] == round(gap, 1)
        assert len(p["access_connector"]) == 2
        assert p["baseline_miles"] == round((low * graph["edges"][edge][2] + gap) / MILE, 3)
    assert results[7]["properties"]["baseline_miles"] > 5
    assert summary["without_special"]["focus_counts"] == summary["focus"]["counts"]
    for parcel in results:
        p = parcel["properties"]
        assert p["coverage_without_special"] == p["coverage"]
        assert p["baseline_without_special_miles"] == p["baseline_miles"]


@pytest.mark.parametrize("with_regular_station", [True, False])
def test_without_local_station_preserves_overlap_and_inferred_access(
    analysis_inputs, tmp_path, with_regular_station
):
    config, sources = analysis_inputs
    local = tomllib.loads(Path("config/mendocino.toml").read_text())["additional_stations"][0]
    config["additional_stations"] = [{**local, "coordinates": [-123.7, 39.3]}]
    if not with_regular_station:
        sources["osm_stations"]["elements"] = []
    summary = analyze(config, tmp_path, tmp_path)
    graph = json.loads((tmp_path / "graph.json").read_text())
    parcels = json.loads((tmp_path / "parcels.geojson").read_text())["features"]
    assert summary["focus"]["counts"] == {"covered": 5, "uncovered": 0}
    assert summary["stations"] == (2 if with_regular_station else 1)
    alternative = summary["without_special"]
    assert alternative["stations"] == (1 if with_regular_station else 0)
    assert alternative["focus_counts"] == (
        {"covered": 3, "uncovered": 2} if with_regular_station else {"covered": 0, "uncovered": 5}
    )
    assert alternative["inferred_counts"] == (
        {"covered": 2, "uncovered": 1} if with_regular_station else {"covered": 0, "uncovered": 3}
    )
    for record in graph["parcels"]:
        p = parcels[record["id"]]["properties"]
        assert record["baseline_without_special"] == p["coverage_without_special"]
        if not with_regular_station:
            assert p["baseline_without_special_miles"] is None
    if with_regular_station:
        assert parcels[0]["properties"]["coverage_without_special"] == "covered"
        for index in [1, 7]:
            p = parcels[index]["properties"]
            assert p["coverage"] == "covered"
            assert p["coverage_without_special"] == "uncovered"
            assert p["baseline_without_special_miles"] > 5 > p["baseline_miles"]
        inferred = graph["parcels"][-1]
        edge, low, _, gap = inferred["access"][0]
        assert parcels[7]["properties"]["baseline_without_special_miles"] == round(
            (low * graph["edges"][edge][2] + gap) / MILE, 3
        )


@pytest.mark.parametrize("value", [-1, float("nan"), "10000"])
def test_invalid_improvement_values_are_not_silently_treated_as_undeveloped(value):
    features = [
        {
            "properties": {"FID": 1, "APNFULL": "123", "BASEZONE": "RR", "IMPV": value},
            "geometry": mapping(box(-123.8, 39.3, -123.799, 39.301)),
        }
    ]
    with pytest.raises(ValueError, match="Invalid improvement value"):
        group_parcels(features, box(-1e7, -1e7, 1e7, 1e7))
