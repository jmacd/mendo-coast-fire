import { test, expect } from "@playwright/test";
import proj4 from "proj4";

proj4.defs("EPSG:3310", "+proj=aea +lat_1=34 +lat_2=40.5 +lat_0=0 +lon_0=-120 +x_0=0 +y_0=-4000000 +datum=NAD83 +units=m +no_defs");
const collection = (features) => ({ type: "FeatureCollection", features });
const geometry = (type, coordinates, properties, id) => ({ type: "Feature", id, geometry: { type, coordinates }, properties });

async function fixture(page, missing = false, special = false) {
  const center = proj4("EPSG:4326", "EPSG:3310", [-123.75, 39.3]);
  const nodes = [-1000, 1000].map((dx) => {
    const xy = [center[0] + dx, center[1]];
    return [...xy, ...proj4("EPSG:3310", "EPSG:4326", xy)];
  });
  const parcel = (id, longitude, coverage, focus = "included", zone = "RR") => geometry("Polygon", [[
    [longitude, 39.299], [longitude + .002, 39.299], [longitude + .002, 39.301],
    [longitude, 39.301], [longitude, 39.299],
  ]], {
    apn: `TEST-${id}`, coverage, focus_status: focus, base_zones: zone,
    improvement_value: coverage === "unknown" ? null : 100000,
    access: coverage === "unknown" ? "no_mapped_road" : "estimated",
    baseline_miles: coverage === "covered" ? 1 : null,
  }, id);
  const data = {
    "graph.json": {
      schema: 3, crs: "EPSG:3310", nodes, edges: [[0, 1, 2000, 3]], highway_edges: [0],
      to_highway: [0, 0], limit_m: 8046.72, candidate_snap_m: 100, station_snap_m: 150,
      parcels: [
        { id: 0, access: [[0, .2, .4]], baseline: "covered" },
        { id: 1, access: [[0, .6, .8]], baseline: "uncovered" },
      ],
    },
    "summary.json": {
      stations: 1, parcels: 5, counts: { covered: 1, uncovered: 3, unknown: 1 },
      focus: {
        parcels: 2, counts: { covered: 1, uncovered: 1 }, uncertain: 2, excluded: 1,
        min_improvement_value: 10000, inferred_counts: { covered: 0, uncovered: 0 },
      },
      built_at: "2026-01-01T00:00:00Z", extent: [-123.77, 39.29, -123.73, 39.31],
    },
    "parcels.geojson": collection([
      parcel(0, -123.758, "covered"), parcel(1, -123.746, "uncovered"),
      parcel(2, -123.752, "unknown", "uncertain"),
      parcel(3, -123.764, "uncovered", "excluded", "RL"),
      parcel(4, -123.74, "uncovered", "uncertain", "Unknown"),
    ]),
    "stations.geojson": collection([geometry("Point", nodes[0].slice(2), {
      name: "Test station", status: "included", highway_miles: 0, snap_m: 0,
      address: "123 Coast Road", city: "Test town",
      verification: "Test fixture only", source_description: "Synthetic browser test",
    }, 1)]),
    "highway.geojson": collection([geometry("LineString", nodes.map((n) => n.slice(2)), {}, 1)]),
  };
  if (special) {
    data["stations.geojson"].features.push(geometry("Point", [-123.75, 39.3], {
      name: "Local special-case station",
      address: "42800 Caspar Little Lake Rd",
      status: "included", highway_miles: 0, snap_m: 0,
      special_case: true,
      special_case_note: "Insurer recognition and premium effects have not been verified.",
      verification: "Locally reported station",
      source_description: "Locally reported station. Approximate location from the county parcel at the reported situs address, not a surveyed building entrance. Building entrance and operational status have not been independently verified.",
    }, 2));
    data["summary.json"].stations = 2;
  }
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({
    contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGN4/f7ZfwAJSQPAHACoWgAAAABJRU5ErkJggg==", "base64"),
  }));
  await page.route(/\/(graph|summary)\.json|\/(parcels|stations|highway)\.geojson/, (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    return route.fulfill({
      status: missing && name === "graph.json" ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(data[name]),
    });
  });
  return data;
}

async function mapColors(page) {
  const image = await page.locator(".maplibregl-canvas").screenshot();
  return page.evaluate(async (base64) => {
    const response = await fetch(`data:image/png;base64,${base64}`);
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    bitmap.close();
    const counts = { red: 0, purple: 0, yellow: 0, blue: 0 };
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = data.subarray(i, i + 3);
      if (r > 170 && g < 160 && b < 160) counts.red++;
      if (r > 120 && r < 210 && g < 160 && b > 210) counts.purple++;
      if (r > 225 && g > 225 && b < 60) counts.yellow++;
      if (r < 120 && g > 140 && g < 220 && b > 210) counts.blue++;
    }
    return counts;
  }, image.toString("base64"));
}

test("candidate highlights only additions, reset restores baseline, and off-road click errors", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await fixture(page);
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Ready.");
  await page.getByRole("button", { name: "Use map center" }).click();
  await expect(page.locator("#new-count")).toHaveText("1");
  await expect(page.locator("#map-warning")).toBeHidden();
  await expect(page.locator("#candidate-detail")).toContainText("2 developed residential parcels reached");
  await expect(page.locator("#covered-count")).toHaveText("1");
  await page.getByRole("button", { name: "Clear candidate" }).click();
  await expect(page.locator("#new-count")).toHaveText("--");
  await expect(page.locator("#covered-count")).toHaveText("1");
  const canvas = page.locator(".maplibregl-canvas");
  const bounds = await canvas.boundingBox();
  await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await expect(page.locator("#new-count")).toHaveText("1");
  await canvas.click({ position: { x: bounds.width / 2, y: 120 } });
  await expect(page.locator("#error")).toContainText("within 100 m");
  await expect(page.locator("#new-count")).toHaveText("--");
  expect(errors).toEqual([]);
});

test("failed data loads are visible, with no misleading zero counts", async ({ page }) => {
  await fixture(page, true);
  await page.goto("/");
  await expect(page.locator("#error")).toContainText("503");
  await expect(page.locator("#covered-count")).toHaveText("--");
  await expect(page.locator("#use-center")).toBeDisabled();
});

test("basemap failure is visible without blocking local coverage calculations", async ({ page }) => {
  await fixture(page);
  await page.route("https://tile.openstreetmap.org/**", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Ready.");
  await expect(page.locator("#map-warning")).toBeVisible();
  await page.getByRole("button", { name: "Use map center" }).click();
  await expect(page.locator("#new-count")).toHaveText("1");
});

test("mobile map remains usable without horizontal page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Ready.");
  await page.getByRole("button", { name: "Use map center" }).click();
  await expect(page.locator("#new-count")).toHaveText("1");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("inspect mode shows the local station's reach without a station popup", async ({ page }) => {
  await fixture(page, false, true);
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Ready.");
  await page.getByRole("button", { name: "Inspect parcels" }).click();
  const canvas = page.locator(".maplibregl-canvas");
  const bounds = await canvas.boundingBox();
  await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await expect(page.locator("#status")).toContainText("Station evaluated.");
  await expect(page.locator("#status")).toContainText("Local special-case station");
  await expect(page.locator("#selected-station")).toBeHidden();
  await expect(page.locator(".maplibregl-popup")).toHaveCount(0);
  await expect(page.locator("#new-count")).toHaveText("--");
  await page.getByText("Review the station inventory", { exact: true }).click();
  const row = page.locator("#station-list tr").filter({ hasText: "Local special-case station" });
  await expect(row).toContainText("Included (unverified) - special case");
  await expect(row).toContainText("42800 Caspar Little Lake Rd");
  await expect(row).toContainText("Insurer recognition and premium effects have not been verified.");
});

for (const width of [1280, 390]) {
  test(`station clicks override placement and show replaceable road reach at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const data = await fixture(page);
    data["stations.geojson"].features[0].geometry.coordinates = [-123.75, 39.3];
    await page.goto("/");
    await expect(page.locator("#status")).toContainText("Ready.");
    await expect(page.locator("#place-mode")).toHaveAttribute("aria-pressed", "true");
    const canvas = page.locator(".maplibregl-canvas");
    const bounds = await canvas.boundingBox();
    const clickStation = () => canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
    await clickStation();
    await expect(page.locator("#status")).toContainText("Test station: 2 residential parcels within five miles");
    await expect(page.locator("#selected-station")).toBeHidden();
    await expect(page.locator(".maplibregl-popup")).toHaveCount(0);
    await expect(page.locator("#new-count")).toHaveText("--");
    await expect(page.locator("#covered-count")).toHaveText("1");
    await expect.poll(async () => (await mapColors(page)).yellow).toBeGreaterThan(300);
    await expect.poll(async () => (await mapColors(page)).blue).toBeGreaterThan(300);
    expect((await mapColors(page)).purple).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.getByRole("button", { name: "Clear station", exact: true }).click();
    await expect(page.locator("#selected-station")).toBeHidden();
    await expect.poll(async () => (await mapColors(page)).yellow).toBe(0);
    await expect.poll(async () => (await mapColors(page)).blue).toBe(0);
    await clickStation();
    await expect(page.locator("#status")).toContainText("Station evaluated.");
    await page.getByRole("button", { name: "Use map center" }).click();
    await expect(page.locator("#new-count")).toHaveText("1");
    await expect(page.locator("#selected-station")).toBeHidden();
    await expect.poll(async () => (await mapColors(page)).blue).toBe(0);
    await expect.poll(async () => (await mapColors(page)).purple).toBeGreaterThan(width < 640 ? 100 : 300);
    await expect(page.locator("#map-warning")).toBeHidden();
  });
}

test("unconnected stations retain their identity and show an explicit coverage error", async ({ page }) => {
  const data = await fixture(page);
  const station = data["stations.geojson"].features[0];
  station.geometry.coordinates = [-123.75, 39.305];
  station.properties.address = "";
  station.properties.city = null;
  station.properties.status = "unconnected";
  data["summary.json"].extent = [-123.77, 39.295, -123.73, 39.315];
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Ready.");
  const canvas = page.locator(".maplibregl-canvas");
  const bounds = await canvas.boundingBox();
  await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await expect(page.locator("#status")).toContainText("Station reach unavailable for Test station");
  await expect(page.locator("#selected-station")).toBeHidden();
  await expect(page.locator("#error")).toContainText("within 150 m");
  await expect(page.locator("#covered-count")).toHaveText("1");
  await expect.poll(async () => (await mapColors(page)).yellow).toBe(0);
});

test("gap highlighting and candidate colors stay distinct without changing the baseline", async ({ page }) => {
  await fixture(page, false, true);
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Ready.");
  const toggle = page.getByRole("checkbox", { name: "Highlight coverage gaps" });
  await expect(toggle).toBeChecked();
  await expect(page.locator("#gap-summary")).toContainText("Residential gap parcels: 1. Existing stations: 2");
  await expect(page.locator("#gap-summary")).toContainText("Zoning/value uncertain: 2 (outlines only)");
  const colors = () => mapColors(page);
  const redPixels = async () => (await colors()).red;
  await expect.poll(redPixels).toBeGreaterThan(300);
  expect((await colors()).purple).toBe(0);
  expect((await colors()).yellow).toBe(0);
  const highlighted = await redPixels();
  await toggle.uncheck();
  await expect.poll(redPixels).toBeLessThan(highlighted - 300);
  await toggle.check();
  await expect.poll(redPixels).toBeGreaterThan(highlighted - 100);
  await page.getByRole("button", { name: "Use map center" }).click();
  await expect(page.locator("#new-count")).toHaveText("1");
  await expect.poll(redPixels).toBeLessThan(highlighted - 300);
  await expect.poll(async () => (await colors()).purple).toBeGreaterThan(300);
  await expect.poll(async () => (await colors()).yellow).toBeGreaterThan(300);
  await toggle.uncheck();
  await expect.poll(async () => (await colors()).purple).toBeGreaterThan(300);
  await expect.poll(async () => (await colors()).yellow).toBeGreaterThan(300);
  await toggle.check();
  await expect(page.locator("#gap-summary")).toContainText("Residential gap parcels: 1");
  await expect(page.locator("#unknown-count")).toHaveText("2");
  await page.getByRole("button", { name: "Clear candidate" }).click();
  await expect.poll(redPixels).toBeGreaterThan(highlighted - 100);
  await expect.poll(async () => (await colors()).purple).toBe(0);
  await expect.poll(async () => (await colors()).yellow).toBe(0);
});

test("other zoning and uncertain parcels never become colored gaps or candidate additions", async ({ page }) => {
  const data = await fixture(page);
  data["parcels.geojson"].features[1].properties.coverage = "covered";
  data["graph.json"].parcels[1].baseline = "covered";
  data["summary.json"].counts = { covered: 2, uncovered: 2, unknown: 1 };
  data["summary.json"].focus.counts = { covered: 2, uncovered: 0 };
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Ready.");
  await expect(page.locator("#uncovered-count")).toHaveText("0");
  await expect(page.locator("#unknown-count")).toHaveText("2");
  await expect.poll(async () => (await mapColors(page)).red).toBeLessThan(40);
  await page.getByRole("checkbox", { name: "Highlight coverage gaps" }).uncheck();
  await expect.poll(async () => (await mapColors(page)).red).toBeLessThan(40);
  await page.getByRole("button", { name: "Use map center" }).click();
  await expect(page.locator("#new-count")).toHaveText("0");
  await expect(page.locator("#candidate-detail")).toContainText("2 developed residential parcels");
  // The candidate marker's antialiased edge contributes a few purple pixels.
  await expect.poll(async () => (await mapColors(page)).purple).toBeLessThan(40);
});

test("inferred parcel gaps remain visible, include connector cost, and disclose the estimate", async ({ page }) => {
  const data = await fixture(page);
  data["summary.json"].focus.inferred_counts.uncovered = 1;
  const parcel = data["parcels.geojson"].features[1];
  parcel.geometry.coordinates[0] = [
    [-123.751, 39.299], [-123.749, 39.299], [-123.749, 39.301],
    [-123.751, 39.301], [-123.751, 39.299],
  ];
  Object.assign(parcel.properties, {
    access: "inferred_straight_line", improvement_value: 10000,
    access_gap_m: 8000, baseline_miles: 5.3,
    access_connector: [[-123.751, 39.3], [-123.76, 39.3]],
  });
  data["graph.json"].parcels[1].access = [[0, .75, .75, 8000]];
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Ready.");
  await expect(page.locator("#focus-rule")).toContainText("$10,000");
  await expect(page.locator("#gap-summary")).toContainText("Inferred-access gaps: 1");
  await expect.poll(async () => (await mapColors(page)).red).toBeGreaterThan(300);
  await page.getByRole("button", { name: "Inspect parcels" }).click();
  const canvas = page.locator(".maplibregl-canvas");
  const bounds = await canvas.boundingBox();
  await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  const popup = page.locator(".maplibregl-popup-content");
  await expect(popup).toContainText("County improvement value: $10,000");
  await expect(popup).toContainText("Baseline route + access: 5.3 mi");
  await expect(popup).toContainText("8,000 m straight-line");
  await expect(popup).toContainText("not a verified driveway");
  await page.getByRole("button", { name: "Use map center" }).click();
  await expect(page.locator("#new-count")).toHaveText("0");
  await expect(page.locator("#candidate-detail")).toContainText("1 developed residential parcels reached");
  await expect(popup).toHaveCount(0);
  await expect(page.locator("#map-warning")).toBeHidden();
});
