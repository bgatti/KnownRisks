// features.js — windowed feature extraction.
//
// Every detector consumes either an array of `Sample`s (per-fix kinematics)
// or a `FeatureWindow` (rolled-up stats over a slice). Derivatives are
// computed locally from raw (lat, lon, alt, ts) so archived and live data
// are identical inputs.
//
// Port of phase-ml/phase_ml/features.py.

import {
  bearingDeg,
  cumulativeAbsTurnDeg,
  cumulativeSignedTurnDeg,
  haversineNm,
  haversinePathLengthNm,
  orbitRadiusNm,
  bankAngleDegFromTurnRate,
  percentile,
  signedHeadingChange,
  std,
  turnRateDegPerS,
} from './geometry.js'

// Two adjacent fixes more than this far apart in time are treated as
// different sessions (year-aggregated archives stack many flights per tail
// into one record; without this the gs derivative across an overnight gap
// can hit 50 000 kt).
export const MAX_SAMPLE_GAP_S = 120

// ── Point shape (the public input) ──────────────────────────────────────
//
// { lat: number, lon: number, altMslFt: number, tsUnix: number }   // seconds, UTC

// Helpers for the two raw shapes our archive/live feed produce.
export function pointFromArchiveTuple(tuple, t0Seconds) {
  // Archive: [lat, lon, alt_msl_ft, seconds_since_t0]
  return {
    lat: tuple[0],
    lon: tuple[1],
    altMslFt: tuple[2],
    tsUnix: t0Seconds + tuple[3],
  }
}

export function pointFromLiveRecord(rec) {
  // Live feed: { lat, lon, alt_ft, ts: ISO string | epoch ms }
  let ts = rec.ts ?? rec.tsUnix ?? rec.timestamp
  if (typeof ts === 'string') ts = Date.parse(ts) / 1000
  else if (ts > 1e12) ts = ts / 1000        // ms → s
  return {
    lat: rec.lat,
    lon: rec.lon,
    altMslFt: rec.alt_ft ?? rec.altMslFt ?? rec.alt,
    tsUnix: ts,
  }
}

// ── Per-sample enrichment ───────────────────────────────────────────────

/**
 * Compute gs/vs/track/turn_rate locally from raw points.
 *
 * Returns an array of Sample objects:
 *   {
 *     point,         // the original Point
 *     gsKts,         // smoothed ground speed
 *     vsFpm,         // smoothed vertical speed
 *     trackDeg,      // raw bearing from previous point
 *     turnRateDps,   // signed °/s, +right -left
 *     dtS,           // wall-clock dt to previous fix (0 at index 0 / session start)
 *     isSessionBreak,
 *   }
 */
export function enrich(points, { smoothN = 3 } = {}) {
  const n = points.length
  if (n === 0) return []
  const rawGs = new Array(n).fill(0)
  const rawVs = new Array(n).fill(0)
  const rawTk = new Array(n).fill(0)
  const dts = new Array(n).fill(0)
  const isBreak = new Array(n).fill(false)

  for (let i = 1; i < n; i++) {
    const prev = points[i - 1]
    const cur = points[i]
    const dt = cur.tsUnix - prev.tsUnix
    if (dt > MAX_SAMPLE_GAP_S || dt <= 0) {
      isBreak[i] = true
      dts[i] = 0
      rawGs[i] = rawGs[i - 1]
      rawVs[i] = 0
      rawTk[i] = rawTk[i - 1]
      continue
    }
    dts[i] = dt
    const dNm = haversineNm(prev.lat, prev.lon, cur.lat, cur.lon)
    rawGs[i] = (dNm / dt) * 3600
    rawVs[i] = ((cur.altMslFt - prev.altMslFt) / dt) * 60
    rawTk[i] = bearingDeg(prev.lat, prev.lon, cur.lat, cur.lon)
  }
  rawGs[0] = n > 1 ? rawGs[1] : 0
  rawVs[0] = n > 1 ? rawVs[1] : 0
  rawTk[0] = n > 1 ? rawTk[1] : 0

  const gs = smoothSkippingBreaks(rawGs, isBreak, smoothN)
  const vs = smoothSkippingBreaks(rawVs, isBreak, smoothN)

  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    const tr = (i === 0 || isBreak[i])
      ? 0
      : turnRateDegPerS(rawTk[i - 1], rawTk[i], dts[i])
    out[i] = {
      point: points[i],
      gsKts: gs[i],
      vsFpm: vs[i],
      trackDeg: rawTk[i],
      turnRateDps: tr,
      dtS: dts[i],
      isSessionBreak: isBreak[i],
    }
  }
  return out
}

// Centred moving average that does not cross a session-break boundary.
function smoothSkippingBreaks(values, breaks, n) {
  if (n <= 1) return [...values]
  const half = Math.floor(n / 2)
  const out = new Array(values.length)
  for (let i = 0; i < values.length; i++) {
    let lo = Math.max(0, i - half)
    let hi = Math.min(values.length, i + half + 1)
    for (let j = i; j >= lo; j--) {
      if (j < i && breaks[j + 1]) { lo = j + 1; break }
    }
    for (let j = i; j < hi; j++) {
      if (j > i && breaks[j]) { hi = j; break }
    }
    let sum = 0
    let count = 0
    for (let j = lo; j < hi; j++) { sum += values[j]; count++ }
    out[i] = count ? sum / count : values[i]
  }
  return out
}

// ── Windowed roll-up ────────────────────────────────────────────────────

/**
 * Build a FeatureWindow from a slice of samples. The fields mirror
 * phase_ml.features.FeatureWindow.
 */
export function buildWindow(samples) {
  const w = {
    samples,
    durationS: 0,
    trackLengthNm: 0,
    displacementNm: 0,
    sinuosity: 1,
    gsMeanKts: 0, gsMinKts: 0, gsMaxKts: 0, gsStdKts: 0,
    vsMeanFpm: 0, vsMinFpm: 0, vsMaxFpm: 0, vsStdFpm: 0,
    altStartFt: 0, altEndFt: 0, altMinFt: 0, altMaxFt: 0, altStdFt: 0,
    altitudeReversals: 0,
    trackStartDeg: 0, trackEndDeg: 0,
    absTurnTotalDeg: 0, signedTurnTotalDeg: 0,
    turnRateMaxDps: 0, turnRateP95Dps: 0, bankAngleMaxDeg: 0,
    directionReversals: 0,
    avgOrbitRadiusNm: Infinity,
    pointStart: null, pointEnd: null,
    gsSeries: [], vsSeries: [], altSeries: [], trackSeries: [], turnRateSeries: [],
  }
  const n = samples.length
  if (n === 0) return w
  w.pointStart = samples[0].point
  w.pointEnd = samples[n - 1].point
  w.durationS = samples[n - 1].point.tsUnix - samples[0].point.tsUnix

  const gs = samples.map(s => s.gsKts)
  const vs = samples.map(s => s.vsFpm)
  const alt = samples.map(s => s.point.altMslFt)
  const tk = samples.map(s => s.trackDeg)
  const tr = samples.map(s => s.turnRateDps)
  w.gsSeries = gs; w.vsSeries = vs; w.altSeries = alt
  w.trackSeries = tk; w.turnRateSeries = tr

  w.trackLengthNm = haversinePathLengthNm(samples.map(s => s.point))
  if (n >= 2) {
    w.displacementNm = haversineNm(
      samples[0].point.lat, samples[0].point.lon,
      samples[n - 1].point.lat, samples[n - 1].point.lon,
    )
  }
  w.sinuosity = w.displacementNm > 1e-6 ? w.trackLengthNm / w.displacementNm : Infinity

  w.gsMeanKts = gs.reduce((a, b) => a + b, 0) / n
  w.gsMinKts = Math.min(...gs)
  w.gsMaxKts = Math.max(...gs)
  w.gsStdKts = std(gs)
  w.vsMeanFpm = vs.reduce((a, b) => a + b, 0) / n
  w.vsMinFpm = Math.min(...vs)
  w.vsMaxFpm = Math.max(...vs)
  w.vsStdFpm = std(vs)
  w.altStartFt = alt[0]
  w.altEndFt = alt[n - 1]
  w.altMinFt = Math.min(...alt)
  w.altMaxFt = Math.max(...alt)
  w.altStdFt = std(alt)
  w.altitudeReversals = countSignReversals(vs, 100)

  w.trackStartDeg = tk[0]
  w.trackEndDeg = tk[n - 1]
  w.absTurnTotalDeg = cumulativeAbsTurnDeg(tk)
  w.signedTurnTotalDeg = cumulativeSignedTurnDeg(tk)

  const absTr = tr.map(Math.abs)
  if (absTr.length) {
    let iMax = 0
    for (let i = 1; i < n; i++) if (absTr[i] > absTr[iMax]) iMax = i
    w.turnRateMaxDps = tr[iMax]
    w.turnRateP95Dps = percentile(absTr, 0.95)
    w.bankAngleMaxDeg = bankAngleDegFromTurnRate(tr[iMax], samples[iMax].gsKts)
  }
  w.directionReversals = countSignReversals(tr, 1)
  w.avgOrbitRadiusNm = orbitRadiusNm(w.turnRateP95Dps, Math.max(1, w.gsMeanKts))
  return w
}

/**
 * Slice a track of samples into overlapping trailing windows.
 *   windowS — window length (seconds)
 *   stepS   — how far to advance between window emits
 */
export function windowTrack(samples, { windowS = 180, stepS = 30 } = {}) {
  if (samples.length < 2) return []
  const ts = samples.map(s => s.point.tsUnix)
  const out = []
  let end = 0
  let nextEmit = ts[0] + windowS
  while (end < samples.length && ts[end] < nextEmit) end++
  while (end < samples.length) {
    const targetEndTs = ts[end]
    const targetStartTs = targetEndTs - windowS
    let start = end
    while (start > 0 && ts[start - 1] >= targetStartTs) start--
    out.push(buildWindow(samples.slice(start, end + 1)))
    nextEmit += stepS
    while (end < samples.length && ts[end] < nextEmit) end++
  }
  // Always include the freshest data.
  if (!out.length || out[out.length - 1].pointEnd !== samples[samples.length - 1].point) {
    const targetEndTs = ts[ts.length - 1]
    const targetStartTs = targetEndTs - windowS
    let start = samples.length - 1
    while (start > 0 && ts[start - 1] >= targetStartTs) start--
    out.push(buildWindow(samples.slice(start)))
  }
  return out
}

// ── Helpers exposed for detectors ───────────────────────────────────────

export function countSignReversals(values, threshold) {
  let sign = 0
  let count = 0
  for (const v of values) {
    let next
    if (v > threshold) next = 1
    else if (v < -threshold) next = -1
    else continue
    if (sign !== 0 && next !== sign) count++
    sign = next
  }
  return count
}

// Slice metrics — what most detectors need.
export function sliceMetrics(samples, lo, hi) {
  const slice = samples.slice(lo, hi + 1)
  const n = slice.length
  const gs = slice.map(s => s.gsKts)
  const vs = slice.map(s => s.vsFpm)
  const alt = slice.map(s => s.point.altMslFt)
  const tk = slice.map(s => s.trackDeg)
  const tr = slice.map(s => s.turnRateDps)
  return {
    n,
    durationS: slice[n - 1].point.tsUnix - slice[0].point.tsUnix,
    gsMean: gs.reduce((a, b) => a + b, 0) / n,
    gsMin: Math.min(...gs), gsMax: Math.max(...gs), gsStd: std(gs),
    vsMean: vs.reduce((a, b) => a + b, 0) / n,
    vsMin: Math.min(...vs), vsMax: Math.max(...vs), vsStd: std(vs),
    altStart: alt[0], altEnd: alt[n - 1],
    altMin: Math.min(...alt), altMax: Math.max(...alt),
    altRange: Math.max(...alt) - Math.min(...alt),
    altStd: std(alt),
    absTurnTotalDeg: cumulativeAbsTurnDeg(tk),
    signedTurnTotalDeg: cumulativeSignedTurnDeg(tk),
    turnRateMean: tr.reduce((a, b) => a + b, 0) / n,
    turnRateAbsMean: tr.reduce((a, b) => a + Math.abs(b), 0) / n,
    turnRateP90: percentile(tr.map(Math.abs), 0.9),
    trackStart: tk[0], trackEnd: tk[n - 1],
  }
}

export function mergeAdjacent(detections, { gapS = 10 } = {}) {
  if (!detections.length) return []
  const sorted = [...detections].sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type)
    return a.startTs - b.startTs
  })
  const out = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i]
    const prev = out[out.length - 1]
    if (d.type === prev.type && d.startTs - prev.endTs <= gapS) {
      out[out.length - 1] = {
        type: prev.type,
        startIdx: prev.startIdx,
        endIdx: d.endIdx,
        startTs: prev.startTs,
        endTs: Math.max(prev.endTs, d.endTs),
        confidence: Math.max(prev.confidence, d.confidence),
        explanation: prev.explanation,
        evidence: { ...prev.evidence, ...d.evidence, merged: true },
      }
    } else {
      out.push(d)
    }
  }
  return out
}

// Walk back/forward respecting session-break boundaries.
export function walkBackWithin(samples, originIdx, maxS) {
  let out = originIdx
  while (out > 0) {
    const prevDt = samples[out].point.tsUnix - samples[out - 1].point.tsUnix
    if (prevDt > MAX_SAMPLE_GAP_S || prevDt <= 0) break
    if (samples[originIdx].point.tsUnix - samples[out - 1].point.tsUnix >= maxS) break
    out--
  }
  return out
}

export function walkForwardWithin(samples, originIdx, maxS) {
  let out = originIdx
  const n = samples.length
  while (out + 1 < n) {
    const nextDt = samples[out + 1].point.tsUnix - samples[out].point.tsUnix
    if (nextDt > MAX_SAMPLE_GAP_S || nextDt <= 0) break
    if (samples[out + 1].point.tsUnix - samples[originIdx].point.tsUnix >= maxS) break
    out++
  }
  return out
}
