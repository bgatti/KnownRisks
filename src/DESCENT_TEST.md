# Descent / Ascent / Touch-and-Go Test Page

Standalone test page for validating flight-phase detection before it
feeds the main map's violation classifier.

## Running it

```bash
cd noise/web
NODE_OPTIONS=--max-old-space-size=10240 npx vite --port 5174
```

Open http://localhost:5174/descents

This is a standalone route — it bypasses App.jsx entirely (no API calls,
no DB, no `/api/noise` dependency). It loads only `tracks_2026.json` from
`C:\tmp\noise_data\` via the vite external-data plugin.

## What it shows

**Sidebar** — 6 handpicked test tracks from 2026-04-08 and 2026-04-10:

| Label | Tail | Type | Expected phase |
|-------|------|------|---------------|
| Pattern C172 | N4547E | C172 | pattern (33 desc) |
| Pattern C172b | N268FM | C172 | pattern (34 desc) |
| Arrival DA40 | N272DS | DA40 | arrival (1 desc) |
| Departure C172 | N406JA | C172 | departure |
| Overflight A320 | N434UA | A320 | overflight |
| Helo pattern | 86-24529 | H60 | pattern (35 desc) |

Each track shows: phase classification, nearest airport + field elevation,
descent/ascent/T&G counts, AGL range, MSL range.

**Map** — tracks colored by phase (amber=pattern, blue=arrival,
green=departure, gray=overflight). Toggle overlays:

- **Red (5px)** — descent segments (above 800 AGL → below 250 AGL)
- **Green (5px)** — ascent segments (below 250 AGL → above 800 AGL)
- **Amber (7px)** — touch-and-go (descent bottom → ascent start within 90s)

Tooltips show segment details: point count, MSL altitudes, AGL at
bottom/top, ground time for T&G.

## Detection thresholds

All AGL values are relative to the nearest airport's published field
elevation, not the track's own minimum altitude.

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Low AGL | 250 ft | Must get below this to count as "on the ground" |
| High AGL | 800 ft | Must come from / reach above this |
| T&G max gap | 90 s | Bottom-to-climb. Median is 7s, p90 is 53s |

### Airport field elevations (MSL ft)

| Airport | Elev |
|---------|------|
| KBDU | 5288 |
| KBJC | 5673 |
| KEIK | 5130 |
| KLMO | 5055 |
| KAPA | 5885 |
| KGXY | 4697 |

## How phases are classified

- **Pattern** — starts low + ends low + ≥2 descents
- **Departure** — starts low, ends high
- **Arrival** — starts high, ends low
- **Overflight** — never below threshold

## How T&G feeds the main map

On the main map (#map), `bandTrack()` calls `detectQuietHourTnG()` which
applies the same descent/ascent/T&G logic but ONLY flags T&G events that
occur during quiet hours (5 PM – 5 AM MST). These render as **purple**
segments and count as noise excursions in the offender rankings.

## Data requirements

- Tracks need 4-tuple points `[lat, lon, alt, t_sec]` for time-based
  detection. Old 3-tuple tracks skip T&G classification.
- Track records need `t0` (epoch) for wallclock hour calculation.
- Per-year JSON files must exist in `C:\tmp\noise_data\`.

## Adding test tracks

Edit `TEST_TRACKS` in `DescentTest.jsx`. Each entry is `{ label, src }`
where `src` matches a track's `src` field (e.g. `globe/2026-04-10/a5844a`).
All test tracks must be from the same year file loaded in the `useEffect`.
To add tracks from other years, add the year to the fetch call.
