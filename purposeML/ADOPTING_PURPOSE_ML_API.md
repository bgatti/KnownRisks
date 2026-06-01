# purposeML — how to adopt it (for agents and consumers)

Path-based flight-purpose classifier. Given a track of `{lat, lon, altMslFt, tsUnix}` points, returns one of 14 purpose labels with a confidence and an audit trail. Composes [phaseML](../phaseML/README.md) for per-sample phases + maneuver detection (touch_and_go, thermalling, …) — does **not** re-implement them.

- **Production base URL**: https://web-app-production-fedf.up.railway.app
- **Local dev**: http://localhost:5174
- **CORS**: all endpoints set `Access-Control-Allow-Origin: *`
- **Stateless**: no caches, no DB. Safe to call N times in parallel.
- **Optional install**: if the `purposeML/` directory is missing, the HTTP endpoints return 404 and the in-process resolver gracefully skips its shape step (see vite.config.js `requireOpt('./purposeML/index.js')`). No build-time dependency.

---

## When to use

Use purposeML when the existing `purpose` field (e.g. on `/api/flights/current` or `/api/adsb/flights`) is `unknown` or `ga_single`, and you want a path-shape inference of what the flight is actually doing. The taxonomy is drop-in compatible with `vite.config.js`'s `purposeOf` / `resolvePurpose` output values.

Do NOT use it when:
- Type code already gives a confident answer (e.g. `PA25` → `tow_plane`). `resolvePurpose` handles type regex first; only fall through to purposeML when type is missing, anonymized (`~hex`), or generic.
- A curated `special_use_aircraft.json` entry exists for the tail.
- You only have < 30 points or < 5 min of active wall-clock. purposeML will honestly return `{ purpose: 'unknown', confidence: 0.0 }`.

---

## Buckets

```
glider_local   glider_xc     tow_plane
training       pattern_solo
survey         patrol
airline        biz_jet       turboprop
ga_xc          ga_local      helicopter
unknown
```

`unknown` carries `confidence: 0.0`. Every other bucket carries a `confidence` in (0.5, 0.95). Treat anything `< 0.7` as "hedge or fall through to type-based heuristics".

---

## Endpoints

All endpoints are JSON, CORS-open, no auth.

### `GET /api/purpose-ml/health`

Liveness probe. Returns `{ "ok": true, "version": "0.2.0" }`.

### `GET /api/purpose-ml/buckets`

```json
{ "buckets": ["glider_local", "glider_xc", "tow_plane", "training", "pattern_solo", "survey", "patrol", "airline", "biz_jet", "turboprop", "ga_xc", "ga_local", "helicopter", "unknown"] }
```

### `POST /api/purpose-ml/classify`

Canonical entry point. Pass a track of points in the standard shape (the same shape phaseML and `/api/adsb/track/:icao` use).

**Request:**
```json
{
  "points": [
    { "lat": 40.04, "lon": -105.23, "altMslFt": 8000, "tsUnix": 1779200000 },
    { "lat": 40.04, "lon": -105.22, "altMslFt": 7950, "tsUnix": 1779200002 }
  ],
  "typeCode": "C172",
  "tail": "N4632F",
  "isSchoolFleet": false,
  "includeFeatures": false
}
```

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| `points` | `Point[]` | — | yes | Canonical track. Each Point is `{ lat, lon, altMslFt, tsUnix }` with `tsUnix` in epoch seconds. ≥ 2 points; the classifier needs ≥ 30 + 5 min active to do anything useful. |
| `typeCode` | `string` | `""` | no | ICAO type code. Used to detect engineless aircraft (gliders / balloons) and to calibrate phaseML's slow_flight / thermalling detectors. |
| `tail` | `string` | `""` | no | Informational — included in payload so audit trails can name the aircraft. |
| `isSchoolFleet` | `boolean` | `false` | no | If true, the verdict shifts from `pattern_solo` → `training` when the pattern rule fires. Look this up against `flight_schools_fleets.json` before calling. |
| `includeFeatures` | `boolean` | `false` | no | When true, response includes the full feature vector. |

**Response:**
```json
{
  "purpose": "pattern_solo",
  "confidence": 0.8,
  "reasons": [
    "touch_and_go + landed_full_stop = 24 ≥ 3 (phaseML)",
    "pattern_seconds=3021 ≥ 300 (≥ 5 min in pattern)",
    "alt_agl_p90=727 ft < 2500",
    "home=KBJC is primary-trainer field"
  ]
}
```

With `includeFeatures: true`, an additional `features` object is included — see [Features reference](#features-reference).

**Errors:**
- `400 { "error": "need at least 2 points" }` — empty / undersized `points`.
- `500 { "error": "..." }` — internal exception.

### `POST /api/purpose-ml/classify-archive`

For the on-disk archive format (`C:/tmp/noise_data/tracks_<year>.json`) where each point is `[lat, lon, altMslFt, secs_since_t0]`. Pass `t0Seconds` (epoch seconds for offset=0) — usually `Math.floor(Date.UTC(year, 0, 1) / 1000)`.

**Request:**
```json
{
  "points": [[40.04, -105.23, 8000, 12345], [40.04, -105.22, 7950, 12347]],
  "t0Seconds": 1767225600,
  "typeCode": "C172",
  "tail": "N4632F",
  "isSchoolFleet": false,
  "includeFeatures": false
}
```

Same response as `/classify`. Errors as above plus `400 { "error": "need t0Seconds (epoch seconds)" }`.

### `POST /api/purpose-ml/extract`

Feature extraction only. **Request:** `{ "points": [...], "typeCode": "C172" }`. **Response:** `{ "features": { ... } }`. See below.

---

## Features reference

The feature object surfaced by `/extract` and (when requested) `/classify`:

| Field | What it captures |
|---|---|
| `nPoints` | Number of input points. |
| `durationS` | Wall-clock duration first → last fix (seconds). |
| `activeWallClockS` | Sum of inter-fix dt's that are NOT session breaks. Use this instead of `durationS` for "is the track real or a concatenated gap". |
| `pathLengthNm`, `straightLineNm`, `tortuosity` | Geometric. Tortuosity = pathLength / straightLine. Beeline ≈ 1.0; survey grid ≈ 3-10; thermalling glider ≈ 10+. |
| `bboxDiagNm` | Diagonal of the lat/lon bounding box (nm). |
| `headingDeltaStd`, `turnCount`, `returnedToOrigin` | Bending. |
| `altAglP50` / `altAglP90` / `altMaxFt` | Altitude stats (AGL via nearest known field's elevation; MSL for the max). |
| `maxClimbFpm` / `maxDescentFpm` | Peak vertical speeds. |
| `cruiseSpeedKts` / `gsP90Kts` | Ground speed stats. |
| `levelFraction` | Share of time at constant alt (±100 ft for ≥ 30 s). |
| `enginelessShare` | 1 if type code matches a glider regex, else 0. |
| `phaseSeconds` | Seconds in each phaseML phase: `on_ground`, `taxiing`, `pattern`, `practice_area`, `departing`, `inbound`, `en_route`, `nearby`, `landed_full_stop`. |
| `maneuverCounts` | Event counts from phaseML's detectors: `touch_and_go`, `landed_full_stop`, `thermalling`, `holding_pattern`, `sightseeing_orbit`, `steep_turn`, `s_turns_across_road`, `turn_around_a_point`, `chandelle`, `lazy_8`, `slow_flight`, `stall_recovery`, `emergency_descent`. |
| `gridScore` | Bidirectional parallel-pass score in [0, 1]. 2 × min(forward_band_share, reverse_band_share). |
| `loiterRadiusNm` | Smallest circle containing 80% of fixes in any 5-min window. |
| `ifrCruiseS` / `vfrCruiseS` / `ifrCruiseShare` | Phase-gated. Seconds spent at exact thousands (IFR rule below FL180) vs thousands+500 (VFR), restricted to `en_route` / `inbound` / `departing` phases. |
| `cruiseAltMslFt` | Median altitude during level cruise. |
| `startIcao` / `endIcao` | Airport ICAO within 2 nm of the first / last fix. Often null on capture-radius-truncated tracks. |
| `inferredOriginIcao` / `inferredOriginDistNm` / `inferredDestIcao` / `inferredDestDistNm` | **Closest** airport (up to 50 nm) to the first / last fix regardless of distance. Use these instead when literal endpoints are null. |
| `homeIcao` / `homeTraits` | Airport ICAO closest to the track centroid (within 5 nm) and its traits (`gliderPort`, `primaryTrainer`, `towered`, `busyClassD`, `airlineHub`, `bizjetHub`). |
| `homeFieldDwell` | 1 if `startIcao === endIcao`, else 0. |
| `airportsVisited` | List of every airport ICAO within 2 nm of any fix. |

---

## Adoption recipes

### From a Node service (no HTTP)

```js
import { classifyOneTrack } from './purposeML/index.js'

const verdict = classifyOneTrack(points, {
  typeCode: 'C172',
  tail: 'N4632F',
  isSchoolFleet: schoolMap.has('N4632F'),
})
// → { purpose, confidence, reasons[] }
```

### From the browser / a remote agent

```js
const r = await fetch('/api/purpose-ml/classify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ points, typeCode: 'C172', tail: 'N4632F' }),
})
const { purpose, confidence, reasons } = await r.json()
```

### Boosting an existing `purpose` field

`resolvePurposeWithShape` in [vite.config.js](../vite.config.js) is the reference integration. The priority chain:

```js
function resolvePurposeWithShape(stored, type, tail, points, schoolMap) {
  // 1. Special-use registry (curated overrides) — authoritative.
  const su = SPECIAL_USE_MAP.get(tail?.toUpperCase())
  if (su) return { purpose: purposeOf(type, tail, false, su), source: 'special_use' }

  // 2. Type regex — unambiguous airframes win.
  const typeAnswer = typeRegexAnswer(type)   // PA25→tow_plane, GLID→glider, B73→airline …
  if (typeAnswer) return { purpose: typeAnswer, source: 'type' }

  // 3. Stored curated value on the tracks row.
  if (stored && stored !== 'unknown') return { purpose: stored, source: 'tracked' }

  // 4. Path-shape inference (purposeML) when there are enough points.
  if (points && points.length >= 30 && purposeMLClassify) {
    const v = purposeMLClassify(points, { typeCode: type, tail, isSchoolFleet: schoolMap.has(tail) })
    if (v.confidence >= 0.7) return { purpose: v.purpose, source: 'shape', confidence: v.confidence, reasons: v.reasons }
  }

  // 5. Type-based fallback (the old behaviour).
  return { purpose: purposeOf(type, tail, schoolMap.has(tail), null), source: 'fallback' }
}
```

Surface the `source` on the wire (e.g. `purpose_source: 'shape' | 'tracked' | 'type' | 'special_use' | 'fallback'`) so consumers can distinguish inferred from curated.

### Reading the audit trail

`reasons[]` is the contract. Each entry is one threshold that fired (or context that was applied):

- **Phase / maneuver counts** sourced from phaseML, e.g. `"touch_and_go + landed_full_stop = 24 ≥ 3 (phaseML)"`. Strongest signals.
- **Shape thresholds** sourced from purposeML, e.g. `"grid_score=0.83 > 0.5 (bidirectional passes)"`, `"meander=2.57 > 1.5"`.

If a verdict surprises you, the reasons[] tell you which gate to argue with. File issues against phaseML (if the maneuver count is wrong) or purposeML (if the threshold is wrong).

---

## Latency

purposeML composes phaseML's `detectAll` (12 maneuver detectors) which dominates the per-track cost.

| Track length | Time |
|---|---|
| 60 points (~ 2 min) | ~ 5 ms |
| 500 points (~ 15 min) | ~ 15 ms |
| 2000 points (~ 70 min) | ~ 40 ms |

The classifier itself is ~ 0.1 ms once features are in hand. For batch jobs (`/api/adsb/flights` enrichment, the kiosk's leaderboard) cache by `(track_id, last_point_ts)` — the verdict is a pure function of the track.

---

## Limitations to flag in consumers

1. **Archive truncation distorts altitude / cruise stats.** The yearly archive caps altitude at 9000 ft and clips out-of-region segments. An airline overflight will look low and slow because only the in-range portion of the descent is retained. Use the type regex BEFORE falling through to purposeML for known airliner / biz-jet types.
2. **Without a tail → school-fleet map, `training` won't fire.** purposeML defaults `isSchoolFleet: false`. Look up the tail in `flight_schools_fleets.json` and pass `isSchoolFleet: true` to upgrade `pattern_solo` → `training`.
3. **`home_field` is centroid-based.** Tracks that pass over many fields without staying near one (`airportsVisited.length >= 2`) report `homeIcao: null`. The `pattern_solo` rule that gates on a primary-trainer home won't fire and the track gets the more conservative confidence-0.72 branch.
4. **Live capture radius truncates real endpoints.** Live archive (`tracks_live_YYYY-MM-DD.json`) captures only the in-radius portion. The literal `startIcao`/`endIcao` will be null for ~94% of flights. Use `inferredOriginIcao` + `inferredOriginDistNm` instead — that gives you "closest airport regardless of distance", with the distance reported as a confidence signal.
5. **Unknown means we couldn't tell, not that something is wrong.** 97% of `unknown` verdicts on the archived sample are "track too short" (< 30 points or < 5 min active). Consumers should display `unknown` honestly rather than hiding it or guessing.
6. **Per-flight ≠ per-tail.** A single direct flight could be private transport, a school cross-country, or a ferry. For confident *what kind of aircraft is this* answers, aggregate across many flights using [experiments/deep_dive.mjs](experiments/deep_dive.mjs) and the FAA registry.

---

## Versioning

- Version surfaced via `GET /api/purpose-ml/health` → `version`.
- Bucket list (`/api/purpose-ml/buckets`) is the wire contract. New buckets are additive; existing labels won't be renamed.
- Reason strings are human-readable diagnostics, not contract; consumers should not parse them.

---

## See also

- [purposeML/README.md](README.md) — package overview
- [purposeML/kickoff.md](kickoff.md) — design rationale
- [purposeML/experiments/FLIGHT_BREAKDOWN_GROUP_REPORT.md](experiments/FLIGHT_BREAKDOWN_GROUP_REPORT.md) — per-tail + FAA-registry deep dive
- [phaseML README](../phaseML/README.md) — the lower-level phase + maneuver detector this composes
- [vite.config.js `resolvePurposeWithShape`](../vite.config.js) — the live integration point
