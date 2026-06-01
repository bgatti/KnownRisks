# adjusted_alt / verified_alt — what it is, how it's computed, why

ADS-B transponders broadcast **barometric altitude** referenced to the
1013.25 hPa / 29.92 inHg standard pressure surface, not true MSL.
Local pressure differs from standard; the transponder itself has
calibration tolerances. The combined error is routinely **±100–400 ft**
for any given flight on any given day. That's enough to push a noise
event from "1300 ft AGL inbound" to "1700 ft AGL inbound," which
swings the AGL-aware dBA proxy by ~3 dB and the noise-abatement-zone
membership test from "inside" to "above ceiling" — both load-bearing
on `/api/flights/current` indicators.

`adjusted_alt` (also called `verified_alt` in the codebase — same
quantity) is the per-flight correction that backs that error out.

## The formula

For one flight's set of fixes `[lat, lon, alt_ft_msl, ts_ms]`:

```
offset_ft      = mean(reported_alt at runway-anchor fixes) − field_elevation_ft
verified_alt   = reported_alt − offset_ft
verified_agl   = verified_alt − field_elevation_ft
```

`field_elevation_ft` comes from `ENRICH_AP[airport].elev` (set per
airport in vite.config.js) — the published surface elevation. For
KBDU = 5288 ft, KBJC = 5673 ft, KAPA = 5885 ft, KFNL = 5016 ft,
KEIK = 5025 ft, KLMO = 5054 ft, KGXY = 4697 ft (all FAA Form 5010
via AirNav, also cached in `noise/web/data/runways.json` under each
airport's `runways[*].elev_ft`).

The `offset_ft` is the systematic delta between what the transponder
*said* the aircraft was at when it was on the runway, and where the
runway *actually* is. Every reported altitude on that flight gets the
same offset subtracted. Sign convention: positive offset = transponder
over-reports.

## Where the anchors come from

A fix qualifies as a runway-anchor when it's:

- Within `VERIFIED_ALT_CAL_RADIUS_NM = 2.0` nm of the airport center,
- Stationary-shaped (low ground speed AND/OR level vertical AND/OR
  clustered with other fixes at the same altitude).

`findRunwayAnchors` (vite.config.js) scores every in-radius fix and
returns the high-confidence cohort:

| Signal | Weight | Reasoning |
| --- | --- | --- |
| `gs < 20 kts` | **+3** | Taxiing, landing roll, or stopped. Very high confidence the aircraft is on the surface. |
| `\|vs\| < 100 fpm` | **+2** | Level flight — necessary but not sufficient (level flight at any altitude scores too). |
| 2+ neighbors within ±10 ft alt | **+2** | A cluster of same-alt fixes means the transponder is reporting the same number repeatedly — the runway surface, almost always. |

Anchors are sorted by score desc, then by altitude asc (ties break to
the lower fix — physically closer to the surface). The cohort that
feeds the offset is every anchor with `score ≥ topScore / 2`. The
cohort mean must be within `VERIFIED_ALT_CAL_MAX_AGL_FT = 500 ft` of
field elevation; otherwise the flight never actually descended to the
runway and we don't trust the calibration.

Minimum cohort size is `VERIFIED_ALT_CAL_MIN_FIXES = 3`.

### Fallback: lowest-25% if anchor signals aren't there

Sometimes the ADS-B data is sparse — the receiver missed the taxi
phase, or the aircraft is fast enough at touchdown that `gs < 20`
never registers. In that case we fall back to the prior algorithm:
take every in-radius fix, sort by altitude ascending, average the
lowest `VERIFIED_ALT_CAL_COHORT_FRACTION = 0.25` (floor 3 fixes).
Same `MAX_AGL_FT` sanity bound applies — if the cohort still averages
> 500 ft AGL, the offset stays 0 (we'd rather emit no correction than
a wrong one).

## Regional time-smoothing

A single flight's self-calibration is noisy. **Pressure changes
across a region within minutes; transponders share the same baro
station across the same hour.** The post-pass blends each flight's
own offset with its temporal neighbors at the same airport.

For each flight that has a self-calibrated `_selfOffset`:

1. Record `(landingMs = midpoint of takeoff_ts and landed_at,
   offsetFt = _selfOffset)` into a per-airport time-sorted series.
2. For every flight (including those that never approached the
   runway), look up its midtime in the airport's series, take the
   `REGIONAL_OFFSET_NEAR_N = 2` events before and the 2 events after,
   compute mean and stddev, drop any sample further than
   `max(50, stddev)` ft from the mean, and average what remains.
3. Replace the flight's `alt_offset_ft` with that smoothed mean and
   record `alt_offset_smoothing_landings = sample size used`.
4. Shift every AGL-derived field on `worst_segment` and
   `incursion_segments` by the delta `(smoothed − self)` so noise
   items report the smoothed-corrected AGL.

The window is bounded at `REGIONAL_OFFSET_WINDOW_MS = 12 hours` — any
event older than 12 h is dropped from the series. Long enough that a
busy day at KBDU has dozens of anchors; short enough that yesterday's
high-pressure system doesn't pollute today's low.

The smoother's two effects:

- **Catches baro drift across a long flight.** A 4-hour cross-country
  that took off at 06:00 may end at 10:00 in different surface
  pressure. The flight's self-cohort calibrates only to its takeoff
  hour; the smoother reaches forward to landings 2-3 flights later
  with the matching pressure.
- **Rescues flights that never approached a runway.** En-route
  transit that overflew the airspace at 9000 ft never gets a
  self-cohort (no in-radius fixes). The smoother gives it the regional
  mean for its time window — the right answer for the noise picture.

## What gets emitted

On every flight row in `/api/flights/current`:

```jsonc
"indicators": {
  ...,
  "alt_offset_ft": -147,                  // smoothed offset
  "alt_offset_calibration_fixes": 8,      // self-cohort size (per-flight anchor count)
  "alt_offset_smoothing_landings": 4,     // regional sample size (≤ 4 = 2 before + 2 after)
}
```

And on `worst_segment` + each `incursion_segments[i]`:

```jsonc
{
  ...,
  "alt_agl_min": 1187,    // adjusted, in ft AGL relative to field elev
  "alt_agl_mean": 1262,
  "alt_agl_peak": 1312,
}
```

These are the numbers the kiosk shows in its info-box. They're
already the smoothed-corrected AGLs — the kiosk doesn't have to
re-derive.

## How to interpret

- **`alt_offset_ft = 0` with `alt_offset_calibration_fixes = 0`** —
  no calibration was possible for this flight and no regional
  neighbor was close enough either. Raw ADS-B used. Treat the AGL
  values with the usual ±300 ft skepticism.
- **`alt_offset_ft = +120` with `calibration_fixes = 6`** — the
  transponder over-reports by 120 ft (typical positive bias). All AGL
  values are shifted down by 120 ft from raw.
- **`alt_offset_ft = -85` with `smoothing_landings = 4`** — flight
  didn't reach the runway itself, but four nearby landings averaged
  to −85 ft. Reasonable confidence.

## Why this matters operationally

Noise-abatement polygons at KBDU specify a ceiling of `7500 ft MSL`
(the default, overridable per zone — see `/api/noise-zones`). The
membership test for `incursion_segments` is `alt_msl ≤ ceiling AND
inside-polygon`. A 200 ft positive transponder bias pushes a
legitimate 7400-MSL overflight to a reported 7600 — outside the
ceiling, no incursion fires, the operator misses the report.
Conversely, a 200-ft negative bias creates phantom incursions for
flights that were actually above the ceiling.

`pop_impact` and `worst_segment` also depend on AGL via the
`-6 dB / altitude doubling above 1000 ft AGL` proxy. A 200 ft offset
at 1500 ft AGL changes the proxy dBA by ~1.5 dB — enough to swing the
worst-segment dBA peak across the yellow/orange klass boundary.

The smoother gives every flight the best AGL estimate the data
supports, so downstream membership and severity tests are honest.

## File pointers

| File | What's there |
| --- | --- |
| [noise/web/vite.config.js:3120-3164](vite.config.js#L3120-L3164) | `regionalOffsetSeriesFromFlights`, `smoothedOffsetFor` — region-wide smoother |
| [noise/web/vite.config.js:3167-3291](vite.config.js#L3167-L3291) | `computeFlightAltOffset` + tuning knobs |
| [noise/web/vite.config.js:3216-3246](vite.config.js#L3216-L3246) | `findRunwayAnchors` — the anchor scorer |
| [noise/web/vite.config.js:4811-4858](vite.config.js#L4811-L4858) | Post-pass that wires the regional smoother into the response |
| [noise/web/data/runways.json](data/runways.json) | Field elevations per airport — the reference MSL the offset is measured against |

## Constants reference

| Constant | Value | Meaning |
| --- | --- | --- |
| `VERIFIED_ALT_CAL_RADIUS_NM` | 2.0 nm | How close to airport center to look for anchors |
| `VERIFIED_ALT_CAL_COHORT_FRACTION` | 0.25 | Lowest-25% fallback fraction |
| `VERIFIED_ALT_CAL_MIN_FIXES` | 3 | Minimum anchors before we trust the calibration |
| `VERIFIED_ALT_CAL_MAX_AGL_FT` | 500 | Sanity bound — if cohort > 500 ft AGL, no calibration |
| `RUNWAY_GS_KTS_MAX` | 20 | Ground-speed threshold for "on runway" scoring |
| `RUNWAY_VS_FPM_MAX` | 100 | Vertical-speed threshold for "level" scoring |
| `RUNWAY_ALT_CLUSTER_FT` | 10 | Alt cluster radius for neighbor counting |
| `RUNWAY_ALT_CLUSTER_NEIGHBORS` | 2 | Required cluster size |
| `RUNWAY_SCORE_W_GS` | 3 | Score weight for low ground-speed |
| `RUNWAY_SCORE_W_VS` | 2 | Score weight for level VS |
| `RUNWAY_SCORE_W_CLUSTER` | 2 | Score weight for alt-cluster |
| `REGIONAL_OFFSET_WINDOW_MS` | 12 hr | How far back the regional series remembers |
| `REGIONAL_OFFSET_NEAR_N` | 2 | Landings before + after for smoothing |
