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
import { perfForType } from '../aircraftPerf.js'
import { estimateThrottle } from '../throttleEstimate.js'

// Per-sample throttle estimate (0..1) using the same model that the
// sortie API uses (climb_fraction + level_flight_fraction against the
// type's POH-derived performance table). Returns an array parallel
// to samples, with null entries where the type is engineless or the
// estimate isn't reliable.
export function estimateThrottleSeries(samples, typeCode) {
  const perf = perfForType(typeCode || '')
  const out = new Array(samples.length).fill(null)
  if (!perf || perf.vs_max_fpm <= 0) return out   // glider / balloon
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    if (s.isSessionBreak && i > 0) continue
    const est = estimateThrottle(s.gsKts, s.vsFpm, s.point.altMslFt, perf)
    if (est) out[i] = est.throttle
  }
  return out
}

// Mean throttle over the inclusive index range [lo, hi].
export function meanThrottle(throttleSeries, lo, hi) {
  let sum = 0, n = 0
  for (let i = lo; i <= hi && i < throttleSeries.length; i++) {
    if (throttleSeries[i] != null) { sum += throttleSeries[i]; n++ }
  }
  return n > 0 ? sum / n : null
}

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
// A rectangular course around a fixed ground reference. Per ACS:
// four ~90° turns, legs of roughly equal length, AGL 600-1000 ft.
//
// Detection: walk the samples, alternating between TURNING and
// STRAIGHT-AND-LEVEL episodes. A turning episode accumulates signed
// heading change; a straight episode resets it. The output is a
// sequence of "turn events" each with the total signed deg.
//
// A rectangular course is 4 consecutive turn events same-direction
// each in [60°, 120°] totaling ~360°, separated by straight legs of
// 5-60s.
export function detectRectangularCourse(samples) {
  const out = []
  if (samples.length < 10) return out

  // Build per-sample instantaneous turn rate, then segment.
  // A sample is "turning" if its absolute turn-rate exceeds ~1°/s
  // OR the cumulative heading change in the last 4 s exceeds 10°.
  const turning = new Array(samples.length).fill(false)
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].isSessionBreak) continue
    if (Math.abs(samples[i].turnRateDps) > 1.5) turning[i] = true
  }

  // Build turn events: runs of consecutive turning=true samples.
  const turnEvents = []
  let i = 0
  while (i < samples.length) {
    if (!turning[i]) { i++; continue }
    let j = i
    let signed = 0
    while (j < samples.length && (turning[j] || (j > i && turning[j - 1] && Math.abs(samples[j].turnRateDps) > 0.5))) {
      if (j > i) signed += signedHeadingChange(samples[j - 1].trackDeg, samples[j].trackDeg)
      j++
    }
    const durS = samples[j - 1].point.tsUnix - samples[i].point.tsUnix
    if (durS >= 3 && Math.abs(signed) >= 45 && Math.abs(signed) <= 135) {
      turnEvents.push({ startIdx: i, endIdx: j - 1, deltaDeg: signed, durS })
    }
    i = j
  }

  // Scan groups of 4 consecutive same-direction turn events with
  // small straight legs between them.
  for (let k = 0; k + 3 < turnEvents.length; k++) {
    const grp = turnEvents.slice(k, k + 4)
    const dir = Math.sign(grp[0].deltaDeg)
    if (!grp.every(t => Math.sign(t.deltaDeg) === dir)) continue
    const total = grp.reduce((s, t) => s + t.deltaDeg, 0)
    if (Math.abs(Math.abs(total) - 360) > 40) continue
    // Straight legs between turns must be 5-60 s each.
    let okLegs = true
    for (let m = 0; m < 3; m++) {
      const legS = samples[grp[m + 1].startIdx].point.tsUnix - samples[grp[m].endIdx].point.tsUnix
      if (legS < 5 || legS > 90) { okLegs = false; break }
    }
    if (!okLegs) continue

    const lo = grp[0].startIdx
    const hi = grp[3].endIdx
    const totalDurS = samples[hi].point.tsUnix - samples[lo].point.tsUnix
    if (totalDurS > 600) continue

    // AGL: median over the maneuver.
    const agls = []
    for (let m = lo; m <= hi; m++) {
      const { airport } = nearestAirport(samples[m].point.lat, samples[m].point.lon, { maxNm: 50 })
      const a = airport ? samples[m].point.altMslFt - airport.fieldElevFt : samples[m].point.altMslFt
      agls.push(a)
    }
    const aglMed = agls.sort((a, b) => a - b)[Math.floor(agls.length / 2)]
    if (aglMed < 400 || aglMed > 1500) continue

    out.push(makeDetection('rectangular_course', samples, lo, hi, 0.75,
      `4 ${dir > 0 ? 'right' : 'left'}-hand ~${Math.abs(total / 4) | 0}° turns totaling ${Math.abs(total) | 0}°, AGL ${aglMed | 0} ft, ${(totalDurS / 60).toFixed(1)} min`,
      { totalTurnDeg: total, aglFt: aglMed, direction: dir > 0 ? 'right' : 'left',
        turnDeltas: grp.map(t => t.deltaDeg | 0) }))
    k += 3   // don't double-count overlapping
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

// ── ACS IX.B Emergency Approach and Landing (simulated) ──────────────────
//
// Per FAA ACS IX.B: pilot establishes best-glide speed, looks for a
// suitable off-airport field, and flies a simulated power-off approach
// (does not actually land).
//
// Track signature:
//   - Sustained descent (VS < -300 fpm) starting from MODERATE AGL
//     (typically 1500-4000 ft AGL — training is done above safe
//     glide altitude)
//   - Descent terminates AWAY from any airport (> 3 nm from any
//     known field) below ~800 ft AGL, then power is restored and
//     the aircraft climbs back out.
//   - Energy signature: speed roughly stable (or trending toward
//     ~65 kts for a piston single = best glide), VS strongly
//     negative. Total mechanical energy
//       E = 0.5 * V² + g * h
//     decays at a rate consistent with drag-only descent
//     (~3-5 kts equivalent altitude per second).
//
// We approximate "found a field" by: the lowest AGL fix during the
// descent occurred MORE than 3 nm from any known airport AND was
// followed by a sustained climb (VS > +300 fpm for 30+ s).
//
// Cannot perfectly distinguish a TRUE emergency from an INTENTIONAL
// simulation. Both look the same from track. We label the detection
// as a CANDIDATE for IX.B with low-to-medium confidence; the operator
// can correlate with no_emergency_radio_call / no_actual_landing.
export function detectEmergencyApproach(samples) {
  const out = []
  if (samples.length < 30) return out

  for (let i = 0; i < samples.length; i++) {
    // Find start of a sustained descent.
    if (samples[i].isSessionBreak) continue
    if (samples[i].vsFpm > -300) continue
    let j = i
    while (j + 1 < samples.length
        && !samples[j + 1].isSessionBreak
        && samples[j + 1].vsFpm <= -100) j++
    const durS = samples[j].point.tsUnix - samples[i].point.tsUnix
    if (durS < 60) { i = j + 1; continue }

    // Endpoint AGL — must be < 800 AND > 3 nm from any airport.
    const endPoint = samples[j].point
    const apEnd = nearestAirport(endPoint.lat, endPoint.lon, { maxNm: 50 })
    if (!apEnd.airport) { i = j + 1; continue }
    const aglEnd = endPoint.altMslFt - apEnd.airport.fieldElevFt
    if (aglEnd > 800 || apEnd.distanceNm < 3) { i = j + 1; continue }

    // Recovery: VS > +300 fpm sustained 30+ s within the next 90 s.
    let k = j + 1
    let recoveryStart = -1
    while (k < samples.length && samples[k].point.tsUnix - samples[j].point.tsUnix < 90) {
      if (!samples[k].isSessionBreak && samples[k].vsFpm > 300) {
        // Check sustained.
        let m = k
        while (m + 1 < samples.length
            && !samples[m + 1].isSessionBreak
            && samples[m + 1].vsFpm > 100
            && samples[m + 1].point.tsUnix - samples[k].point.tsUnix < 60) m++
        if (samples[m].point.tsUnix - samples[k].point.tsUnix >= 30) {
          recoveryStart = k
          break
        }
      }
      k++
    }
    if (recoveryStart < 0) { i = j + 1; continue }

    // Energy-loss sanity check: speed stable within ±20 kts (no rapid
    // deceleration that would indicate a different maneuver).
    const gsList = []
    for (let m = i; m <= j; m++) gsList.push(samples[m].gsKts)
    const gsRange = Math.max(...gsList) - Math.min(...gsList)
    if (gsRange > 50) { i = j + 1; continue }

    const altLost = samples[i].point.altMslFt - samples[j].point.altMslFt
    const meanVs = (samples[j].point.altMslFt - samples[i].point.altMslFt) / durS * 60
    const conf = Math.min(0.85,
      0.4
      + 0.2 * Math.min(1, altLost / 2000)
      + 0.15 * (apEnd.distanceNm > 5 ? 1 : 0)
      + 0.10 * (gsRange < 25 ? 1 : 0))
    out.push(makeDetection('emergency_approach_landing', samples, i, j, conf,
      `descent ${meanVs.toFixed(0)} fpm to ${aglEnd | 0} ft AGL, ${apEnd.distanceNm.toFixed(1)} nm from ${apEnd.airport.icao}, gs range ${gsRange | 0} kts, recovered to climb`,
      { altLostFt: altLost, endAglFt: aglEnd, distFromAirportNm: apEnd.distanceNm,
        gsRangeKts: gsRange, recoveryStartIdx: recoveryStart }))
    i = recoveryStart
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
    return { samples: [], phaseLabels: [], detections: [], throttleSeries: [] }
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
  acsDetections.push(...detectEmergencyApproach(samples))

  // Per-sample throttle (first-class sortie field per main API). Attach
  // mean-throttle and pre-event-throttle to every detection's evidence
  // so selectors and gates can be driven by power, not just kinematics.
  const throttleSeries = estimateThrottleSeries(samples, typeCode)

  const merged = [...phaseDetections, ...acsDetections].sort((a, b) => a.startTs - b.startTs)
  for (const det of merged) {
    const meanT = meanThrottle(throttleSeries, det.startIdx, det.endIdx)
    if (meanT != null) {
      det.evidence = det.evidence || {}
      det.evidence.meanThrottle = Math.round(meanT * 1000) / 1000
      // Pre-event throttle (5 s window before startIdx) — useful for
      // distinguishing power-on vs power-off stalls.
      let preLo = det.startIdx - 1
      while (preLo > 0 && samples[det.startIdx].point.tsUnix - samples[preLo].point.tsUnix < 5) preLo--
      const preT = meanThrottle(throttleSeries, preLo, det.startIdx - 1)
      if (preT != null) det.evidence.preEventThrottle = Math.round(preT * 1000) / 1000
    }
  }
  return { samples, phaseLabels, detections: merged, throttleSeries }
}
