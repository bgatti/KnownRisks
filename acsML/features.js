// features.js — ACS-specific feature extraction on top of phaseML.
//
// phaseML already detects most performance maneuvers (steep_turn,
// s_turns_across_road, turn_around_a_point, chandelle, lazy_8,
// slow_flight, stall_recovery, emergency_descent, holding_pattern,
// thermalling, sightseeing_orbit, touch_and_go, landed_full_stop).
//
// This module adds the ACS-specific signatures phaseML doesn't:
//   - rectangular_course (ground reference maneuver V.B)
//   - short_field_takeoff / soft_field_takeoff (suspected by climb profile)
//   - short_field_landing / soft_field_landing (suspected by descent profile)
//   - unusual_attitude_recovery (instrument task VIII.E proxy)
//
// All detectors are pure functions over phaseML's enriched Sample[]
// stream and return Detection-shape objects (same as phaseML).

import { enrich, MAX_SAMPLE_GAP_S } from '../phaseML/features.js'
import { classifyTrack as phaseClassifyTrack } from '../phaseML/oracle.js'
import { detectAll as phaseDetectAll } from '../phaseML/maneuvers.js'
import {
  angleDiffAbs, haversineNm, signedHeadingChange,
} from '../phaseML/geometry.js'
import { nearestAirport } from '../phaseML/airports.js'

function makeDetection(type, samples, lo, hi, confidence, explanation, evidence) {
  return {
    type, startIdx: lo, endIdx: hi,
    startTs: samples[lo].point.tsUnix,
    endTs: samples[hi].point.tsUnix,
    durationS: samples[hi].point.tsUnix - samples[lo].point.tsUnix,
    confidence, explanation, evidence,
  }
}

// ── ACS V.B Rectangular Course ─────────────────────────────────────────
//
// Four ~90° turns at AGL 600–1000 ft, legs roughly orthogonal,
// tracing a rectangle around a fixed ground reference.
//
// Detection heuristic:
//   - Look for runs of 4 consecutive turns each in [60°, 120°] in the
//     SAME direction (all left or all right)
//   - Total cumulative turn close to 360°
//   - AGL stays in [400, 1500] (relaxed from ACS 600-1000)
//   - Total span < 10 min
export function detectRectangularCourse(samples) {
  const out = []
  if (samples.length < 5) return out
  const turns = []   // { startIdx, endIdx, deltaDeg }
  let runStart = 0
  let runDir = 0
  let runSum = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].isSessionBreak) {
      runStart = i; runDir = 0; runSum = 0; continue
    }
    const delta = signedHeadingChange(samples[i - 1].trackDeg, samples[i].trackDeg)
    if (Math.abs(delta) < 5) continue
    const sign = Math.sign(delta)
    if (runDir === 0) { runDir = sign; runStart = i - 1; runSum = delta; continue }
    if (sign !== runDir || Math.abs(runSum + delta) > 130) {
      // End of run.
      if (Math.abs(runSum) >= 60 && Math.abs(runSum) <= 120) {
        turns.push({ startIdx: runStart, endIdx: i, deltaDeg: runSum })
      }
      runStart = i - 1; runDir = sign; runSum = delta
    } else {
      runSum += delta
    }
  }
  // Now scan turns for groups of 4 same-direction.
  for (let i = 0; i + 3 < turns.length; i++) {
    const grp = turns.slice(i, i + 4)
    const total = grp.reduce((s, t) => s + t.deltaDeg, 0)
    if (Math.abs(Math.abs(total) - 360) > 30) continue
    const lo = grp[0].startIdx
    const hi = grp[3].endIdx
    const durS = samples[hi].point.tsUnix - samples[lo].point.tsUnix
    if (durS < 60 || durS > 600) continue
    const agls = []
    for (let k = lo; k <= hi; k++) {
      const { airport } = nearestAirport(samples[k].point.lat, samples[k].point.lon, { maxNm: 50 })
      const a = airport ? samples[k].point.altMslFt - airport.fieldElevFt : samples[k].point.altMslFt
      agls.push(a)
    }
    const aglMed = agls.sort((a, b) => a - b)[Math.floor(agls.length / 2)]
    if (aglMed < 400 || aglMed > 1500) continue
    out.push(makeDetection('rectangular_course', samples, lo, hi, 0.8,
      `4 same-direction turns averaging ${Math.abs(total) / 4 | 0}° each, AGL ${aglMed | 0} ft`,
      { totalTurnDeg: total, aglFt: aglMed }))
  }
  return out
}

// ── ACS IV.E Short-Field Takeoff (suspected) ───────────────────────────
//
// Departing phase with very steep initial climb (>= 700 fpm) sustained
// for >= 60 s starting from low AGL.
export function detectShortFieldTakeoff(samples, phaseLabels) {
  const out = []
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].isSessionBreak) continue
    if (phaseLabels[i]?.phase !== 'departing') continue
    // Find run of departing
    let j = i
    while (j < samples.length && phaseLabels[j]?.phase === 'departing' && !samples[j].isSessionBreak) j++
    const segSamples = samples.slice(i, j)
    if (segSamples.length < 5) { i = j; continue }
    const meanVs = segSamples.reduce((s, x) => s + x.vsFpm, 0) / segSamples.length
    const startAgl = (phaseLabels[i]?.aglFt) ?? 0
    if (meanVs >= 700 && startAgl < 500) {
      out.push(makeDetection('short_field_takeoff', samples, i, j - 1, 0.7,
        `sustained ${meanVs | 0} fpm climb from ${startAgl | 0} ft AGL — suspected short-field technique`,
        { meanVsFpm: meanVs, startAglFt: startAgl }))
    }
    i = j
  }
  return out
}

// ── ACS IV.F Short-Field Landing (suspected) ───────────────────────────
//
// Inbound to landed_full_stop or touch_and_go with steep stabilized
// descent (> 600 fpm) on short final.
export function detectShortFieldLanding(samples, phaseLabels, landingDetections) {
  const out = []
  for (const ld of landingDetections) {
    if (ld.type !== 'landed_full_stop' && ld.type !== 'touch_and_go') continue
    // Look at the 60 s before touchdown.
    const tdIdx = ld.startIdx
    let lo = tdIdx
    while (lo > 0 && samples[tdIdx].point.tsUnix - samples[lo].point.tsUnix < 60) lo--
    const seg = samples.slice(lo, tdIdx + 1)
    if (seg.length < 3) continue
    const meanVs = seg.reduce((s, x) => s + x.vsFpm, 0) / seg.length
    if (meanVs <= -600) {
      out.push(makeDetection('short_field_landing', samples, lo, tdIdx, 0.65,
        `${(-meanVs) | 0} fpm sustained descent into touchdown — suspected short-field technique`,
        { meanVsFpm: meanVs, landingType: ld.type }))
    }
  }
  return out
}

// ── ACS VIII.E Recovery from Unusual Attitudes (proxy) ─────────────────
//
// Sudden large altitude excursion (≥ 500 ft) + heading deviation
// (≥ 30°) followed by recovery within 30 s.
export function detectUnusualAttitudeRecovery(samples) {
  const out = []
  if (samples.length < 10) return out
  for (let i = 5; i < samples.length - 5; i++) {
    if (samples[i].isSessionBreak) continue
    // 5-sample backward window vs 5-sample forward window
    const before = samples.slice(i - 5, i)
    const after = samples.slice(i, i + 5)
    const altSwing = Math.max(...before.map(s => s.point.altMslFt)) - Math.min(...after.map(s => s.point.altMslFt))
    const altSwingDown = Math.max(...after.map(s => s.point.altMslFt)) - Math.min(...before.map(s => s.point.altMslFt))
    const hdgDiff = angleDiffAbs(before[before.length - 1].trackDeg, after[0].trackDeg)
    if ((Math.abs(altSwing) > 500 || Math.abs(altSwingDown) > 500) && hdgDiff > 30) {
      // Check recovery within 30 s.
      let j = i + 5
      while (j < samples.length && samples[j].point.tsUnix - samples[i].point.tsUnix < 30) j++
      if (j < samples.length) {
        const recovered = Math.abs(samples[j].vsFpm) < 200
          && angleDiffAbs(samples[j].trackDeg, samples[j - 1].trackDeg) < 10
        if (recovered) {
          out.push(makeDetection('unusual_attitude_recovery', samples, i - 5, j, 0.6,
            `${Math.max(Math.abs(altSwing), Math.abs(altSwingDown)) | 0} ft alt swing + ${hdgDiff | 0}° hdg deviation, recovered within 30 s`,
            { altSwingFt: Math.max(Math.abs(altSwing), Math.abs(altSwingDown)), hdgDeviationDeg: hdgDiff }))
        }
      }
      i += 5
    }
  }
  return out
}

// ── ACS-level extraction wrapper ────────────────────────────────────────
//
// Runs phaseML's detectors and the acsML-specific detectors over one
// flight and returns the merged list of detections + per-sample phase
// labels.
export function extractAcsSignals(points, { typeCode = '' } = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    return { samples: [], phaseLabels: [], detections: [] }
  }
  const samples = enrich(points)
  const phaseLabels = phaseClassifyTrack(points)
  const phaseDetections = phaseDetectAll(samples, typeCode)

  const acsDetections = []
  acsDetections.push(...detectRectangularCourse(samples))
  acsDetections.push(...detectShortFieldTakeoff(samples, phaseLabels))
  acsDetections.push(...detectShortFieldLanding(samples, phaseLabels,
    phaseDetections.filter(d => d.type === 'landed_full_stop' || d.type === 'touch_and_go')))
  acsDetections.push(...detectUnusualAttitudeRecovery(samples))

  const merged = [...phaseDetections, ...acsDetections].sort((a, b) => a.startTs - b.startTs)
  return { samples, phaseLabels, detections: merged }
}
