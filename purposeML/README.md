# purposeML — flight-purpose classifier from track shape + owner

Path-based flight-purpose classifier composing [phaseML](../phaseML/README.md) (per-sample phases + maneuver detection) with shape-only features (tortuosity, grid score, loiter radius), airport-trait context, and FAA-registry owner lookup. Per-flight and per-tail granularity.

```
purposeML/
├── README.md                       this file
├── kickoff.md                      original problem statement & taxonomy
├── ADOPTING_PURPOSE_ML_API.md      HTTP API reference + adoption recipes
├── airports.js                     airport traits + inferred endpoints
├── features.js                     extractFeatures(points, opts) — composes phaseML
├── classifier.js                   classifyTrack(features, ctx) — per-flight heuristic
├── registry.js                     FAA registry loader + owner classifier
├── service.js                      classifyOneTrack + inputToPoints
├── apiPlugin.js                    Vite middleware /api/purpose-ml/*
├── index.js                        barrel exports
└── experiments/
    ├── REFLECTION_AFTER_15.md      what the first 15 tails taught the deep-dive
    ├── FLIGHT_BREAKDOWN_GROUP_REPORT.md   tail-level + owner-augmented analysis (the main report)
    └── deep_dive.mjs               the multi-day, per-tail-pattern analysis script
```

## Two layers

1. **Per-flight purpose** ([classifier.js](classifier.js)) — what an individual flight looks like in isolation. 14-bucket taxonomy: `glider_local`, `glider_xc`, `tow_plane`, `training`, `pattern_solo`, `survey`, `patrol`, `airline`, `biz_jet`, `turboprop`, `ga_xc`, `ga_local`, `helicopter`, `unknown`.

2. **Per-tail purpose** ([experiments/deep_dive.mjs](experiments/deep_dive.mjs)) — what the aircraft *does as a whole*, aggregated across many flights and the FAA registry. Adds: `flight_school`, `private_transport`, `owner_proficiency`, `commuter_shuttle`, `manufacturer_demo`, `fractional_jet`, `government_public`, `airliner_overflight`, `bizjet_overflight`, `turboprop_overflight`, `local_sightseeing`, `personal_xc_traveler`, `one_way_xc`, `helicopter_ops`, `recreational`, and honest residuals (`unidentified_local`, `unidentified_transient`, `transient_overflight`, `insufficient_data`).

The per-flight layer is exposed via HTTP. The per-tail layer runs offline (multi-day rollup) and its output is consumed by other reports.

## Composing phaseML, not duplicating it

[features.js](features.js) calls phaseML's `classifyTrack(points)` for per-sample phase labels and `detectAll(samples)` for maneuver events (touch_and_go, thermalling, holding_pattern, sightseeing_orbit, steep_turn, …). purposeML rolls these into seconds-per-phase + maneuver-count features. We add:

- `tortuosity` (meander = pathLength / straightLine)
- `gridScore` (bidirectional parallel-pass detector)
- `loiterRadiusNm`
- `enginelessShare` (glider type regex)
- `airportsVisited`, `homeIcao`, `homeTraits` (gliderPort / primaryTrainer / airlineHub / bizjetHub)
- `inferredOriginIcao` / `inferredDestIcao` — closest airport to first / last fix regardless of distance (the live capture archive trims tracks to the in-radius portion, clipping real takeoff/landing fixes)
- `ifrCruiseShare` — phase-gated detector of cruise-at-round-thousands (IFR rule below FL180)

## Priority chain (in [vite.config.js → resolvePurposeWithShape](../vite.config.js))

```
special_use registry → type regex → stored (curated) → shape (purposeML, conf ≥ 0.7) → type-based fallback
```

`/api/flights/current` rows surface `purpose_source: 'special_use' | 'type' | 'tracked' | 'shape' | 'fallback'` so consumers can distinguish inferred from curated.

## Optional load

purposeML is treated as optional by the vite.config.js wiring. If the directory is missing, `resolvePurposeWithShape` skips its shape step and the HTTP endpoints return 404. No build-time dependency. See [the wiring](../vite.config.js) (search for `requireOpt('./purposeML/index.js')`).

## See also

- [phaseML README](../phaseML/README.md) — the lower-level phase + maneuver detector this composes
- [kickoff.md](kickoff.md) — original problem statement & taxonomy
- [ADOPTING_PURPOSE_ML_API.md](ADOPTING_PURPOSE_ML_API.md) — HTTP API contract
- [experiments/FLIGHT_BREAKDOWN_GROUP_REPORT.md](experiments/FLIGHT_BREAKDOWN_GROUP_REPORT.md) — the per-tail + FAA-registry analysis (what 90% of "general_recreational" actually turned out to be)
