# Flight-Phase ML Classifier — Project Kickoff

## What we want
A trained model that takes one aircraft's recent ADS-B trajectory (lat/lon/alt/gs/track/vs over the last ~3 min) and returns a categorical **phase** label with calibrated confidence. Replaces three different rule-based classifiers scattered across this codebase with one canonical source of truth.

## Label set (target)
Eight labels from the existing rule-based oracle plus one **new** label the heuristics can't detect reliably:

| Label | Definition (operational) |
|---|---|
| `on_ground` | gs < 30 kt, AGL < 200 ft, within 2 nm of a runway |
| `taxiing` | 5 ≤ gs < 40 kt, AGL < 150 ft, within 1.5 nm |
| `pattern` | within 2.5 nm, 100 < AGL < 1500 ft, 40 < gs < 130 kt, multiple altitude reversals |
| **`landed_full_stop`** | sustained on_ground (≥ 30 s) followed by ≥ 5 min taxi/stop dwell (no new takeoff). This is the label our `/api/noise/recent-landings` endpoint actually needs but currently fakes with a heuristic. |
| `practice_area` | 2–8 nm out, 200 < AGL < 3000 ft, track not pointed at field, |vs| moderate |
| `departing` | AGL > 200 ft, vs > +200 fpm, heading away from field, dist < 15 nm |
| `inbound` | track aligned with field bearing (Δ < 40°), 1.5 < dist < 50 nm, vs < +300 fpm |
| `en_route` | dist > 8 nm, neither clearly inbound nor outbound |
| `nearby` | catch-all for unclassifiable points in/near the corridor |

The `landed_full_stop` label is the immediate driver for this project — see the bug at the end.

## Training data plan
1. **Weak labels from the rule-based oracle.** The function below currently lives in another project. Port it into the new repo as `oracleClassify(ac)` and run it over the historical ADS-B archive (Postgres `live_tracks` rows, ~90 days available; ~10 M point-samples / aircraft-minute pairs).

   ```js
   function classifyAircraft(ac) {
     if (ac.lat == null || ac.lon == null) return null
     const dist = haversineNm(ac.lat, ac.lon, FIELD.lat, FIELD.lon)
     const altAgl = (ac.alt_ft ?? FIELD.elev) - FIELD.elev
     const gs = ac.gs_kts ?? 0
     const vs = ac.vs_fpm ?? 0
     const trackToField = bearingToField(ac.lat, ac.lon)
     const acTrack = ac.track_deg ?? 0
     let trackDiff = Math.abs(acTrack - trackToField)
     if (trackDiff > 180) trackDiff = 360 - trackDiff
     // … see kickoff doc for the full ladder …
     if (gs < 30 && altAgl < 200 && dist < 2) return { phase: 'on_ground' }
     if (gs >= 5 && gs < 40 && altAgl < 150 && dist < 1.5) return { phase: 'taxiing' }
     if (dist < 2.5 && altAgl < 1500 && altAgl > 100 && gs > 40 && gs < 130) return { phase: 'pattern' }
     if (dist < 8 && dist > 2 && altAgl < 3000 && altAgl > 200 && trackDiff > 40 && vs > -500) return { phase: 'practice_area' }
     if (altAgl > 200 && vs > 200 && trackDiff > 60 && dist < 15) return { phase: 'departing' }
     if (trackDiff < 40 && dist > 1.5 && dist < 50 && gs > 30 && vs <= 300) return { phase: 'inbound' }
     if (dist > 8) return { phase: 'en_route' }
     return { phase: 'nearby' }
   }
   ```

2. **Hand-curate `landed_full_stop`.** The oracle doesn't have this label. Use `extractTowCycles()` (in `noise/web/adsb.js`) to find sequences where the aircraft was on_ground for ≥ 30 s followed by ≥ 5 min of dwell, *and* did not take off again within 15 min. Label the on-ground points within that window as `landed_full_stop`. This gives ~1-2 K hand-verifiable examples per month.

3. **Active learning loop.** When the trained model disagrees with the oracle, surface those cases in a kiosk view for one-click human labeling. The oracle is wrong about thermalling gliders (classifies them as `practice_area` even when they're soaring at altitude), short-final aircraft (calls them `on_ground` prematurely — exactly the N75FF bug we just patched around), and any aircraft with stale ADS-B fixes.

## Features (engineered from 3-min window, ~90 samples at 2 s)
- `closure_pct` — `(d_dist/dt) / groundspeed × 100` — normalizes inbound/outbound for speed
- `angular_accumulation` — total |Δheading| / (gs × hours) — pattern vs straight-in
- `vrate_var` — variance of `vs_fpm` over the window — soaring vs stable cruise
- `agl_trend` — slope of AGL — climbing/level/descending
- `dist_to_nearest_runway_threshold` — not just airport center
- `track_offset_from_runway_heading_deg` — for final/short_final detection
- `time_below_groundCeil_in_window_s` — directly drives `landed_full_stop`
- Plus the instantaneous tuple: `lat, lon, alt, agl, gs, vs, track, dist, bearing`

See [`noise/web/src/INTENT_MODEL.md`](INTENT_MODEL.md) for the longer feature catalogue and the rationale for each.

## Model architecture (start simple)
- **Baseline:** gradient-boosted trees (XGBoost / LightGBM) on the engineered features. Fast to train, easy to deploy, gives feature importances we can sanity-check against the rule-based oracle. Aim for >95 % agreement with the oracle on the easy labels, with the disagreements being cases where the oracle is genuinely wrong (validated by hand).
- **Stretch:** small 1-D conv net over the raw 90-sample trajectory tensor (lat, lon, alt, gs, vs, track per timestep). Useful only if the engineered features plateau.
- **NOT:** anything that needs a GPU at inference. This must serve from a Node.js or Python sidecar with <50 ms p99 latency per aircraft, all 600 aircraft in our corridor classified per 2 s capture cycle.

## Integration plan
Once trained, expose two consumption surfaces:

1. **HTTP endpoint** at `/api/phase/classify` (Python FastAPI sidecar OR Node binding for ONNX runtime). Accepts a list of aircraft state dicts, returns `[{icao, phase, confidence}]`. Cache by `(icao, last_seen_ts)` to avoid recomputation.

2. **Embed the field in existing endpoints** in `noise/web/vite.config.js`:
   - `/api/adsb/live` — add `phase`, `phase_confidence` per aircraft
   - `/api/excursions/boot` — replace the current `classifyTrackPhase()` call (line ~298) with the ML phase derived from the track's last 3 min
   - `/api/noise/recent-landings` — use `landed_full_stop` directly to gate landings instead of the layered heuristics we built today

The Node server calls the Python sidecar over localhost HTTP; both deploy as one Railway service via a process manager (e.g. `concurrently`).

## Acceptance criteria
- ≥ 95 % macro-F1 on a held-out test set hand-labeled across all 9 classes
- `landed_full_stop` precision ≥ 0.95 (don't tell pilots they landed when they didn't — the N75FF case)
- `landed_full_stop` recall ≥ 0.90 (don't miss real landings)
- p99 latency < 50 ms per aircraft on a single Railway container
- Drop-in replacement for `classifyTrackPhase()` in [`noise/web/vite.config.js:298`](vite.config.js#L298) — same return shape `{ phase, descents?, hasDescents? }` so the kiosk and the boot endpoint don't break.

## Why this matters (the bug we hit today)
We just patched `/api/noise/recent-landings` to require ≥ 30 s of on-ground fixes before calling an aircraft "landed". This worked, but it's a layered heuristic — and we've now got three rule-based phase classifiers in this codebase:

1. `classifyTrackPhase()` in [`vite.config.js:298`](vite.config.js#L298) — overflight/departure/arrival/pattern
2. `adsb.detectPhases()` in [`adsb.js:73`](adsb.js#L73) — on_ground/taxiing/climbing_on_tow/descending
3. The `classifyAircraft()` oracle quoted above — 9-way labels

They disagree, they each have their own corner-case bugs, and the kiosk currently has its own *fourth* altitude-trend heuristic on top. An ML classifier with one canonical label set (and especially `landed_full_stop`) is what unifies all four.

## Repo layout (suggested)
```
phase-ml/
├── README.md           ← problem statement + acceptance criteria (this file, trimmed)
├── data/
│   ├── extract.py      ← pulls live_tracks from Postgres → parquet
│   ├── label.py        ← oracleClassify + landed_full_stop heuristic
│   └── splits.py       ← 70/15/15 by aircraft (not by point — leakage!)
├── features/
│   └── window.py       ← 3-min window feature engineering
├── models/
│   ├── train_xgb.py
│   └── eval.py
├── serve/
│   ├── api.py          ← FastAPI sidecar
│   └── Dockerfile
└── tests/
    └── test_oracle_agreement.py
```

## First-day work
1. Clone the existing `noise/web/adsb.js` and `noise/web/vite.config.js` into the new repo for reference (read-only).
2. Stand up `data/extract.py` to pull one day of `live_tracks` and emit a parquet of (icao, ts, lat, lon, alt, gs, vs, track) tuples.
3. Port `oracleClassify` from JS to Python and verify it on that day's data — count label distributions, sanity-check a few aircraft visually.
4. Hand-label `landed_full_stop` for ~50 aircraft (use `extractTowCycles` results as a starting set).
5. Train a one-feature baseline (just `agl`) to confirm the pipeline works, then add features incrementally.

Expected wall-clock: 2 weeks to v1 model with acceptance-criteria scores; 1 more week to ship the sidecar and wire into the three production endpoints.
