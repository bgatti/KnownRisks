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
  const { samples, phaseLabels, detections } = extractAcsSignals(points, { typeCode })

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
  // If no explicit on_ground samples (ADS-B dropout near field), use
  // the FIRST airborne fix near an airport as an implied takeoff.
  if (takeoffs.length === 0 && samples.length) {
    const s0 = samples[0]
    const ap = nearestAirport(s0.point.lat, s0.point.lon, { maxNm: 5 })
    if (ap.airport) {
      takeoffs.push({
        ts: s0.point.tsUnix, lat: s0.point.lat, lon: s0.point.lon,
        implied: true, idx: 0,
      })
    }
  }

  // Emit a synthetic 'takeoff' detection for each takeoff event so
  // IV.A Normal Takeoff fires. Short-field detections preempt these.
  for (const to of takeoffs) {
    const synthetic = {
      type: 'takeoff', startIdx: to.idx, endIdx: to.idx,
      startTs: to.ts, endTs: to.ts, durationS: 0, confidence: to.implied ? 0.6 : 0.9,
      explanation: to.implied ? 'implied takeoff (no on-ground fix; first in-radius airborne fix near airport)'
        : 'takeoff (on_ground → airborne transition)',
      evidence: { implied: !!to.implied },
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
  }
  if (patternS >= 60) {
    taskMap.set('III.B', {
      code: 'III.B', name: 'Traffic Patterns', instances: 1,
      evidence: [{ type: 'phase:pattern', duration_s: Math.round(patternS), confidence: 0.9 }],
    })
  }

  for (const to of takeoffs) {
    const ap = nearestAirport(to.lat, to.lon, { maxNm: 10 })
    const apIcao = ap.airport?.icao || null
    const apLat = ap.airport?.lat ?? to.lat
    const apLon = ap.airport?.lon ?? to.lon
    const night = isFaaNight(to.ts, apLat, apLon)
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
  out.phase_summary = {
    total_active_s: Object.values(phaseSeconds).reduce((a, b) => a + b, 0),
    phase_seconds: phaseSeconds,
    n_takeoffs: takeoffs.length,
    n_landings: landings.length,
    n_touch_and_go: landings.filter(l => l.type === 'touch_and_go').length,
    n_full_stop: landings.filter(l => l.type === 'landed_full_stop').length,
  }

  // Finalise tasks list.
  out.tasks_demonstrated = [...taskMap.values()]
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))

  return out
}
