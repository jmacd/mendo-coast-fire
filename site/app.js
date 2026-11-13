import maplibregl from "maplibre-gl";
import proj4 from "proj4";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";

proj4.defs("EPSG:3310", "+proj=aea +lat_1=34 +lat_2=40.5 +lat_0=0 +lon_0=-120 +x_0=0 +y_0=-4000000 +datum=NAD83 +units=m +no_defs");

const $ = (id) => document.getElementById(id);
const empty = () => ({ type: "FeatureCollection", features: [] });
const number = (value) => value.toLocaleString();
let map, worker, candidateMarker, popup, ready = false, mode = "place", requestId = 0, currentNew = [];
let selectedStation = null, currentReached = [];

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = false;
}

function clearError() {
  $("error").hidden = true;
  $("error").textContent = "";
}

function clearSelection() {
  requestId++;
  popup?.remove();
  for (const id of currentNew) map.setFeatureState({ source: "parcels", id }, { added: false });
  for (const id of currentReached) map.setFeatureState({ source: "parcels", id }, { stationReached: false });
  if (selectedStation) map.setFeatureState({ source: "stations", id: selectedStation.id }, { selected: false });
  currentNew = [];
  currentReached = [];
  selectedStation = null;
  map.getSource("candidate-roads")?.setData(empty());
  map.getSource("connector")?.setData(empty());
  candidateMarker?.remove();
  candidateMarker = null;
  $("station-reach-legend").hidden = true;
  $("road-reach-label").textContent = "Candidate's five-mile road reach";
  $("candidate").hidden = false;
  $("candidate").setAttribute("aria-busy", "false");
  $("new-count").textContent = "--";
  $("candidate-detail").textContent = "Place a station to calculate its contribution. Each click replaces the previous candidate.";
  $("clear").disabled = true;
  $("clear").textContent = "Clear candidate";
}

function selectLocation(lngLat) {
  if (!ready) return;
  clearSelection();
  clearError();
  $("status").textContent = "Following the road network...";
  $("candidate").setAttribute("aria-busy", "true");
  candidateMarker = new maplibregl.Marker({ color: "#7b35c9" }).setLngLat(lngLat).addTo(map);
  $("clear").disabled = false;
  worker.postMessage({
    type: "scenario",
    id: requestId,
    xy: proj4("EPSG:4326", "EPSG:3310", [lngLat.lng, lngLat.lat]),
  });
}

function selectStation(station) {
  if (!ready) return;
  clearSelection();
  clearError();
  selectedStation = station;
  $("candidate").hidden = true;
  $("clear").disabled = false;
  $("clear").textContent = "Clear station";
  $("road-reach-label").textContent = "Selected station's five-mile road reach";
  $("status").textContent = `Calculating the five-mile road reach of ${station.properties.name}...`;
  map.setFeatureState({ source: "stations", id: station.id }, { selected: true });
  worker.postMessage({
    type: "station", id: requestId,
    xy: proj4("EPSG:4326", "EPSG:3310", station.geometry.coordinates),
  });
}

function showPopup(lngLat, title, lines, connector = null) {
  popup?.remove();
  const content = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = title;
  content.append(heading);
  for (const line of lines) {
    const p = document.createElement("p");
    p.textContent = line;
    content.append(p);
  }
  popup = new maplibregl.Popup().setLngLat(lngLat).setDOMContent(content).addTo(map);
  const coordinates = typeof connector === "string" ? JSON.parse(connector) : connector;
  map.getSource("parcel-connector").setData({
    type: "FeatureCollection",
    features: coordinates ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } }] : [],
  });
  popup.on("close", () => map.getSource("parcel-connector").setData(empty()));
}

async function getJSON(filename) {
  const response = await fetch(new URL(filename, document.baseURI), { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${filename}: HTTP ${response.status}. Run fire-coverage run and rebuild the site.`);
  return response.json();
}

function updateGapHighlight() {
  const highlighted = $("highlight-gaps").checked;
  const added = ["boolean", ["feature-state", "added"], false];
  const reached = ["boolean", ["feature-state", "stationReached"], false];
  const uncovered = ["==", ["get", "coverage"], "uncovered"];
  map.setPaintProperty("parcel-fill", "fill-color", [
    "case", added, "#a45cff", reached, "#38bdf8",
    ["match", ["get", "coverage"], "covered", "#438360",
      "uncovered", highlighted ? "#c34f43" : "#d58678", "#a4aaa8"],
  ]);
  map.setPaintProperty("parcel-fill", "fill-opacity",
    ["case", ["any", added, reached], .85, highlighted ? ["case", uncovered, .7, .18] : .55]);
  map.setLayoutProperty("gap-outline", "visibility", highlighted ? "visible" : "none");
  $("explorer").classList.toggle("gaps-highlighted", highlighted);
}

function mapData(parcels, stations, highway) {
  const added = ["boolean", ["feature-state", "added"], false];
  const reached = ["boolean", ["feature-state", "stationReached"], false];
  const active = ["any", added, reached];
  const included = ["==", ["get", "focus_status"], "included"];
  const mapped = ["all", included, ["!=", ["get", "access"], "inferred_straight_line"]];
  map.addSource("parcels", { type: "geojson", data: parcels });
  map.addLayer({
    id: "parcel-context", type: "line", source: "parcels",
    filter: ["==", ["get", "focus_status"], "uncertain"],
    paint: {
      "line-color": "#707977",
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, .25, 15, .75],
      "line-opacity": .3,
    },
  });
  map.addLayer({ id: "parcel-fill", type: "fill", source: "parcels", filter: included });
  map.addLayer({
    id: "parcel-line", type: "line", source: "parcels",
    filter: mapped,
    paint: {
      "line-color": ["case", added, "#58248f", reached, "#0369a1", "#4c6355"],
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, ["case", active, 1.5, .15], 15, ["case", active, 3, .8]],
      "line-opacity": ["case", active, 1, .6],
    },
  });
  map.addLayer({
    id: "gap-outline", type: "line", source: "parcels",
    filter: ["all", mapped, ["==", ["get", "coverage"], "uncovered"]],
    paint: {
      "line-color": ["case", added, "#58248f", reached, "#0369a1", "#982d27"],
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, .8, 15, 2],
      "line-opacity": .9,
    },
  });
  map.addLayer({
    id: "inferred-outline", type: "line", source: "parcels",
    filter: ["all", included, ["==", ["get", "access"], "inferred_straight_line"]],
    paint: {
      "line-color": ["case", added, "#58248f", reached, "#0369a1",
        ["match", ["get", "coverage"], "uncovered", "#982d27", "#275238"]],
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.3, 15, ["case", active, 3, 2]],
      "line-dasharray": [3, 2],
    },
  });
  updateGapHighlight();
  map.addSource("highway", { type: "geojson", data: highway });
  map.addLayer({ id: "highway", type: "line", source: "highway", paint: { "line-color": "#324d66", "line-width": 2.5 } });
  map.addSource("candidate-roads", { type: "geojson", data: empty() });
  map.addLayer({
    id: "candidate-roads-border", type: "line", source: "candidate-roads",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#34402b", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4, 14, 7] },
  });
  map.addLayer({
    id: "candidate-roads", type: "line", source: "candidate-roads",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffff00", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2, 14, 4] },
  });
  map.addSource("connector", { type: "geojson", data: empty() });
  map.addLayer({ id: "connector", type: "line", source: "connector", paint: { "line-color": "#58248f", "line-width": 2, "line-dasharray": [2, 2] } });
  map.addSource("parcel-connector", { type: "geojson", data: empty() });
  map.addLayer({
    id: "parcel-connector", type: "line", source: "parcel-connector",
    paint: { "line-color": "#7c410c", "line-width": 3, "line-dasharray": [3, 2] },
  });
  map.addSource("stations", { type: "geojson", data: stations });
  map.addLayer({
    id: "stations", type: "circle", source: "stations",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 4, 14, 8],
      "circle-color": ["case",
        ["!=", ["get", "status"], "included"], "#fffdf8",
        ["boolean", ["get", "special_case"], false], "#e97816",
        "#913e2c"],
      "circle-stroke-color": ["case", ["boolean", ["feature-state", "selected"], false], "#0369a1", "#5d332a"],
      "circle-stroke-width": ["case", ["boolean", ["feature-state", "selected"], false], 4, 1.5],
    },
  });
}

function stationTable(stations) {
  for (const { properties: p } of stations.features) {
    const row = document.createElement("tr");
    row.classList.toggle("special-case-row", p.special_case === true);
    const selection = p.status === "included" ? "Included (unverified)" : p.status.replaceAll("_", " ");
    const values = [p.name, p.special_case ? `${selection} - special case` : selection,
      p.highway_miles === null ? "No route within limit" : p.highway_miles.toFixed(2),
      p.snap_m === null ? "No connection" : `${p.snap_m.toFixed(0)} m`];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    if (p.special_case) {
      const note = document.createElement("small");
      note.textContent = `${p.address}. ${p.special_case_note}`;
      row.firstElementChild.append(note);
    }
    $("station-list").append(row);
  }
}

async function initialize() {
  map = new maplibregl.Map({
    container: "map", center: [-123.72, 39.2], zoom: 8.3, maxZoom: 19,
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256, maxzoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
        },
      },
      layers: [{ id: "basemap", type: "raster", source: "osm", paint: { "raster-saturation": -.6, "raster-opacity": .8 } }],
    },
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-left");
  map.on("error", ({ error }) => {
    console.error(error);
    $("map-warning").textContent = `Map rendering or tile error: ${error.message}. Coverage results may still be available; do not assume missing layers mean no coverage.`;
    $("map-warning").hidden = false;
  });
  const mapLoaded = new Promise((resolve) => map.once("style.load", resolve));
  worker = new Worker(new URL("./coverage-worker.js", import.meta.url), { type: "module" });
  const workerLoaded = new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === "ready") {
        resolve();
        return;
      }
      if (data.type === "error" && data.id === undefined) {
        reject(new Error(data.message));
        return;
      }
      if (data.id !== requestId) return;
      $("candidate").setAttribute("aria-busy", "false");
      if (data.type === "error") {
        if (selectedStation) {
          $("status").textContent = `Station reach unavailable for ${selectedStation.properties.name}. The baseline is unchanged.`;
        } else {
          clearSelection();
          $("status").textContent = "Candidate not evaluated. The baseline is unchanged.";
        }
        showError(data.message);
        return;
      }
      const result = data.result;
      map.getSource("candidate-roads").setData(result.roads);
      const origin = selectedStation ? selectedStation.geometry.coordinates : candidateMarker.getLngLat().toArray();
      map.getSource("connector").setData({
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [origin, result.snapped] } }],
      });
      map.setPaintProperty("connector", "line-color", selectedStation ? "#0369a1" : "#58248f");
      if (selectedStation) {
        currentReached = result.reachedIds;
        for (const id of currentReached) map.setFeatureState({ source: "parcels", id }, { stationReached: true });
        $("station-reach-legend").hidden = false;
        $("status").textContent = `Station evaluated. ${selectedStation.properties.name}: ${number(currentReached.length)} residential parcels within five miles, including any inferred access. The baseline is unchanged.`;
        return;
      }
      currentNew = result.newIds;
      for (const id of currentNew) map.setFeatureState({ source: "parcels", id }, { added: true });
      const placed = candidateMarker.getLngLat();
      $("new-count").textContent = number(currentNew.length);
      $("candidate-detail").textContent = `${number(result.reachedIds.length)} developed residential parcels reached in total, including any inferred access distance. Station road connector: ${result.snap_m.toFixed(0)} m; route to Highway 1: ${result.highway_miles.toFixed(2)} mi. Candidate: ${placed.lat.toFixed(5)}, ${placed.lng.toFixed(5)}.`;
      $("status").textContent = "Candidate evaluated. Purple parcels are newly covered; green parcels were already covered. Bright yellow roads show the candidate's reach.";
    };
    worker.onerror = (event) => {
      console.error(event);
      ready = false;
      reject(new Error("Routing worker failed. Reload the page or rebuild the data."));
      clearSelection();
      $("candidate").setAttribute("aria-busy", "false");
      $("status").textContent = "Routing unavailable. No candidate result is valid.";
      showError("Routing worker failed. Reload the page or rebuild the data.");
    };
  });
  worker.postMessage({ type: "load", url: new URL("graph.json", document.baseURI).href });
  const [summary, parcels, stations, highway] = await Promise.all([
    getJSON("summary.json"), getJSON("parcels.geojson"), getJSON("stations.geojson"), getJSON("highway.geojson"),
    mapLoaded, workerLoaded,
  ]);
  if (!parcels.features.length || !stations.features.length || !highway.features.length) {
    throw new Error("Required coverage layers are empty. Rebuild the dataset.");
  }
  if (!summary.focus?.inferred_counts || !Number.isFinite(summary.focus.min_improvement_value)) {
    throw new Error("Development and inferred-access data is missing. Rebuild the dataset.");
  }
  mapData(parcels, stations, highway);
  $("station-count").textContent = number(summary.stations);
  for (const category of ["covered", "uncovered"]) {
    $(`${category}-count`).textContent = number(summary.focus.counts[category]);
  }
  $("unknown-count").textContent = number(summary.focus.uncertain);
  $("focus-rule").textContent = `Residential zoning and at least $${number(summary.focus.min_improvement_value)} in county improvement value. Keep mapped road contacts; infer straight-line access only where missing. Baseline stations include the Caspar special case.`;
  $("gap-summary").textContent = `Residential gap parcels: ${number(summary.focus.counts.uncovered)}. Existing stations: ${number(summary.stations)} (including local additions). Inferred-access gaps: ${number(summary.focus.inferred_counts.uncovered)}. Zoning/value uncertain: ${number(summary.focus.uncertain)} (outlines only). Other zoning or below cutoff: ${number(summary.focus.excluded)}.`;
  $("highlight-gaps").onchange = updateGapHighlight;
  $("data-date").textContent = `Analysis built ${new Date(summary.built_at).toLocaleDateString()}. Counts focus on ${number(summary.focus.parcels)} developed residential parcels; ${number(summary.focus.inferred_counts.covered + summary.focus.inferred_counts.uncovered)} use inferred access. The download retains all ${number(summary.parcels)} parcel identifiers. Source dates may be older; inspect provenance and station records.`;
  stationTable(stations);
  const fit = () => map.fitBounds([[summary.extent[0], summary.extent[1]], [summary.extent[2], summary.extent[3]]], { padding: 35, duration: 0 });
  fit();
  $("fit").onclick = fit;
  $("use-center").onclick = () => selectLocation(map.getCenter());
  $("coordinate-form").onsubmit = (event) => {
    event.preventDefault();
    const lat = Number($("latitude").value), lng = Number($("longitude").value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      showError("Enter valid latitude and longitude coordinates.");
      return;
    }
    map.jumpTo({ center: [lng, lat], zoom: 13 });
    selectLocation({ lng, lat });
  };
  $("clear").onclick = () => {
    const wasStation = selectedStation !== null;
    clearSelection();
    clearError();
    $("status").textContent = `${wasStation ? "Station selection" : "Candidate"} cleared. Showing existing-station coverage.`;
  };
  for (const next of ["place", "inspect"]) {
    $(`${next}-mode`).onclick = () => {
      mode = next;
      for (const value of ["place", "inspect"]) $(`${value}-mode`).setAttribute("aria-pressed", String(value === mode));
      map.getCanvas().style.cursor = mode === "place" ? "crosshair" : "";
      $("status").textContent = mode === "place" ? "Click near a road to place a candidate, or click an existing station to see its reach." : "Click a parcel to inspect it, or a station to see its five-mile reach.";
    };
  }
  map.on("click", (event) => {
    if (!ready) return;
    const station = map.queryRenderedFeatures(event.point, { layers: ["stations"] })[0];
    if (station) {
      selectStation(station);
      return;
    }
    if (mode === "place") {
      selectLocation(event.lngLat);
      return;
    }
    const hits = map.queryRenderedFeatures(event.point, { layers: ["parcel-fill", "parcel-context"] });
    const hit = hits[0];
    if (!hit) return;
    const p = hit.properties;
    showPopup(event.lngLat, `Parcel ${p.apn}`, [
      `County zoning: ${p.base_zones}.`,
      `County improvement value: ${p.improvement_value == null ? "Unknown" : `$${number(p.improvement_value)}`}.`,
      p.focus_status === "included" ? "Included in the developed-residential focus." : "Zoning or improvement value is uncertain; excluded from map coverage counts.",
      `Baseline (all existing stations): ${p.coverage === "uncovered" ? "No modeled route within five miles" : p.coverage}.`,
      currentNew.includes(hit.id) ? "Newly covered by the hypothetical station." : "Not an addition from the current candidate.",
      ...(currentReached.includes(hit.id) ? ["Within five miles of the selected station, including any inferred access."] : []),
      `Access: ${p.access.replaceAll("_", " ")}. ${p.baseline_miles == null ? "" : `Baseline route + access: ${p.baseline_miles} mi.`}`,
      p.access === "inferred_straight_line"
        ? `Inferred access: ${number(p.access_gap_m)} m straight-line from parcel boundary to nearest connected road, counted in the total. The dashed line is an estimate, not a verified driveway; actual access may be longer or blocked.`
        : "Parcel boundary access is estimated, not verified.",
    ], p.access_connector);
  });
  ready = true;
  for (const id of ["highlight-gaps", "place-mode", "inspect-mode", "use-center", "use-coordinates", "fit"]) $(id).disabled = false;
  map.getCanvas().style.cursor = "crosshair";
  $("status").textContent = "Ready. Red parcels highlight developed-residential coverage gaps. Dashed outlines indicate inferred access. Click near a road to place a hypothetical station.";
}

initialize().catch((error) => {
  console.error(error);
  ready = false;
  worker?.terminate();
  $("status").textContent = "Coverage data unavailable. No results can be interpreted.";
  showError(error.message);
});
