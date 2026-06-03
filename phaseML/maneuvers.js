// maneuvers.js — geometric detectors for in-flight maneuvers.
//
// Each detector is a pure function:
//   detect<Name>(samples, [typeCode]) -> Detection[]
//
// Detection shape:
//   {
//     type:            string,        // one of the maneuver names below
//     startIdx, endIdx, startTs, endTs, durationS,
//     confidence:      number,        // 0-1
//     explanation:     string,        // one-line human summary
//     evidence:        object,        // structured "why this fired"
//   }
//
// Maneuvers covered (drawn from the FAA Airman Certification Standards plus a
// few real-world signatures):
//   steep_turn, s_turns_across_road, turn_around_a_point,
//   chandelle, lazy_8, slow_flight, stall_recovery, emergency_descent,
//   holding_pattern, touch_and_go, landed_full_stop, thermalling,
//   sightseeing_orbit.
//
// detectTouchAndGo emits two types: 'touch_and_go' or 'landed_full_stop'
// based on the post-touchdown outcome. See README for the verdict cues.
//
// Port of phase-ml/phase_ml/maneuvers.py.

import {
  bankAngleDegFromTurnRate,
  centroidLatLon,
  cumulativeAbsTurnDeg,
  cumulativeSignedTurnDeg,
  DEG_TO_RAD,
  haversineNm,
  orbitRadiusNm,
  percentile,
  signedHeadingChange,
  std,
  xyNmToLatLon,
} from './geometry.js'
import { nearestAirport } from './airports.js'
import {
  countSignReversals,
  MAX_SAMPLE_GAP_S,
  mergeAdjacent,
  sliceMetrics,
  walkBackWithin,
  walkForwardWithin,
} from './features.js'

// ── Shared helpers ──────────────────────────────────────────────────────

function makeDetection(type, samples, lo, hi, confidence, explanation, evidence) {
  return {
    type,
    startIdx: lo, endIdx: hi,
    startTs: samples[lo].point.tsUnix,
    endTs: samples[hi].point.tsUnix,
    durationS: samples[hi].point.tsUnix - samples[lo].point.tsUnix,
    confidence,
    explanation,
    evidence,
  }
}

function windowedIndices(samples, targetDurationS) {
  const n = samples.length
  if (n < 2) return []
  const out = []
  let start = 0
  for (let end = 1; end < n; end++) {
    while (samples[end].point.tsUnix - samples[start].point.tsUnix > targetDurationS * 1.5) {
      start++
    }
    if (samples[end].point.tsUnix - samples[start].point.tsUnix >= targetDurationS) {
      out.push([start, end])
    }
  }
  return out
}

// ── 1. Steep turn ───────────────────────────────────────────────────────

const STEEP_TURN_CFG = {
  minBankDeg: 45,
  minSignedTurnDeg: 270,
  maxAltRangeFt: 200,
  minDurationS: 15,
  // ACS V.A Steep Turns is a deliberate ONE-OFF maneuver exited
  // to wings-level cruise. Thermalling gliders do continuous
  // same-direction 360°s — without this gate, every thermal lap
  // fires steep_turn.
  //
  // Discriminating check: by the END of the post-maneuver window,
  // is the aircraft actually rolled out? Give the pilot up to
  // rolloutTransitionS seconds to recover from steep bank to
  // level. Then over the next rolloutCheckWindowS seconds, the
  // bank must stay below rolloutMaxBankDeg. Thermalling never
  // satisfies this — it stays at 30-45° bank continuously.
  //
  // Pre-rollin check intentionally omitted: a pilot's clearing
  // turn before a V.A demo can leave moderate residual bank and
  // we don't want to reject those.
  rolloutTransitionS: 5,       // allow this much "rolling out" time
  rolloutCheckWindowS: 10,     // then bank must stay low for this long
  rolloutMaxBankDeg: 20,
  rolloutMinDataS: 8,          // need at least this much post-window data total
}

// Helper: max implied bank over a sample range.
function maxBankOverRange(samples, lo, hi) {
  let mx = 0
  for (let k = lo; k <= hi && k < samples.length; k++) {
    if (k < 0) continue
    if (samples[k].isSessionBreak) continue
    const b = bankAngleDegFromTurnRate(samples[k].turnRateDps, samples[k].gsKts)
    if (b > mx) mx = b
  }
  return mx
}

// Helper: collect the index range [windowStart..windowEnd] inclusive
// covering `targetS` seconds before `idx` (`dir=-1`) or after
// (`dir=+1`), capped at the captured-slice edges.
function rangeAround(samples, idx, targetS, dir) {
  let k = idx
  while (k + dir >= 0 && k + dir < samples.length) {
    const next = samples[k + dir]
    if (next.isSessionBreak) break
    const dt = Math.abs(next.point.tsUnix - samples[idx].point.tsUnix)
    if (dt > targetS) break
    k += dir
  }
  return dir < 0 ? [k, idx - 1] : [idx + 1, k]
}

export function detectSteepTurn(samples, cfg = STEEP_TURN_CFG) {
  const n = samples.length
  if (n < 5) return []
  const out = []
  let i = 0
  while (i < n - 1) {
    const bankNow = bankAngleDegFromTurnRate(samples[i].turnRateDps, samples[i].gsKts)
    if (bankNow < cfg.minBankDeg) { i++; continue }
    const sign = samples[i].turnRateDps > 0 ? 1 : -1
    let j = i
    while (j + 1 < n) {
      const nx = samples[j + 1]
      const bank = bankAngleDegFromTurnRate(nx.turnRateDps, nx.gsKts)
      const sameDir = nx.turnRateDps * sign > 0
      if (bank < cfg.minBankDeg * 0.7 || !sameDir) break
      j++
    }
    if (j === i) { i++; continue }
    const m = sliceMetrics(samples, i, j)
    if (m.durationS >= cfg.minDurationS
        && Math.abs(m.signedTurnTotalDeg) >= cfg.minSignedTurnDeg
        && m.altRange <= cfg.maxAltRangeFt) {
      // Post-rollout level-flight check. Skip the first
      // rolloutTransitionS seconds (pilot rolling out from steep
      // bank) and require the bank to stay low for the next
      // rolloutCheckWindowS seconds. Thermalling never satisfies
      // this — it stays at 30-45° bank continuously.
      //
      // When there isn't enough post-window data (turn at end of
      // captured slice), we conservatively SKIP the check rather
      // than reject — better to admit a maybe-V.A than drop a real
      // one because the track happened to end mid-rollout.
      let postOk = true
      let postBankAfterRollout = 0
      // Find the first sample whose ts is ≥ samples[j].ts + transition.
      let checkStart = -1
      for (let k = j + 1; k < n; k++) {
        if (samples[k].isSessionBreak) break
        if (samples[k].point.tsUnix - samples[j].point.tsUnix >= cfg.rolloutTransitionS) {
          checkStart = k; break
        }
      }
      if (checkStart >= 0) {
        // Find the last sample within rolloutCheckWindowS of checkStart.
        let checkEnd = checkStart
        while (checkEnd + 1 < n
            && !samples[checkEnd + 1].isSessionBreak
            && samples[checkEnd + 1].point.tsUnix - samples[checkStart].point.tsUnix < cfg.rolloutCheckWindowS) {
          checkEnd++
        }
        const haveS = samples[checkEnd].point.tsUnix - samples[j].point.tsUnix
        if (haveS >= cfg.rolloutMinDataS) {
          postBankAfterRollout = maxBankOverRange(samples, checkStart, checkEnd)
          postOk = postBankAfterRollout <= cfg.rolloutMaxBankDeg
        }
        // Else: not enough data after rollout transition to enforce;
        // skip the check (give benefit of the doubt).
      }
      if (!postOk) { i = j + 1; continue }

      const conf = Math.min(1, 0.55
        + 0.15 * Math.min(1, Math.abs(m.signedTurnTotalDeg) / 540)
        + 0.15 * (1 - Math.min(1, m.altRange / cfg.maxAltRangeFt))
        + 0.15 * Math.min(1, m.durationS / 45))
      const direction = sign > 0 ? 'right' : 'left'
      let maxBank = 0
      for (let k = i; k <= j; k++) {
        maxBank = Math.max(maxBank, bankAngleDegFromTurnRate(samples[k].turnRateDps, samples[k].gsKts))
      }
      out.push(makeDetection('steep_turn', samples, i, j, conf,
        `sustained ${direction} turn, ~${Math.abs(m.signedTurnTotalDeg).toFixed(0)}° in ${m.durationS.toFixed(0)}s, alt range ${m.altRange.toFixed(0)} ft, post-rollout bank ${postBankAfterRollout | 0}°`,
        { ...m, direction, maxBankImpliedDeg: maxBank, postRolloutBankDeg: postBankAfterRollout }))
    }
    i = j + 1
  }
  return mergeAdjacent(out)
}

// ── 2. S-turns across a road ────────────────────────────────────────────

const S_TURN_CFG = {
  minSignReversals: 2,
  minPerLegTurnDeg: 100,
  maxAltRangeFt: 250,
  minDurationS: 45,
}

export function detectSTurns(samples, cfg = S_TURN_CFG) {
  const n = samples.length
  if (n < 10) return []
  // Find contiguous same-sign turn legs.
  const legs = []
  let legStart = 0
  let legSign = 0
  let legTotal = 0
  for (let i = 1; i < n; i++) {
    const delta = signedHeadingChange(samples[i - 1].trackDeg, samples[i].trackDeg)
    const curSign = delta > 0.5 ? 1 : (delta < -0.5 ? -1 : legSign)
    if (curSign !== 0 && curSign !== legSign && legSign !== 0) {
      legs.push([legStart, i - 1, legTotal])
      legStart = i - 1
      legSign = curSign
      legTotal = delta
    } else {
      legTotal += delta
      if (curSign !== 0) legSign = curSign
    }
  }
  if (legSign !== 0) legs.push([legStart, n - 1, legTotal])

  const out = []
  for (let startLeg = 0; startLeg < legs.length - cfg.minSignReversals; startLeg++) {
    const run = legs.slice(startLeg, startLeg + cfg.minSignReversals + 1)
    if (!run.every(L => Math.abs(L[2]) >= cfg.minPerLegTurnDeg)) continue
    const signs = run.map(L => L[2] > 0 ? 1 : -1)
    let alternating = true
    for (let k = 1; k < signs.length; k++) {
      if (signs[k] === signs[k - 1]) { alternating = false; break }
    }
    if (!alternating) continue
    const i0 = run[0][0], iN = run[run.length - 1][1]
    const m = sliceMetrics(samples, i0, iN)
    if (m.durationS < cfg.minDurationS || m.altRange > cfg.maxAltRangeFt) continue
    const legStrs = run.map(L => `${L[2] >= 0 ? '+' : ''}${L[2].toFixed(0)}°`).join(', ')
    const conf = Math.min(1, 0.5
      + 0.1 * run.length
      + 0.2 * (1 - Math.min(1, m.altRange / cfg.maxAltRangeFt))
      + 0.1 * Math.min(1, m.durationS / 120))
    out.push(makeDetection('s_turns_across_road', samples, i0, iN, conf,
      `${run.length} alternating legs (${legStrs}), level within ${m.altRange.toFixed(0)} ft`,
      { ...m, legs: run.map(L => ({ start: L[0], end: L[1], signedDeg: L[2] })) }))
  }
  return mergeAdjacent(out, { gapS: 30 })
}

// ── 3. Turn around a point ──────────────────────────────────────────────

const TAP_CFG = {
  minSignedTurnDeg: 360,
  maxAltRangeFt: 200,
  minDurationS: 30,
  maxCentreSpreadNm: 0.2,
}

export function detectTurnAroundPoint(samples, cfg = TAP_CFG) {
  const n = samples.length
  if (n < 10) return []
  const out = []
  let i = 0
  while (i < n - 1) {
    if (Math.abs(samples[i].turnRateDps) < 1) { i++; continue }
    const sign = samples[i].turnRateDps > 0 ? 1 : -1
    let j = i
    while (j + 1 < n) {
      const nx = samples[j + 1]
      if (nx.turnRateDps * sign <= 0 || Math.abs(nx.turnRateDps) < 0.5) break
      j++
    }
    if (j - i < 5) { i++; continue }
    const m = sliceMetrics(samples, i, j)
    if (m.durationS < cfg.minDurationS
        || Math.abs(m.signedTurnTotalDeg) < cfg.minSignedTurnDeg
        || m.altRange > cfg.maxAltRangeFt) {
      i = j + 1; continue
    }
    const centres = estimateOrbitCentres(samples, i, j)
    if (!centres.length) { i = j + 1; continue }
    const c = centroidLatLon(centres)
    let spread = 0
    for (const ce of centres) {
      spread = Math.max(spread, haversineNm(ce.lat, ce.lon, c.lat, c.lon))
    }
    if (spread > cfg.maxCentreSpreadNm) { i = j + 1; continue }
    let radiusSum = 0
    for (let k = i; k <= j; k++) {
      radiusSum += haversineNm(samples[k].point.lat, samples[k].point.lon, c.lat, c.lon)
    }
    const radius = radiusSum / (j - i + 1)
    const conf = Math.min(1, 0.55
      + 0.2 * (1 - Math.min(1, spread / cfg.maxCentreSpreadNm))
      + 0.15 * Math.min(1, Math.abs(m.signedTurnTotalDeg) / 540)
      + 0.10 * (1 - Math.min(1, m.altRange / cfg.maxAltRangeFt)))
    out.push(makeDetection('turn_around_a_point', samples, i, j, conf,
      `orbit at (${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}), radius ~${radius.toFixed(2)} nm, centre spread ${(spread * 6076).toFixed(0)} ft`,
      { ...m, centreLat: c.lat, centreLon: c.lon, radiusNm: radius, centreSpreadNm: spread }))
    i = j + 1
  }
  return mergeAdjacent(out)
}

function estimateOrbitCentres(samples, lo, hi) {
  const out = []
  for (let k = lo; k <= hi; k++) {
    const s = samples[k]
    if (Math.abs(s.turnRateDps) < 0.5 || s.gsKts < 5) continue
    const radiusNm = orbitRadiusNm(s.turnRateDps, s.gsKts)
    if (!isFinite(radiusNm) || radiusNm > 5) continue
    const perp = s.trackDeg + (s.turnRateDps > 0 ? 90 : -90)
    const perpRad = perp * DEG_TO_RAD
    const xOff = Math.sin(perpRad) * radiusNm
    const yOff = Math.cos(perpRad) * radiusNm
    out.push(xyNmToLatLon(xOff, yOff, s.point.lat, s.point.lon))
  }
  return out
}

// ── 4. Chandelle ────────────────────────────────────────────────────────

const CHANDELLE_CFG = {
  targetTurnDeg: 180,
  turnToleranceDeg: 35,
  minClimbFpm: 300,
  minDurationS: 25,
  maxDurationS: 120,
  minGsDropKts: 8,
}

export function detectChandelle(samples, cfg = CHANDELLE_CFG) {
  const out = []
  for (const [lo, hi] of windowedIndices(samples, cfg.minDurationS)) {
    const m = sliceMetrics(samples, lo, hi)
    if (m.durationS > cfg.maxDurationS) continue
    if (Math.abs(m.signedTurnTotalDeg - 180) > cfg.turnToleranceDeg
        && Math.abs(m.signedTurnTotalDeg + 180) > cfg.turnToleranceDeg) continue
    if (m.vsMean < cfg.minClimbFpm) continue
    const gsDrop = samples[lo].gsKts - samples[hi].gsKts
    if (gsDrop < cfg.minGsDropKts) continue
    let climbCount = 0
    for (let k = lo; k <= hi; k++) if (samples[k].vsFpm > 100) climbCount++
    const climbFrac = climbCount / (hi - lo + 1)
    if (climbFrac < 0.65) continue
    const conf = Math.min(1, 0.45
      + 0.20 * climbFrac
      + 0.20 * (1 - Math.min(1, Math.abs(Math.abs(m.signedTurnTotalDeg) - 180) / cfg.turnToleranceDeg))
      + 0.15 * Math.min(1, gsDrop / 30))
    out.push(makeDetection('chandelle', samples, lo, hi, conf,
      `180°-ish climbing turn (${m.signedTurnTotalDeg >= 0 ? '+' : ''}${m.signedTurnTotalDeg.toFixed(0)}°), climbed ${(m.altEnd - m.altStart).toFixed(0)} ft, lost ${gsDrop.toFixed(0)} kt`,
      { ...m, gsDropKts: gsDrop, climbFraction: climbFrac }))
  }
  return mergeAdjacent(out)
}

// ── 5. Lazy 8 ───────────────────────────────────────────────────────────

const LAZY8_CFG = {
  minAltSwingFt: 400,
  minDurationS: 60,
  maxDurationS: 180,
  minSignReversals: 1,
  minPerLobeTurnDeg: 120,
}

export function detectLazy8(samples, cfg = LAZY8_CFG) {
  const out = []
  for (const [lo, hi] of windowedIndices(samples, cfg.minDurationS)) {
    const m = sliceMetrics(samples, lo, hi)
    if (m.durationS > cfg.maxDurationS || m.altRange < cfg.minAltSwingFt) continue
    const trSlice = samples.slice(lo, hi + 1).map(s => s.turnRateDps)
    const reversals = countSignReversals(trSlice, 2)
    if (reversals < cfg.minSignReversals) continue
    const lobes = splitIntoTurnLobes(samples, lo, hi)
    if (lobes.length < 2 || !lobes.slice(0, 2).every(L => Math.abs(L.signedDeg) >= cfg.minPerLobeTurnDeg)) continue
    const alts = samples.slice(lo, hi + 1).map(s => s.point.altMslFt)
    if (!hasClimbThenDive(alts, cfg.minAltSwingFt)) continue
    const minLobeAbs = Math.min(...lobes.slice(0, 2).map(L => Math.abs(L.signedDeg)))
    const conf = Math.min(1, 0.40
      + 0.15 * Math.min(1, reversals / 2)
      + 0.20 * Math.min(1, m.altRange / 800)
      + 0.15 * Math.min(1, minLobeAbs / 180))
    out.push(makeDetection('lazy_8', samples, lo, hi, conf,
      `${reversals} reversal(s), ${m.altRange.toFixed(0)} ft swing, lobes ${Math.abs(lobes[0].signedDeg).toFixed(0)}°/${Math.abs(lobes[1].signedDeg).toFixed(0)}°`,
      { ...m, reversals, lobes: lobes.slice(0, 4) }))
  }
  return mergeAdjacent(out, { gapS: 20 })
}

function splitIntoTurnLobes(samples, lo, hi) {
  const out = []
  let sign = 0
  let segStart = lo
  let segTotal = 0
  for (let i = lo + 1; i <= hi; i++) {
    const delta = signedHeadingChange(samples[i - 1].trackDeg, samples[i].trackDeg)
    const newSign = delta > 0.5 ? 1 : (delta < -0.5 ? -1 : sign)
    if (newSign !== 0 && newSign !== sign && sign !== 0) {
      out.push({ start: segStart, end: i - 1, signedDeg: segTotal })
      segStart = i - 1
      segTotal = delta
    } else {
      segTotal += delta
    }
    if (newSign !== 0) sign = newSign
  }
  out.push({ start: segStart, end: hi, signedDeg: segTotal })
  return out
}

function hasClimbThenDive(alt, minSwing) {
  if (alt.length < 5) return false
  let peakIdx = 0, troughIdx = 0
  for (let i = 1; i < alt.length; i++) {
    if (alt[i] > alt[peakIdx]) peakIdx = i
    if (alt[i] < alt[troughIdx]) troughIdx = i
  }
  const rise = alt[peakIdx] - alt[0]
  const fall = alt[peakIdx] - alt[alt.length - 1]
  if (rise >= minSwing / 2 && fall >= minSwing / 2) return true
  const drop = alt[0] - alt[troughIdx]
  const recover = alt[alt.length - 1] - alt[troughIdx]
  if (drop >= minSwing / 2 && recover >= minSwing / 2) return true
  return false
}

// ── 6. Slow flight ──────────────────────────────────────────────────────

export const CRUISE_KTS_BY_TYPE = {
  C172: 110, C150: 90, C152: 95, C162: 95, C170: 100,
  P28A: 110, P28R: 130, P28T: 140,
  DA40: 130, DA20: 110,
  SR20: 140, SR22: 165,
  M20J: 150, M20P: 145,
  BE58: 180, PA44: 150, DA42: 165,
  PC12: 250, TBM7: 280, TBM8: 290, TBM9: 320,
  C25A: 360, C25B: 380, C25C: 400, CL30: 400, LJ40: 420,
  R44: 100, R22: 90, B06: 110,
  GLID: 50, AS21: 50, AS25: 50, DG30: 55, DG40: 55,
}
const DEFAULT_CRUISE_KTS = 110

const SLOW_FLIGHT_CFG = {
  fractionOfCruise: 0.55,
  minDurationS: 30,
  maxAltRangeFt: 400,
  minDistFromRunwayNm: 2,
  minTurnRatePeakDps: 1,
}

export function detectSlowFlight(samples, typeCode = '', cfg = SLOW_FLIGHT_CFG) {
  const cruise = CRUISE_KTS_BY_TYPE[String(typeCode || '').toUpperCase()] || DEFAULT_CRUISE_KTS
  const threshold = cruise * cfg.fractionOfCruise
  const n = samples.length
  const out = []
  let i = 0
  while (i < n) {
    if (samples[i].gsKts > threshold) { i++; continue }
    let j = i
    while (j + 1 < n && samples[j + 1].gsKts <= threshold * 1.05) j++
    if (j === i) { i++; continue }
    const m = sliceMetrics(samples, i, j)
    if (m.durationS < cfg.minDurationS || m.altRange > cfg.maxAltRangeFt) { i = j + 1; continue }
    const mid = samples[(i + j) >> 1].point
    const { airport, distanceNm } = nearestAirport(mid.lat, mid.lon)
    if (airport && distanceNm < cfg.minDistFromRunwayNm) { i = j + 1; continue }
    if (m.turnRateP90 < cfg.minTurnRatePeakDps) { i = j + 1; continue }
    const conf = Math.min(1, 0.5
      + 0.20 * Math.min(1, m.durationS / 120)
      + 0.15 * (1 - Math.min(1, m.altRange / cfg.maxAltRangeFt))
      + 0.15 * Math.min(1, (threshold - m.gsMean) / threshold))
    out.push(makeDetection('slow_flight', samples, i, j, conf,
      `GS ${m.gsMean.toFixed(0)} kt (cruise est ${cruise} kt), ${m.durationS.toFixed(0)}s, alt range ${m.altRange.toFixed(0)} ft`,
      { ...m, cruiseKtsEst: cruise, thresholdKts: threshold, distFromNearestAirportNm: distanceNm }))
    i = j + 1
  }
  return mergeAdjacent(out)
}

// ── 7. Stall recovery ───────────────────────────────────────────────────

const STALL_CFG = {
  minDropFpm: -1200,
  minRecoveryFpm: -200,
  preLowGsKts: 70,
  preWindowS: 12,
  breakWindowS: 8,
  recoveryWindowS: 15,
}

export function detectStallRecovery(samples, typeCode = '', cfg = STALL_CFG) {
  const cruise = CRUISE_KTS_BY_TYPE[String(typeCode || '').toUpperCase()] || DEFAULT_CRUISE_KTS
  const lowThreshold = Math.max(cfg.preLowGsKts, cruise * 0.55)
  const n = samples.length
  const out = []
  for (let i = 2; i < n - 3; i++) {
    if (samples[i].vsFpm > cfg.minDropFpm) continue
    let preStart = i
    while (preStart > 0 && samples[i].point.tsUnix - samples[preStart].point.tsUnix < cfg.preWindowS) preStart--
    let lowOk = true
    for (let k = preStart; k < i; k++) if (samples[k].gsKts >= lowThreshold) { lowOk = false; break }
    if (!lowOk) continue
    let breakEnd = i
    while (breakEnd + 1 < n && samples[breakEnd + 1].point.tsUnix - samples[i].point.tsUnix < cfg.breakWindowS) {
      if (samples[breakEnd + 1].vsFpm > cfg.minRecoveryFpm) break
      breakEnd++
    }
    if (breakEnd === i) continue
    let recEnd = breakEnd
    while (recEnd + 1 < n && samples[recEnd + 1].point.tsUnix - samples[breakEnd].point.tsUnix < cfg.recoveryWindowS) {
      recEnd++
    }
    if (recEnd === breakEnd) continue
    if (samples[recEnd].vsFpm <= cfg.minRecoveryFpm) continue
    const m = sliceMetrics(samples, preStart, recEnd)
    const conf = Math.min(1, 0.55
      + 0.20 * Math.min(1, Math.abs(samples[i].vsFpm) / 2500)
      + 0.15 * (1 - Math.min(1, samples[preStart].gsKts / lowThreshold)))
    out.push(makeDetection('stall_recovery', samples, preStart, recEnd, conf,
      `setup GS ${samples[preStart].gsKts.toFixed(0)} kt → break vs ${samples[i].vsFpm.toFixed(0)} fpm → recovered to ${samples[recEnd].vsFpm.toFixed(0)} fpm`,
      { ...m, breakVsFpm: samples[i].vsFpm, lowGsThresholdKts: lowThreshold }))
  }
  return mergeAdjacent(out, { gapS: 20 })
}

// ── 8. Emergency descent ────────────────────────────────────────────────

const ED_CFG = {
  maxVsFpm: -1200,
  minAltLostFt: 1200,
  minDurationS: 30,
  // ACS IX.A Emergency Descent is a TRAINING maneuver: enter from
  // cruise altitude, lose altitude rapidly, then RECOVER to
  // controlled flight (not continue to landing). Three discriminators
  // to separate it from the false positives that previously dominated:
  //
  //   1. minStartAglFt — must START from cruise altitude. Tow planes
  //      release at 2000-3000 AGL then dive; that's not IX.A.
  //   2. recovery requirement — after the descent, VS must recover
  //      to > recoveryVsFpm sustained for recoveryHoldS seconds.
  //      Airlines/jets descending into KDEN never recover — they
  //      keep descending all the way to the runway.
  //   3. maxEndAglFt — end of the descent should still be above the
  //      ground (training recovery happens above traffic pattern).
  minStartAglFt: 4000,
  recoveryVsFpm: -500,
  recoveryHoldS: 30,
  recoveryWindowS: 120,        // look this far past end of descent
  maxEndAglFt: 5000,           // recovery alt should be reasonable
}

export function detectEmergencyDescent(samples, cfg = ED_CFG) {
  const n = samples.length
  const out = []
  let i = 0
  while (i < n) {
    if (samples[i].vsFpm > cfg.maxVsFpm) { i++; continue }
    let j = i
    while (j + 1 < n && samples[j + 1].vsFpm <= cfg.maxVsFpm * 0.7) j++
    if (j === i) { i++; continue }
    const m = sliceMetrics(samples, i, j)
    const altLost = m.altStart - m.altEnd
    if (m.durationS < cfg.minDurationS || altLost < cfg.minAltLostFt) { i = j + 1; continue }

    // Start-from-cruise gate. Use nearest airport at the START of
    // the descent to compute AGL. If no airport within 50 nm we
    // skip the check (rare for our coverage area).
    const startPt = samples[i].point
    const apStart = nearestAirport(startPt.lat, startPt.lon, { maxNm: 50 })
    let startAglFt = null
    if (apStart.airport) {
      startAglFt = startPt.altMslFt - apStart.airport.fieldElevFt
      if (startAglFt < cfg.minStartAglFt) { i = j + 1; continue }
    }

    // Recovery gate. After the descent ends at index j, search up to
    // recoveryWindowS for a sustained run where VS > recoveryVsFpm
    // for at least recoveryHoldS. If no recovery is observed, this
    // is a continued descent (airliner approach, tow descent) — not
    // an emergency descent.
    let recoveryStart = -1
    let recoveryEnd = -1
    for (let k = j + 1; k < n; k++) {
      if (samples[k].isSessionBreak) break
      if (samples[k].point.tsUnix - samples[j].point.tsUnix > cfg.recoveryWindowS) break
      if (samples[k].vsFpm <= cfg.recoveryVsFpm) { recoveryStart = -1; continue }
      if (recoveryStart < 0) recoveryStart = k
      const heldS = samples[k].point.tsUnix - samples[recoveryStart].point.tsUnix
      if (heldS >= cfg.recoveryHoldS) { recoveryEnd = k; break }
    }
    if (recoveryEnd < 0) { i = j + 1; continue }

    // End-of-descent AGL gate. The recovery point should still be
    // above some reasonable altitude (training recovery happens
    // above traffic pattern altitude, ~1000 AGL minimum).
    const endPt = samples[j].point
    const apEnd = nearestAirport(endPt.lat, endPt.lon, { maxNm: 50 })
    if (apEnd.airport) {
      const endAglFt = endPt.altMslFt - apEnd.airport.fieldElevFt
      if (endAglFt > cfg.maxEndAglFt || endAglFt < 500) { i = j + 1; continue }
    }

    const spiraling = Math.abs(m.signedTurnTotalDeg) > 120
    const conf = Math.min(1, 0.50
      + 0.20 * Math.min(1, altLost / 4000)
      + 0.15 * (spiraling ? 1 : 0)
      + 0.15 * Math.min(1, m.durationS / 90))
    const expl = `vs ${m.vsMean.toFixed(0)} fpm avg, lost ${altLost.toFixed(0)} ft in ${m.durationS.toFixed(0)}s`
      + (startAglFt != null ? `, from ${startAglFt | 0} AGL` : '')
      + `, recovered to ${samples[recoveryEnd].vsFpm.toFixed(0)} fpm`
      + (spiraling ? `, spiraled ${m.signedTurnTotalDeg >= 0 ? '+' : ''}${m.signedTurnTotalDeg.toFixed(0)}°` : '')
    out.push(makeDetection('emergency_descent', samples, i, j, conf, expl,
      { ...m, altLostFt: altLost, spiraling, startAglFt }))
    i = recoveryEnd
  }
  return mergeAdjacent(out)
}

// ── 9. Holding pattern ──────────────────────────────────────────────────

const HOLDING_CFG = {
  legMinS: 30,
  legMaxS: 120,
  turnTargetDeg: 180,
  turnToleranceDeg: 35,
  maxAltRangeFt: 200,
  minDurationS: 180,
  maxDurationS: 600,
  maxTurnPhases: 6,
  turnPhaseThresholdDps: 3,
}

export function detectHoldingPattern(samples, cfg = HOLDING_CFG) {
  const out = []
  for (const [lo, hi] of windowedIndices(samples, cfg.minDurationS)) {
    const m = sliceMetrics(samples, lo, hi)
    if (m.durationS > cfg.maxDurationS || m.altRange > cfg.maxAltRangeFt) continue
    const signed = m.signedTurnTotalDeg
    if (!(Math.abs(signed) >= 300 && Math.abs(signed) <= 420)) continue
    const phases = classifyPhases(samples.slice(lo, hi + 1).map(s => s.turnRateDps), cfg.turnPhaseThresholdDps)
    const nTurns = phases.filter(p => p.kind === 'turn').length
    const nStraights = phases.filter(p => p.kind === 'straight').length
    if (nTurns < 2 || nTurns > cfg.maxTurnPhases || nStraights < 1) continue
    const straightDurations = []
    for (const p of phases) {
      if (p.kind !== 'straight') continue
      straightDurations.push(samples[lo + p.end].point.tsUnix - samples[lo + p.start].point.tsUnix)
    }
    if (!straightDurations.some(d => d >= cfg.legMinS && d <= cfg.legMaxS)) continue
    const conf = Math.min(1, 0.45
      + 0.20 * Math.min(1, nTurns / 4)
      + 0.20 * (1 - Math.min(1, m.altRange / cfg.maxAltRangeFt))
      + 0.15 * Math.min(1, m.durationS / 360))
    out.push(makeDetection('holding_pattern', samples, lo, hi, conf,
      `${nTurns} 180° turn(s) + ${nStraights} leg(s), signed turn ${signed >= 0 ? '+' : ''}${signed.toFixed(0)}°`,
      { ...m, nTurns, nStraights, straightDurationsS: straightDurations }))
  }
  return mergeAdjacent(out, { gapS: 120 })
}

function classifyPhases(turnRate, threshold) {
  const out = []
  if (!turnRate.length) return out
  let curKind = Math.abs(turnRate[0]) > threshold ? 'turn' : 'straight'
  let start = 0
  for (let i = 1; i < turnRate.length; i++) {
    const kind = Math.abs(turnRate[i]) > threshold ? 'turn' : 'straight'
    if (kind !== curKind) {
      out.push({ kind: curKind, start, end: i - 1 })
      start = i
      curKind = kind
    }
  }
  out.push({ kind: curKind, start, end: turnRate.length - 1 })
  return out
}

// ── 10. Landing events (touch_and_go vs landed_full_stop) ───────────────

const TG_CFG = {
  maxTouchdownAglFt: 100,
  maxTouchdownDistNm: 1,
  minDescentBeforeFpm: -200,
  minClimbAfterFpm: 400,
  touchdownWindowS: 20,
  surroundingWindowS: 60,
  impliedMaxPreAglFt: 800,
  impliedMaxPostAglFt: 1500,
  impliedMaxDistNm: 2,
  impliedMinGapS: 30,
  impliedMaxGapS: 15 * 60,
  impliedMinPreDescentFpm: -200,
  impliedMinPostClimbFpm: 200,
  outcomeWindowS: 180,
  taxiGsKts: 25,
  taxiSustainedS: 20,
  silenceThenFullStopS: 5 * 60,
}

/**
 * Classify a touchdown's outcome by looking forward — T&G vs FULL_STOP.
 * Returns { verdict, confidence, evidence }.
 *
 * Two cues we rely on (from real ADS-B behaviour at low altitude):
 *   1. Sustained taxi-speed sample after touchdown → FULL_STOP
 *   2. Long silence / track end / no climbout → FULL_STOP
 *   3. Climbout within the outcome window → T&G
 */
function classifyTouchdownOutcome(samples, touchdownIdx, airport, cfg) {
  const n = samples.length
  const s0 = samples[touchdownIdx]
  const deadline = s0.point.tsUnix + cfg.outcomeWindowS

  let sustainedTaxiS = 0
  // null = no post-touchdown sample at the airport has been seen yet. We
  // explicitly avoid a numeric sentinel so it can't leak into explanations.
  let maxPostVs = null
  let lastIdx = touchdownIdx
  let silenceRunS = 0

  for (let k = touchdownIdx + 1; k < n; k++) {
    const s = samples[k]
    if (s.point.tsUnix > deadline) break
    const dtStep = s.point.tsUnix - samples[k - 1].point.tsUnix
    if (dtStep > 60) silenceRunS = Math.max(silenceRunS, dtStep)
    const { airport: ap, distanceNm: dist } = nearestAirport(s.point.lat, s.point.lon)
    if (!ap || ap.icao !== airport.icao || dist > cfg.impliedMaxDistNm) continue
    const agl = s.point.altMslFt - airport.fieldElevFt
    if (s.gsKts < cfg.taxiGsKts && agl < 200) {
      sustainedTaxiS += s.dtS > 0 ? s.dtS : 2
    } else {
      sustainedTaxiS = 0
    }
    if (maxPostVs === null || s.vsFpm > maxPostVs) maxPostVs = s.vsFpm
    lastIdx = k
    if (sustainedTaxiS >= cfg.taxiSustainedS) {
      return {
        verdict: 'landed_full_stop',
        confidence: 0.85,
        evidence: {
          decisionCue: 'sustained_taxi',
          taxiSeconds: sustainedTaxiS,
          maxPostVsFpm: maxPostVs,
          airport: airport.icao,
        },
      }
    }
  }

  const noClimbout = maxPostVs === null || maxPostVs < cfg.minClimbAfterFpm

  if (lastIdx >= n - 1 && noClimbout) {
    return {
      verdict: 'landed_full_stop',
      confidence: 0.7,
      evidence: { decisionCue: 'track_ended_at_airport', maxPostVsFpm: maxPostVs, airport: airport.icao },
    }
  }
  if (silenceRunS >= cfg.silenceThenFullStopS && noClimbout) {
    return {
      verdict: 'landed_full_stop',
      confidence: 0.75,
      evidence: { decisionCue: 'long_silence_no_climbout', silenceS: silenceRunS, maxPostVsFpm: maxPostVs, airport: airport.icao },
    }
  }
  if (maxPostVs !== null && maxPostVs >= cfg.minClimbAfterFpm) {
    return {
      verdict: 'touch_and_go',
      confidence: 0.8,
      evidence: { decisionCue: 'climbout_within_window', maxPostVsFpm: maxPostVs, airport: airport.icao },
    }
  }
  return {
    verdict: 'touch_and_go',
    confidence: 0.45,
    evidence: { decisionCue: 'indeterminate', maxPostVsFpm: maxPostVs, airport: airport.icao },
  }
}

/**
 * Find landing events at known fields. Two branches:
 *   - explicit: a local AGL minimum below maxTouchdownAglFt within 1 nm of a field
 *   - implied:  an ADS-B gap bounded by descend-to-airport / still-at-airport
 *
 * Each detection's `type` is either 'touch_and_go' or 'landed_full_stop' as
 * determined by classifyTouchdownOutcome.
 */
export function detectTouchAndGo(samples, cfg = TG_CFG) {
  const n = samples.length
  if (n < 5) return []
  // Annotate each sample with (airport, agl, dist).
  const annot = new Array(n)
  for (let i = 0; i < n; i++) {
    const s = samples[i]
    const { airport, distanceNm } = nearestAirport(s.point.lat, s.point.lon)
    if (!airport || distanceNm > cfg.maxTouchdownDistNm) {
      annot[i] = { icao: null, agl: Infinity, dist: Infinity, airport: null }
    } else {
      annot[i] = {
        icao: airport.icao,
        agl: s.point.altMslFt - airport.fieldElevFt,
        dist: distanceNm,
        airport,
      }
    }
  }

  const out = []
  let lastEmitTs = -1e18
  let i = 1
  while (i < n - 1) {
    const a = annot[i]
    if (!a.icao || a.agl > cfg.maxTouchdownAglFt) { i++; continue }
    // Walk forward while AGL strictly decreasing — find the local minimum.
    let j = i
    while (j + 1 < n
        && annot[j + 1].icao === a.icao
        && annot[j + 1].agl < annot[j].agl - 0.5) j++
    if (samples[j].point.tsUnix - lastEmitTs < cfg.surroundingWindowS) { i = j + 1; continue }
    const aglMin = annot[j].agl
    if (aglMin > cfg.maxTouchdownAglFt) { i = j + 1; continue }
    const preLo = walkBackWithin(samples, j, cfg.surroundingWindowS)
    const postHi = walkForwardWithin(samples, j, cfg.surroundingWindowS)
    const preVs = samples.slice(preLo, j).map(x => x.vsFpm)
    if (!preVs.length || Math.min(...preVs) > cfg.minDescentBeforeFpm) { i = j + 1; continue }
    const { verdict, confidence: vConf, evidence: vEv } = classifyTouchdownOutcome(samples, j, annot[j].airport, cfg)
    const m = sliceMetrics(samples, preLo, postHi)
    const geomConf = Math.min(1, 0.4
      + 0.20 * Math.min(1, Math.abs(Math.min(...preVs)) / 800)
      + 0.15 * (1 - Math.min(1, aglMin / cfg.maxTouchdownAglFt)))
    const conf = (geomConf + vConf) / 2
    let postSummary
    if (verdict === 'touch_and_go') {
      postSummary = vEv.decisionCue === 'climbout_within_window' && vEv.maxPostVsFpm != null
        ? `climb-out ${vEv.maxPostVsFpm.toFixed(0)} fpm`
        : `indeterminate (no post-touchdown data at ${a.icao})`
    } else {
      postSummary = `FULL_STOP (${vEv.decisionCue ?? '?'})`
    }
    out.push({
      type: verdict,
      startIdx: preLo, endIdx: postHi,
      startTs: samples[preLo].point.tsUnix, endTs: samples[postHi].point.tsUnix,
      durationS: samples[postHi].point.tsUnix - samples[preLo].point.tsUnix,
      confidence: conf,
      explanation: `touchdown at ${a.icao} (${aglMin.toFixed(0)} AGL), descent ${Math.min(...preVs).toFixed(0)} → ${postSummary}`,
      evidence: { ...m, airport: a.icao, minAglFt: aglMin, preMinVs: Math.min(...preVs), ...vEv },
    })
    lastEmitTs = samples[j].point.tsUnix
    i = postHi + 1
  }

  // Implied branch — scan session breaks.
  out.push(...detectImpliedTouchdowns(samples, cfg, cfg.surroundingWindowS, out))
  out.sort((a, b) => a.startTs - b.startTs)
  return out
}

function detectImpliedTouchdowns(samples, cfg, suppressWithinS, existing) {
  const n = samples.length
  if (n < 2) return []
  const overlapsExisting = ts => {
    for (const d of existing) {
      if (Math.abs(d.startTs - ts) < suppressWithinS) return true
      if (d.startTs <= ts && ts <= d.endTs) return true
    }
    return false
  }
  const out = []
  for (let i = 1; i < n; i++) {
    const gap = samples[i].point.tsUnix - samples[i - 1].point.tsUnix
    if (gap <= cfg.impliedMinGapS || gap > cfg.impliedMaxGapS) continue
    const pre = samples[i - 1].point
    const post = samples[i].point
    const apPreRes = nearestAirport(pre.lat, pre.lon)
    const apPostRes = nearestAirport(post.lat, post.lon)
    if (!apPreRes.airport || !apPostRes.airport || apPreRes.airport.icao !== apPostRes.airport.icao) continue
    if (apPreRes.distanceNm > cfg.impliedMaxDistNm || apPostRes.distanceNm > cfg.impliedMaxDistNm) continue
    const aglPre = pre.altMslFt - apPreRes.airport.fieldElevFt
    const aglPost = post.altMslFt - apPostRes.airport.fieldElevFt
    if (aglPre > cfg.impliedMaxPreAglFt || aglPost > cfg.impliedMaxPostAglFt) continue
    const preVsWindow = samples.slice(Math.max(0, i - 5), i).filter(s => s.dtS > 0).map(s => s.vsFpm)
    if (!preVsWindow.length || Math.min(...preVsWindow) > cfg.impliedMinPreDescentFpm) continue
    const midTs = (pre.tsUnix + post.tsUnix) / 2
    if (overlapsExisting(midTs)) continue
    const { verdict, confidence: vConf, evidence: vEv } = classifyTouchdownOutcome(samples, i, apPostRes.airport, cfg)
    const geomConf = Math.min(1, 0.4
      + 0.10 * (1 - Math.min(1, aglPre / cfg.impliedMaxPreAglFt))
      + 0.10 * (1 - Math.min(1, aglPost / cfg.impliedMaxPostAglFt))
      + 0.15 * Math.min(1, Math.abs(samples[i - 1].vsFpm) / 800))
    const conf = (geomConf + vConf) / 2
    out.push({
      type: verdict,
      startIdx: i - 1, endIdx: i,
      startTs: pre.tsUnix, endTs: post.tsUnix,
      durationS: post.tsUnix - pre.tsUnix,
      confidence: conf,
      explanation:
        `IMPLIED ${verdict.toUpperCase()} at ${apPreRes.airport.icao}: ` +
        `descent ${samples[i - 1].vsFpm.toFixed(0)} fpm @ ${aglPre.toFixed(0)} AGL → ` +
        `ADS-B gap ${gap.toFixed(0)}s → cue=${vEv.decisionCue ?? '?'}`,
      evidence: {
        airport: apPreRes.airport.icao,
        gapS: gap,
        preAglFt: aglPre, postAglFt: aglPost,
        preVsFpm: samples[i - 1].vsFpm, postVsFpm: samples[i].vsFpm,
        preDistNm: apPreRes.distanceNm, postDistNm: apPostRes.distanceNm,
        implied: true,
        ...vEv,
      },
    })
  }
  return out
}

// ── 11. Thermalling ─────────────────────────────────────────────────────

const THERMAL_CFG = {
  minSignedTurnDeg: 720,
  minNetClimbFt: 300,
  minDurationS: 120,
}

export const GLIDER_TYPES = new Set([
  'GLID', 'AS21', 'AS22', 'AS25', 'AS33', 'DG30', 'DG40',
  'VENT', 'LS6', 'LS8', 'G103', 'K21',
])

export function detectThermalling(samples, typeCode = '', cfg = THERMAL_CFG) {
  if (!GLIDER_TYPES.has(String(typeCode || '').toUpperCase())) return []
  const n = samples.length
  const out = []
  let i = 0
  while (i < n - 1) {
    if (Math.abs(samples[i].turnRateDps) < 1) { i++; continue }
    const sign = samples[i].turnRateDps > 0 ? 1 : -1
    let j = i
    while (j + 1 < n) {
      const nx = samples[j + 1]
      if (nx.turnRateDps * sign <= 0 || Math.abs(nx.turnRateDps) < 0.5) {
        let gapEnd = j + 1
        while (gapEnd < n && Math.abs(samples[gapEnd].turnRateDps) < 0.5) gapEnd++
        if (gapEnd - j > 3) break
      }
      j++
    }
    if (j - i < 10) { i++; continue }
    const m = sliceMetrics(samples, i, j)
    const netClimb = m.altEnd - m.altStart
    if (Math.abs(m.signedTurnTotalDeg) < cfg.minSignedTurnDeg
        || netClimb < cfg.minNetClimbFt
        || m.durationS < cfg.minDurationS) {
      i = j + 1; continue
    }
    const conf = Math.min(1, 0.6
      + 0.20 * Math.min(1, netClimb / 2000)
      + 0.15 * Math.min(1, Math.abs(m.signedTurnTotalDeg) / 3600))
    out.push(makeDetection('thermalling', samples, i, j, conf,
      `continuous ${sign >= 0 ? '+' : '-'}-sense turn, gained ${netClimb.toFixed(0)} ft in ${m.durationS.toFixed(0)}s`,
      { ...m, netClimbFt: netClimb }))
    i = j + 1
  }
  return mergeAdjacent(out)
}

// ── 12. Sightseeing orbit ───────────────────────────────────────────────

const SS_CFG = {
  minSignedTurnDeg: 360,
  minRadiusNm: 0.3,
  maxRadiusNm: 3,
  maxAltRangeFt: 500,
  minDurationS: 90,
  minDistFromAirportNm: 3,
}

export function detectSightseeingOrbit(samples, cfg = SS_CFG) {
  const n = samples.length
  const out = []
  let i = 0
  while (i < n - 1) {
    if (Math.abs(samples[i].turnRateDps) < 0.5) { i++; continue }
    const sign = samples[i].turnRateDps > 0 ? 1 : -1
    let j = i
    while (j + 1 < n) {
      const nx = samples[j + 1]
      if (nx.turnRateDps * sign < 0 && Math.abs(nx.turnRateDps) > 0.5) break
      j++
    }
    if (j - i < 15) { i++; continue }
    const m = sliceMetrics(samples, i, j)
    if (Math.abs(m.signedTurnTotalDeg) < cfg.minSignedTurnDeg
        || m.durationS < cfg.minDurationS
        || m.altRange > cfg.maxAltRangeFt) {
      i = j + 1; continue
    }
    const mid = samples[(i + j) >> 1].point
    const { airport, distanceNm } = nearestAirport(mid.lat, mid.lon)
    if (airport && distanceNm < cfg.minDistFromAirportNm) { i = j + 1; continue }
    const radius = orbitRadiusNm(m.turnRateP90, Math.max(1, m.gsMean))
    if (!isFinite(radius) || radius < cfg.minRadiusNm || radius > cfg.maxRadiusNm) { i = j + 1; continue }
    const conf = Math.min(1, 0.55
      + 0.15 * Math.min(1, m.durationS / 360)
      + 0.15 * (1 - Math.min(1, m.altRange / cfg.maxAltRangeFt))
      + 0.10 * (distanceNm > cfg.minDistFromAirportNm ? 1 : 0))
    out.push(makeDetection('sightseeing_orbit', samples, i, j, conf,
      `~${radius.toFixed(1)} nm radius orbit, ${distanceNm.toFixed(1)} nm from ${airport ? airport.icao : 'airport'}, alt range ${m.altRange.toFixed(0)} ft`,
      { ...m, radiusNm: radius, nearestAirport: airport ? airport.icao : null, distNm: distanceNm }))
    i = j + 1
  }
  return mergeAdjacent(out, { gapS: 60 })
}

// ── Run them all ────────────────────────────────────────────────────────

export const DETECTORS = {
  steep_turn: (s) => detectSteepTurn(s),
  s_turns_across_road: (s) => detectSTurns(s),
  turn_around_a_point: (s) => detectTurnAroundPoint(s),
  chandelle: (s) => detectChandelle(s),
  lazy_8: (s) => detectLazy8(s),
  slow_flight: (s, t) => detectSlowFlight(s, t),
  stall_recovery: (s, t) => detectStallRecovery(s, t),
  emergency_descent: (s) => detectEmergencyDescent(s),
  holding_pattern: (s) => detectHoldingPattern(s),
  // emits 'touch_and_go' OR 'landed_full_stop' based on outcome
  touch_and_go_or_full_stop: (s) => detectTouchAndGo(s),
  thermalling: (s, t) => detectThermalling(s, t),
  sightseeing_orbit: (s) => detectSightseeingOrbit(s),
}

export function detectAll(samples, typeCode = '') {
  const out = []
  for (const fn of Object.values(DETECTORS)) {
    try {
      out.push(...fn(samples, typeCode))
    } catch {
      // detector errors must not crash the whole pipeline
    }
  }
  out.sort((a, b) => a.startTs - b.startTs || a.type.localeCompare(b.type))
  return out
}
