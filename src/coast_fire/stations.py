from shapely.geometry import Point, shape

from .network import PROJECT


def station_inventory(usgs, osm, colocation_m, additions=()):
    records = [
        {
            **station,
            "source_id": f"local:{station['id']}",
            "source": "Local addition",
            "special_case": True,
        }
        for station in additions
    ]
    for source in sorted(
        usgs["features"], key=lambda f: f["properties"].get("LOADDATE") or 0, reverse=True
    ):
        p = source["properties"]
        location = shape(source["geometry"])
        if location.geom_type != "Point":
            raise ValueError(f"Station {source['id']} is not a point")
        records.append(
            {
                "coordinates": list(location.coords[0]),
                "name": p["NAME"],
                "source_id": p["PERMANENT_IDENTIFIER"],
                "address": p.get("ADDRESS"),
                "city": p.get("CITY"),
                "source": p.get("SOURCE_ORIGINATOR") or "USGS",
                "source_description": p.get("SOURCE_DATADESC") or "Source date unknown",
            }
        )
    for source in osm["elements"]:
        p = source.get("tags", {})
        if p.get("disused") == "yes" or p.get("abandoned") == "yes":
            continue
        location = source if source["type"] == "node" else source.get("center", {})
        if "lon" not in location or "lat" not in location:
            raise ValueError(f"OSM station {source['id']} has no location")
        records.append(
            {
                "coordinates": [location["lon"], location["lat"]],
                "name": p.get("name", "Unnamed OSM fire station"),
                "source_id": f"osm:{source['type']}/{source['id']}",
                "address": " ".join(
                    p[key] for key in ("addr:housenumber", "addr:street") if key in p
                ),
                "city": p.get("addr:city"),
                "source": "OpenStreetMap",
                "source_description": (
                    f"OSM {source['type']}/{source['id']}; operational status unknown"
                ),
            }
        )
    groups = []
    for record in records:
        point = Point(PROJECT.transform(*record["coordinates"]))
        existing = next(
            (group for group in groups if point.distance(group["point"]) <= colocation_m), None
        )
        if existing:
            existing["records"].append(record)
        else:
            groups.append({"point": point, "records": [record]})
    return [
        {
            "coordinates": group["records"][0]["coordinates"],
            "properties": {
                "name": " / ".join(dict.fromkeys(r["name"] for r in group["records"])),
                "source_id": "; ".join(r["source_id"] for r in group["records"]),
                "address": group["records"][0]["address"],
                "city": group["records"][0]["city"],
                "source": "; ".join(dict.fromkeys(r["source"] for r in group["records"])),
                "source_description": "; ".join(r["source_description"] for r in group["records"]),
                "source_url": "; ".join(
                    dict.fromkeys(r["source_url"] for r in group["records"] if r.get("source_url"))
                ),
                "special_case": any(r.get("special_case", False) for r in group["records"]),
                "special_case_note": "; ".join(
                    r["note"] for r in group["records"] if r.get("special_case")
                ),
                "colocated_records": len(group["records"]),
            },
        }
        for group in groups
    ]
