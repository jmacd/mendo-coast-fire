import { test } from "node:test";
import assert from "node:assert/strict";
import { MILE, RoadNetwork, parcelDistance, shortestPaths, sourceSeeds } from "../site/routing.js";

function graph() {
  return {
    schema: 4, crs: "EPSG:3310",
    nodes: [[0, 0, -123.8, 39.3], [20000, 0, -123.6, 39.3]],
    edges: [[0, 1, 20000, 3]],
    highway_edges: [0], to_highway: [0, 0],
    candidate_snap_m: 100, station_snap_m: 150, limit_m: 5 * MILE,
    parcels: [
      { id: 0, access: [[0, .5, .5]], baseline: "covered", baseline_without_special: "uncovered" },
      { id: 1, access: [[0, .8, .8]], baseline: "uncovered", baseline_without_special: "uncovered" },
      { id: 2, access: [[0, 1, 1]], baseline: "uncovered", baseline_without_special: "uncovered" },
      { id: 3, access: [], baseline: "unknown", baseline_without_special: "unknown" },
    ],
  };
}

test("click uses a partial edge; newly covered excludes baseline and unknown parcels", () => {
  const network = new RoadNetwork(graph());
  const result = network.scenario([10000, 0]);
  assert.deepEqual(result.reachedIds, [0, 1]);
  assert.deepEqual(result.newIds, [1]);
  assert.ok(result.roads.features.length);
  assert.deepEqual(network.scenario([20000, 0]).newIds, [1, 2]);
  assert.deepEqual(network.scenario([10000, 0]).newIds, [1], "scenarios do not accumulate");
});

test("exact five-mile limit includes endpoint and excludes a point one meter farther", () => {
  const { edges, limit_m: limit } = graph();
  const source = [[0, .5, 0]];
  const distances = shortestPaths([[[1, 20000]], [[0, 20000]]], sourceSeeds(edges, source), limit);
  assert.deepEqual(Array.from(distances), [Infinity, Infinity]);
  const end = .5 + limit / 20000;
  assert.ok(Math.abs(parcelDistance(edges, distances, [[0, end, end]], new Map([[0, [[.5, 0]]]])) - limit) < 1e-8);
  assert.ok(parcelDistance(edges, distances, [[0, end + .00005, end + .00005]], new Map([[0, [[.5, 0]]]])) > limit);
});

test("one-way direction and off-road connector count toward coverage", () => {
  const g = graph();
  g.edges[0][3] = 1;
  g.parcels = [
    { id: 0, baseline: "uncovered", baseline_without_special: "uncovered", access: [[0, .4, .4]] },
    { id: 1, baseline: "uncovered", baseline_without_special: "uncovered", access: [[0, .9, .9]] },
  ];
  assert.deepEqual(new RoadNetwork(g).scenario([10000, 0]).newIds, [1]);
  assert.deepEqual(new RoadNetwork(g).scenario([10000, 60]).newIds, []);
});

test("reject far-away and disconnected candidates instead of fabricating a road", () => {
  assert.throws(() => new RoadNetwork(graph()).scenario([10000, 101]), /within 100 m/);
  const g = graph();
  g.highway_edges = [];
  g.to_highway = [null, null];
  assert.throws(() => new RoadNetwork(g).scenario([10000, 0]), /cannot reach/);
});

test("reject older or incomplete datasets without both comparison baselines", () => {
  for (const schema of [1, 2, 3]) {
    const g = { ...graph(), schema };
    assert.throws(() => new RoadNetwork(g), /Rebuild the coverage data/);
  }
  const g = graph();
  delete g.parcels[0].baseline_without_special;
  assert.throws(() => new RoadNetwork(g), /Rebuild the coverage data/);
});

test("candidate additions use the selected baseline without changing road reach", () => {
  const g = graph();
  g.parcels.push({ id: 4, baseline: "covered", baseline_without_special: "covered", access: [[0, .6, .6]] });
  const network = new RoadNetwork(g);
  const on = network.scenario([10000, 0]);
  const off = network.scenario([10000, 0], { includeSpecial: false });
  assert.deepEqual(on.newIds, [1]);
  assert.deepEqual(off.newIds, [0, 1]);
  assert.deepEqual(off.reachedIds, on.reachedIds);
  assert.deepEqual(off.roads, on.roads);
  assert.deepEqual(network.scenario([10000, 0]).newIds, [1], "re-enabling restores the original baseline");
  assert.deepEqual(network.scenario([10000, 0], { existingStation: true, includeSpecial: false }).newIds, []);
});

test("inferred parcel access counts against candidate and existing-station reach", () => {
  const g = graph();
  g.parcels = [
    { id: 10, baseline: "uncovered", baseline_without_special: "uncovered", access: [[0, .8, .8, 2000]] },
    { id: 11, baseline: "uncovered", baseline_without_special: "uncovered", access: [[0, .8, .8, 2100]] },
    { id: 12, baseline: "uncovered", baseline_without_special: "uncovered", access: [[0, .5, .5, g.limit_m]] },
  ];
  const network = new RoadNetwork(g);
  assert.deepEqual(network.scenario([10000, 0]).newIds, [10, 12]);
  assert.deepEqual(network.scenario([10000, 0], { existingStation: true }).reachedIds, [10, 12]);
  assert.deepEqual(network.scenario([10000, 60]).reachedIds, []);
  assert.equal(parcelDistance([[0, 1, 5000, 3], [1, 2, 5000, 3]], [0, 5000, Infinity], [[1, .6, .6, 100]], new Map()), 8100);
});

test("existing-station reach uses its own snap limit, connector budget and one-way directions", () => {
  const g = graph();
  g.edges[0][3] = 1;
  g.parcels.push(
    { id: 4, baseline: "uncovered", baseline_without_special: "uncovered", access: [[0, .9, .9]] },
    { id: 5, baseline: "covered", baseline_without_special: "covered", access: [[0, .4, .4]] },
  );
  const network = new RoadNetwork(g);
  assert.throws(() => network.scenario([10000, 125]), /within 100 m/);
  const result = network.scenario([10000, 125], { existingStation: true });
  assert.deepEqual(result.reachedIds, [0, 1]);
  assert.deepEqual(result.newIds, [], "existing stations never report hypothetical additions");
  assert.equal(result.snap_m, 125);
  const [line] = result.roads.features[0].geometry.coordinates;
  assert.ok(Math.abs(line[0][0] - (-123.7)) < 1e-10);
  assert.ok(Math.abs(line[1][0] - (-123.7 + (g.limit_m - 125) / 20000 * .2)) < 1e-10);
  assert.throws(() => network.scenario([10000, 151], { existingStation: true }), /within 150 m/);
});

test("station inspection does not apply candidate eligibility or accumulate previous reach", () => {
  const g = graph();
  g.highway_edges = [];
  g.to_highway = [null, null];
  const network = new RoadNetwork(g);
  assert.throws(() => network.scenario([10000, 0]), /cannot reach/);
  assert.deepEqual(network.scenario([10000, 0], { existingStation: true }).reachedIds, [0, 1]);
  assert.deepEqual(network.scenario([20000, 0], { existingStation: true }).reachedIds, [1, 2]);
  delete g.station_snap_m;
  assert.throws(() => network.scenario([10000, 0], { existingStation: true }), /Rebuild/);
});

test("shortest path follows a detour, honors stale heap entries and bounded costs", () => {
  const adj = [[[1, 10], [2, 1]], [[3, 4]], [[1, 2], [3, 20]], [], [[3, 1]]];
  assert.deepEqual(Array.from(shortestPaths(adj, [[0, 0]], 7)), [0, 3, 1, 7, Infinity]);
});
