# Wiring `/api/noise/recent-landings` onto phaseML

Plan to replace the heuristic ladder in [vite.config.js:3481-3753](../vite.config.js#L3481-L3753) with phaseML's landing-event detector. The current endpoint hallucinated a landing for N721FJ at KBJC at 17:23Z when the aircraft was actually at KBDU doing pattern work and didn't reach KBJC until 17:53Z. phaseML produces the right answer (verified — see "Why this fixes N721FJ" at the bottom).

## What phaseML gives you

For each track of `Point[]`, [`detectAll(samples, typeCode)`](maneuvers.js) returns a list of `Detection` objects. The two that matter for this endpoint:

| `detection.type` | When | Key evidence fields |
|---|---|---|
| `landed_full_stop` | aircraft arrived and stopped at the airport | `evidence.airport`, `evidence.decisionCue`, `evidence.taxiSeconds`, `evidence.minAglFt` |
| `touch_and_go`     | aircraft touched down and climbed out | `evidence.airport`, `evidence.decisionCue`, `evidence.maxPostVsFpm` |

`decisionCue` is the *reason* the verdict went one way:
- `sustained_taxi` — saw ≥20s of GS<25 kt at the field after touchdown → FULL_STOP
- `track_ended_at_airport` — track ended at the field within 3 min of touchdown → FULL_STOP
- `long_silence_no_climbout` — 5+ min ADS-B gap with no climb-out → FULL_STOP
- `climbout_within_window` — vs ≥+400 fpm within 3 min → T&G
- `indeterminate` — no post-touchdown data at all (rare; defaults to T&G low-conf)

Each detection's `evidence.airport` is **the airport where it actually happened**. This is the property the current endpoint lacks — see "the bug" section.

## Code skeleton

Replace the per-track block (lines 3532-3716) with this:

```js
import { enrich, detectAll } from './phaseML/index.js'

// inside the handler, after loading `tracks`, `ap`, `nowMs`, `minutesMs`:
const out = []
const tngs = []   // optional: surface separately for kiosk visualizations

for (const t of tracks) {
  if ((t.call || '').trim().startsWith('~')) continue       // anonymized PIA/TIS-B
  const pts = (t.points || []).slice().sort((a, b) => (a[3] || 0) - (b[3] || 0))
  if (pts.length < 5) continue

  // Convert archive 4-tuples [lat, lon, alt_msl_ft, ts_ms] → Point[]
  const points = pts.map(p => ({
    lat: p[0], lon: p[1], altMslFt: p[2], tsUnix: p[3] / 1000,
  }))
  const samples = enrich(points)
  const dets = detectAll(samples, t.type || '')

  // Filter to landings AT the requested airport in the requested window.
  const landings = dets.filter(d =>
    d.type === 'landed_full_stop'
    && d.evidence.airport === airport
    && (nowMs - d.endTs * 1000) <= minutesMs
  )

  // Optional: also collect touch-and-goes at this field for the kiosk's
  // "transit touches" overlay. These are explicitly NOT in `out`.
  for (const d of dets) {
    if (d.type === 'touch_and_go'
        && d.evidence.airport === airport
        && (nowMs - d.endTs * 1000) <= minutesMs) {
      tngs.push({ tail: (t.call || '').trim(), at: new Date(d.endTs * 1000).toISOString(), cue: d.evidence.decisionCue })
    }
  }

  for (const d of landings) {
    const tMs = takeoffMsBefore(pts, d.startTs * 1000)   // first airborne fix preceding this landing
    const lMs = d.endTs * 1000

    // Departure detection (existing logic still works — phaseML doesn't know
    // about post-landing departures, only the landing itself).
    const { departedMs, stillOnGround, coverageFresh } =
      detectDeparture(pts, lMs, ap, nowMs)

    const onGroundMin =
      departedMs != null    ? round1((departedMs - lMs) / 60000) :
      stillOnGround         ? round1((nowMs - lMs) / 60000) :
      /* coverage gap */      null

    const cyclePts = pts.filter(p => p[3] >= tMs && p[3] <= lMs)
    const o = nearestAp(cyclePts[0][0], cyclePts[0][1])
    const inf = info.get((t.call || '').trim()) || {}
    const purpose = resolvePurpose(inf.purpose, t.type, (t.call || '').trim())

    out.push({
      tail: (t.call || '').trim(),
      type: t.type || null,
      desc: inf.descr || expandType(t.type),
      icon_url: aircraftIconUrl(t.type, (t.call || '').trim()),
      base: inf.base || null, purpose, school: inf.school || null,
      origin: o.dist <= 3 ? o.code : null,
      dest: airport,
      origin_dist_nm: round1(distNmAp(cyclePts[0][0], cyclePts[0][1], ap.lat, ap.lon)),
      landed: true,
      landed_at: new Date(lMs).toISOString(),
      departed_at: departedMs != null ? new Date(departedMs).toISOString() : null,
      still_on_ground: !!stillOnGround,
      on_ground_min: onGroundMin,
      full_stop: true,                                    // <-- phaseML already decided this
      // phaseML-specific provenance (new fields — back-compat additive):
      decision_cue: d.evidence.decisionCue,
      classifier_confidence: d.confidence,
      airborne_min: round1((lMs - tMs) / 60000),
      ...computeImpact(cyclePts, t, purpose, POPGRID),    // unchanged from existing logic
    })
  }
}
```

Helper for finding the takeoff that paired with this landing:

```js
function takeoffMsBefore(pts, landingMs) {
  // Walk back through pts to find the most recent contiguous airborne segment
  // ending at landingMs. Same SESSION_GAP_MS logic the current code uses.
  const SESSION_GAP_MS = 30 * 60_000
  // Last contiguous session before landingMs:
  let i = pts.findIndex(p => p[3] >= landingMs)
  if (i < 0) i = pts.length
  let sessionStart = i - 1
  while (sessionStart > 0) {
    const gap = pts[sessionStart][3] - pts[sessionStart - 1][3]
    if (gap > SESSION_GAP_MS) break
    sessionStart--
  }
  // First airborne fix within that session:
  const groundCeil = (/* ap.elev + 200 */)
  for (let k = sessionStart; k < i; k++) {
    if (pts[k][2] != null && pts[k][2] > groundCeil) return pts[k][3]
  }
  return pts[sessionStart]?.[3] ?? landingMs
}
```

The departure-detection block (lines 3664-3673) stays as-is — phaseML doesn't yet model "how long the aircraft sat there", and the existing logic is correct.

## Why this fixes N721FJ

The current code calls `extractTowCycles(t.hex, t.call, pts, zoneConfig)` with `field_elevation_ft: ap.elev`. When `airport=KBJC` is requested, every cycle whose landing geometry is *near KBJC's elevation* gets reported as a KBJC landing. N721FJ did pattern work at KBDU (elev 5288 ft); KBJC's elev is 5673 ft. A KBDU touch-and-go ends at ~5300 ft MSL — comfortably below `5673 + 200 = 5873` (KBJC's ground ceiling). `extractTowCycles` saw "on-ground" and reported it as a KBJC landing.

phaseML's `detectTouchAndGo` annotates each candidate with [`nearestAirport(lat, lon)`](maneuvers.js#L666-L685) at the *position of the touchdown*. The 12 KBDU pattern events all carry `evidence.airport === 'KBDU'`, so the `d.evidence.airport === airport` filter excludes them when `airport=KBJC` is requested. Only the actual KBJC landing at 17:53Z survives the filter.

Verified: `node test_n721fj.mjs` (the same script we used to debug) shows phaseML reporting one `landed_full_stop` at KBJC at 17:53:25Z with cue `track_ended_at_airport`, and zero landings reported when filtered to `airport === 'KBJC'` and `(nowMs - d.endTs*1000) <= minutesMs` for the window the kiosk was showing.

## What about the `boot` endpoint's `overflight` call?

The boot endpoint's `classifyTrackPhase()` correctly labels N721FJ's brief KBJC visit as `overflight`. Boot looks at the *whole* track shape; recent-landings looks at *cycles*. They disagreed because they were classifying different things. With phaseML in place:

- Boot continues to use `classifyTrackPhase()` for its strategic intent label. No change needed there (or use phaseML's `intent` predictor if we want to consolidate later — see [the kickoff doc's integration plan](../src/PHASE_ML_KICKOFF.md#integration-plan)).
- Recent-landings stops emitting overflight-as-landing because phaseML doesn't emit `landed_full_stop` for an aircraft that never actually touched down at the target field.

## Backwards compatibility

The response shape is mostly preserved. New additive fields:

- `decision_cue` — one of the 5 cue strings (or null if not applicable)
- `classifier_confidence` — 0-1 from phaseML

Behavioral changes the kiosk should know about:

- `on_ground_min` becomes truly null when coverage is gapped (today it can read 181.6 minutes of stale wall-clock from a phantom landing). Callers that depended on a numeric value should handle null.
- `full_stop: false` may appear *less often* — touch-and-goes are now emitted as separate detections (in `tngs[]` if we wire it through to the response, or simply omitted). The current endpoint conflated T&Gs as "landings with low on_ground_min"; phaseML separates them at detection time.
- A given (tail, window) pair can now produce zero landings where the old endpoint produced one — that's correct for overflights.

The `airborne_min`, `impact_*`, `bands`, and `complaints` blocks all keep the same shape. The impact computation runs on `cyclePts` filtered from the chosen `(tMs, lMs)` window — same as today.

## Testing

Before flipping the endpoint, add one regression test:

```js
// noise/web/recentLandings.test.js
it('N721FJ overflight at KBJC is not reported as a landing', async () => {
  const pts = await loadFixture('n721fj_2026-05-26.json')
  const result = await callRecentLandings({ airport: 'KBJC', minutes: 60, tracks: [pts] })
  // 17:23 was over KBDU; 17:53 was the actual KBJC arrival.
  const at_1723 = result.landings.find(l => l.landed_at.startsWith('2026-05-26T17:23'))
  expect(at_1723).toBeUndefined()
  const at_1753 = result.landings.find(l => l.landed_at.startsWith('2026-05-26T17:53'))
  expect(at_1753).toBeDefined()
  expect(at_1753.decision_cue).toBe('track_ended_at_airport')
})
```

Pull the fixture once with `curl https://web-app-production-fedf.up.railway.app/api/adsb/track/a9a7c9 > n721fj_2026-05-26.json` and commit it.

## Migration order

1. Add phaseML imports at the top of vite.config.js — no behavior change yet.
2. Build the new code path **alongside** the existing one behind a query flag (`?classifier=phaseml`). Log discrepancies for a day.
3. Make `phaseml` the default; keep the old path behind `?classifier=legacy` for one more day so any consumer dependent on the old `on_ground_min` semantics can adapt.
4. Remove the legacy path and the layered heuristics (lines 3527-3628).

The kiosk's airborne-cross-check at `kiosk.js:817-833` can be left in place — it's a defense-in-depth shield that phaseML rarely trips, and removing it is a separate change.
