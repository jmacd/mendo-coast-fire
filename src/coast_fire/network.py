from __future__ import annotations

import heapq
import math
import re
from collections import Counter

from pyproj import Geod, Transformer
from shapely import STRtree
from shapely.geometry import LineString, Point

MILE = 1609.344
PROJECT = Transformer.from_crs(4326, 3310, always_xy=True)
UNPROJECT = Transformer.from_crs(3310, 4326, always_xy=True)
GEOD = Geod(ellps="WGS84")
ALLOWED_ACCESS = {"yes", "designated", "permissive", "destination"}


def access_allowed(tags):
    value = next(
        (tags[key] for key in ("motorcar", "motor_vehicle", "vehicle", "access") if key in tags),
        "yes",
    )
    return value in ALLOWED_ACCESS


def directions(tags):
    value = tags.get(
        "oneway:motor_vehicle",
        tags.get("oneway", "yes" if tags.get("junction") == "roundabout" else "no"),
    )
    if value in ("yes", "1", "true"):
        return 1
    if value == "-1":
        return 2
    if value in ("no", "0", "false"):
        return 3
    return 0


def adjacency(nodes, edges, reverse=False):
    result = [[] for _ in nodes]
    for u, v, length, direction in edges:
        if direction & 1:
            result[v if reverse else u].append((u if reverse else v, length))
        if direction & 2:
            result[u if reverse else v].append((v if reverse else u, length))
    return result


def dijkstra(adj, seeds, limit):
    distances = [math.inf] * len(adj)
    heap = []
    for node, cost in seeds:
        if cost <= limit and cost < distances[node]:
            distances[node] = cost
            heapq.heappush(heap, (cost, node))
    while heap:
        distance, u = heapq.heappop(heap)
        if distance != distances[u]:
            continue
        for v, length in adj[u]:
            candidate = distance + length
            if candidate <= limit and candidate < distances[v]:
                distances[v] = candidate
                heapq.heappush(heap, (candidate, v))
    return distances


def source_seeds(edges, starts):
    for edge_id, fraction, offset in starts:
        u, v, length, direction = edges[edge_id]
        if direction & 1:
            yield v, offset + (1 - fraction) * length
        if direction & 2:
            yield u, offset + fraction * length


def parcel_distance(edges, distances, accesses, starts):
    best = math.inf
    for access in accesses:
        edge_id, low, high = access[:3]
        connector = access[3] if len(access) == 4 else 0
        u, v, length, direction = edges[edge_id]
        if direction & 1:
            best = min(best, distances[u] + low * length + connector)
        if direction & 2:
            best = min(best, distances[v] + (1 - high) * length + connector)
        # A start and destination can share an edge without reaching either end.
        for fraction, offset in starts.get(edge_id, []):
            if low <= fraction <= high:
                best = min(best, offset + connector)
            elif fraction < low and direction & 1:
                best = min(best, offset + (low - fraction) * length + connector)
            elif fraction > high and direction & 2:
                best = min(best, offset + (fraction - high) * length + connector)
    return best


class Network:
    def __init__(self, osm, study):
        self.nodes = []
        self.edges = []
        self.lines = []
        self.highway = []
        self.diagnostics = Counter()
        raw_nodes = {e["id"]: e for e in osm["elements"] if e["type"] == "node"}
        indexes = {}

        def index(node_id):
            if node_id not in indexes:
                node = raw_nodes[node_id]
                lon, lat = node["lon"], node["lat"]
                x, y = PROJECT.transform(lon, lat)
                indexes[node_id] = len(self.nodes)
                self.nodes.append([round(x, 3), round(y, 3), lon, lat])
            return indexes[node_id]

        for way in osm["elements"]:
            if way["type"] != "way":
                continue
            tags = way.get("tags", {})
            if not access_allowed(tags):
                self.diagnostics["restricted_ways_excluded"] += 1
                continue
            if any(
                key.endswith(":conditional")
                and key.split(":")[0]
                in {"access", "vehicle", "motor_vehicle", "motorcar", "oneway"}
                for key in tags
            ):
                self.diagnostics["conditional_ways_excluded"] += 1
                continue
            direction = directions(tags)
            if not direction or tags.get("area") == "yes":
                self.diagnostics["ambiguous_ways_excluded"] += 1
                continue
            highway = bool(re.search(r"(?:^|;)\s*(?:CA[ -]?)?1\s*(?:;|$)", tags.get("ref", "")))
            for a, b in zip(way["nodes"], way["nodes"][1:]):
                if a not in raw_nodes or b not in raw_nodes:
                    raise ValueError(f"Missing OSM node in way {way['id']}")
                blocked = False
                for node_id in (a, b):
                    node_tags = raw_nodes[node_id].get("tags", {})
                    if not access_allowed(node_tags) or (
                        node_tags.get("barrier") not in (None, "no", "cattle_grid", "toll_booth")
                        and not any(
                            node_tags.get(k) in ALLOWED_ACCESS
                            for k in ("motor_vehicle", "motorcar", "access")
                        )
                    ):
                        blocked = True
                if blocked:
                    self.diagnostics["barrier_segments_excluded"] += 1
                    continue
                u, v = index(a), index(b)
                p, q = self.nodes[u], self.nodes[v]
                length = GEOD.inv(p[2], p[3], q[2], q[3])[2]
                if length < 0.001:
                    continue
                edge_id = len(self.edges)
                self.edges.append([u, v, round(length, 3), direction])
                self.lines.append(LineString([p[:2], q[:2]]))
                if highway and (
                    study["highway_south"] <= (p[3] + q[3]) / 2 <= study["highway_north"]
                ):
                    self.highway.append(edge_id)
        if not self.highway:
            raise ValueError("No Highway 1 segments found in the configured coastal extent")
        self.tree = STRtree(self.lines)
        self.adj = adjacency(self.nodes, self.edges)
        self.highway_nodes = sorted({node for i in self.highway for node in self.edges[i][:2]})
        self.to_highway = dijkstra(
            adjacency(self.nodes, self.edges, reverse=True),
            ((node, 0) for node in self.highway_nodes),
            study["distance_miles"] * MILE,
        )

    def snap(self, point, maximum):
        edge = int(self.tree.nearest(point))
        gap = self.lines[edge].distance(point)
        if gap > maximum:
            return None
        return [edge, self.lines[edge].project(point, normalized=True), gap]

    def highway_distance(self, start):
        edge, fraction, offset = start
        if edge in self.highway:
            return offset
        return min(
            (cost + self.to_highway[node] for node, cost in source_seeds(self.edges, [start])),
            default=math.inf,
        )

    def parcel_access(self, polygon, tolerance):
        buffered = polygon.buffer(tolerance)
        result = []
        for index in self.tree.query(buffered, predicate="intersects"):
            index = int(index)
            line = self.lines[index]
            intersection = line.intersection(buffered)
            parts = list(intersection.geoms) if hasattr(intersection, "geoms") else [intersection]
            for part in parts:
                if part.is_empty:
                    continue
                if part.geom_type not in ("Point", "LineString"):
                    raise ValueError(f"Unexpected road/parcel intersection: {part.geom_type}")
                values = [line.project(Point(coord), normalized=True) for coord in part.coords]
                result.append([index, min(values), max(values)])
        return result
