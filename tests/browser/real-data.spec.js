import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import proj4 from "proj4";
import { RoadNetwork } from "../../site/routing.js";

test("generated coastal dataset supports a real new-coverage scenario", async ({ page }, testInfo) => {
  test.skip(!existsSync("output/graph.json"), "Run fire-coverage run to exercise real source data.");
  test.setTimeout(60000);
  const graph = JSON.parse(readFileSync("output/graph.json", "utf8"));
  const summary = JSON.parse(readFileSync("output/summary.json", "utf8"));
  const parcels = JSON.parse(readFileSync("output/parcels.geojson", "utf8"));
  const included = parcels.features.filter((p) => p.properties.focus_status === "included");
  expect(included.every((p) => p.properties.improvement_value >= summary.focus.min_improvement_value)).toBe(true);
  expect(graph.parcels.map((p) => p.id)).toEqual(included.map((p) => p.id));
  expect(graph.parcels.length).toBe(summary.focus.parcels);
  expect(included.filter((p) => p.properties.coverage === "uncovered").length).toBe(summary.focus.counts.uncovered);
  const network = new RoadNetwork(graph);
  let candidate;
  for (const parcel of graph.parcels.filter((p) => p.baseline === "uncovered" && p.access.some((a) => a.length === 4))) {
    for (const [edgeId, low, high] of parcel.access) {
      const [u, v] = graph.edges[edgeId];
      if (Math.min(graph.to_highway[u] ?? Infinity, graph.to_highway[v] ?? Infinity) > graph.limit_m / 2) continue;
      const t = (low + high) / 2;
      const xy = [0, 1].map((axis) => graph.nodes[u][axis] + t * (graph.nodes[v][axis] - graph.nodes[u][axis]));
      const expected = network.scenario(xy);
      if (expected.newIds.includes(parcel.id)) {
        candidate = { xy, expected };
        break;
      }
    }
    if (candidate) break;
  }
  expect(candidate, "The real dataset should have an inferred-access gap a candidate can reach").toBeTruthy();
  proj4.defs("EPSG:3310", "+proj=aea +lat_1=34 +lat_2=40.5 +lat_0=0 +lon_0=-120 +x_0=0 +y_0=-4000000 +datum=NAD83 +units=m +no_defs");
  const [lng, lat] = proj4("EPSG:3310", "EPSG:4326", candidate.xy);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({
    contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGN4/f7ZfwAJSQPAHACoWgAAAABJRU5ErkJggg==", "base64"),
  }));
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Ready.");
  await expect(page.locator("#covered-count")).toHaveText(summary.focus.counts.covered.toLocaleString());
  await page.getByText("Enter a precise location", { exact: true }).click();
  await page.getByLabel("Latitude", { exact: true }).fill(String(lat));
  await page.getByLabel("Longitude", { exact: true }).fill(String(lng));
  await page.getByRole("button", { name: "Evaluate location" }).click();
  await expect(page.locator("#new-count")).toHaveText(candidate.expected.newIds.length.toLocaleString());
  await expect(page.locator("#covered-count")).toHaveText(summary.focus.counts.covered.toLocaleString());
  await expect(page.locator("#error")).toBeHidden();
  await expect(page.locator("#map-warning")).toBeHidden();
  const stations = JSON.parse(readFileSync("output/stations.geojson", "utf8")).features;
  const station = stations.find((s) => s.properties.status === "included" && s.properties.snap_m > graph.candidate_snap_m) ?? stations[0];
  const [stationLng, stationLat] = station.geometry.coordinates;
  const reach = network.scenario(proj4("EPSG:4326", "EPSG:3310", [stationLng, stationLat]), { existingStation: true });
  const baselineCovered = new Set(graph.parcels.filter((p) => p.baseline === "covered").map((p) => p.id));
  expect(reach.reachedIds.every((id) => baselineCovered.has(id))).toBe(true);
  await page.getByLabel("Latitude", { exact: true }).fill(String(stationLat));
  await page.getByLabel("Longitude", { exact: true }).fill(String(stationLng));
  await page.getByRole("button", { name: "Evaluate location" }).click();
  await expect(page.locator("#candidate")).toHaveAttribute("aria-busy", "false");
  if (await page.locator("#clear").isEnabled()) await page.locator("#clear").click();
  const canvas = page.locator(".maplibregl-canvas");
  const bounds = await canvas.boundingBox();
  await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await expect(page.locator("#status")).toContainText(station.properties.name);
  await expect(page.locator("#status")).toContainText(`${reach.reachedIds.length.toLocaleString()} residential parcels within five miles`);
  await expect(page.locator("#selected-station")).toBeHidden();
  await expect(page.locator("#covered-count")).toHaveText(summary.focus.counts.covered.toLocaleString());
  await expect(page.locator("#new-count")).toHaveText("--");
  await expect(page.locator("#error")).toBeHidden();
  await expect(page.locator("#map-warning")).toBeHidden();
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("coverage.png"), fullPage: true });
});
