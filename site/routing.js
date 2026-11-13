export const MILE = 1609.344;

class MinHeap {
  items = [];

  push(item) {
    let i = this.items.length;
    this.items.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent][0] <= item[0]) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = item;
  }

  pop() {
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length) {
      let i = 0;
      while (i * 2 + 1 < this.items.length) {
        let child = i * 2 + 1;
        if (child + 1 < this.items.length && this.items[child + 1][0] < this.items[child][0]) child++;
        if (last[0] <= this.items[child][0]) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = last;
    }
    return first;
  }
}

export function sourceSeeds(edges, starts) {
  const seeds = [];
  for (const [edgeId, t, offset] of starts) {
    const [u, v, length, direction] = edges[edgeId];
    if (direction & 1) seeds.push([v, offset + (1 - t) * length]);
    if (direction & 2) seeds.push([u, offset + t * length]);
  }
  return seeds;
}

export function shortestPaths(adjacency, seeds, limit) {
  const distances = new Float64Array(adjacency.length).fill(Infinity);
  const heap = new MinHeap();
  for (const [node, cost] of seeds) {
    if (cost <= limit && cost < distances[node]) {
      distances[node] = cost;
      heap.push([cost, node]);
    }
  }
  while (heap.items.length) {
    const [cost, u] = heap.pop();
    if (cost !== distances[u]) continue;
    for (const [v, length] of adjacency[u]) {
      const next = cost + length;
      if (next <= limit && next < distances[v]) {
        distances[v] = next;
        heap.push([next, v]);
      }
    }
  }
  return distances;
}

export function parcelDistance(edges, distances, accesses, starts) {
  let best = Infinity;
  for (const [edgeId, low, high, connector = 0] of accesses) {
    const [u, v, length, direction] = edges[edgeId];
    if (direction & 1) best = Math.min(best, distances[u] + low * length + connector);
    if (direction & 2) best = Math.min(best, distances[v] + (1 - high) * length + connector);
    for (const [t, offset] of starts.get(edgeId) ?? []) {
      if (t >= low && t <= high) best = Math.min(best, offset + connector);
      else if (t < low && direction & 1) best = Math.min(best, offset + (low - t) * length + connector);
      else if (t > high && direction & 2) best = Math.min(best, offset + (t - high) * length + connector);
    }
  }
  return best;
}

export class RoadNetwork {
  constructor(graph) {
    if (graph.schema !== 4 || graph.crs !== "EPSG:3310" || !graph.edges.length
      || !Array.isArray(graph.parcels)
      || graph.parcels.some((p) => !["covered", "uncovered", "unknown"].includes(p.baseline_without_special))) {
      throw new Error("Unsupported or empty routing dataset. Rebuild the coverage data.");
    }
    this.graph = graph;
    this.highway = new Set(graph.highway_edges);
    this.adjacency = Array.from({ length: graph.nodes.length }, () => []);
    for (const [u, v, length, direction] of graph.edges) {
      if (direction & 1) this.adjacency[u].push([v, length]);
      if (direction & 2) this.adjacency[v].push([u, length]);
    }
  }

  snap([x, y], maxGap = this.graph.candidate_snap_m) {
    if (!Number.isFinite(maxGap) || maxGap < 0) {
      throw new Error("Missing or invalid road connection limit. Rebuild the coverage data.");
    }
    let best = null;
    let minimum = Infinity;
    this.graph.edges.forEach(([u, v], edgeId) => {
      const a = this.graph.nodes[u], b = this.graph.nodes[v];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
      const gap = Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
      if (gap < minimum) {
        minimum = gap;
        best = [edgeId, t, gap];
      }
    });
    if (!best || minimum > maxGap) {
      throw new Error(`Choose a location within ${maxGap} m of a modeled drivable road.`);
    }
    return best;
  }

  scenario(xy, { existingStation = false, includeSpecial = true } = {}) {
    const { nodes, edges, parcels, limit_m: limit, to_highway: toHighway } = this.graph;
    if (existingStation && !Number.isFinite(this.graph.station_snap_m)) {
      throw new Error("Station routing settings are missing. Rebuild the coverage data.");
    }
    const start = this.snap(xy, existingStation ? this.graph.station_snap_m : this.graph.candidate_snap_m);
    const [edgeId, t, gap] = start;
    const seeds = sourceSeeds(edges, [start]);
    const highwayDistance = this.highway.has(edgeId) ? gap : Math.min(
      ...seeds.map(([node, cost]) => cost + (toHighway[node] ?? Infinity)),
    );
    if (!existingStation && highwayDistance > limit) {
      throw new Error("This road connection cannot reach the study Highway 1 segment within five road miles. Choose a closer, connected location.");
    }
    const distances = shortestPaths(this.adjacency, seeds, limit);
    const starts = new Map([[edgeId, [[t, gap]]]]);
    const newIds = [], reachedIds = [];
    for (const parcel of parcels) {
      if (parcelDistance(edges, distances, parcel.access, starts) <= limit) {
        reachedIds.push(parcel.id);
        const baseline = includeSpecial ? parcel.baseline : parcel.baseline_without_special;
        if (!existingStation && baseline === "uncovered") newIds.push(parcel.id);
      }
    }
    const coordinates = [];
    edges.forEach(([u, v, length, direction], id) => {
      const intervals = [];
      if (direction & 1 && distances[u] < limit) intervals.push([0, Math.min(1, (limit - distances[u]) / length)]);
      if (direction & 2 && distances[v] < limit) intervals.push([Math.max(0, 1 - (limit - distances[v]) / length), 1]);
      if (id === edgeId && gap < limit) {
        const remaining = (limit - gap) / length;
        if (direction & 1) intervals.push([t, Math.min(1, t + remaining)]);
        if (direction & 2) intervals.push([Math.max(0, t - remaining), t]);
      }
      const point = (fraction) => [
        nodes[u][2] + fraction * (nodes[v][2] - nodes[u][2]),
        nodes[u][3] + fraction * (nodes[v][3] - nodes[u][3]),
      ];
      for (const [low, high] of intervals) {
        if (high > low) coordinates.push([point(low), point(high)]);
      }
    });
    const [u, v] = edges[edgeId];
    return {
      newIds,
      reachedIds,
      snap_m: gap,
      highway_miles: highwayDistance / MILE,
      snapped: [nodes[u][2] + t * (nodes[v][2] - nodes[u][2]), nodes[u][3] + t * (nodes[v][3] - nodes[u][3])],
      roads: {
        type: "FeatureCollection",
        features: coordinates.length ? [{
          type: "Feature",
          properties: {},
          geometry: { type: "MultiLineString", coordinates },
        }] : [],
      },
    };
  }
}
