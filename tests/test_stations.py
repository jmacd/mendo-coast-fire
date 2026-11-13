from coast_fire.stations import station_inventory


def test_colocated_inventory_is_one_site_and_osm_adds_missing_sites():
    usgs = {
        "features": [
            {
                "id": index,
                "geometry": {"type": "Point", "coordinates": [lon, 39.3]},
                "properties": {
                    "NAME": name,
                    "PERMANENT_IDENTIFIER": str(index),
                    "LOADDATE": index,
                },
            }
            for index, (lon, name) in enumerate(
                [(-123.75, "Old name"), (-123.7501, "New name"), (-123.751, "Separate station")]
            )
        ]
    }
    osm = {
        "elements": [
            {
                "type": "way",
                "id": 5,
                "center": {"lon": -123.8, "lat": 39.3},
                "tags": {"name": "OSM-only site"},
            },
            {
                "type": "node",
                "id": 6,
                "lon": -123.75,
                "lat": 39.3,
                "tags": {"name": "Duplicate mapped site"},
            },
        ]
    }
    inventory = station_inventory(usgs, osm, 50)
    assert len(inventory) == 3
    merged = next(item for item in inventory if "New name" in item["properties"]["name"])
    assert merged["properties"]["colocated_records"] == 3
    assert merged["coordinates"] == [-123.7501, 39.3]
    assert inventory[-1]["properties"]["source"] == "OpenStreetMap"


def test_local_addition_survives_source_refresh_without_duplicate_site():
    local = {
        "id": "local-station",
        "name": "Locally reported station",
        "address": "42800 Caspar Little Lake Rd",
        "city": "Caspar",
        "coordinates": [-123.77565, 39.34293],
        "source_description": "Approximate county parcel location",
        "source_url": "https://example.test/parcels",
        "note": "Special case; insurer recognition is unverified.",
    }
    usgs = {"features": []}
    empty_osm = {"elements": []}
    initial = station_inventory(usgs, empty_osm, 50, [local])
    assert len(initial) == 1
    assert initial[0]["properties"]["special_case"] is True
    refreshed_osm = {
        "elements": [
            {
                "type": "node",
                "id": 123,
                "lon": -123.7757,
                "lat": 39.3429,
                "tags": {"name": "Newly mapped station"},
            }
        ]
    }
    refreshed = station_inventory(usgs, refreshed_osm, 50, [local])
    assert len(refreshed) == 1
    station = refreshed[0]
    assert station["coordinates"] == local["coordinates"]
    assert station["properties"]["special_case"] is True
    assert station["properties"]["special_case_note"] == local["note"]
    assert station["properties"]["source_id"] == "local:local-station; osm:node/123"
    assert station["properties"]["colocated_records"] == 2
