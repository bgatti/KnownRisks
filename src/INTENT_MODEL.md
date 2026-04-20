# Aircraft Intent Prediction Model — Plan

## Goal
Classify each live aircraft's *intent* in real time based on its recent
trajectory (last 3 minutes). Feed this into the `/api/aircraft-ops`
endpoint so consumers get not just "what is it doing now" but "what is it
about to do."

## Data source
`/api/adsb/live` on Railway — returns all aircraft in the 36 nm corridor.
Each aircraft has: lat, lon, alt, heading, groundspeed, vrate, and a
short position history (last ~30 min of 2-second samples).

## Intent labels (output)

### Strategic (whole-flight purpose)
- `inbound` — consistently closing distance to an airport
- `outbound` — recently departed, increasing distance
- `to_practice` — heading away from airport toward known practice area
- `practicing` — maneuvering in practice area, >5 nm from any airport
- `returning` — heading back to airport from practice area
- `pattern` ��� orbiting an airport, multiple descents/ascents
- `towing` — PA25/PA18 doing repeated climbs from KBDU with glider
- `soaring` — glider, thermalling or ridge-running
- `transit` — passing through, not approaching any airport

### Tactical (pattern leg — only when intent = 'pattern')
- `upwind` — climbing, aligned with runway heading, <1nm from threshold
- `crosswind` — turning 90° from runway heading, climbing
- `downwind` — parallel to runway, opposite heading, level, 0.5–1.5nm abeam
- `base` — turning toward final, beginning descent
- `final` — aligned with runway, descending, closing on threshold
- `short_final` — <0.5nm from threshold, <200 AGL
- `on_runway` — <50 AGL, on centerline (landed or rolling)
- `entering` — joining pattern from outside (45° to downwind typically)
- `departing` — climbing away from pattern, heading diverges from pattern box

## Inputs (per aircraft, computed from last 3 min of track)

### Static / lookup
- `type` — ICAO type code (C172, PA25, GLID, etc.)
- `purpose` — general aircraft purpose derived from type:
  - `trainer` (C172, P28A, DA40, etc.)
  - `tow_plane` (PA25, PA18)
  - `glider` (GLID, VENT, AS2x, DG, SGS)
  - `helicopter` (R44, R22, AS50, EC35, etc.)
  - `business_jet` (C25x, CL30, LJ40, etc.)
  - `turboprop` (PC12, TBM, DHC6)
  - `airline` (B738, A320, CRJ2, E75L)
  - `experimental` (RV7, RV8, LGEZ, VL3)
  - `ga_single` (everything else single-engine)
  - `ga_twin` (BE58, PA44, DA42)
- `school` — flight school affiliation from fleet lookup (null if private)
- `flight_time_min` — minutes since first point in today's track
- `base_airport` — home field (from historical data / fleet lookup)

### Instantaneous
- `lat, lon, alt, heading, groundspeed, vrate`
- `agl` — altitude above nearest airport field elevation

### Key intermediaries (computed from 3-min window, ~90 samples at 2s)

1. **`closure_pct`** — closure rate as % of groundspeed.
   `closure_pct = (d_dist/dt) / groundspeed × 100`
   - 100% = flying directly at the airport
   - 0% = tangential (orbiting or crossing)
   - negative = flying away
   Why: normalizes for fast vs slow aircraft. A jet at 200 kt closing
   at 3 nm/min and a C172 at 90 kt closing at 1.5 nm/min both read
   ~100% — they're both pointed at the airport.

2. **`angular_accumulation`** — total degrees turned in 3 minutes,
   normalized by groundspeed (deg·nm⁻¹).
   `angular_accum = Σ|Δheading| / (groundspeed × 3min_in_hours)`
   - ~0 = straight line (transit, inbound, outbound)
   - ~360 = one full orbit (pattern lap at 1 nm radius)
   - ~720+ = multiple laps (active pattern / touch-and-go)
   Why: distinguishes pattern work from straight-in arrivals regardless
   of aircraft speed. Tow planes have very high angular accumulation.

3. **`climb_energy`** — net altitude gained in last 3 min, in fpm equivalent.
   `climb_energy = (alt_now - alt_3min_ago) / 3`
   - positive = net climb (departure, tow, practice climb)
   - ~0 = level (cruise, downwind, transit)
   - negative = net descent (arrival, final approach)
   Why: raw vrate is noisy sample-to-sample. Smoothing over 3 min gives
   the real vertical intent.

4. **`vertical_stability`** — standard deviation of altitude over the
   3-min window, in feet.
   - < 50 ft = very stable (cruise, transit, level downwind)
   - 50–200 ft = moderate (practice maneuvers, turbulence, pattern turns)
   - > 200 ft = highly variable (multiple ascents/descents, T&G practice)
   Why: separates "doing something vertical" from "just flying along."
   Pattern work and practice stalls both have high variability vs transit.

5. **`at_pattern_altitude`** — boolean: is the aircraft within ±200 ft of
   the standard pattern altitude for the nearest (or base) airport?
   Pattern altitudes:
   - KBDU: 6300 MSL (1012 AGL)
   - KBJC: 6700 MSL (1027 AGL)
   - KEIK: 6100 MSL (970 AGL)
   - KLMO: 6100 MSL (1045 AGL)
   - KAPA: 6900 MSL (1015 AGL)
   If at_pattern_altitude AND dist < 3 nm → strong pattern signal.
   Also check base airport pattern altitude (aircraft may be in pattern
   at its home field, not just the nearest field geometrically).

6. **`orbit_radius_nm`** — estimated circular orbit radius from the
   3-min track, computed as `groundspeed / (turn_rate × 2π)`.
   - 0 = straight (no orbit)
   - 0.5–1.0 nm = standard traffic pattern (C172 at 90 kt, 3°/s)
   - 1.5–3 nm = practice area maneuvering (steep turns, lazy 8s)
   - > 5 nm = large radius (probably not orbiting, just curving)
   Why: distinguishes tight pattern orbits from wide maneuvering.
   Combined with distance-to-airport, separates "in the pattern" from
   "doing steep turns in the practice area."

7. **`directness`** — how straight is the recent track? Ratio of
   straight-line displacement to actual path length over 3 minutes.
   `directness = displacement_nm / track_length_nm`
   - 1.0 = perfectly straight (inbound, outbound, transit)
   - 0.5 = moderate wandering (maneuvering, entering pattern)
   - < 0.2 = highly curved (tight pattern, T&G laps, practice stalls)
   Why: another axis separating "going somewhere" from "doing something
   in one place." Combines with closure_pct for high confidence.

8. **`heading_to_runway`** — alignment of current heading with the
   nearest runway's heading (0° = perfectly aligned for landing/takeoff,
   180° = opposite direction = downwind leg).
   `heading_to_runway = normalize(heading - runway_heading, ±180)`
   Computed for BOTH runway directions and the closest is used.
   Why: critical for pattern leg identification and distinguishing
   inbound (aligned, closing) from downwind (anti-aligned, parallel).

### Derived composites
- `intent_score_inbound` = closure_pct × (1 - directness_error) × descent_signal
- `intent_score_pattern` = angular_accumulation × at_pattern_altitude × (dist < 3)
- `intent_score_practice` = vertical_stability × (dist > 5) × (1 - closure_pct)

### Runway geometry (static, per airport)
- `threshold_lat, threshold_lon` — each runway end
- `heading` — magnetic/true heading of each runway
- Pattern direction (left/right traffic) for each runway

## Runway definitions needed

| Airport | Runway | Heading | Pattern |
|---------|--------|---------|---------|
| KBDU | 08 | 080° | Left |
| KBDU | 26 | 260° | Left |
| KBJC | 12R | 119° | Right |
| KBJC | 30L | 299° | Left |
| KBJC | 12L | 119° | Left |
| KBJC | 30R | 299° | Right |
| KEIK | 15 | 152° | Left |
| KEIK | 33 | 332° | Left |
| KLMO | 11 | 113° | Left |
| KLMO | 29 | 293° | Left |
| KAPA | 17L | 174° | Left |
| KAPA | 35R | 354° | Right |
| KAPA | 17R | 174° | Right |
| KAPA | 35L | 354° | Left |

## Classification algorithm

### Layer 1: Distance trend (strategic intent)
```
if dist_to_nearest < 3 nm AND descents >= 2:
  intent = 'pattern'
elif d_dist/dt < -1.5 nm/min AND dist < 15 nm:
  intent = 'inbound'
elif d_dist/dt > 1.5 nm/min AND dist < 5 nm:
  intent = 'outbound'
elif dist > 5 nm AND heading_stability < 15° AND alt_trend == 'level':
  intent = 'practicing'
elif dist > 5 nm AND d_dist/dt < -0.5:
  intent = 'returning'
elif dist > 5 nm AND d_dist/dt > 0.5:
  intent = 'to_practice'
else:
  intent = 'transit'
```

### Layer 2: Pattern leg (when intent = 'pattern')
```
Compute:
  runway_heading = active runway heading (from wind or most-used today)
  rel_heading = aircraft_heading - runway_heading (normalize to ±180)
  dist_from_threshold = distance to active runway threshold
  abeam_dist = perpendicular distance from extended centerline

Rules:
  if agl < 50 AND on_centerline:
    leg = 'on_runway'
  elif agl < 200 AND closing AND |rel_heading| < 20:
    leg = 'short_final'
  elif |rel_heading| < 30 AND closing AND descending:
    leg = 'final'
  elif |rel_heading - 90| < 30 AND descending:
    leg = 'base'
  elif |rel_heading - 180| < 30 AND level AND 0.3 < abeam_dist < 2.0:
    leg = 'downwind'
  elif |rel_heading - 90| < 30 AND climbing:
    leg = 'crosswind'
  elif |rel_heading| < 30 AND climbing AND dist < 1.5:
    leg = 'upwind'
  elif closing AND from_outside:
    leg = 'entering'
  elif opening AND climbing:
    leg = 'departing'
```

### Layer 3: Confidence
Each classification gets a confidence 0–1 based on:
- How long the state has been stable (> 30s = high)
- How well the geometry fits (heading alignment, closure rate magnitude)
- Whether the transition makes physical sense (can't go from final to upwind without touching down)

## State machine transitions (valid)
```
on_runway → upwind → crosswind → downwind → base → final → on_runway
on_runway → departing → (exits pattern)
entering → downwind (45° entry)
entering → base (straight-in entry from downwind side)
final → on_runway (landing)
final → upwind (go-around / touch-and-go)
```

## Implementation plan

### Phase 1: API endpoint (server-side)
- New endpoint: `GET /api/aircraft-ops` (already exists, enhance it)
- Reads from `/api/adsb/live` feed (already available)
- Computes per-aircraft: dist/bearing to each airport, closure rate,
  alt trend, turn rate from last 3 min of positions
- Returns strategic intent label + confidence

### Phase 2: Pattern leg detection
- Add runway geometry as static data
- When strategic intent = 'pattern', run the leg classifier
- Return `leg` field in the aircraft response
- Track state transitions to prevent impossible jumps

### Phase 3: Prediction
- Given current state + velocity vector, project forward:
  - "will land in ~2 min" (on final, closing at 90 kt)
  - "will enter downwind in ~30s" (on 45° entry)
  - "beginning descent, ETA 4 min" (inbound, starting down)
- Return `prediction` field with { event, eta_sec, confidence }

### Phase 4: Clustering / practice areas
- Identify practice area hotspots from historical data (already done in
  our clustering study)
- When aircraft is "practicing", label the specific practice area:
  - "NE practice (Niwot)"
  - "E practice (Erie)"
  - "Foothills soaring"
- Use the grid clusters from the Journeys/MHG study as seed regions

## Dependencies
- Runway threshold coordinates (from FAA 56-day data or manually)
- Active runway determination (wind data or traffic analysis)
- 3-minute position buffer per aircraft (already in live collector)
- The `/api/adsb/live` feed on Railway (already running)

## Output shape (proposed)
```json
{
  "tail": "N52993",
  "type": "C172",
  "school": "Journeys Aviation",
  "intent": "pattern",
  "leg": "downwind",
  "confidence": 0.87,
  "airport": "KBDU",
  "runway": "26",
  "dist_nm": 0.8,
  "closure_nm_min": -0.1,
  "alt": 6300,
  "agl": 1012,
  "vrate": -50,
  "groundspeed": 85,
  "heading": 80,
  "prediction": {
    "event": "turn_base",
    "eta_sec": 25,
    "confidence": 0.72
  }
}
```
