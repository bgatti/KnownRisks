# Front Range Aviation Monitor — API Reference

Base URL: `https://web-app-production-fedf.up.railway.app`

All endpoints return JSON with `Access-Control-Allow-Origin: *`.

---

## Noise Map API

Pre-computed from Postgres. Historical tracks are classified by the backfill job; stats and trends are aggregated server-side.

### GET /api/noise/tracks

Paginated, filtered tracks with pre-banded polylines for map rendering.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| year | string | all | Filter by year (e.g. `2024`) |
| base | string | all | Filter by base airport (e.g. `KBDU`) |
| school | string | all | Filter by flight school name |
| purpose | string | all | Filter by flight purpose |
| tod_start | int | — | Time-of-day filter start hour (0–24) |
| tod_end | int | — | Time-of-day filter end hour (0–24) |
| violations_only | 1 | — | Only tracks with excursions (worst_class IS NOT NULL) |
| tng_only | 1 | — | Only touch-and-go quiet-hour excursions (seg_purple > 0) |
| limit | int | 500 | Max tracks returned (max 2000) |
| offset | int | 0 | Pagination offset |

**Response:**
```json
{
  "tracks": [{
    "call": "N12345",
    "type": "C172",
    "desc": "CESSNA 172",
    "ownOp": "OWNER NAME",
    "src": "globe/2024-08-15/hex",
    "year": "2024",
    "date": "2024-08-15",
    "base": "KBDU",
    "worst": "red",
    "seg_total": 142,
    "seg_red": 12,
    "seg_orange": 8,
    "seg_yellow": 15,
    "len_total_ft": 234567.8,
    "len_red_ft": 12345.6,
    "len_orange_ft": 8901.2,
    "len_yellow_ft": 15678.9,
    "school": "School Name",
    "purpose": "training",
    "bands": [
      { "klass": null, "points": [[40.03, -105.22, 7800], ...] },
      { "klass": "yellow", "points": [[40.04, -105.23, 7400], ...] },
      { "klass": "red", "points": [[40.05, -105.24, 6200], ...] }
    ]
  }],
  "total": 98392,
  "limit": 500,
  "offset": 0,
  "pages": 197
}
```

**Rendering bands:** Each `bands[]` entry is a contiguous run of the same classification. Render each as a Polyline colored by `klass` (`null` = clean). Adjacent runs share their boundary point for line continuity. Points are `[lat, lon, alt_ft_msl]`.

### GET /api/noise/stats

Aggregated statistics for the current filter. Returns per-tail excursion rankings, daily time series, and available filter options.

| Param | Type | Description |
|-------|------|-------------|
| year, base, school, purpose, tod_start, tod_end | — | Same filters as /tracks |

**Response includes:** `perTail[]`, `cube{}` (year×base breakdown), `byDate[]` (daily red/orange/yellow/purple ft), `years[]`, `bases[]`, `schools[]`, `purposes[]`.

### GET /api/noise/years

Returns available years in the database.

```json
{ "years": ["2023", "2024", "2025", "2026"] }
```

### GET /api/noise/leaderboard

"Good-Neighbor" ranking of aircraft / bases / schools. Biases toward flying
**often** while staying clean and **low-impact over populated areas**.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `airport` | string | — | Restrict to aircraft whose **home base** is this field, e.g. `airport=KBDU`. Comma-separate for multiple (`KBDU,KLMO`). Aliases: `homeBase`, `base`. |
| `days` | int | 90 | Lookback window in days, ending today (1–3650). |
| `limit` | int | 20 | Number of entries returned, after scoring (1–100). |
| `by` | string | `tail` | Group by `tail`, `base`, or `school`. |
| `source` | string | — | `tracks` forces the historical-table path; default uses the live store. |
| `origin` | string | — | `local`/`transient` — only applied on the historical fallback. |

**Data source.** By default the board aggregates the **live capture store**
(`live_tracks`, the current per-day captures) over the window — this is the
fresh data. The historical `tracks` table is an automatic fallback (and is
forced by `?source=tracks`). `source` in the response says which was used.

**Scoring.**

```
score = flights^1.5 × (1 − excursion_rate) × 1 / (1 + impact_index)
```
- `flights` — real takeoff→landing **cycles** (touch-and-goes/taxi-backs merged
  when the on-ground gap < 10 min). Super-linear, so frequent flyers rank higher.
- `excursion_rate` — fraction of path length inside the noise-abatement (VNAP) zones.
- `impact_index` — population-noise impact **per foot flown**, normalized: each
  segment = length × people/km² beneath it × (1000 ft / AGL)² (louder when lower
  over more people). `impact_basis` is `population` (real grid) or, as a fallback,
  `zone_proxy` (severity-weighted zone excursion per mile).

Higher score = better neighbor. Sort: `score` desc, then `flights` desc.

Response (CORS `*`, `Cache-Control: 300`):
```json
{
  "generated_at": "…", "source": "live_tracks", "days_loaded": 30,
  "by": "tail", "airport": "KBDU", "home_base": "KBDU", "origin": null,
  "window": { "days": 30, "from": "2026-04-23", "to": "2026-05-22" },
  "scoring": {
    "formula": "flights^1.5 × (1 − excursion_rate) × 1/(1 + impact_index)",
    "flights_exponent": 1.5, "impact_basis": "population",
    "sort": "score desc, flights desc"
  },
  "entries": [{
    "rank": 1, "name": "N4593Y", "type": "PA25", "icon_url": "/aircraft-icons/PA25",
    "school": null, "base": "KBDU", "purpose": "tow_plane",
    "flights": 26, "total_nm": 1548.4, "clean_nm": 1525.2, "excursion_nm": 23.2,
    "excursion_rate": 1.5, "pop_impact": 412000000, "impact_basis": "population",
    "impact_index": 0.266, "score": 103.19, "score_pct": 100
  }]
}
```
Per-entry fields: `name` is the tail (`by=tail`) / airport (`by=base`) / school
(`by=school`). `excursion_rate` is a percent. `pop_impact` is the raw weighted
sum (`null` under `zone_proxy`). `impact_index` lower = better. `score_pct` is
0–100 vs the top entry. **`icon_url`** is the aircraft image URL (`by=tail`
only; `null` for aggregates) — see "Aircraft icons" below; render with a
fallback to the `type` label on load error.

```
GET /api/noise/leaderboard?airport=KBDU&days=30&by=tail&limit=10
```

#### Aircraft icons

`icon_url` is a per-tail override or per-type override from optional
`public/aircraft_icons.json` (`{ "byTail": {...}, "byType": {...} }`), else the
convention path **`/aircraft-icons/<TYPE>`**.

`GET /aircraft-icons/<TYPE>` returns a **real aircraft photo** for the type:
- an uploaded file in `public/aircraft-icons/<TYPE>.{png,jpg,svg}` if present, else
- a **302 redirect** to a type photo resolved from Wikipedia page-images (by the
  expanded type name; cached server-side), else
- a generated SVG placeholder (plane glyph + type label) for unmatched types.

So an `<img src={icon_url}>` shows the aircraft photo with no client logic.
`icon_url` is `null` for `by=base`/`by=school` aggregates. To pin a specific
image, drop a file in `public/aircraft-icons/` or add it to `aircraft_icons.json`.

### GET /api/noise/impact-explain

Per-flight, per-**segment** population-noise breakdown for one tail — the
auditable detail behind the leaderboard's `impact_index`. Computed live from the
population grid + stored geometry. Backs the `/impact-explain?tail=…` map.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `tail` | string | — | **Required.** Tail/callsign, e.g. `N3547L`. |
| `days` | int | 30 | Lookback window (1–365). |
| `limit` | int | 12 | Max flights returned (1–50). |

```json
{
  "tail": "N3547L", "days": 90, "window": { "from": "…", "to": "…" },
  "pop_scale": 1000, "kernel": { "GROUND_REF_FT": 5300, "REF_AGL_FT": 1000, "MIN_AGL_FT": 300 },
  "totals": { "flights": 5, "len_ft": 9200998, "pop_impact": 5375269356, "impact_index": 0.584, "max_contribution": 107925771 },
  "flights": [{
    "id": 123, "date": "2026-04-10", "type": "C172", "type_desc": "Cessna Skyhawk 172", "base": "KBDU",
    "points": [[40.04, -105.22, 6500], …],
    "contributions": [80119953, …],
    "segments": [{ "ft": 3868, "alt": 5600, "agl": 300, "pop": 1864, "atten": 11.11, "contribution": 80119953 }],
    "len_ft": 1953986, "pop_impact": 1144555273, "impact_index": 0.586
  }]
}
```
`contributions[i]` is the impact of segment `points[i]→points[i+1]` (so length =
`points.length − 1`); `segments[i]` is its full breakdown. Use them to heat-color
the path and label AGL at population peaks.

### GET /api/noise/recent-landings

Recent **full-stop landings** at an airport, each with its population-noise
impact (the **same kernel** as the leaderboard / impact-explain — no separate
Lmax model), classified `bands[]`, and authoritative visitor-gating values.
Drives the RealImpact / Welcome kiosk: render `impact_grade`/`impact_score` and
draw `bands[]` — no client-side scoring needed.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `airport` | ICAO | `KBDU` | Field to report landings at (must be a known field). |
| `minutes` | int | 30 | Touchdown within the last N minutes (1–720). |

A landing qualifies when the track ends on the ground (≤ field elev + 200 ft)
within 2.5 nm of the field, has ≥ 5 min wheels-down, and touched down within the
window. Sourced from the live store (`live_tracks`), most-recent first.

```json
{
  "generated_at": "2026-05-22T16:24:00.000Z",
  "airport": "KBDU", "minutes": 30, "pop_scale": 1000,
  "scoring": {
    "impact_index": "population-noise per ft / POP_SCALE (same kernel as leaderboard & impact-explain)",
    "impact_score": "alias of impact_index (no purpose multiplier — purpose-aware ranking is a caller concern)",
    "impact_grade": "A<0.3 B<0.6 C<1.2 D<2.0 F (on impact_score)"
  },
  "count": 1,
  "landings": [{
    "tail": "N4345G", "type": "P28A", "desc": "Piper Cherokee/Warrior PA-28",
    "icon_url": "/aircraft-icons/P28A",
    "base": "KBJC", "purpose": "training", "school": "…",
    "origin": "KBJC", "dest": "KBJC", "origin_dist_nm": 0.1,
    "landed": true, "landed_at": "2026-05-22T16:17:09.183Z",
    "on_ground_min": 8.8, "airborne_min": 71.8,
    "impact_index": 0.237, "impact_score": 0.475, "impact_grade": "B",
    "pop_impact": 1144555273,
    "bands": [{
      "klass": null,
      "impact": 25620, "impact_share": 0.486,
      "points": [[40.04, -105.22, 6500, 1240], [40.05, -105.21, 6200, 6400], …]
    }]
  }]
}
```

**Scoring contract** — `impact_index` is the population-noise measurement
(identical kernel to the leaderboard / impact-explain). `impact_score` is
currently an **alias of `impact_index`** — there is **no purpose multiplier**
applied server-side. Purpose-aware weighting (e.g. emphasizing training in a
ranking or slide rotation) is a caller concern. The `purpose` field is still
returned on each landing so callers can apply their own policy. `impact_grade`
is the letter mapped from `impact_score` (= `impact_index`).
**`bands[]`** carry the classified runs (`klass`: `red`/`orange`/`yellow`/`null`)
with per-point and per-band impact values — see "Bands" below.

**Gating fields** — `airborne_min` is the *last sortie's* airborne time (a
day-track merges all of an aircraft's flights, so this walks back to that
landing's takeoff). `origin_dist_nm` is the great-circle from the first observed
fix to the field — note the capture is corridor-bounded (~36 nm), so this is the
*observed inbound leg*, not necessarily the true flight origin distance.
`null` `airborne_min` means a taxi-only track (no airborne segment captured).

**Bands — per-point and per-band impact for gradient renderers.**
Each `bands[].points[]` is a **4-tuple** `[lat, lon, alt_ft_msl, impact]`
where `impact` is the per-point population-noise intensity (same kernel family
as `impact_index`). The fourth slot is a strict superset of the legacy 3-tuple,
so clients that read `p[0..2]` keep working.

Each band also carries:
- `impact` — sum of per-point impacts in this band.
- `impact_share` — that band's share of the track total, `0.000..1.000`.

Use `impact_share` to color whole bands relatively when you don't autoscale
per-point; use `p[3]` to autoscale across visible points (e.g. percentile
stops) for a smooth gradient. The 4-bucket `klass` is a **population/zone
classifier** — within a single `klass`, per-point `impact` can vary ~100×+
because population density and AGL both vary along the path. Categorical
`klass` and continuous `impact` complement each other.

### GET /api/noise/missions

Completed flights categorized by purpose. A **flight** is a takeoff→landing
cycle (a track with both a takeoff and a landing). Touch-and-goes and
taxi-backs are not counted separately — consecutive cycles whose on-ground gap
is under 10 minutes are merged into one flight. Counts are flights, not
aircraft. Purpose is looked up per tail from the historical `tracks`
classification (the 2023–24 backfill); aircraft with no classified history fall
into `unknown`.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `days` | int | 1 | Window size in UTC days, ending today. `1` = today only. Clamped to 1–90. |
| `airport` / `operatedAt` | ICAO | — | **"operated" scope** — flights where `origin` **or** `dest` (nearest field to the first/last fix) **or** home `base` == this airport. The field's own activity, **including visitors**. |
| `homeBase` / `base` | ICAO | — | **"based" scope** — only aircraft whose home base is this airport. |

If both are given, `airport`/`operatedAt` (operated) wins. With no scope param,
returns the whole corridor (`scope: "all"`). The response echoes `airport` and
`scope` (`operated` \| `based` \| `all`) so the panel can be labeled accurately.
Scope is applied **before** cycle extraction, so scoped queries are fast;
results are cached 300 s.

Points for the same aircraft are concatenated across days before cycle
extraction, so a flight crossing midnight UTC is counted once.

```json
{
  "date": "2026-05-22", "days": 30, "from": "2026-04-22", "to": "2026-05-22",
  "airport": "KBDU", "scope": "operated",
  "updated_at": "2026-05-22T21:16:00.000Z",
  "days_loaded": 30,
  "total": 412,
  "categories": {
    "training": { "count": 380, "aircraft": [{ "tail": "N123AB", "type": "C172", "school": "...", "base": "KBDU", "flights": 41 }] },
    "medivac":  { "count": 14,  "aircraft": [...] }
  }
}
```

`total` is the flight count across the window; each category `count` is its
share. `days_loaded` is how many daily rows actually had capture data (may be
less than `days` if the window pre-dates available history). Returns
`total: 0` with empty `categories` when no capture data exists in the window.

---

## Excursions API

Real-time and historical excursion data. Live tracks are classified at capture time by the capture worker; historical tracks use pre-computed DB columns from the backfill job.

### GET /api/excursions/boot

Combined endpoint: tracks with pre-computed bands + per-tail active summaries. Primary endpoint for client bootstrapping.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| hours | int | 1 | Lookback window in hours |
| limit | int | 100 | Max historical tracks (max 500) |
| include | string | — | Comma-separated: `reports`, `notifications` |

**Response:**
```json
{
  "generated_at": "2026-04-20T21:16:00.000Z",
  "window": { "hours": 1, "from": "2026-04-20", "to": "2026-04-20", "limit": 100 },
  "include": [],
  "render": {
    "format": "bands",
    "colors": { "red": "#dc2626", "orange": "#f97316", "yellow": "#facc15", "purple": "#a855f7" },
    "clean_color": "#1a7070",
    "weight": 1.5,
    "opacity": 0.7,
    "blend": "multiply",
    "note": "Each track.bands[] is an array of {klass, points} runs. Render each as a Polyline colored by klass (null = clean_color). Points are [lat, lon, alt_ft]."
  },
  "active": [{
    "tail": "N855CP",
    "type": "C172",
    "school": "School Name",
    "airport": "KBDU",
    "worst": "red",
    "counts": { "yellow": 5, "orange": 3, "red": 8, "purple": 0 },
    "pointsHit": 16,
    "lastDate": "2026-04-20"
  }],
  "tracks": [{
    "call": "N12345",
    "type": "C172",
    "src": "live",
    "date": "2026-04-20",
    "base": null,
    "worst": "red",
    "school": null,
    "seg_total": 142,
    "seg_red": 12, "seg_orange": 8, "seg_yellow": 15,
    "len_total_ft": 234567.8,
    "len_red_ft": 12345.6, "len_orange_ft": 8901.2, "len_yellow_ft": 15678.9,
    "bands": [
      { "klass": null, "points": [[40.03, -105.22, 7800], ...] },
      { "klass": "red", "points": [[40.05, -105.24, 6200], ...] }
    ],
    "live": true
  }],
  "live": { "updated_at": "2026-04-20T21:16:26", "tracks": 316 }
}
```

With `include=reports`: each `active[]` entry gets `reportCount`, `reportScoreMax`, `reportScoreAvg`.

With `include=notifications`: each `active[]` entry gets `operatorNotified`, `pilotNotified`, `pilotAction { status, at, steps }`.

### GET /api/excursions/active

Per-tail excursion summary within a time window.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| hours | int | 48 | Lookback window |
| include | string | — | `reports`, `notifications` |

### GET /api/excursions/segments

Classified track segments for a specific tail or time window.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| tail | string | — | Aircraft registration (e.g. `N52993`) |
| hours | int | 720 | Lookback window |
| limit | int | 50 | Max tracks |

### GET /api/excursions/flight-ops

Intent model showing aircraft operations near an airport.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| base | string | KBDU | Airport code |
| radius | int | 10 | Radius in nm |

### GET /api/excursions?tail=N12345

Per-aircraft excursion history with deep link back to the map.

| Param | Type | Description |
|-------|------|-------------|
| tail | string | **Required.** Aircraft registration |
| from | string | Start date (YYYY-MM-DD) |
| to | string | End date (YYYY-MM-DD) |

---

## Performance

| Endpoint | Response time | Payload size |
|----------|--------------|--------------|
| /api/noise/tracks (100 tracks) | ~0.6s | ~170 KB |
| /api/excursions/boot (1hr, 316 live) | ~1.5s | ~6 MB |
| /api/excursions/boot (30 days, 100 hist + live) | ~1.6s | ~7 MB |
| /api/noise/years | <0.1s | <100 B |

---

## Architecture

- **Postgres** (Railway): `tracks` table (98K+ rows) with pre-computed columns: `year`, `date`, `base_airport`, `worst_class`, `seg_*`, `len_*_ft`, `bands` (JSONB), `school`, `purpose`, `rand_key`, `start_hour`
- **Backfill job** (`backfill.js`): One-time classification of historical tracks. Computes noise zone violations, purple T&G detection, band polylines. Safe to re-run.
- **Capture worker** (`capture-worker.js`): Polls ADS-B every 2s, classifies points against noise zones at capture time, stores pre-computed `bands`/`worst`/stats in `live_tracks` table.
- **Web app** (`vite.config.js`): Vite dev server with API middleware plugins. Reads pre-computed data from Postgres — no runtime classification.

### Band format

Both `/api/noise/tracks` and `/api/excursions/boot` use the same band format:

```json
{
  "klass": "red",       // "red" | "orange" | "yellow" | "purple" | null (clean)
  "points": [           // [lat, lon, altitude_ft_msl]
    [40.039, -105.225, 6200],
    [40.041, -105.228, 6150]
  ]
}
```

Colors: red `#dc2626`, orange `#f97316`, yellow `#facc15`, purple `#a855f7`, clean `#1a7070`.
