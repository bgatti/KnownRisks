# Globalized sortie — schema + extractor

A **sortie** is one airborne flight of one aircraft. The defining
boundary is a **break of ≥ 17 minutes** in the flight path (either a
real ground pause or an ADS-B coverage dropout of that length). T&Gs
and brief full-stop-with-taxi-backs **do not** end a sortie. Long
parking does.

This module gives the kiosk and the localized noise report a single
unit of analysis that's both source-agnostic (live tracks, the
historical `tracks` Postgres rows, the yearly archive files) and
stable across the UTC date boundary that breaks the per-day archive
shape.

## Definition

```
sortie  := contiguous sequence of fixes where every consecutive pair
           has Δt < SORTIE_BREAK_MS (default 17 min)
break   := the gap that separates two sorties for the same tail
```

A break can be a real ground pause OR a coverage dropout. We don't
try to distinguish — at 17 min the operational consequence is the
same: "this is a different sortie."

## Schema

```jsonc
{
  // Stable, deterministic — same input always produces the same id
  "sortie_id": "n4593y-2025-12-21-3",

  // Aircraft
  "tail": "N4593Y",
  "type": "C172",
  "desc": "Cessna Skyhawk 172",      // expanded type if available
  "ownOp": "...",                    // from archive when present

  // Endpoints
  "departure": {
    "airport": "KBDU",               // nearest field within 4 nm of the first fix; null otherwise
    "time": "2025-12-21T15:23:32Z",  // ISO at first fix
    "lat": 40.0394, "lon": -105.2258, "alt_ft": 5290
  },
  "arrival": {
    "airport": "KBDU",
    "time": "2025-12-21T16:36:14Z",
    "lat": 40.0394, "lon": -105.2258, "alt_ft": 5288
  },

  // Airports visited (within 4 nm of any fix), departure + arrival included
  "airports_visited": ["KBDU", "KLMO"],

  // Detected operations along the path
  "operations": [
    { "kind": "takeoff",       "airport": "KBDU", "time": "..." },
    { "kind": "touch_and_go",  "airport": "KBDU", "time": "..." },
    { "kind": "landing",       "airport": "KBDU", "time": "..." }
  ],

  // Path-shape inferred (via purposeML when available)
  "purpose": {
    "label": "training",                   // see purposeML buckets
    "confidence": 0.85,
    "reasons": ["..."]
  },

  // Glider-tow pairing — only populated when this is a tow plane (PA25/PA18) and
  // a glider was detected close in lat/lon/alt/time during the climb phase
  "tow": null,                             // or { glider_tail, glider_sortie_id }

  // Metrics
  "metrics": {
    "duration_s": 4362,
    "duration_min": 72.7,
    "distance": {
      "furthest_nm": 12.3,                 // greatest distance any point ever reached from departure
      "total_nm": 64.1,                    // sum of haversine segments
      "travel_nm": 0                       // straight-line from departure → arrival; 0 if same airport
    },
    "height": {
      "msl_max_ft": 8950,
      "msl_mean_ft": 7240,
      "agl_max_ft": 3662,                  // relative to departure airport elev (or first-fix alt when no airport)
      "agl_mean_ft": 1952
    }
  },

  // FLIGHTSEGMENTS — load-bearing field name.
  // Always an OBJECT (never bare points). The kiosk + analyzers
  // dereference `flightsegments.points` for the path. For archive
  // sorties we copy points; for live sorties we can store a reference
  // (track_id, ts_offset_start, ts_offset_end) to keep the wire small.
  "flightsegments": {
    "source": "archive:tracks_2025.json#track=12345",
    "point_count": 487,
    "points": [
      [40.0394, -105.2258, 5290, 1734790012000],
      // ... [lat, lon, alt_msl_ft, ts_ms]
    ]
  },

  // Annotations of the path — VNAP incursions, complaints, noise events, etc.
  // Each annotation is a slice of the path with a kind + payload.
  "annotations": [
    {
      "kind": "vnap_incursion",
      "klass": "orange",
      "zone": "KBDU Frasier Meadows",
      "point_index_start": 234, "point_index_end": 252,
      "payload": { "agl_min_ft": 1187, "agl_peak_ft": 1562 }
    },
    {
      "kind": "noise_complaint",
      "point_index_nearest": 412,
      "payload": { "lat": 40.05, "lon": -105.18, "dba_estimate": 67, "klass": "orange" }
    }
  ]
}
```

### Index-vs-copy on `flightsegments`

- **Archive sorties** (the 2025 batch): copy points inline; the
  yearly archive is large but each sortie is bounded (median ≈ 300
  points, ~ 8 KB).
- **Live sorties** (current day): can store a reference
  `{ source: "live_tracks:<date>:<tail>", ts_start, ts_end }` and
  resolve on read.
- **Either way, `flightsegments` is an OBJECT** — never a bare array.
  The wire shape stays consistent so consumers never have to branch.

### Operations detection

We detect three kinds inside a sortie:

| kind | trigger |
| --- | --- |
| `takeoff` | First fix > `field_elev + 200` (AGL > 200) after a ground fix or sortie start |
| `landing` | First fix ≤ `field_elev + 200` with low groundspeed near an airport (≤ 4 nm) |
| `touch_and_go` | A landing immediately followed (< 60 s ground) by another takeoff at the same field |

The TAIL's actual takeoff/landing at the sortie boundaries become the
`departure` and `arrival` records. Mid-sortie ops (T&Gs, transit
stops) populate `operations[]`.

## Constants

| Constant | Value | Meaning |
| --- | --- | --- |
| `SORTIE_BREAK_MS` | 17 min | Gap that splits sorties |
| `AIRPORT_NEAR_NM` | 4 | Nearest-airport threshold for departure / arrival / visited |
| `GROUND_AGL_FT` | 200 | Above field elev counts as "airborne" |
| `TG_GROUND_S` | 60 | T&G classification (full-stop with < 60 s ground = T&G, not separate sortie) |

## Sources

The extractor (`sortieExtract.js`) is a **pure function**:

```js
extractSorties(tailPoints, opts) → sortie[]
```

Three callers feed it:

1. **Live**: walk `live_tracks` for a date range, group by tail,
   sort points by ts, call extractor. New endpoint
   `GET /api/sorties-global?airport=&since=&until=`.
2. **Historical**: walk `tracks` Postgres rows per tail. Bands
   contain points; we flatten and call the extractor. Same endpoint
   with a wider window.
3. **Archive**: walk yearly archive JSON. Convert t_offset →
   absolute ms via `t0 + day_offset_secs`. Call the extractor. This
   powers the backfill script.

## Goal queries (v0)

The two queries the operator asked for to validate the model:

### A. Top 10 sorties ranked by `metrics.height.agl_max_ft`, filtered to `metrics.distance.furthest_nm > 40`

These are the cross-country / high-altitude sorties in the 2025
archive. The archive's 9000 ft altitude cap (per CLAUDE.md) clips
airline overflights to ~ 3700 ft AGL above KBDU's field elev — so the
true high-altitude population is invisible to this archive. The
ranking surfaces what the data CAN see: regional turboprop / biz-jet
operations that fly above 9000 ft and travel > 40 nm laterally.

### B. Top 10 tails by sorties / day in 2025

Sortie density per tail — `sortie_count / active_days`. Surfaces the
busiest training / pattern aircraft. Active days = days where the
tail appears in the archive at all.

See `scripts/sortie_topN_2025.mjs` for the runner.
