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

Top aircraft/bases/schools ranked by clean flight distance.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| days | int | 90 | Lookback window (1–3650) |
| limit | int | 20 | Number of entries (1–100) |
| by | string | tail | Group by: `tail`, `base`, or `school` |
| homeBase | string | — | Restrict to aircraft whose **home base** is this airport, e.g. `homeBase=KBDU`. Ranks the based fleet among itself. Comma-separate for multiple (`KBDU,KLMO`). `base` is an accepted alias. |
| origin | string | — | `local` or `transient` — per-flight geometric class (within vs beyond the local radius). |

**"Based here" vs "operated here".** `homeBase` filters `tracks.base_airport`,
the aircraft's home field — this is the "based at KBDU" filter the leaderboard
needs. It is **not** an operating-airport filter: the backfill records each
aircraft's home base, not the field a given flight operated at, so there is no
operating-airport dimension to filter on. `homeBase` is consistent with the
`base` param on `/api/noise/stats` and `/api/noise/tracks`, which already filter
`base_airport`. (Before this change the leaderboard ignored `base` entirely,
which is why `?base=KBDU` returned the global top-N rather than KBDU-based tails.)

`origin` is a different axis from `homeBase`: a based aircraft can fly transient
(cross-country), and a visitor can fly local. The `cube` in `/api/noise/stats`
breaks flights down by `base_airport × origin` if you need both at once.

The response echoes the applied filters as `home_base` and `origin`, alongside
the existing `by` and `window`. Entry shape is unchanged — for `by=tail`:
`name` (tail), `type`, `school`, `base` (home), `purpose`, `flights`,
`total_nm`, `clean_nm`, `excursion_nm`, `red_nm`/`orange_nm`/`yellow_nm`, and
the `*_pct` variants.

```
GET /api/noise/leaderboard?by=tail&homeBase=KBDU&days=3650&limit=8
→ { "by":"tail", "home_base":"KBDU", "origin":null,
    "window": { "days":3650, "from":"…", "to":"…" },
    "entries": [ { "name":"N…", "base":"KBDU", "flights":…, "clean_pct":…, … } ] }
```

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

Points for the same aircraft are concatenated across days before cycle
extraction, so a flight crossing midnight UTC is counted once.

```json
{
  "date": "2026-04-20",
  "days": 30,
  "from": "2026-03-22",
  "to": "2026-04-20",
  "updated_at": "2026-04-20T21:16:00.000Z",
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
