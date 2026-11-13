from __future__ import annotations

import csv
import hashlib
import json
import logging
import math
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from shapely import STRtree, make_valid, to_geojson, transform, union_all
from shapely.geometry import Point, box, mapping, shape
from shapely.ops import nearest_points

from .acquire import write_json
from .network import MILE, PROJECT, UNPROJECT, Network, dijkstra, parcel_distance, source_seeds
from .stations import station_inventory

LOG = logging.getLogger(__name__)
OTHER_ZONES = {
    "AG",
    "AV",
    "C",
    "C1",
    "C2",
    "FL",
    "FV",
    "G",
    "GHMU",
    "GI",
    "GPD",
    "GVMU",
    "I",
    "I1",
    "I2",
    "MC",
    "MFL",
    "MMU",
    "MOS",
    "MPF",
    "OS",
    "PF",
    "RC",
    "RL",
    "RV",
    "TP",
    "TPZ",
}


def collection(features):
    return {"type": "FeatureCollection", "features": features}


def feature(geometry, properties, feature_id):
    return {
        "type": "Feature",
        "id": feature_id,
        "geometry": geometry,
        "properties": properties,
    }


def geographic(geometry):
    return json.loads(to_geojson(transform(geometry, UNPROJECT.transform, interleaved=False)))


def load_sources(config, directory):
    sources, provenance = {}, {}
    for name, source in config["sources"].items():
        path = directory / f"{name}.json"
        meta = json.loads((directory / f"{name}.source.json").read_text())
        query = {"source": source, "bbox": config["study"]["bbox"]}
        fingerprint = hashlib.sha256(json.dumps(query, sort_keys=True).encode()).hexdigest()
        if fingerprint != meta["query_sha256"]:
            raise RuntimeError(f"Configuration changed for {name}; run fire-coverage fetch")
        if hashlib.sha256(path.read_bytes()).hexdigest() != meta["sha256"]:
            raise RuntimeError(f"Cache integrity failure: {path}; run fetch --refresh")
        sources[name] = json.loads(path.read_text())
        provenance[name] = meta
    return sources, provenance


def group_parcels(features, envelope):
    groups = defaultdict(list)
    zones = defaultdict(set)
    improvements = defaultdict(list)
    for source in features:
        properties = source["properties"]
        apn = str(properties.get("APNFULL") or "").strip()
        key = apn or f"FID:{properties['FID']}"
        geometry = transform(
            make_valid(shape(source["geometry"])), PROJECT.transform, interleaved=False
        )
        if geometry.geom_type not in ("Polygon", "MultiPolygon"):
            raise ValueError(f"Non-polygon county parcel {key}: {geometry.geom_type}")
        if geometry.intersects(envelope):
            groups[key].append(geometry)
            zones[key].add(str(properties.get("BASEZONE") or "").strip().upper())
            value = properties.get("IMPV")
            if value is not None:
                if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                    raise ValueError(f"Invalid improvement value for parcel {key}: {value!r}")
                improvements[key].append(value)
    return [
        (apn, union_all(parts), sorted(zones[apn]), max(improvements[apn], default=None))
        for apn, parts in sorted(groups.items())
    ]


def zoning_status(zones, residential_zones):
    normalized = {zone.strip().upper().replace("-", "") for zone in zones}
    residential = set(residential_zones)
    if normalized and normalized <= residential:
        return "residential"
    if normalized and normalized <= OTHER_ZONES:
        return "other"
    return "unknown"


def focus_status(zoning, improvement_value, minimum):
    if zoning == "other" or (improvement_value is not None and improvement_value < minimum):
        return "excluded"
    if zoning == "residential" and improvement_value is not None:
        return "included"
    return "uncertain"


def connected_nodes(network):
    neighbors = [[] for _ in network.nodes]
    for u, v, _, _ in network.edges:
        neighbors[u].append(v)
        neighbors[v].append(u)
    visited = set(network.highway_nodes)
    queue = list(visited)
    for u in queue:
        for v in neighbors[u]:
            if v not in visited:
                visited.add(v)
                queue.append(v)
    return visited


def analyze(config, directory: Path, output: Path):
    sources, provenance = load_sources(config, directory)
    study = config["study"]
    minimum_value = study["min_improvement_value"]
    if (
        not isinstance(minimum_value, (int, float))
        or not math.isfinite(minimum_value)
        or minimum_value < 0
    ):
        raise ValueError("min_improvement_value must be a nonnegative finite number")
    limit = study["distance_miles"] * MILE
    network = Network(sources["roads"], study)
    LOG.info("Road graph: %s nodes, %s segments", len(network.nodes), len(network.edges))
    highway_geometry = union_all([network.lines[i] for i in network.highway])
    envelope = highway_geometry.buffer(2 * limit + study["parcel_road_tolerance_m"])
    bounds = transform(box(*study["bbox"]), PROJECT.transform, interleaved=False)
    if not bounds.contains(envelope):
        raise ValueError("Download bbox must contain the entire ten-mile Highway 1 envelope")

    stations, starts, regular_starts = [], [], []
    additions = config.get("additional_stations", [])
    if additions:
        provenance["local_stations"] = {
            "source": "additional_stations configuration",
            "records": additions,
            "sha256": hashlib.sha256(json.dumps(additions, sort_keys=True).encode()).hexdigest(),
        }
    inventory = station_inventory(
        sources["stations"], sources["osm_stations"], study["station_colocation_m"], additions
    )
    for station_id, source in enumerate(inventory):
        properties = source["properties"]
        location = Point(source["coordinates"])
        point = transform(location, PROJECT.transform, interleaved=False)
        if point.distance(highway_geometry) > limit:
            continue
        start = network.snap(point, study["station_snap_m"])
        distance = network.highway_distance(start) if start else math.inf
        status = (
            "included" if distance <= limit else ("unconnected" if not start else "beyond_limit")
        )
        if status == "included":
            starts.append(start)
            if not properties["special_case"]:
                regular_starts.append(start)
        stations.append(
            feature(
                mapping(location),
                {
                    **properties,
                    "status": status,
                    "highway_miles": round(distance / MILE, 3) if math.isfinite(distance) else None,
                    "snap_m": round(start[2], 1) if start else None,
                    "verification": (
                        "Locally reported station; operational status not independently verified"
                        if properties["special_case"]
                        else "Inventory location; operational status not verified"
                    ),
                },
                station_id,
            )
        )
    if not starts:
        raise ValueError("No stations qualify; refusing to publish an empty baseline")

    distances = dijkstra(network.adj, source_seeds(network.edges, starts), math.inf)
    starts_by_edge = defaultdict(list)
    for edge, fraction, offset in starts:
        starts_by_edge[edge].append((fraction, offset))
    distances_without_special = dijkstra(
        network.adj, source_seeds(network.edges, regular_starts), math.inf
    )
    regular_starts_by_edge = defaultdict(list)
    for edge, fraction, offset in regular_starts:
        regular_starts_by_edge[edge].append((fraction, offset))
    connected = connected_nodes(network)
    connected_edges = [i for i, edge in enumerate(network.edges) if edge[0] in connected]
    connected_tree = STRtree([network.lines[i] for i in connected_edges])
    parcels, access_records = [], []
    counts = Counter()
    focus_counts = Counter()
    focus_totals = Counter()
    inferred_counts = Counter()
    counts_without_special = Counter()
    focus_without_special = Counter()
    inferred_without_special = Counter()
    grouped = group_parcels(sources["parcels"]["features"], envelope)
    for index, (apn, polygon, zones, improvement_value) in enumerate(grouped):
        accesses = network.parcel_access(polygon, study["parcel_road_tolerance_m"])
        connected_accesses = [item for item in accesses if network.edges[item[0]][0] in connected]
        mapped_access = (
            "estimated"
            if connected_accesses
            else ("disconnected_roads" if accesses else "no_mapped_road")
        )
        zoning = zoning_status(zones, study["residential_zones"])
        focus = focus_status(zoning, improvement_value, minimum_value)
        connector = None
        if focus == "included" and not connected_accesses:
            edge = connected_edges[int(connected_tree.nearest(polygon))]
            parcel_point, road_point = nearest_points(polygon, network.lines[edge])
            fraction = network.lines[edge].project(road_point, normalized=True)
            gap = parcel_point.distance(road_point)
            connected_accesses = [[edge, fraction, fraction, gap]]
            connector = [
                list(UNPROJECT.transform(*point.coords[0])) for point in (parcel_point, road_point)
            ]
        distance = parcel_distance(network.edges, distances, connected_accesses, starts_by_edge)
        state = (
            "unknown"
            if not connected_accesses
            else ("covered" if distance <= limit else "uncovered")
        )
        distance_without_special = parcel_distance(
            network.edges, distances_without_special, connected_accesses, regular_starts_by_edge
        )
        state_without_special = (
            "unknown"
            if not connected_accesses
            else ("covered" if distance_without_special <= limit else "uncovered")
        )
        counts[state] += 1
        counts_without_special[state_without_special] += 1
        focus_totals[focus] += 1
        if focus == "included":
            focus_counts[state] += 1
            focus_without_special[state_without_special] += 1
            access_records.append(
                {
                    "id": index,
                    "access": connected_accesses,
                    "baseline": state,
                    "baseline_without_special": state_without_special,
                }
            )
        if connector:
            inferred_counts[state] += 1
            inferred_without_special[state_without_special] += 1
        properties = {
            "apn": apn,
            "coverage": state,
            "coverage_without_special": state_without_special,
            "base_zones": "; ".join(zone or "Unknown" for zone in zones),
            "zoning_status": zoning,
            "focus_status": focus,
            "improvement_value": improvement_value,
            "baseline_miles": round(distance / MILE, 3) if math.isfinite(distance) else None,
            "baseline_without_special_miles": (
                round(distance_without_special / MILE, 3)
                if math.isfinite(distance_without_special)
                else None
            ),
            "access": "inferred_straight_line" if connector else mapped_access,
            "mapped_access": mapped_access,
            **({"access_gap_m": round(gap, 1), "access_connector": connector} if connector else {}),
        }
        # Simplification is for display only; access uses the full county geometry.
        display = polygon.simplify(1.5, preserve_topology=True)
        parcels.append(feature(geographic(display), properties, index))
        if index % 2000 == 0:
            LOG.info("Connected %s/%s parcels", index, len(grouped))
    if not parcels:
        raise ValueError("No parcels in the study envelope")
    if not access_records:
        raise ValueError(
            "No qualifying developed residential parcels; check zoning and improvement values"
        )

    timestamp = datetime.now(timezone.utc).isoformat()
    provenance["parcel_focus"] = {
        "zoning_field": "parcels.BASEZONE",
        "residential_zones": study["residential_zones"],
        "road_tolerance_m": study["parcel_road_tolerance_m"],
        "min_improvement_value": minimum_value,
        "improvement_value_rule": "Maximum reported IMPV per APN; duplicate records are not summed",
        "rule": "Dedicated residential zoning and sufficient improvement value; preserve mapped "
        "contacts, otherwise infer the shortest boundary connector to a highway-connected road",
    }
    summary = {
        "name": study["name"],
        "built_at": timestamp,
        "distance_miles": study["distance_miles"],
        "stations": len(starts),
        "station_records": len(stations),
        "special_case_stations": sum(
            station["properties"]["special_case"] and station["properties"]["status"] == "included"
            for station in stations
        ),
        "parcels": len(parcels),
        "counts": {key: counts[key] for key in ("covered", "uncovered", "unknown")},
        "focus": {
            "parcels": focus_totals["included"],
            "counts": {key: focus_counts[key] for key in ("covered", "uncovered")},
            "uncertain": focus_totals["uncertain"],
            "excluded": focus_totals["excluded"],
            "residential_zones": study["residential_zones"],
            "min_improvement_value": minimum_value,
            "inferred_counts": {key: inferred_counts[key] for key in ("covered", "uncovered")},
        },
        "without_special": {
            "stations": len(regular_starts),
            "counts": {
                key: counts_without_special[key] for key in ("covered", "uncovered", "unknown")
            },
            "focus_counts": {key: focus_without_special[key] for key in ("covered", "uncovered")},
            "inferred_counts": {
                key: inferred_without_special[key] for key in ("covered", "uncovered")
            },
        },
        "road_nodes": len(network.nodes),
        "road_segments": len(network.edges),
        "exclusions": dict(network.diagnostics),
        "parcel_road_tolerance_m": study["parcel_road_tolerance_m"],
        "station_snap_m": study["station_snap_m"],
        "candidate_snap_m": study["candidate_snap_m"],
        "extent": list(transform(envelope, UNPROJECT.transform, interleaved=False).bounds),
        "limitations": [
            "Screening estimates, not verified legal access, insurance eligibility "
            "or response times.",
            f"Station locations combine USGS and OSM inventories with labeled local additions. "
            f"Points within "
            f"{study['station_colocation_m']:g} m "
            "are consolidated; staffing and active status are unverified.",
            "A station's omission from public inventories does not establish insurer "
            "recognition or premium effects.",
            "OSM roads may be missing or disconnected. Private, restricted, conditional roads "
            "and unverified barriers are excluded; destination access is allowed.",
            "One-way directions are respected. Turn restrictions, apparatus size/weight limits, "
            "seasonal closures, bridges and road condition are not modeled.",
            "Any mapped drivable segment within 30 m of a parcel is an estimated connection, "
            "not a verified driveway. Reaching a parcel does not imply reaching every building.",
            f"Map colors and candidate counts require dedicated residential zoning and at least "
            f"${minimum_value:,.0f} in reported county improvement value. Other zoning and values "
            "below the cutoff are hidden. Missing zoning or value remains uncertain.",
            "Where mapped road access is missing, a straight-line parcel-boundary connector to "
            "the nearest highway-connected modeled road is inferred without a gap cap. Its "
            "length counts toward the five-mile limit. This optimistic estimate is not a "
            "verified driveway and can cross barriers or underestimate winding access roads.",
            "Improvement value is a development proxy, not a dwelling inventory or market value. "
            "Missing or low assessments can omit developed properties.",
            "County zoning does not cover incorporated cities. Missing, mixed, or unrecognized "
            "zoning is uncertain, not evidence that a parcel is non-residential.",
            "Parcel counts are distinct APNs, combining all source parts intersecting the "
            "ten-mile straight-line search envelope. Missing APNs use county feature IDs.",
            "No route within five miles is not proof of no fire protection; excluded stations, "
            "mutual aid and missing roads may change the result.",
        ],
    }
    output.mkdir(parents=True, exist_ok=True)
    write_json(output / "parcels.geojson", collection(parcels))
    write_json(output / "stations.geojson", collection(stations))
    write_json(
        output / "highway.geojson",
        collection([feature(geographic(highway_geometry), {"name": "Highway 1"}, 0)]),
    )
    write_json(
        output / "graph.json",
        {
            "schema": 4,
            "crs": "EPSG:3310",
            "nodes": network.nodes,
            "edges": network.edges,
            "parcels": access_records,
            "highway_edges": network.highway,
            "to_highway": [value if math.isfinite(value) else None for value in network.to_highway],
            "limit_m": limit,
            "candidate_snap_m": study["candidate_snap_m"],
            "station_snap_m": study["station_snap_m"],
        },
    )
    with (output / "stations.csv").open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(stations[0]["properties"]) + ["lon", "lat"])
        writer.writeheader()
        for station in stations:
            lon, lat = station["geometry"]["coordinates"]
            writer.writerow({**station["properties"], "lon": lon, "lat": lat})
    write_json(output / "provenance.json", provenance)
    write_json(output / "summary.json", summary)
    LOG.info("Coverage: %s", dict(counts))
    LOG.info(
        "Residential road-access focus: %s; dispositions: %s",
        dict(focus_counts),
        dict(focus_totals),
    )
    return summary
