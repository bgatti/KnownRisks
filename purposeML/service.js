// service.js — ties feature extraction + classification into one call.
//
// Used by apiPlugin.js for HTTP requests and importable from any Node
// module (vite.config.js's resolvePurposeWithShape imports this).

import { extractFeatures } from './features.js'
import { classifyTrack } from './classifier.js'
import {
  pointFromArchiveTuple,
  pointFromLiveRecord,
} from '../phaseML/features.js'

// Quality + sanity gates the classifier runs on every input.
// Documented here so consumers know what's silently dropped.
//
//   QUALITY: a 5-tuple [lat, lon, alt, ts, quality] is the sortie_path
//   wire shape. Drop unless quality === 'real'. Bridged/repaired/
//   synthesized points are NOT safe for classification per the sortie
//   contract.
//
//   SANITY: drop fixes that can't physically be flying:
//     - lat ∉ [-90, 90] or lon ∉ [-180, 180]
//     - altMslFt non-finite, < -1000, or > 65000
//     - tsUnix non-finite, <= 0, or > now + 1 day
//
// Both gates are conservative — they reject obviously-bad data and
// pass through everything else. The downstream classifier still owns
// its own min-points / min-duration thresholds.
const NOW_EPOCH_S = () => Math.floor(Date.now() / 1000)
const SANE_FUTURE_S = 86400

function qualityOk(quality) {
  // No quality field present → trust (raw archive / live record).
  if (quality === undefined || quality === null) return true
  return quality === 'real' || quality === 'observed'
}
function sanityOk(p) {
  return Number.isFinite(p.lat) && p.lat >= -90 && p.lat <= 90
    && Number.isFinite(p.lon) && p.lon >= -180 && p.lon <= 180
    && Number.isFinite(p.altMslFt) && p.altMslFt > -1000 && p.altMslFt < 65000
    && Number.isFinite(p.tsUnix) && p.tsUnix > 0
    && p.tsUnix < NOW_EPOCH_S() + SANE_FUTURE_S
}

/**
 * Normalise inputs from any of:
 *   - canonical Point objects: { lat, lon, altMslFt, tsUnix }
 *   - archive 4-tuples + t0Seconds: [lat, lon, alt, secsSinceT0]
 *   - sortie 5-tuples: [lat, lon, alt, tsMs, quality]
 *       quality !== 'real' is silently dropped (bridge/repair guard)
 *   - live records: { lat, lon, alt_ft, ts: ISO|ms }
 * into the canonical Point[]. Drops any point that fails quality or
 * sanity gates above.
 *
 * @returns Point[]
 *   To see how many input items were dropped, use inputToPointsWithStats.
 */
export function inputToPoints(raw, opts) {
  return inputToPointsWithStats(raw, opts).points
}

/**
 * Same as inputToPoints but also returns drop counts so callers can
 * surface "we ignored N bridged points" diagnostics.
 *
 * @returns { points: Point[], dropped: { quality, sanity, malformed } }
 */
export function inputToPointsWithStats(raw, { archive = false, t0Seconds = 0 } = {}) {
  const dropped = { quality: 0, sanity: 0, malformed: 0 }
  if (!Array.isArray(raw)) return { points: [], dropped }
  const out = []
  for (const item of raw) {
    let p = null
    if (Array.isArray(item)) {
      if (item.length >= 5 && !qualityOk(item[4])) { dropped.quality++; continue }
      if (archive) {
        p = pointFromArchiveTuple(item, t0Seconds)
      } else if (item.length >= 4) {
        p = { lat: item[0], lon: item[1], altMslFt: item[2], tsUnix: item[3] }
        // Sortie tuples carry tsUnix in MILLISECONDS; canonical is
        // seconds. If the value is obviously ms (>1e10), convert.
        if (p.tsUnix > 1e10) p.tsUnix = p.tsUnix / 1000
      }
    } else if (item && typeof item === 'object') {
      if (item.quality !== undefined && !qualityOk(item.quality)) { dropped.quality++; continue }
      if (typeof item.lat === 'number' && typeof item.lon === 'number'
          && typeof item.tsUnix === 'number') {
        p = {
          lat: item.lat, lon: item.lon,
          altMslFt: item.altMslFt ?? item.alt_ft ?? item.alt,
          tsUnix: item.tsUnix,
        }
      } else {
        p = pointFromLiveRecord(item)
      }
    }
    if (!p) { dropped.malformed++; continue }
    if (!sanityOk(p)) { dropped.sanity++; continue }
    out.push(p)
  }
  return { points: out, dropped }
}

/**
 * Classify one track end-to-end.
 *
 * @param {Point[]} points
 * @param {object} opts
 *   typeCode        — ICAO type code (engineless detection + phaseML calibration)
 *   tail            — tail number (informational)
 *   isSchoolFleet   — pushes pattern_solo → training
 *   includeFeatures — include the full feature vector in the response
 * @returns { purpose, confidence, reasons, features? }
 */
export function classifyOneTrack(points, {
  typeCode = '',
  tail = '',
  isSchoolFleet = false,
  includeFeatures = false,
} = {}) {
  const features = extractFeatures(points, { typeCode })
  const verdict = classifyTrack(features, { typeCode, tail, isSchoolFleet })
  if (includeFeatures) return { ...verdict, features }
  return verdict
}
