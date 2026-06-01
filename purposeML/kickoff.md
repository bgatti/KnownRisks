# purposeML — design rationale

## Problem

A meaningful slice of `/api/flights/current` rows surface `purpose: unknown` or default to `ga_single` even though their actual mission is obvious from the path — a glider thermalling, a tow plane doing repeat tow-release cycles, a survey aircraft running a grid, a regional jet on approach.

The legacy `resolvePurpose` ([vite.config.js](../vite.config.js)) only looks at:

1. Curated `public/special_use_aircraft.json`
2. Type-code regex (`PA25→tow_plane`, `GLID*→glider`, `B73*→airline`, …)
3. Stored curated value on the `tracks` row
4. School-fleet membership → `training`

When type is missing, anonymized (`~hex`), or generic (`C172` is the most common type — could be training, scenic, owner GA, skydive shuttle), the classifier falls through to `unknown` or `ga_single`. The kiosk surfaces those rows uninformatively.

purposeML scopes a **path-based classifier** that infers purpose from the *shape* of the flight track — no type code required, though type can boost confidence when present.

## Output taxonomy (per-flight)

Match the existing wire-shape values so the classifier is a drop-in booster for `resolvePurpose`:

```
training      pattern_solo  tow_plane
glider_local  glider_xc
ga_local      ga_xc
biz_jet       airline       turboprop      helicopter
survey        patrol
unknown       — explicitly: features didn't match a confident bucket
```

Each emitted classification carries a **confidence 0..1**. The kiosk integration rule: shape inference wins only if `confidence ≥ 0.7`; otherwise the row falls through to the type-based fallback.

## Approach — composition + heuristics first

### Composition over duplication

phaseML already exposes per-sample phase labels (`oracle.js`: `on_ground` / `taxiing` / `pattern` / `practice_area` / `departing` / `inbound` / `en_route` / `landed_full_stop`) and maneuver detections (`maneuvers.js`: `touch_and_go` with ADS-B-dropout-aware implied-touchdown handling, `landed_full_stop`, `thermalling`, `holding_pattern`, `sightseeing_orbit`, `steep_turn`, `s_turns`, `chandelle`, `lazy_8`, `slow_flight`, `stall_recovery`, `emergency_descent`).

purposeML composes those outputs into track-level counts and adds only the shape-only features phaseML doesn't compute (`tortuosity`, `gridScore`, `loiterRadiusNm`, `enginelessShare`, airport-context). The corollary: when phaseML mis-detects, fix phaseML once and every downstream classifier benefits.

### Heuristics first, ML later

Rule-based classifier as v0, gated by clear thresholds. ML upgrade path is open but not required for the first ship.

- Labeled training data doesn't exist; we'd be hand-labeling hundreds of flights before any model could learn.
- The well-separated cases (tow ops, thermalling, jet cruise, pattern work, survey grid) are obvious from one or two features each.
- Heuristics produce explainable decisions — `reasons[]` lists each threshold that fired (e.g., `"touch_and_go + landed_full_stop = 24 ≥ 3 (phaseML)"`). Operators trust and tune those.
- The hard cases (C172 at KBJC — training? scenic? owner GA?) are exactly the cases an ML model would also struggle with; the heuristic v0 emits `confidence < 0.7` and the kiosk can honestly display "purpose unclear."

When v0 ships and starts emitting per-flight classifications, we'll have weeks of labeled-by-heuristic data plus operator corrections. A gradient-boosted tree on the same feature vector — with the heuristic decision as a feature itself — usually wins over pure heuristics without sacrificing explainability. That's iteration 2.

## Tail-level layer

Per-flight classification on its own dumps ~84% of GA into `ga_local` because a single direct point-to-point flight could be private transport, a school cross-country, or a ferry. The **tail's overall pattern across many flights** is a much stronger signal — see [experiments/FLIGHT_BREAKDOWN_GROUP_REPORT.md](experiments/FLIGHT_BREAKDOWN_GROUP_REPORT.md).

The tail-level layer aggregates per-tail across the analysis window and adds **owner from the FAA registry** (`registry.js`). Owner-from-registry is the most authoritative signal we have — a SkyWest-owned aircraft is an airliner regardless of what its low-altitude approach slice into KDEN looks like. The FAA registry lookup is O(1) and has 92% hit rate on Front Range tails.

## Priority chain (live integration)

[vite.config.js → resolvePurposeWithShape](../vite.config.js):

```
special_use registry         (curated)
  ↓ no hit
type regex                   (PA25 → tow_plane, GLID* → glider, B73* → airline, …)
  ↓ no hit
stored (curated) value       (the tracks row's purpose column)
  ↓ no value
shape inference (purposeML)  (confidence ≥ 0.7)
  ↓ low confidence
type-based fallback          (the original resolvePurpose behaviour)
```

`/api/flights/current` rows now surface `purpose_source: 'special_use' | 'type' | 'tracked' | 'shape' | 'fallback'` so consumers can distinguish inferred from curated.

## What v0 ships

1. `extractFeatures(points, opts)` ([features.js](features.js)) — composes phaseML + adds shape features. ~250 lines.
2. `classifyTrack(features, ctx)` ([classifier.js](classifier.js)) — 13 ordered heuristic rules with `reasons[]` audit trail.
3. HTTP API ([apiPlugin.js](apiPlugin.js)) — `/api/purpose-ml/{health,buckets,classify,classify-archive,extract}`. See [ADOPTING_PURPOSE_ML_API.md](ADOPTING_PURPOSE_ML_API.md).
4. `classifyOneTrack(points, opts)` ([service.js](service.js)) — composition entry point for in-process callers.
5. `resolvePurposeWithShape` wiring in vite.config.js — shape inference between curated and type-fallback.
6. Tail-level deep-dive ([experiments/deep_dive.mjs](experiments/deep_dive.mjs)) — multi-day, per-tail-pattern analysis with FAA-registry owner classification.

## What v0 is NOT solving

- **Confusion matrix vs ground truth** — there is no hand-labeled set yet. The experiment outputs spot-check pools ready for labeling.
- **ML upgrade** — heuristics-first floor; iteration 2 can layer a gradient-boosted tree on the same feature vector once labeled data accumulates.
- **Per-tail cache for live use** — [deep_dive.mjs](experiments/deep_dive.mjs) is offline. Live `/api/flights/current` calls only get per-flight purpose. Adding a `tail_purpose` cache built nightly off the deep-dive is a natural follow-up.

## What NOT to do

- Don't classify on < 30 points or < 5 min of active wall-clock. Emit `unknown` with `confidence: 0.0` and a `reasons: ["track too short"]`.
- Don't overwrite a curated `purpose` from the DB or a special-use registry hit. Those are authoritative.
- Don't let heuristics promote a wrong answer above the default `ga_single` — emit `unknown` when confidence < 0.7.
- Don't add a per-classification network call. Everything fits in the `/api/flights/current` handler latency budget.

## File pointers

| File | What's there |
|---|---|
| [vite.config.js](../vite.config.js) | `resolvePurposeWithShape` — the entry point this work boosts; `requireOpt` optional load |
| [phaseML/](../phaseML/) | Sister classifier (phases / maneuvers / intent) — same architecture purposeML mirrors and composes |
| [data/fleet.json](../data/fleet.json) | ICAO hex → tail / type / operator / role (per-tail authority) |
| [public/flight_schools_fleets.json](../public/flight_schools_fleets.json) | Per-school tail rosters (sets `isSchoolFleet`) |
| [public/special_use_aircraft.json](../public/special_use_aircraft.json) | Curated overrides (medevac, military, science, …) — highest authority |
| [../CLAUDE.md](../../CLAUDE.md) | `/api/adsb/track/:icao` contract — primary source of per-flight points |
| [../adsb.js](../adsb.js) | `extractTowCycles`, `detectPhases`, `pairTowWithGliders` — domain logic for tow / glider context |
| FAA registry CSV (operator-supplied) | `aircraft_registry.csv` with `tail,type,desc,owner_operator,flights,days_seen,years,total_points`. Not checked in — operator places it locally and points the experiment script at it via `AIRCRAFT_REGISTRY_PATH`. |
