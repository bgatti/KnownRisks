// altCorrection.js — per-flight ADS-B barometric altitude correction.
//
// Mode-S transponders broadcast barometric altitude calibrated to the
// 29.92 inHg standard-pressure surface. Local pressure and transponder
// drift give every flight a systematic offset (±100–400 ft) versus
// true MSL. This module backs that offset out by anchoring each flight's
// fixes to known runway elevations, then smooths the resulting per-flight
// offset across temporal neighbors at the same airport to absorb single-
// transponder noise and rescue flights that never approached the runway.
//
// See `noise/web/ADJUSTED_ALT.md` for the prose explanation of the math.
//
// Pure module — no module state, no side effects, no async. Flat exports
// matching the convention of `noise/web/src/geo.js`.

import { distFt } from './geo.js'

// Tuning knobs (exported so consumers and tests can introspect them).
export const VERIFIED_ALT_CAL_RADIUS_NM = 2.0
export const VERIFIED_ALT_CAL_COHORT_FRACTION = 0.25
export const VERIFIED_ALT_CAL_MIN_FIXES = 3
export const VERIFIED_ALT_CAL_MAX_AGL_FT = 500
export const RUNWAY_GS_KTS_MAX = 20
export const RUNWAY_VS_FPM_MAX = 100
export const RUNWAY_ALT_CLUSTER_FT = 10
export const RUNWAY_ALT_CLUSTER_NEIGHBORS = 2
export const RUNWAY_SCORE_W_GS = 3
export const RUNWAY_SCORE_W_VS = 2
export const RUNWAY_SCORE_W_CLUSTER = 2
export const REGIONAL_OFFSET_WINDOW_MS = 12 * 3600 * 1000 // keep last 12 h of events
export const REGIONAL_OFFSET_NEAR_N = 2 // 2 landings before + 2 after

// Great-circle-ish distance in nautical miles for the anchor radius check.
// Local to the module so we don't pull a network of imports in tests.
function distNmAp(la1, lo1, la2, lo2) {
  const dLat = (la1 - la2) * 60
  const dLon = (lo1 - lo2) * 60 * Math.cos(((la1 + la2) / 2) * Math.PI / 180)
  return Math.hypot(dLat, dLon)
}

// Find high-confidence runway-anchor fixes from a flight track. Combines
// stationary signals (low ground speed, low vertical speed, alt-clustered
// neighbors) into a per-fix score. Returns anchors sorted by score
// descending (and alt ascending as a tiebreaker). Per operator: vs=0,
// gs<20 kts, and several consecutive datums at the same alt are strong
// hints the aircraft is on the runway. Sometimes we won't see these —
// in which case the caller falls back to the lowest-25% method.
//
// `ap = { lat, lon, elev }` (the `code` field is unused but a full
// ENRICH_AP entry is fine too).
export function findRunwayAnchors(flightPts, ap) {
  const out = []
  if (!flightPts || !ap) return out
  for (let i = 0; i < flightPts.length; i++) {
    const p = flightPts[i]
    if (p[0] == null || p[1] == null || p[2] == null) continue
    if (distNmAp(p[0], p[1], ap.lat, ap.lon) > VERIFIED_ALT_CAL_RADIUS_NM) continue
    let vs = null, gs = null
    if (i > 0) {
      const prev = flightPts[i - 1]
      const dtSec = ((p[3] || 0) - (prev[3] || 0)) / 1000
      if (dtSec > 0 && dtSec < 60 && prev[2] != null) {
        vs = ((p[2] - prev[2]) / dtSec) * 60 // ft/min
        const dFt = distFt(prev[0], prev[1], p[0], p[1])
        gs = (dFt / dtSec) / 1.68781 // ft/s → knots
      }
    }
    let score = 0
    if (gs != null && gs < RUNWAY_GS_KTS_MAX) score += RUNWAY_SCORE_W_GS
    if (vs != null && Math.abs(vs) < RUNWAY_VS_FPM_MAX) score += RUNWAY_SCORE_W_VS
    let altNeighbors = 0
    for (let j = Math.max(0, i - 2); j <= Math.min(flightPts.length - 1, i + 2); j++) {
      if (j === i) continue
      const q = flightPts[j]
      if (q && q[2] != null && Math.abs(q[2] - p[2]) <= RUNWAY_ALT_CLUSTER_FT) altNeighbors++
    }
    if (altNeighbors >= RUNWAY_ALT_CLUSTER_NEIGHBORS) score += RUNWAY_SCORE_W_CLUSTER
    if (score > 0) out.push({ alt: p[2], score })
  }
  out.sort((a, b) => (b.score - a.score) || (a.alt - b.alt))
  return out
}

// Per-flight self-calibration. Returns
//   { offset_ft, calibration_fixes, source }
// where source ∈ 'anchors' | 'lowest25' | 'none'.
//
// `ap = { lat, lon, elev }` — pass the ENRICH_AP entry for the flight's
// base airport. Sign convention: positive offset = transponder over-reports
// (subtract from raw alt to get verified MSL).
export function computeFlightAltOffset(flightPts, ap) {
  if (!ap || !flightPts || !flightPts.length) {
    return { offset_ft: 0, calibration_fixes: 0, source: 'none' }
  }
  // Primary: high-confidence runway anchors from low gs/vs/alt-clustered
  // fixes. Use anchors with score ≥ topScore/2 (keeps the best cohort).
  const anchors = findRunwayAnchors(flightPts, ap)
  if (anchors.length >= VERIFIED_ALT_CAL_MIN_FIXES) {
    const topScore = anchors[0].score
    const cohort = anchors.filter(a => a.score >= Math.max(1, topScore / 2))
    if (cohort.length >= VERIFIED_ALT_CAL_MIN_FIXES) {
      const avg = cohort.reduce((s, a) => s + a.alt, 0) / cohort.length
      if ((avg - ap.elev) <= VERIFIED_ALT_CAL_MAX_AGL_FT) {
        return {
          offset_ft: Math.round(avg - ap.elev),
          calibration_fixes: cohort.length,
          source: 'anchors',
        }
      }
    }
  }
  // Fallback: lowest-25% of in-range fixes (the prior algorithm). Catches
  // flights where we lack the speed/vs signals but did dip near the field.
  const candidates = []
  for (const p of flightPts) {
    if (p[0] == null || p[1] == null || p[2] == null) continue
    if (distNmAp(p[0], p[1], ap.lat, ap.lon) > VERIFIED_ALT_CAL_RADIUS_NM) continue
    candidates.push(p[2])
  }
  if (candidates.length < VERIFIED_ALT_CAL_MIN_FIXES) {
    return { offset_ft: 0, calibration_fixes: 0, source: 'none' }
  }
  const sorted = candidates.slice().sort((a, b) => a - b)
  const kFloor = Math.max(VERIFIED_ALT_CAL_MIN_FIXES, Math.ceil(sorted.length * VERIFIED_ALT_CAL_COHORT_FRACTION))
  const cohort = sorted.slice(0, kFloor)
  const avg = cohort.reduce((s, v) => s + v, 0) / cohort.length
  if ((avg - ap.elev) > VERIFIED_ALT_CAL_MAX_AGL_FT) {
    // Cohort mean is too high above field elevation — the plane never
    // actually descended to the runway. Pre-existing semantics return
    // offset_ft=0 with the cohort size as `calibration_fixes`.
    return { offset_ft: 0, calibration_fixes: cohort.length, source: 'none' }
  }
  return {
    offset_ft: Math.round(avg - ap.elev),
    calibration_fixes: cohort.length,
    source: 'lowest25',
  }
}

// Build per-airport time-sorted series from a flat list of
// already-self-calibrated flights. Pure, no mutation of input.
//
// Input:  Array<{ airport, midMs, offsetFt, calibrationFixes }>
// Output: Map<airport, Array<{ landingMs, offsetFt }>> sorted asc by landingMs
//
// Drops entries with calibrationFixes == 0 (no self-cohort = no event).
export function regionalOffsetSeries(flights) {
  const byAirport = new Map()
  if (!flights || !flights.length) return byAirport
  for (const f of flights) {
    if (!f) continue
    if (!f.calibrationFixes) continue
    if (!f.airport) continue
    if (!Number.isFinite(f.midMs)) continue
    if (!byAirport.has(f.airport)) byAirport.set(f.airport, [])
    byAirport.get(f.airport).push({ landingMs: f.midMs, offsetFt: f.offsetFt })
  }
  for (const series of byAirport.values()) series.sort((a, b) => a.landingMs - b.landingMs)
  return byAirport
}

// Per-flight smoother lookup. For a flight at `midMs` over `airport`,
// blend the REGIONAL_OFFSET_NEAR_N events immediately before with the
// same number after, filter outliers more than max(50, stddev) ft from
// the mean, and average what remains.
//
// Returns { offset_ft, n_landings } or null if not enough events.
export function smoothedOffsetFor(airport, midMs, series) {
  if (!series) return null
  const events = series.get(airport)
  if (!events || events.length === 0) return null
  const before = events.filter(e => e.landingMs < midMs).slice(-REGIONAL_OFFSET_NEAR_N)
  const after = events.filter(e => e.landingMs >= midMs).slice(0, REGIONAL_OFFSET_NEAR_N)
  const sample = [...before, ...after].map(e => e.offsetFt)
  if (sample.length === 0) return null
  const mean = sample.reduce((s, v) => s + v, 0) / sample.length
  const variance = sample.reduce((s, v) => s + (v - mean) * (v - mean), 0) / sample.length
  const stddev = Math.sqrt(variance)
  const band = Math.max(50, stddev)
  const filtered = sample.filter(v => Math.abs(v - mean) <= band)
  const finalMean = (filtered.length > 0 ? filtered : sample).reduce((s, v) => s + v, 0) / (filtered.length || sample.length)
  return { offset_ft: Math.round(finalMean), n_landings: sample.length }
}

// Apply a smoothed offset to a point array. Returns a NEW array of
// [lat, lon, alt - offsetFt, ts] tuples. When offsetFt is 0 (or falsy),
// returns the input by reference so consumers can wire this in
// unconditionally without paying an allocation cost.
//
// Preserves null altitudes (a missing alt stays missing).
export function applyOffsetToPoints(points, offsetFt) {
  if (!offsetFt) return points
  if (!points) return points
  const out = new Array(points.length)
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const alt = p[2]
    out[i] = [p[0], p[1], alt == null ? alt : alt - offsetFt, p[3]]
  }
  return out
}
