# phaseML — JS port of phase-ml/

Server-side classifier for aircraft activity (oracle phases + 12 PTS maneuver detectors + multi-airport intent), ported from [noise/phase-ml/phase_ml/](../../phase-ml/phase_ml/). Pure ES modules with **zero browser globals** — runs in Node only. The frontend never imports any of this; consumption is via HTTP.

## Wire it into vite.config.js

One line in the plugins array:

```js
import { phaseMLApiPlugin } from './phaseML/apiPlugin.js'

export default defineConfig({
  plugins: [
    react(),
    // … existing plugins …
    phaseMLApiPlugin(),
  ],
})
```

That registers four endpoints (all CORS-open, all JSON):

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/phase-ml/health`            | liveness probe |
| GET  | `/api/phase-ml/airports`          | airport + runway DB (the same one the classifier uses) |
| POST | `/api/phase-ml/classify`          | classify a track of canonical points |
| POST | `/api/phase-ml/classify-archive`  | classify a track of `[lat, lon, alt, t_offset]` 4-tuples + `t0Seconds` |

## POST /api/phase-ml/classify

Canonical input — what you'd send from another Node service or from a curl pipeline:

```json
{
  "points": [
    {"lat": 40.04, "lon": -105.23, "altMslFt": 8000, "tsUnix": 1779200000},
    {"lat": 40.04, "lon": -105.22, "altMslFt": 7950, "tsUnix": 1779200002},
    …
  ],
  "typeCode": "C172",
  "intentWindowS": 180,
  "priorByAirport": {"KBDU": 2.0}
}
```

Response:

```json
{
  "phases": [
    {"phase": "inbound", "airport": "KBDU", "distNm": 5.1, "aglFt": 2700, "trackOffDeg": 4},
    …                                  // one per input point
  ],
  "maneuvers": [
    {
      "type": "touch_and_go",         // or "landed_full_stop", "steep_turn", …
      "startTs": 1779200120,
      "endTs":   1779200240,
      "durationS": 120,
      "confidence": 0.82,
      "explanation": "touchdown at KBDU (5 AGL), descent -960 → climb-out 800 fpm",
      "evidence": { … }
    }
  ],
  "intent": {
    "top": {"airport": "KBDU", "runway": "26", "probability": 0.62, "explanation": "…"},
    "runnerUp": {"airport": "KBJC", "runway": "30", "probability": 0.18, …},
    "confidenceGap": 0.44,
    "allScores": [ … ]
  }
}
```

`maneuvers[].type` is one of: `steep_turn`, `s_turns_across_road`, `turn_around_a_point`, `chandelle`, `lazy_8`, `slow_flight`, `stall_recovery`, `emergency_descent`, `holding_pattern`, `touch_and_go`, `landed_full_stop`, `thermalling`, `sightseeing_orbit`.

For `touch_and_go` and `landed_full_stop`, `evidence.decisionCue` carries the reason the verdict went one way or the other: `sustained_taxi`, `track_ended_at_airport`, `long_silence_no_climbout`, `climbout_within_window`, or `indeterminate`. See [phaseML/maneuvers.js](maneuvers.js).

## POST /api/phase-ml/classify-archive

For the on-disk archive format ([C:/tmp/noise_data/tracks_<year>.json](../../../../../tmp/noise_data/)):

```json
{
  "points": [[40.04, -105.23, 8000, 12345], …],   // [lat, lon, alt, secs-since-t0]
  "t0Seconds": 1779196800,                          // epoch seconds for offset=0
  "typeCode": "C172"
}
```

## Using it from another Node module (no HTTP)

```js
import { classifyOneTrack } from './phaseML/index.js'

const result = classifyOneTrack(points, { typeCode: 'C172' })
// result.phases    one label per point
// result.maneuvers list of Detection objects
// result.intent    { top, runnerUp, confidenceGap, allScores }
```

Or compose the layers individually:

```js
import { enrich, buildWindow, detectAll, predictIntent, classifyTrack } from './phaseML/index.js'

const samples = enrich(points)              // gs/vs/track/turn_rate
const oraclePhases = classifyTrack(points)  // 9-label per-sample classification
const maneuvers = detectAll(samples, typeCode)
const intent = predictIntent(buildWindow(samples.slice(-90)))
```

## Tests

```bash
npx vitest run phaseML.test.js
```

19 tests covering geometry, airport DB, every maneuver detector (synthetic trajectories), intent prediction, and the end-to-end service.

## Keeping the JS and Python in lock-step

This package is a faithful port of [phase-ml/phase_ml/](../../phase-ml/phase_ml/). When you tune a threshold or add a maneuver, change both. The Python copy is the reference for offline experimentation (it's easier to swap in pandas/scikit-learn); the JS copy is the one that serves production traffic.
