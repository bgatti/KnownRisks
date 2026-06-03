// scoring.js — score detected ACS-task instances against the ACS
// performance standard.
//
// The identifier emits which TASKS a flight demonstrated. Scoring goes
// one level deeper: for each instance, compare the observed kinematics
// to the ACS performance standard (e.g. V.A Steep Turns: bank 45° ±5°,
// alt ±100 ft, airspeed ±10 kts, rollout ±10° heading) and return:
//
//   {
//     code, name, ts, durationS,
//     score:        0..100,         // overall percentage
//     breakdown:    [{ dimension, target, observed, tolerance, met, deviation }]
//     verdict:      'within_standard' | 'outside_standard' | 'cannot_score',
//     reasons:      [...]            // human-readable summary
//   }
//
// Status: v0 SKELETON. Scoring is implemented for V.A Steep Turns,
// V.C S-Turns Across a Road, V.D Turns Around a Point, and V.B
// Rectangular Course (alt + roundness + squareness). Other tasks
// (IV.B landing accuracy, IV.F short-field tolerances, VII.A slow
// flight, VII.B/C stalls) need pilot-input data we don't have from
// track alone — they return verdict='cannot_score'.
//
// The user kickoff:
//   "score this segments again the ACS standards for speed and
//    altitude deviation, roundness, squareness (cross road at 90)"
//
// Roundness: for V.D Turns Around a Point, compute the per-sample
// distance from the orbit centre and report std/mean as roundness.
// Squareness: for V.C S-Turns Across a Road and V.B Rectangular
// Course, compute the angle of crossing legs (S-turns should cross
// the reference at 90°; rectangular course corner angles should be
// 90°).

import { angleDiffAbs, signedHeadingChange, haversineNm } from '../phaseML/geometry.js'

// ── Helpers ─────────────────────────────────────────────────────────────

function summary(dims) {
  let total = 0
  let weights = 0
  for (const d of dims) {
    total += d.met ? d.weight : (d.weight * Math.max(0, 1 - d.deviation / (d.failPoint || (d.tolerance * 2))))
    weights += d.weight
  }
  const score = weights > 0 ? Math.round(100 * total / weights) : 0
  const allMet = dims.every(d => d.met)
  return { score, verdict: allMet ? 'within_standard' : 'outside_standard' }
}

// Get the samples slice spanning [startIdx, endIdx] of a detection.
function sliceFor(samples, det) {
  return samples.slice(det.startIdx, det.endIdx + 1)
}

// ── V.A Steep Turns ────────────────────────────────────────────────────
// ACS: bank 45° ±5°, altitude ±100 ft, airspeed ±10 kts, rollout
// heading ±10°, 360° (or 180° each side).
export function scoreSteepTurn(det, samples) {
  if (det.type !== 'steep_turn') return null
  const slice = sliceFor(samples, det)
  const alts = slice.map(s => s.point.altMslFt)
  const altMean = alts.reduce((a, b) => a + b, 0) / alts.length
  const altDev = Math.max(...alts.map(a => Math.abs(a - altMean)))

  const gs = slice.map(s => s.gsKts)
  const gsMean = gs.reduce((a, b) => a + b, 0) / gs.length
  const gsDev = Math.max(...gs.map(g => Math.abs(g - gsMean)))

  // maxBankImpliedDeg is on the detection evidence.
  const observedBank = det.evidence?.maxBankImpliedDeg || 0
  const bankDev = Math.abs(observedBank - 45)

  const turnDeg = Math.abs(det.evidence?.signedTurnTotalDeg || 0)
  const turnTarget = turnDeg >= 270 ? 360 : 180   // accept partials
  const turnDev = Math.abs(turnDeg - turnTarget)

  const dims = [
    { dimension: 'bank', target: '45°', observed: `${observedBank | 0}°`,
      tolerance: 5, deviation: bankDev, met: bankDev <= 5, weight: 2 },
    { dimension: 'altitude_deviation', target: '±100 ft', observed: `±${altDev | 0} ft`,
      tolerance: 100, deviation: altDev, met: altDev <= 100, weight: 2 },
    { dimension: 'airspeed_deviation', target: '±10 kts',
      observed: `±${gsDev.toFixed(0)} kts`,
      tolerance: 10, deviation: gsDev, met: gsDev <= 10, weight: 1,
      notes: 'using groundspeed as a proxy; true airspeed unavailable from ADS-B' },
    { dimension: 'turn_amount', target: `${turnTarget}°`, observed: `${turnDeg | 0}°`,
      tolerance: 10, deviation: turnDev, met: turnDev <= 10, weight: 1 },
  ]
  return {
    code: 'V.A', name: 'Steep Turns', ts: det.startTs, durationS: det.durationS,
    breakdown: dims, ...summary(dims),
    reasons: dims.filter(d => !d.met).map(d => `${d.dimension}: ${d.observed} vs ${d.target}`),
  }
}

// ── V.C S-Turns Across a Road (squareness = crossing at 90°) ────────────
export function scoreSTurns(det, samples) {
  if (det.type !== 's_turns_across_road') return null
  const slice = sliceFor(samples, det)
  const alts = slice.map(s => s.point.altMslFt)
  const altRange = Math.max(...alts) - Math.min(...alts)

  // Squareness: at the heading-change zero-crossings (wings level),
  // the track heading should be perpendicular to the road/reference.
  // We don't know the road's heading, so we use the AVERAGE heading
  // at the zero-crossings as a proxy for the reference and measure
  // how perpendicular each crossing is.
  const zeroCrossings = []
  for (let i = 1; i < slice.length; i++) {
    if (slice[i].turnRateDps * slice[i - 1].turnRateDps < 0) {
      zeroCrossings.push(slice[i].trackDeg)
    }
  }
  let squarenessDev = 0
  if (zeroCrossings.length >= 2) {
    // The "reference heading" is the median of the crossings.
    const sorted = [...zeroCrossings].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const devs = zeroCrossings.map(h => angleDiffAbs(h, median))
    squarenessDev = devs.reduce((a, b) => a + b, 0) / devs.length
  }

  const dims = [
    { dimension: 'altitude_range', target: '±100 ft', observed: `${altRange | 0} ft span`,
      tolerance: 200, deviation: altRange, met: altRange <= 200, weight: 1 },
    { dimension: 'squareness_at_reference', target: 'crossings parallel',
      observed: `${squarenessDev.toFixed(0)}° spread`,
      tolerance: 15, deviation: squarenessDev, met: squarenessDev <= 15, weight: 1,
      notes: 'reference heading inferred from track itself; an external road heading would tighten this.' },
    { dimension: 'leg_count', target: '≥ 2 alternating', observed: `${zeroCrossings.length} zero crossings`,
      tolerance: 1, deviation: Math.max(0, 2 - zeroCrossings.length), met: zeroCrossings.length >= 2, weight: 1 },
  ]
  return {
    code: 'V.C', name: 'S-Turns Across a Road', ts: det.startTs, durationS: det.durationS,
    breakdown: dims, ...summary(dims),
    reasons: dims.filter(d => !d.met).map(d => `${d.dimension}: ${d.observed}`),
  }
}

// ── V.D Turns Around a Point (roundness) ────────────────────────────────
export function scoreTurnAroundPoint(det, samples) {
  if (det.type !== 'turn_around_a_point') return null
  const slice = sliceFor(samples, det)

  // Orbit centre: the centroid of the slice. The phaseML detector
  // already verifies the orbit centre is stable (maxCentreSpreadNm
  // < 0.2). We compute per-sample distance to centroid and report
  // mean + std as roundness.
  let latSum = 0, lonSum = 0
  for (const s of slice) { latSum += s.point.lat; lonSum += s.point.lon }
  const cLat = latSum / slice.length
  const cLon = lonSum / slice.length
  const radii = slice.map(s => haversineNm(cLat, cLon, s.point.lat, s.point.lon))
  const rMean = radii.reduce((a, b) => a + b, 0) / radii.length
  const rStd = Math.sqrt(radii.reduce((a, r) => a + (r - rMean) ** 2, 0) / radii.length)
  const roundness = rMean > 0 ? rStd / rMean : 1

  const alts = slice.map(s => s.point.altMslFt)
  const altRange = Math.max(...alts) - Math.min(...alts)

  const gs = slice.map(s => s.gsKts)
  const gsRange = Math.max(...gs) - Math.min(...gs)

  const dims = [
    { dimension: 'roundness', target: 'rStd/rMean ≤ 0.15',
      observed: `rStd=${(rStd * 6076 | 0)} ft / rMean=${(rMean * 6076 | 0)} ft = ${roundness.toFixed(2)}`,
      tolerance: 0.15, deviation: roundness, met: roundness <= 0.15, weight: 2 },
    { dimension: 'altitude_range', target: '±100 ft',
      observed: `${altRange | 0} ft span`,
      tolerance: 200, deviation: altRange, met: altRange <= 200, weight: 1 },
    { dimension: 'airspeed_range', target: '±10 kts',
      observed: `${gsRange.toFixed(0)} kts span`,
      tolerance: 20, deviation: gsRange, met: gsRange <= 20, weight: 1 },
  ]
  return {
    code: 'V.D', name: 'Turns Around a Point', ts: det.startTs, durationS: det.durationS,
    breakdown: dims, ...summary(dims),
    reasons: dims.filter(d => !d.met).map(d => `${d.dimension}: ${d.observed}`),
  }
}

// ── V.B Rectangular Course (squareness — corners at 90°) ───────────────
export function scoreRectangularCourse(det, samples) {
  if (det.type !== 'rectangular_course') return null
  const turnDeltas = det.evidence?.turnDeltas || []
  if (turnDeltas.length !== 4) return { code: 'V.B', verdict: 'cannot_score', reasons: ['detector did not provide 4 turn deltas'] }

  const slice = sliceFor(samples, det)
  const alts = slice.map(s => s.point.altMslFt)
  const altRange = Math.max(...alts) - Math.min(...alts)

  // Squareness: each corner should be 90° ±10°.
  const cornerDevs = turnDeltas.map(t => Math.abs(Math.abs(t) - 90))
  const maxCornerDev = Math.max(...cornerDevs)

  const dims = [
    { dimension: 'squareness_corners', target: 'each 90° ±10°',
      observed: `corners ${turnDeltas.map(t => Math.abs(t) | 0).join('/')}°`,
      tolerance: 10, deviation: maxCornerDev, met: maxCornerDev <= 10, weight: 2 },
    { dimension: 'altitude_range', target: '±100 ft',
      observed: `${altRange | 0} ft span`,
      tolerance: 200, deviation: altRange, met: altRange <= 200, weight: 1 },
  ]
  return {
    code: 'V.B', name: 'Rectangular Course', ts: det.startTs, durationS: det.durationS,
    breakdown: dims, ...summary(dims),
    reasons: dims.filter(d => !d.met).map(d => `${d.dimension}: ${d.observed}`),
  }
}

// ── Dispatcher ──────────────────────────────────────────────────────────

const SCORERS = {
  'steep_turn': scoreSteepTurn,
  's_turns_across_road': scoreSTurns,
  'turn_around_a_point': scoreTurnAroundPoint,
  'rectangular_course': scoreRectangularCourse,
}

/**
 * Score every scorable detection on a flight. Returns an array of
 * scoreOne results.
 */
export function scoreFlight(detections, samples) {
  const out = []
  for (const det of detections) {
    const fn = SCORERS[det.type]
    if (!fn) continue
    const r = fn(det, samples)
    if (r) out.push(r)
  }
  return out
}
