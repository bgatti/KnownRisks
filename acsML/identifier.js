// identifier.js — map detected maneuvers to ACS tasks + emit FAR
// currency events.
//
// Input: one flight as canonical Point[] (same shape phaseML uses).
// Output:
//   {
//     tasks_demonstrated: [{ code, name, instances, evidence[] }],
//     currency_events:    [{ rule, kind, ts, night, lat, lon, airport }],
//     phase_summary:      { taxi_s, takeoffs, landings, ... },
//     notes:              []
//   }

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractAcsSignals } from './features.js'
import { nearestAirport } from '../phaseML/airports.js'
import { isFaaNight } from './suntimes.js'
import { scoreFlight } from './scoring.js'
import { computeClimbMetrics } from './climbMetrics.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Standards loaded once at module load.
const PP_ACS = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'standards/private_pilot_acs.json'), 'utf8'))
const FAR_CURRENCY = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'standards/far_currency.json'), 'utf8'))

// Build maneuver-type → ACS task lookup from the standards JSON.
function buildSignalIndex() {
  const idx = new Map()
  for (const aoo of PP_ACS.areas_of_operation) {
    for (const task of aoo.tasks || []) {
      for (const sig of task.phaseml_signals || []) {
        if (!idx.has(sig)) idx.set(sig, [])
        idx.get(sig).push({ code: task.code, name: task.name, task })
      }
    }
  }
  return idx
}
const SIGNAL_INDEX = buildSignalIndex()

// Selector predicates: when multiple ACS tasks share the same
// phaseML signal, the task's `selector` field picks which one fires
// based on evidence in the detection.
function selectorMatches(selector, det) {
  if (!selector) return true
  // pre_vs_negative / pre_vs_positive — used by VII.B Power-Off vs
  // VII.C Power-On stalls. We approximate from the explanation
  // string ("setup GS X kt → break vs Y fpm").
  if (selector === 'pre_vs_negative' || selector === 'pre_vs_positive') {
    const m = (det.explanation || '').match(/break vs (-?\d+)/)
    if (!m) return selector === 'pre_vs_negative'   // default to power-off when unknown
    const breakVs = parseInt(m[1], 10)
    return selector === 'pre_vs_negative' ? breakVs < 0 : breakVs > 0
  }
  // 'spiraling' — used by IX.A Emergency Descent. Routine airline /
  // biz-jet step-down descents fire phaseML's emergency_descent
  // without a turn; ACS IX.A requires the 30-45° bank.
  if (selector === 'spiraling') {
    return det.evidence && det.evidence.spiraling === true
  }
  // Throttle-based selectors (added when the main API surfaced
  // throttle as a first-class sortie field 2026-06-01).
  if (selector === 'pre_throttle_low') {
    return det.evidence && typeof det.evidence.preEventThrottle === 'number'
      && det.evidence.preEventThrottle < 0.3
  }
  if (selector === 'pre_throttle_high') {
    return det.evidence && typeof det.evidence.preEventThrottle === 'number'
      && det.evidence.preEventThrottle > 0.7
  }
  if (selector === 'throttle_idle') {
    // For maneuvers that should occur at idle (IX.B emergency
    // approach, simulated glide). meanThrottle is null for engineless
    // aircraft — treat as "passes" for gliders.
    if (!det.evidence) return true
    if (det.evidence.meanThrottle == null) return true
    return det.evidence.meanThrottle < 0.4
  }
  if (selector === 'spiraling_and_idle') {
    if (!(det.evidence && det.evidence.spiraling === true)) return false
    // If throttle data available, require idle. If unavailable (e.g.
    // type with no perf table), trust the spiraling gate alone.
    if (det.evidence.meanThrottle == null) return true
    return det.evidence.meanThrottle < 0.4
  }
  return true
}

// Tailwheel hint set from far_currency.json.
const TAILWHEEL_TYPES = new Set(
  (FAR_CURRENCY.rules.find(r => r.code === '61.57(a)(2)') || {}).type_codes_tailwheel_hint || [],
)

/**
 * Identify ACS tasks demonstrated on this flight + emit FAR currency
 * events for each takeoff/landing.
 *
 * @param {Point[]} points
 * @param {object} opts
 *   typeCode       — ICAO type, used for tailwheel detection
 *   tail           — informational
 */
export function identifyAcsSegments(points, { typeCode = '', tail = '' } = {}) {
  const out = {
    tail, typeCode,
    tasks_demonstrated: [],
    currency_events: [],
    phase_summary: {},
    notes: [],
  }
  if (!Array.isArray(points) || points.length < 2) {
    out.notes.push('track too short — < 2 points')
    return out
  }
  const { samples, phaseLabels, detections: rawDetections } = extractAcsSignals(points, { typeCode })

  // ── Dedup near-duplicate landing events ─────────────────────────────
  // Operator round-9: "go-around is detecting more than once per
  // circuit, maybe we can look into dedup?" phaseML emits both literal
  // (AGL-crossing) and implied (ADS-B-gap) touch_and_go detections;
  // when an aircraft's actual touchdown is bracketed by a coverage
  // dropout, the literal AND implied paths can both fire for the
  // SAME touchdown. The same applies to landed_full_stop. Real T&G
  // circuits in a typical pattern aircraft take ≥ 90 s — two
  // touchdown events of the same TYPE at the same airport closer
  // than that are the same event re-detected.
  //
  // Dedup strategy: walk chronologically, keep the FIRST event of
  // each (type, nearest-airport) group, suppress subsequent events
  // within DEDUP_WINDOW_S of a kept event. Higher-confidence events
  // take precedence when they collide (literal > implied), which
  // we approximate by sorting same-ts ties so explicit beats implied.
  // Real C172 pattern circuits at busy fields can be as tight as ~60 s
  // (KLMO has a low TPA + short legs). Same-touchdown re-detections
  // (literal + implied paths firing for the same event, or implied
  // detector retriggering on the same coverage gap) are typically < 60 s
  // apart. 60 s keeps real circuits and squashes re-detections.
  const LANDING_DEDUP_WINDOW_S = 60
  const LANDING_DEDUP_TYPES = new Set(['touch_and_go', 'landed_full_stop'])
  let dedupSuppressed = 0
  const lastKeptAtAirport = new Map()   // key: type + '|' + icao → endTs of last kept
  const detections = []
  // Process in chronological order; tiebreak by impliedness so a
  // literal detection at the same instant wins over an implied one.
  const sortedRaw = [...rawDetections].sort((a, b) => {
    if (a.startTs !== b.startTs) return a.startTs - b.startTs
    const aImp = (a.evidence && a.evidence.implied) ? 1 : 0
    const bImp = (b.evidence && b.evidence.implied) ? 1 : 0
    return aImp - bImp
  })
  for (const det of sortedRaw) {
    if (!LANDING_DEDUP_TYPES.has(det.type)) {
      detections.push(det)
      continue
    }
    // Resolve the airport this event happened near (5 nm cap).
    let icao = det.evidence && det.evidence.airport
      ? String(det.evidence.airport).toUpperCase() : null
    if (!icao) {
      const s = samples[det.startIdx]
      const ap = s ? nearestAirport(s.point.lat, s.point.lon, { maxNm: 5 }) : null
      icao = ap?.airport?.icao || null
    }
    const key = det.type + '|' + (icao || '?')
    const lastTs = lastKeptAtAirport.get(key)
    if (lastTs != null && det.startTs - lastTs < LANDING_DEDUP_WINDOW_S) {
      dedupSuppressed++
      continue
    }
    lastKeptAtAirport.set(key, det.startTs)
    detections.push(det)
  }
  if (dedupSuppressed > 0) {
    out.notes.push(`landing dedup: suppressed ${dedupSuppressed} touch_and_go/landed_full_stop event(s) within ${LANDING_DEDUP_WINDOW_S}s of an earlier same-airport event`)
  }

  // ── Map detections → ACS tasks ──────────────────────────────────────
  // We collect candidate task pairs from BOTH the natural detections
  // (phaseML / acsML output) AND from synthetic events (takeoff). Then
  // preempt, then build the final map.
  //
  // Task-map build happens AFTER takeoff events are computed below.
  const detTaskPairs = []        // { det, code, taskDef }
  for (const det of detections) {
    const hits = SIGNAL_INDEX.get(det.type) || []
    for (const h of hits) {
      if (!selectorMatches(h.task.selector, det)) continue
      detTaskPairs.push({ det, code: h.code, taskDef: h.task })
    }
  }

  // Pattern-phase duration computed up-front; III.B Traffic Patterns
  // is added directly to the final taskMap below (it's not detection-
  // driven so it doesn't go through preemption).
  let patternS = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].isSessionBreak) continue
    if (phaseLabels[i]?.phase === 'pattern') patternS += samples[i].dtS
  }

  // ── Currency events from takeoff / landing detections ────────────────
  // We detect takeoff as: on_ground → airborne transition. Use
  // phaseLabels for ground / airborne, and find the FIRST airborne
  // sample after a run of on_ground/taxiing.
  const takeoffs = []
  const landings = []   // { ts, type: 'landed_full_stop' | 'touch_and_go', lat, lon }
  for (const det of detections) {
    if (det.type === 'landed_full_stop' || det.type === 'touch_and_go') {
      const s = samples[det.startIdx]
      landings.push({ ts: det.startTs, type: det.type, lat: s.point.lat, lon: s.point.lon })
    }
  }
  // Takeoffs from ground→airborne transitions.
  let prevGround = false
  for (let i = 0; i < samples.length; i++) {
    const ph = phaseLabels[i]?.phase
    const isGround = ph === 'on_ground' || ph === 'taxiing'
    if (prevGround && !isGround && !samples[i].isSessionBreak) {
      const s = samples[i]
      takeoffs.push({ ts: s.point.tsUnix, lat: s.point.lat, lon: s.point.lon, idx: i })
    }
    prevGround = isGround
  }
  // ── Implied takeoffs (defensive) ─────────────────────────────────────
  //
  // ADS-B can drop out during taxi/initial climb, so a real takeoff
  // sometimes has NO on_ground samples in the captured track. We can
  // imply one ONLY when the first fix has the actual signature of a
  // takeoff — not an in-progress transit overflight that happens to
  // pass near an airport.
  //
  // Operator round-7 feedback: "I see takeoff implied outside of an
  // airport... seriously taking off is pretty well regulated."
  //
  // Fixed-wing rule (gated):
  //   - first fix is < 3 nm from a known airport
  //   - first fix AGL < 1500 ft above the nearby field
  //   - within the first ~60 s of captured track, mean VS > +200 fpm
  //     (the aircraft was actually CLIMBING — a transit at level cruise
  //     would have vs ≈ 0 or descending)
  //
  // Helicopter exemption: helicopter type codes can legitimately
  // depart from off-airport sites (medevac at a hospital pad, fire
  // ops at a staging point, police at a scene). For helicopters we
  // accept an implied takeoff anywhere AS LONG AS the climb signature
  // is present and the first fix is < 800 ft AGL above local terrain
  // (or below 1500 ft MSL surrogate when terrain isn't known).
  if (takeoffs.length === 0 && samples.length >= 2) {
    const s0 = samples[0]
    // Climb signature: mean VS over first ~60 s of captured data.
    let climbVs = 0
    let climbCount = 0
    const t0 = s0.point.tsUnix
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].point.tsUnix - t0 > 60) break
      if (samples[i].isSessionBreak) continue
      climbVs += samples[i].vsFpm
      climbCount++
    }
    const meanEarlyVs = climbCount > 0 ? climbVs / climbCount : 0

    const isHeliType = /^(R22|R44|R66|EC|AS|S76|B06|B40|B47|H50|H125|MD5|H47|UH|MH|CH|S70|S92|A109|A139)/
      .test(String(typeCode || '').toUpperCase())

    // Fixed-wing path: airport + AGL + climb gates.
    let impliedTakeoff = null
    const ap = nearestAirport(s0.point.lat, s0.point.lon, { maxNm: 3 })
    if (ap.airport) {
      const agl = s0.point.altMslFt - ap.airport.fieldElevFt
      if (agl < 1500 && meanEarlyVs > 200) {
        impliedTakeoff = {
          ts: s0.point.tsUnix, lat: s0.point.lat, lon: s0.point.lon,
          implied: true, idx: 0,
          source: 'fixed_wing_low_climb',
          aglFt: Math.round(agl), meanEarlyVs: Math.round(meanEarlyVs),
          airportIcao: ap.airport.icao, distNm: +ap.distanceNm.toFixed(2),
        }
      }
    }
    // Helicopter exemption: off-airport implied takeoff is legitimate
    // if climb is steep enough and start altitude is low.
    if (!impliedTakeoff && isHeliType && meanEarlyVs > 300
        && s0.point.altMslFt < 8000) {
      impliedTakeoff = {
        ts: s0.point.tsUnix, lat: s0.point.lat, lon: s0.point.lon,
        implied: true, idx: 0,
        source: 'helicopter_off_airport',
        meanEarlyVs: Math.round(meanEarlyVs),
        airportIcao: null, distNm: ap.airport ? +ap.distanceNm.toFixed(2) : null,
      }
    }
    if (impliedTakeoff) takeoffs.push(impliedTakeoff)
    // Otherwise: NO implied takeoff. The track starts already
    // airborne (overflight / transit) and we leave it that way.
    // A missing IV.A is more honest than a spurious one.
  }

  // Emit a synthetic 'takeoff' detection for each takeoff event so
  // IV.A Normal Takeoff fires. Short-field detections preempt these.
  for (const to of takeoffs) {
    let expl
    if (!to.implied) expl = 'takeoff (on_ground → airborne transition)'
    else if (to.source === 'helicopter_off_airport') {
      expl = `implied helicopter takeoff off-airport (mean early VS +${to.meanEarlyVs} fpm)`
    } else if (to.source === 'fixed_wing_low_climb') {
      expl = `implied takeoff from ${to.airportIcao} (${to.distNm} nm, ${to.aglFt} ft AGL, +${to.meanEarlyVs} fpm mean climb)`
    } else expl = 'implied takeoff'
    const synthetic = {
      type: 'takeoff', startIdx: to.idx, endIdx: to.idx,
      startTs: to.ts, endTs: to.ts, durationS: 0,
      confidence: to.implied ? 0.7 : 0.9,
      explanation: expl,
      evidence: {
        implied: !!to.implied,
        source: to.source || 'observed',
        airport: to.airportIcao || null,
        distNm: to.distNm || null,
        aglFt: to.aglFt || null,
        meanEarlyVsFpm: to.meanEarlyVs || null,
      },
    }
    const hits = SIGNAL_INDEX.get('takeoff') || []
    for (const h of hits) {
      if (!selectorMatches(h.task.selector, synthetic)) continue
      detTaskPairs.push({ det: synthetic, code: h.code, taskDef: h.task })
    }
  }

  // Preempt: a task that lists `preempts: [...]` removes any of those
  // codes' pairs whose interval is within ±30 s. We compare each pair's
  // [startTs, endTs] interval (short_field_landing spans 60 s before
  // touchdown; landed_full_stop is at the touchdown moment).
  const PREEMPT_WINDOW_S = 30
  function intervalsOverlap(a, b) {
    const gap = Math.max(0, Math.max(a.det.startTs, b.det.startTs) - Math.min(a.det.endTs, b.det.endTs))
    return gap <= PREEMPT_WINDOW_S
  }
  const removed = new Set()
  for (let i = 0; i < detTaskPairs.length; i++) {
    const a = detTaskPairs[i]
    const preempts = a.taskDef.preempts || []
    if (!preempts.length) continue
    for (let j = 0; j < detTaskPairs.length; j++) {
      if (i === j || removed.has(j)) continue
      const b = detTaskPairs[j]
      if (!preempts.includes(b.code)) continue
      if (!intervalsOverlap(a, b)) continue
      removed.add(j)
    }
  }

  const taskMap = new Map()
  // task_segments[] — flat list of post-preempt detection segments,
  // each annotated with the ACS code it satisfied. Unlike tasks_demonstrated
  // (which collapses by code and strips per-detection indices), this
  // preserves startIdx/endIdx/startTs/endTs/evidence per occurrence so
  // downstream consumers can attach annotations to specific track
  // segments. Indices refer to the `samples`/`points` array passed
  // into identifyAcsSegments (the canonical input).
  out.task_segments = []
  for (let i = 0; i < detTaskPairs.length; i++) {
    if (removed.has(i)) continue
    const { det, code, taskDef } = detTaskPairs[i]
    if (!taskMap.has(code)) taskMap.set(code, { code, name: taskDef.name, instances: 0, evidence: [] })
    const row = taskMap.get(code)
    row.instances++
    row.evidence.push({
      type: det.type, ts: det.startTs, duration_s: det.durationS,
      confidence: det.confidence, explanation: det.explanation,
    })
    out.task_segments.push({
      code, name: taskDef.name,
      type: det.type,
      startIdx: det.startIdx, endIdx: det.endIdx,
      startTs: det.startTs, endTs: det.endTs,
      durationS: det.durationS, confidence: det.confidence,
      explanation: det.explanation,
      evidence: det.evidence || null,
    })
  }
  if (patternS >= 60) {
    taskMap.set('III.B', {
      code: 'III.B', name: 'Traffic Patterns', instances: 1,
      evidence: [{ type: 'phase:pattern', duration_s: Math.round(patternS), confidence: 0.9 }],
    })
    // Pattern is accumulated across non-contiguous samples; emit one
    // segment spanning first-pattern-sample → last-pattern-sample
    // so the client at least gets a bracket.
    let firstP = -1, lastP = -1
    for (let i = 0; i < phaseLabels.length; i++) {
      if (phaseLabels[i] && phaseLabels[i].phase === 'pattern') {
        if (firstP < 0) firstP = i
        lastP = i
      }
    }
    if (firstP >= 0 && lastP > firstP) {
      out.task_segments.push({
        code: 'III.B', name: 'Traffic Patterns',
        type: 'phase:pattern',
        startIdx: firstP, endIdx: lastP,
        startTs: samples[firstP].point.tsUnix,
        endTs: samples[lastP].point.tsUnix,
        durationS: Math.round(patternS),
        confidence: 0.9,
        explanation: 'aggregate pattern time (first → last pattern fix)',
        evidence: null,
      })
    }
  }

  for (const to of takeoffs) {
    const ap = nearestAirport(to.lat, to.lon, { maxNm: 10 })
    const apIcao = ap.airport?.icao || null
    const apLat = ap.airport?.lat ?? to.lat
    const apLon = ap.airport?.lon ?? to.lon
    const night = isFaaNight(to.ts, apLat, apLon)
    to.night = night
    to.airport = apIcao
    out.currency_events.push({
      rule: '61.57(a)', kind: 'takeoff', ts: to.ts,
      airport: apIcao, lat: to.lat, lon: to.lon, night,
      implied: !!to.implied,
    })
    if (night) {
      out.currency_events.push({
        rule: '61.57(b)', kind: 'night_takeoff', ts: to.ts,
        airport: apIcao, lat: to.lat, lon: to.lon, night: true,
        implied: !!to.implied,
      })
    }
  }
  for (const ld of landings) {
    const ap = nearestAirport(ld.lat, ld.lon, { maxNm: 10 })
    const apIcao = ap.airport?.icao || null
    const apLat = ap.airport?.lat ?? ld.lat
    const apLon = ap.airport?.lon ?? ld.lon
    const night = isFaaNight(ld.ts, apLat, apLon)
    const isFullStop = ld.type === 'landed_full_stop'
    const isTailwheel = TAILWHEEL_TYPES.has(String(typeCode || '').toUpperCase())
    // Annotate the landing record for counts further down.
    ld.night = night
    ld.airport = apIcao

    // 61.57(a) — counts touch_and_go OR landed_full_stop (unless tailwheel).
    if (!isTailwheel || isFullStop) {
      out.currency_events.push({
        rule: '61.57(a)', kind: 'landing', ts: ld.ts,
        airport: apIcao, lat: ld.lat, lon: ld.lon, night,
        full_stop: isFullStop, landing_type: ld.type,
      })
    } else {
      out.notes.push(`tailwheel ${typeCode}: touch_and_go does NOT satisfy 61.57(a)(2)`)
    }
    // 61.57(a)(2) — tailwheel-specific FULL-STOP only.
    if (isTailwheel && isFullStop) {
      out.currency_events.push({
        rule: '61.57(a)(2)', kind: 'tailwheel_full_stop_landing', ts: ld.ts,
        airport: apIcao, lat: ld.lat, lon: ld.lon, night,
      })
    }
    // 61.57(b) — night full-stop only.
    if (night && isFullStop) {
      out.currency_events.push({
        rule: '61.57(b)', kind: 'night_full_stop_landing', ts: ld.ts,
        airport: apIcao, lat: ld.lat, lon: ld.lon, night: true,
      })
    } else if (night && !isFullStop) {
      out.notes.push('touch_and_go at night does NOT satisfy 61.57(b)')
    }
  }

  // ── Phase summary ───────────────────────────────────────────────────
  const phaseSeconds = {
    on_ground: 0, taxiing: 0, pattern: 0, practice_area: 0,
    departing: 0, inbound: 0, en_route: 0, nearby: 0, landed_full_stop: 0,
  }
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].isSessionBreak) continue
    const dt = samples[i].dtS
    const ph = phaseLabels[i]?.phase
    if (phaseSeconds[ph] !== undefined) phaseSeconds[ph] += dt
  }
  // Climb / altitude metrics — initial climb rate (every aircraft) +
  // sortie peak altitude + tow-cycle release points & avg climb rates
  // (when the alt-curve has 2+ climb-then-descent peaks). All sourced
  // from phaseML's enriched VS series.
  const climb = computeClimbMetrics(samples, takeoffs)

  out.phase_summary = {
    total_active_s: Object.values(phaseSeconds).reduce((a, b) => a + b, 0),
    phase_seconds: phaseSeconds,
    n_takeoffs: takeoffs.length,
    n_landings: landings.length,
    n_touch_and_go: landings.filter(l => l.type === 'touch_and_go').length,
    n_full_stop: landings.filter(l => l.type === 'landed_full_stop').length,
    n_night_takeoffs: takeoffs.filter(t => t.night).length,
    n_night_landings: landings.filter(l => l.night).length,
    n_night_full_stop: landings.filter(l => l.night && l.type === 'landed_full_stop').length,
    n_night_touch_and_go: landings.filter(l => l.night && l.type === 'touch_and_go').length,
    initial_climb: climb.initial_climb,    // one entry per takeoff: { mean_fpm, peak_fpm, duration_s, ... }
    peak_alt: climb.peak_alt,              // { ts, msl_ft, agl_ft, nearest_airport, lat, lon } | null
    // climb_cycles[]: any sustained climb-then-descent ≥ 1500 ft alt gain.
    // Matches BOTH tow operations AND GA practice climbs (climb to
    // practice area → maneuver → descend → repeat). Consumers wanting
    // tow-only should filter by sortie_purpose === 'tow_plane' or
    // type code (PA25/PA18/PIAT/PC6).
    climb_cycles: climb.climb_cycles,
  }

  // Finalise tasks list.
  out.tasks_demonstrated = [...taskMap.values()]
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))

  // ACS performance-standard scoring for the maneuvers that have a
  // scorer (V.A, V.B, V.C, V.D). Other tasks need pilot-input data
  // we don't have from track alone.
  out.scores = scoreFlight(detections, samples)

  return out
}
