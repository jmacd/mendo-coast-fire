# Mendocino Coast fire coverage

A reproducible public-data screening map for **Gualala through Westport**,
inspired by the neighboring solar study. A static site shows parcels within
five road miles of mapped fire stations. Click to place one hypothetical
station and highlight only the parcels it adds to the existing baseline.
The next click replaces the candidate; it never changes the baseline.

**Highlight coverage gaps** is enabled by default: parcels beyond five road
miles from the existing stations, including the locally added Caspar station,
have strong red fills and outlines while other parcels fade. Only confirmed
residential zoning with at least **$10,000 county improvement value** receives
colored fills and contributes to coverage counts. Missing parcel access is
estimated using a straight-line connector, included in the five-mile distance.
**Dashed outlines** distinguish inferred access; inspect a parcel to see the
connector and its length. Other zoning and values below the cutoff are hidden;
uncertain zoning or value has faint outlines. Turn the highlight
off to restore the balanced coverage view. Hypothetical additions turn purple
with bold outlines without changing the existing-station gap count. They stay
prominent in either view. Bright yellow, dark-bordered roads show the candidate's
five-mile reach; already covered parcels remain green.

Click an **existing station marker in either map mode** to show its own
five-mile road reach in yellow and its reached residential parcels in blue.
The sidebar status identifies the station and reached-parcel count without
covering the map with a popup. This is not a hypothetical addition and never
changes baseline totals. Selecting another station or placing a candidate
replaces the selection; **Clear station** restores the baseline.
Existing stations use their configured 150 m road-connection tolerance,
including the connector in the five-mile distance. Excluded inventory stations
can also be inspected without adding them to the baseline; missing road
connections produce an explicit error rather than an invented coverage area.

This is **not** an emergency dispatch tool, an ISO/PPC or insurance
determination, proof of legal access, or a response-time model.

## Run locally

Requires Python 3.11+, Node 22+, internet access, and about 1 GB of free space.
Commands run from this directory; none opens a browser automatically.

```sh
python3 -m venv .venv
.venv/bin/pip install -e '.[test]'
npm ci
.venv/bin/fire-coverage run
npm run build
npm run preview
```

Visit <http://127.0.0.1:4180/>. The preview uses a dedicated port and fails
explicitly if that port is occupied instead of silently choosing another.
`npm run dev` also serves generated
`output/` data while developing the map. Missing data is a visible error,
not an empty coverage result. The routing calculations run locally in a
Web Worker; map clicks are not submitted to a routing API.

```sh
.venv/bin/fire-coverage fetch             # download/cache original sources
.venv/bin/fire-coverage analyze           # rebuild without network requests
.venv/bin/fire-coverage run --refresh     # explicitly refresh all sources
.venv/bin/pytest -q
.venv/bin/ruff check .
.venv/bin/ruff format --check .
npm test
npm run test:browser                     # requires Playwright Chromium
FIRE_SITE_PREVIEW=1 npm run test:browser -- tests/browser/real-data.spec.js
```

Install the headless test browser if needed with `npx playwright install chromium`.
The browser tests manage their own local server and never launch a GUI.
The real-data test runs only when generated data is present; preview mode
checks the production bundle after `npm run build`.

## What the five-mile rule means

- Highway 1 is the OSM road tagged `ref=CA 1` (or `1`), with segment
  midpoints between latitude 38.765 near Gualala and 39.650 just north of
  Westport. The rest of Highway 1 toward Leggett is not a study anchor.
- An existing station qualifies if it can **travel to that Highway 1
  segment in at most five road miles**. Direction matters on one-way roads.
  Stations in neighboring jurisdictions can qualify near the endpoints.
- Coverage travels **outward from all qualifying stations**, along the
  directed road network, for at most 8,046.72 meters. Distances use WGS84
  geodesic edge lengths, not travel time or circular buffers.
- Station locations snap to a road segment within 150 m. Hypothetical
  stations must be within 100 m of a road and within five road miles of the
  study highway. The assumed straight connector to the road counts toward
  both five-mile tests. Snap gaps are displayed, not treated as verified access.
- A county parcel has estimated access wherever a modeled road intersects
  the parcel or its 30 m tolerance buffer. This allows for centerline/right-
  of-way offsets. The buffer is **not** a five-mile coverage buffer; it
  neither creates connecting roads nor connects separate road components.
  No within-parcel driveway/building distance is known or counted.
- All road-contact intervals are considered, including the middle of long
  edges. A nearby centroid or intersection is never substituted for access.
- If a qualifying developed residential parcel has no mapped contact connected
  to the highway network, infer the shortest **parcel-boundary-to-road**
  connector to the nearest highway-connected modeled segment. Add its full
  straight-line length to the station's road-route distance, with no gap cap.
  Existing mapped contacts are retained, not replaced by this approximation.
  The connector is a parcel endpoint cost, not a new through-road or a shortcut
  between disconnected roads. No actual driveway or building access is verified.
- Faint outlines mean uncertain zoning or improvement value.
  Red residential parcels have no modeled route within five
  miles from the included stations. Green parcels have baseline coverage;
  purple parcels gain coverage from the hypothetical station. These totals
  include inferred parcel access costs wherever applicable.

County parcels intersecting a **ten-mile straight-line search envelope**
around the study highway are included. Five miles from highway to station
plus five from station to parcel cannot reach farther than this envelope.
The road download has a larger halo so eligible five-mile paths are not
cut off at the study boundary. Whole parcel geometries are retained, and
multiple county records for the same APN are counted once. This can color
large parcels whose buildings are much farther from the reachable edge.

## Data and limitations

Sources and parameters are in `config/mendocino.toml`:

| Source | Use |
|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/copyright), via Overpass | Connected road topology, Highway 1, directions, access tags, supplementary stations |
| [USGS structures, hosted by Esri](https://www.arcgis.com/home/item.html?id=2c36dbb008844081b017da6fd3d0d28b) | Fire-station locations; source descriptions/dates retained |
| [Mendocino County parcels](https://services2.arcgis.com/iq8zYa0SRsvIFFKz/arcgis/rest/services/Mendocino_County_Parcels/FeatureServer/0) | Parcel geometry, APNs, BASEZONE zoning and IMPV improvement value; no owner data |

OSM alone is not a complete parcel or station inventory. USGS stations are
supplemented with OSM points/building centers. Points within 50 m of a site's
representative point are consolidated into one location; source names and
IDs are preserved, with configured local additions taking priority, followed
by the most recently loaded USGS point.
This is spatial consolidation, not proof that organizations are identical.
The [NERIS Mendocino station list](https://neris.fsri.org/departments/FD06045071/stations)
also identifies the downtown station omitted from the initial USGS extract.
The resulting station list is **unverified**: active status, staffing, apparatus, seasonal
operation, duplicate/relocated stations and omitted substations require
department review before interpreting gaps as real service gaps.

### Residential focus

The map and candidate calculations use the county's `BASEZONE` attribute.
The configured dedicated-residential allowlist is **R1, R2, R3, RR, RMR, SR,
UR, MRR, MSR, MTR and MRM**. In particular, `RL` means **rangeland**, not
residential; `RC` is rural community, not a dedicated residential district.
Agricultural, timber, commercial and mixed-use zones are outside this focus,
even though some contain homes. Residential zoning does not prove a dwelling
exists or that the mapped road provides a usable or legal entrance.

All source parts grouped under an APN must have confirmed residential zoning.
The maximum reported `IMPV` per APN must meet `min_improvement_value`
in the configuration (currently **$10,000**); duplicate component values are
never summed. No reported value means uncertain, not zero. Invalid values
fail the analysis. Assessed improvement value is a development proxy, not
market value or proof of a home; low assessments or exemptions can omit homes.

Missing or unrecognized codes, ambiguous compound codes, conflicting
residential/non-residential parts, and missing improvement values remain
**uncertain**. Missing/disconnected parcel access no longer hides a qualifying
parcel: it receives the labeled straight-line estimate described above.
This optimistic approximation can cross barriers or underestimate winding
private driveways. A modeled estimate below five miles is not proof the home
is reachable within five road miles.

District definitions come from the county zoning ordinance, including
[Chapter 20.040](https://library.municode.com/ca/mendocino_county/codes/code_of_ordinances?nodeId=MECOCO_TIT20ZOOR_DIVIMECOZOCO_CH20.040ESZODI)
and Mendocino Town districts in Division III. The county's
[zoning map](https://www.mendocinocounty.gov/All-Departments/Information-Services/Geographic-Information-Systems/Zoning-Web-Map)
does not cover incorporated-city zoning, including Fort Bragg and Point Arena.
Missing city zoning remains uncertain, not a claim that there are no homes
or no coverage.

`parcels.geojson` retains **all** studied parcels and their modeled
coverage, plus `base_zones`, `zoning_status`, and `focus_status`
(`included`, `excluded`, or `uncertain`), `improvement_value`, and original
`mapped_access`. Inferred records have `access: inferred_straight_line`,
`access_gap_m`, and an `access_connector` coordinate pair. `baseline_miles`
reports the shortest modeled total, including the connector, even beyond five
miles when a route exists. `summary.json` retains overall
`counts`; `focus` contains the displayed covered/uncovered counts and
excluded/uncertain totals, the cutoff, and `inferred_counts`.
The **schema 3** routing graph contains only qualifying developed residential
parcels. Access records are `[edge, low, high]` for mapped frontage or
`[edge, fraction, fraction, connector_m]` for inferred access. Both Python
baseline routing and browser candidate/station routing add the connector cost.
Old schema 1/2 graphs must be rebuilt.

### Caspar special case

`additional_stations` in `config/mendocino.toml` permanently adds the locally
reported fire station at **42800 Caspar Little Lake Rd**. Its orange marker,
popup, inventory entry and downloadable records identify it as a special case.
It participates in the same station-selection and baseline coverage rules;
it is not a hypothetical station. Nearby future source records are consolidated
without losing the local addition or its special-case label.

The configured point is an **approximate parcel location**, derived from county
parcel `1185005100` (`FID 59005`) at that situs address, not a surveyed building
entrance. A secondary station directory lists the adjoining address, 42775;
this addition follows the locally reported 42800 address and remains subject to
location and operational verification. The local record, source reference and
configuration hash are included in `provenance.json`.

Omission from the imported USGS/OSM inventories does **not** establish that
insurers are unaware of the station or that premiums are incorrect.
Insurer recognition, rating eligibility and any premium effect remain unverified.

### Road and source limitations

The road profile excludes paths, tracks, explicitly private/restricted
roads, conditional access/direction and unverified gates/barriers. It allows
`destination` access and respects motor-vehicle access precedence and
one-way directions. Original OSM node IDs determine junctions, so geometrically
crossing roads/bridges are not incorrectly joined. It does **not** model
turn restrictions, emergency exemptions, vehicle dimensions/weight,
bridge capacity, road conditions or temporary closures. Private driveways
may be usable by firefighters but absent from this conservative graph.
Roads near parcel boundaries are not necessarily legal entrances.

Original downloads are cached in `data/` with query fingerprints, SHA-256
hashes, source URLs and retrieval timestamps. Acquisition fails on missing,
truncated or malformed data rather than silently publishing a partial run.
`output/provenance.json` identifies the source snapshot; retain it and the
original downloads when archiving a result. Refreshing can change results.

## Outputs and publishing

`output/` contains the graph, parcel and station GeoJSON, Highway 1 geometry,
station CSV, summary and provenance. All records considered near the highway
are in `stations.csv`, including excluded/unconnected stations and reasons.
`_site/` is the deployable static site; no backend or secret API key is needed.
MapLibre and projection code are bundled locally. Only the OSM basemap tiles
require an external request when browsing.

The [public site](https://jmacd.github.io/mendo-coast-fire/) is deployed by
`.github/workflows/pages.yml`. Every push to `main` runs linting, Python,
routing and browser checks, then downloads fresh source data, builds the
site, verifies a real coverage scenario against the production bundle, and
deploys to GitHub Pages. Pull requests run checks without publishing.

Pages must use **GitHub Actions** as its publishing source. To refresh the
data without a code change, run **Check and publish coverage** manually on
`main` with **deploy** enabled (the default). Source failures stop deployment
and leave the previously published site intact; failure screenshots are kept
as Actions artifacts for seven days. The site's relative asset/data URLs
support the `/mendo-coast-fire/` project path and local previews. Local builds
do not publish or change repository settings.

OSM-derived road data is subject to the
[Open Database License](https://www.openstreetmap.org/copyright). Preserve
OSM attribution and the downloadable derived graph when publishing.
Other datasets retain their source terms. Public source geometry is not a
survey product. Do not use this map to plan emergency response.
