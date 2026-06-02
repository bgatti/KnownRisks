# acsML — FAA ACS task identifier + currency tracker

Sister library to [phaseML](../phaseML/) and [purposeML](../purposeML/).
Identifies which ACS (Airman Certification Standards) tasks each flight
demonstrates and emits FAR 61.57 currency events for takeoffs and
landings.

```
acsML/
├── README.md
├── standards/
│   ├── private_pilot_acs.json     FAA-S-ACS-6B encoded for track inference
│   └── far_currency.json          14 CFR §61.57 — passenger / night / instrument
├── suntimes.js                    NOAA sunrise/sunset/twilight calculator
├── features.js                    composes phaseML; adds rectangular_course,
│                                  short_field_takeoff, short_field_landing,
│                                  unusual_attitude_recovery detectors
├── identifier.js                  identifyAcsSegments(points, ctx) — the entry point
├── service.js                     identifyOneTrack + inputToPoints
├── apiPlugin.js                   Vite middleware /api/acs-ml/*
├── index.js                       barrel exports
└── experiments/
    └── demo.mjs                   run on real KAPA/KBDU flights
```

## Two outputs per flight

1. **ACS tasks demonstrated** — list of `{ code, name, instances, evidence[] }`
   where each evidence item names the phaseML/acsML detection and a
   timestamp. Codes like `III.B`, `IV.A`, `V.A` map to FAA-S-ACS-6B
   Areas of Operation.

2. **FAR currency events** — list of `{ rule, kind, ts, airport, night, ... }`
   one event per takeoff and per landing. Distinguishes day vs night
   per FAR 61.57(b) using the sunrise/sunset calculator at the
   airport's lat/lon.

## What's detectable from track alone

phaseML already detects ~80% of the ACS performance maneuvers:
`steep_turn`, `s_turns_across_road`, `turn_around_a_point`,
`chandelle`, `lazy_8`, `slow_flight`, `stall_recovery`,
`emergency_descent`, `holding_pattern`, `touch_and_go`,
`landed_full_stop`, plus `thermalling` / `sightseeing_orbit`.

acsML adds:
- `rectangular_course` — V.B Ground Reference Maneuvers
- `short_field_takeoff` — IV.E (preempts IV.A)
- `short_field_landing` — IV.F (preempts IV.B)
- `unusual_attitude_recovery` — VIII.E (proxy)
- Synthetic `takeoff` events from on_ground→airborne transitions

## What's NOT detectable from track alone

- IV.C Soft-Field Takeoff / IV.D Soft-Field Landing (technique-only;
  flagged "suspected" by descent rate / climb shape but cannot
  confirm pilot input from path)
- VIII.A–D Basic Instrument Maneuvers (path is indistinguishable from
  VFR equivalents without hood/sim context)
- 61.57(c) Instrument approach currency (requires CIFP / runway
  alignment data — deferred to v1)
- Anything in ACS Area of Operation I (Preflight Preparation) or
  knowledge-only tasks across other areas

## Priority / preemption logic

When multiple ACS tasks share a phaseML signal, the identifier uses
two mechanisms to pick the right one:

- **`selector` field** — VII.B Power-Off Stalls and VII.C Power-On
  Stalls both map to phaseML `stall_recovery`. The selector field
  picks based on the detection's vertical-speed evidence.
- **`preempts` field** — IV.F Short-Field Approach lists
  `preempts: ["IV.B"]`, so when acsML's `short_field_landing`
  detection overlaps in time with phaseML's `landed_full_stop`,
  the more specific IV.F displaces the generic IV.B.

## HTTP API

```
GET  /api/acs-ml/health           liveness + version
GET  /api/acs-ml/standards        Private Pilot ACS + FAR 61.57 JSON
POST /api/acs-ml/identify         { points, typeCode?, tail? } → tasks + currency
POST /api/acs-ml/identify-archive { points (4-tuples), t0Seconds, ... }
```

All CORS-open, JSON. Optional load via `requireOpt` in vite.config.js
— if the directory is missing, endpoints 404 cleanly.

## Demo

```sh
cd noise/web
node acsML/experiments/demo.mjs
```

Runs against 5 known tails in `public/tracks_live_2026-04-19.json`
(Boulder flight school N1094F, KBJC trainer N4632F, KLMO tow N1812E,
KAPA owner-rental N24144, Textron demo N163CP) and prints the
per-flight task breakdown + currency events.

## Sample output

```
## N1094F  (C172) — Sunday 2026-04-19, 6 flights

### Flight 6 — 20:42 → 22:52  (130.6 min, 1329 pts)
Phases: T/O=2, T&G=26, full_stop=0, pattern_s=2956
ACS tasks demonstrated:
  III.B  Traffic Patterns                                ×1
  IV.A   Normal Takeoff and Climb                        ×2
  IV.F   Short-Field Approach and Landing                ×7   (preempts IV.B)
  IV.K   Go-Around/Rejected Landing                      ×26
  V.A    Steep Turns                                     ×1
  V.C    Ground Reference Maneuvers — S-Turns Across a Road  ×3
  VII.A  Maneuvering During Slow Flight                  ×2
  VII.B  Power-Off Stalls                                ×1   (selector: pre_vs_negative)
FAR currency events: 61.57(a)×28
```

A textbook training sortie that covered Areas III (Airport Operations),
IV (Takeoffs/Landings), V (Performance Maneuvers), and VII (Slow Flight
and Stalls) in one 130-minute flight.

## See also

- [phaseML README](../phaseML/README.md) — lower layer this composes
- [purposeML README](../purposeML/README.md) — sister classifier for purpose
- [noise/kickoff_sorties_test.md](../../kickoff_sorties_test.md) — comm channel
- FAA-S-ACS-6B Private Pilot ACS — https://www.faa.gov/training_testing/testing/acs
