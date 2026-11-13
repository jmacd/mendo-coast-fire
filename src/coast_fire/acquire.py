from __future__ import annotations

import hashlib
import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

LOG = logging.getLogger(__name__)
ROAD_TYPES = (
    "motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|"
    "secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|road"
)


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False) + "\n")
    temporary.replace(path)


def request_json(session, url, params):
    for attempt in range(3):
        try:
            response = session.get(url, params=params, timeout=(20, 180))
            response.raise_for_status()
            payload = response.json()
            if "error" in payload or "remark" in payload:
                raise RuntimeError(f"{url}: {payload.get('error', payload.get('remark'))}")
            return payload
        except (requests.RequestException, ValueError, RuntimeError) as error:
            if attempt == 2:
                raise RuntimeError(f"Unable to retrieve {url}: {error}") from error
            LOG.warning("Request failed; retrying %s: %s", url, error)
            time.sleep(2 ** (attempt + 1))
    raise AssertionError("unreachable")


def arcgis(session, source, bbox):
    url = source["url"].rstrip("/") + "/query"
    ids = request_json(
        session,
        url,
        {
            "f": "json",
            "where": source.get("where", "1=1"),
            "geometry": ",".join(map(str, bbox)),
            "geometryType": "esriGeometryEnvelope",
            "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects",
            "returnIdsOnly": "true",
        },
    ).get("objectIds")
    if not ids:
        raise RuntimeError(f"No records returned by required source {url}")
    features = {}
    for start in range(0, len(ids), 200):
        batch = ids[start : start + 200]
        payload = request_json(
            session,
            url,
            {
                "f": "geojson",
                "objectIds": ",".join(map(str, batch)),
                "outFields": ",".join(source["fields"]),
                "outSR": 4326,
                "returnGeometry": "true",
            },
        )
        if payload.get("exceededTransferLimit"):
            raise RuntimeError(f"Truncated ArcGIS batch from {url}")
        records = payload.get("features", [])
        returned = {f["properties"][source["id_field"]] for f in records}
        if returned != set(batch):
            raise RuntimeError(f"Incomplete ArcGIS batch from {url}; refresh and retry")
        for feature in records:
            if feature.get("geometry") is None:
                raise RuntimeError(f"Missing geometry in {url}, record {feature.get('id')}")
            features[feature["properties"][source["id_field"]]] = feature
        if start % 2000 == 0:
            LOG.info("%s: %s/%s records", source["id_field"], len(features), len(ids))
    return {"type": "FeatureCollection", "features": list(features.values())}


def roads(session, source, bbox):
    west, south, east, north = bbox
    bounds = f"{south},{west},{north},{east}"
    query = f'[out:json][timeout:120];way["highway"~"^({ROAD_TYPES})$"]({bounds});(._;>;);out body;'
    payload = request_json(session, source["url"], {"data": query})
    if not payload.get("elements"):
        raise RuntimeError("OSM returned no road elements")
    return payload


def osm_stations(session, source, bbox):
    west, south, east, north = bbox
    query = (
        f'[out:json][timeout:60];nwr["amenity"="fire_station"]'
        f"({south},{west},{north},{east});out center tags;"
    )
    payload = request_json(session, source["url"], {"data": query})
    if not payload.get("elements"):
        raise RuntimeError("OSM returned no fire station records")
    return payload


def acquire(config, directory: Path, refresh=False):
    directory.mkdir(parents=True, exist_ok=True)
    with requests.Session() as session:
        session.headers["User-Agent"] = "mendocino-coast-fire/0.1 (public GIS study)"
        for name, source in config["sources"].items():
            path = directory / f"{name}.json"
            meta_path = directory / f"{name}.source.json"
            query = {"source": source, "bbox": config["study"]["bbox"]}
            fingerprint = hashlib.sha256(json.dumps(query, sort_keys=True).encode()).hexdigest()
            if not refresh and path.exists() and meta_path.exists():
                meta = json.loads(meta_path.read_text())
                if meta["query_sha256"] == fingerprint:
                    if hashlib.sha256(path.read_bytes()).hexdigest() != meta["sha256"]:
                        raise RuntimeError(f"Cache integrity failure: {path}; use fetch --refresh")
                    LOG.info("Using cached %s (%s)", name, meta["retrieved_at"])
                    continue
            LOG.info("Downloading %s", name)
            fetcher = {"roads": roads, "osm_stations": osm_stations}.get(name, arcgis)
            payload = fetcher(session, source, query["bbox"])
            write_json(path, payload)
            write_json(
                meta_path,
                {
                    **query,
                    "query_sha256": fingerprint,
                    "retrieved_at": datetime.now(timezone.utc).isoformat(),
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "count": len(payload.get("features", payload.get("elements", []))),
                    "osm_timestamp": payload.get("osm3s", {}).get("timestamp_osm_base"),
                },
            )
