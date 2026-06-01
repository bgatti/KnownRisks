// oracle.js — rule-based phase classifier (9 labels + landed_full_stop).
//
// Port of phase-ml/phase_ml/oracle.py. Returns one label per sample. Use
// classifyTrack(...) to also overlay landed_full_stop post-hoc (it can't be
// computed from a single sample — it needs forward-looking dwell evidence).

import { angleDiffAbs, bearingDeg } from './geometry.js'
import { nearestAirport } from './airports.js'
import { enrich } from './features.js'

export const DEFAULT_CFG = {
  onGroundAglFt: 200,
  taxiAglFt: 150,
  patternDistNm: 2.5,
  patternMinAgl: 100,
  patternMaxAgl: 1500,
  practiceDistNm: [2, 8],
  practiceAgl: [200, 3000],
  departTrackOffsetDeg: 60,
  inboundTrackOffsetDeg: 40,
  inboundRangeNm: [1.5, 50],
  enRouteDistNm: 8,
}

export const LANDED_REQUIRED_GROUND_S = 30
export const LANDED_REQUIRED_DWELL_S = 300
export const LANDED_NO_NEW_TAKEOFF_S = 900

/**
 * Per-sample classification — never returns landed_full_stop (see
 * classifyTrack for that, which needs the post-hoc dwell rule).
 */
export function classifySample(sample, airport, cfg = DEFAULT_CFG) {
  const p = sample.point
  const dist = airport.distanceNm(p.lat, p.lon)
  const agl = p.altMslFt - airport.fieldElevFt
  const gs = sample.gsKts
  const vs = sample.vsFpm
  const bearingToField = bearingDeg(p.lat, p.lon, airport.lat, airport.lon)
  const trackOff = angleDiffAbs(sample.trackDeg, bearingToField)

  const out = phase => ({ phase, airport: airport.icao, distNm: dist, aglFt: agl, trackOffDeg: trackOff })

  if (gs < 30 && agl < cfg.onGroundAglFt && dist < 2) return out('on_ground')
  if (gs >= 5 && gs < 40 && agl < cfg.taxiAglFt && dist < 1.5) return out('taxiing')
  if (dist < cfg.patternDistNm && agl > cfg.patternMinAgl && agl < cfg.patternMaxAgl && gs > 40 && gs < 130) {
    return out('pattern')
  }
  if (dist > cfg.practiceDistNm[0] && dist < cfg.practiceDistNm[1]
      && agl > cfg.practiceAgl[0] && agl < cfg.practiceAgl[1]
      && trackOff > 40 && vs > -500) {
    return out('practice_area')
  }
  if (agl > 200 && vs > 200 && trackOff > cfg.departTrackOffsetDeg && dist < 15) return out('departing')
  if (trackOff < cfg.inboundTrackOffsetDeg
      && dist > cfg.inboundRangeNm[0] && dist < cfg.inboundRangeNm[1]
      && gs > 30 && vs <= 300) {
    return out('inbound')
  }
  if (dist > cfg.enRouteDistNm) return out('en_route')
  return out('nearby')
}

/**
 * Classify every sample and overlay landed_full_stop. If `airport` is null we
 * pick the nearest airport per sample.
 */
export function classifyTrack(points, airport = null, cfg = DEFAULT_CFG) {
  const samples = enrich(points)
  const labels = perSampleLabels(samples, airport, cfg)
  overlayLandedFullStop(samples, labels)
  return labels
}

function perSampleLabels(samples, airport, cfg) {
  const out = []
  for (const s of samples) {
    let ap = airport
    if (!ap) {
      const r = nearestAirport(s.point.lat, s.point.lon)
      ap = r.airport
    }
    if (!ap) {
      out.push({ phase: 'nearby', airport: null, distNm: Infinity, aglFt: s.point.altMslFt, trackOffDeg: 0 })
      continue
    }
    out.push(classifySample(s, ap, cfg))
  }
  return out
}

function overlayLandedFullStop(samples, labels) {
  const n = samples.length
  let i = 0
  while (i < n) {
    if (labels[i].phase !== 'on_ground' && labels[i].phase !== 'taxiing') { i++; continue }
    let j = i
    while (j < n && (labels[j].phase === 'on_ground' || labels[j].phase === 'taxiing')) j++
    const runStart = samples[i].point.tsUnix
    const runEnd = samples[j - 1].point.tsUnix
    const runDuration = runEnd - runStart
    if (runDuration < LANDED_REQUIRED_GROUND_S) { i = j; continue }
    const deadline = runStart + LANDED_NO_NEW_TAKEOFF_S
    let newTakeoff = false
    for (let k = j; k < n; k++) {
      if (samples[k].point.tsUnix > deadline) break
      const ph = labels[k].phase
      if (ph !== 'on_ground' && ph !== 'taxiing') { newTakeoff = true; break }
    }
    if (newTakeoff) { i = j; continue }
    const eligible = runDuration >= LANDED_REQUIRED_DWELL_S || j === n
    if (!eligible) { i = j; continue }
    for (let k = i; k < j; k++) {
      labels[k] = { ...labels[k], phase: 'landed_full_stop' }
    }
    i = j
  }
}
