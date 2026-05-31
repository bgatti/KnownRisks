// intent.js — multi-airport inbound predictor.
//
// Score each candidate airport on closure × heading × runway × energy ×
// corridor, normalise across all candidates plus a transit hypothesis, and
// return a ranked posterior. Port of phase-ml/phase_ml/intent.py.

import { allAirports, candidateAirports, runwayFrameFor } from './airports.js'
import { angleDiffAbs, bearingDeg, haversineNm } from './geometry.js'
import { buildWindow } from './features.js'

function closureScore(fw, ap) {
  if (!fw.samples || fw.samples.length < 2) return { score: 0, closurePct: 0 }
  const start = fw.samples[0].point
  const end = fw.samples[fw.samples.length - 1].point
  const dStart = haversineNm(start.lat, start.lon, ap.lat, ap.lon)
  const dEnd = haversineNm(end.lat, end.lon, ap.lat, ap.lon)
  const dtS = end.tsUnix - start.tsUnix
  if (dtS <= 0) return { score: 0, closurePct: 0 }
  const closureNmMin = ((dStart - dEnd) / dtS) * 60
  const gsNmMin = Math.max(0.1, fw.gsMeanKts / 60)
  const closurePct = closureNmMin / gsNmMin
  const score = 1 / (1 + Math.exp(-6 * (closurePct - 0.30)))
  return { score, closurePct }
}

function headingAlignmentScore(fw, ap) {
  if (!fw.samples || !fw.samples.length) return { score: 0, deltaDeg: 180 }
  const end = fw.samples[fw.samples.length - 1].point
  const track = fw.trackEndDeg
  const dist = ap.distanceNm(end.lat, end.lon)
  const bearing = bearingDeg(end.lat, end.lon, ap.lat, ap.lon)
  const delta = angleDiffAbs(track, bearing)
  const geoScore = Math.exp(-((delta / 30) ** 2))
  const taper = Math.min(1, dist / 2)
  const score = taper * geoScore + (1 - taper) * 0.6
  return { score, deltaDeg: delta }
}

function runwayAlignmentScore(fw, ap) {
  if (!fw.samples || !fw.samples.length || !ap.runways.length) {
    return { score: 0, deltaDeg: 180, runwayName: null }
  }
  const end = fw.samples[fw.samples.length - 1].point
  const dist = ap.distanceNm(end.lat, end.lon)
  if (dist > 12) return { score: 0.5, deltaDeg: 180, runwayName: null }
  const track = fw.trackEndDeg
  let bestDelta = 180
  let bestName = null
  for (const rw of ap.runways) {
    const d = angleDiffAbs(track, rw.headingDeg)
    if (d < bestDelta) { bestDelta = d; bestName = rw.name }
  }
  return { score: Math.exp(-((bestDelta / 25) ** 2)), deltaDeg: bestDelta, runwayName: bestName }
}

function energyMatchScore(fw, ap) {
  if (!fw.samples || !fw.samples.length) return { score: 0, agl: 0, targetAgl: 0 }
  const end = fw.samples[fw.samples.length - 1].point
  const agl = end.altMslFt - ap.fieldElevFt
  const dist = ap.distanceNm(end.lat, end.lon)
  const targetAgl = Math.max(ap.tpaAglFt(), dist * 318)
  const diff = agl - targetAgl
  const score = 1 / (1 + Math.exp(0.003 * (diff - 500)))
  return { score, agl, targetAgl }
}

function corridorScore(fw, ap) {
  if (!fw.samples || !fw.samples.length || !ap.runways.length) {
    return { score: 0.2, name: 'none' }
  }
  const end = fw.samples[fw.samples.length - 1].point
  let best = 0.2
  let bestName = 'none'
  for (const rw of ap.runways) {
    const frame = runwayFrameFor(ap, rw)
    const { alongNm, crossNm } = frame.project(end.lat, end.lon)
    if (alongNm > -8 && alongNm < -0.5 && Math.abs(crossNm) < 0.7) {
      const score = Math.exp(-((Math.abs(crossNm) / 0.5) ** 2))
      if (score > best) { best = score; bestName = `straight_in_${rw.name}` }
    }
    const agl = end.altMslFt - ap.fieldElevFt
    if (Math.abs(agl - ap.tpaAglFt()) < 400
        && Math.abs(crossNm) > 1
        && Math.abs(crossNm) < 2.5
        && alongNm > -2 && alongNm < 3) {
      const score = Math.exp(-(((Math.abs(crossNm) - 1.5) / 1) ** 2))
      if (score > best) { best = score; bestName = `45_downwind_${rw.name}` }
    }
  }
  const dist = ap.distanceNm(end.lat, end.lon)
  const agl = end.altMslFt - ap.fieldElevFt
  if (dist < 8 && agl > ap.tpaAglFt() + 1500) {
    const score = 0.6
    if (score > best) { best = score; bestName = 'above_corridor' }
  }
  return { score: best, name: bestName }
}

/**
 * Predict the posterior over candidate airports + a transit hypothesis.
 *
 * @param input  a FeatureWindow or an array of samples (will be windowed)
 * @param opts.candidateAirports  explicit list (default: airports within maxCandidateNm of position)
 * @param opts.maxCandidateNm     default 50
 * @param opts.priorByAirport     { ICAO: multiplier }  — e.g. { KBDU: 2 } to bias the aircraft's base
 * @param opts.transitFloor       baseline 'transit' score (default 0.10)
 */
export function predictIntent(input, {
  candidateAirports: explicitCands,
  maxCandidateNm = 50,
  priorByAirport = null,
  transitFloor = 0.1,
} = {}) {
  const fw = Array.isArray(input) ? buildWindow(input) : input
  if (!fw.samples || !fw.samples.length) return []
  const end = fw.samples[fw.samples.length - 1].point
  const cands = explicitCands
    ? explicitCands
    : candidateAirports(end.lat, end.lon, { maxNm: maxCandidateNm }).map(c => c.airport)

  const scores = []
  const rawScores = []
  for (const ap of cands) {
    const cs = closureScore(fw, ap)
    const hs = headingAlignmentScore(fw, ap)
    const rs = runwayAlignmentScore(fw, ap)
    const es = energyMatchScore(fw, ap)
    const co = corridorScore(fw, ap)
    let raw = cs.score * hs.score * rs.score * es.score * co.score
    if (priorByAirport && priorByAirport[ap.icao]) raw *= priorByAirport[ap.icao]
    const dist = ap.distanceNm(end.lat, end.lon)
    const bearing = bearingDeg(end.lat, end.lon, ap.lat, ap.lon)
    scores.push({
      airport: ap.icao,
      runway: rs.runwayName,
      probability: 0,
      scoreRaw: raw,
      closureScore: cs.score,
      headingScore: hs.score,
      runwayScore: rs.score,
      energyScore: es.score,
      corridorScore: co.name,
      corridorScoreVal: co.score,
      distanceNm: dist,
      bearingToFieldDeg: bearing,
      explanation:
        `dist=${dist.toFixed(1)} nm ` +
        `closure=${(cs.closurePct * 100 >= 0 ? '+' : '')}${(cs.closurePct * 100).toFixed(0)}% ` +
        `Δhead=${hs.deltaDeg.toFixed(0)}° ` +
        `runway_off=${rs.deltaDeg.toFixed(0)}° (best ${rs.runwayName || 'n/a'}) ` +
        `AGL=${es.agl.toFixed(0)}/profile=${es.targetAgl.toFixed(0)} ` +
        `corridor=${co.name}`,
    })
    rawScores.push(raw)
  }

  const transitRaw = Math.max(transitFloor, rawScores.length ? Math.max(...rawScores) * 0.5 : transitFloor)
  const transit = {
    airport: null,
    runway: null,
    probability: 0,
    scoreRaw: transitRaw,
    closureScore: 0, headingScore: 0, runwayScore: 0, energyScore: 0,
    corridorScore: 'transit', corridorScoreVal: transitRaw,
    distanceNm: 0, bearingToFieldDeg: 0,
    explanation: 'no airport hypothesis matched well',
  }

  const total = scores.reduce((a, s) => a + s.scoreRaw, 0) + transit.scoreRaw
  if (total > 0) {
    for (const s of scores) s.probability = s.scoreRaw / total
    transit.probability = transit.scoreRaw / total
  }
  return [...scores, transit].sort((a, b) => b.probability - a.probability)
}

/**
 * Convenience wrapper — returns { top, runnerUp, confidenceGap, allScores }.
 */
export function summarise(input, opts) {
  const scores = predictIntent(input, opts)
  if (!scores.length) {
    const empty = {
      airport: null, runway: null, probability: 0, scoreRaw: 0,
      closureScore: 0, headingScore: 0, runwayScore: 0, energyScore: 0,
      corridorScore: 'none', corridorScoreVal: 0,
      distanceNm: 0, bearingToFieldDeg: 0, explanation: 'no data',
    }
    return { top: empty, runnerUp: null, confidenceGap: 0, allScores: [] }
  }
  const top = scores[0]
  const ru = scores.length > 1 ? scores[1] : null
  return {
    top,
    runnerUp: ru,
    confidenceGap: top.probability - (ru ? ru.probability : 0),
    allScores: scores,
  }
}
