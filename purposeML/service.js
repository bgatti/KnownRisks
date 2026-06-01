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

/**
 * Normalise inputs from any of:
 *   - canonical Point objects: { lat, lon, altMslFt, tsUnix }
 *   - archive 4-tuples + t0Seconds: [lat, lon, alt, secsSinceT0]
 *   - live records: { lat, lon, alt_ft, ts: ISO|ms }
 * into the canonical Point[].
 */
export function inputToPoints(raw, { archive = false, t0Seconds = 0 } = {}) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (Array.isArray(item)) {
      if (archive) {
        out.push(pointFromArchiveTuple(item, t0Seconds))
      } else if (item.length >= 4) {
        out.push({ lat: item[0], lon: item[1], altMslFt: item[2], tsUnix: item[3] })
      }
    } else if (item && typeof item === 'object') {
      if (typeof item.lat === 'number' && typeof item.lon === 'number'
          && typeof item.tsUnix === 'number') {
        out.push({
          lat: item.lat, lon: item.lon,
          altMslFt: item.altMslFt ?? item.alt_ft ?? item.alt,
          tsUnix: item.tsUnix,
        })
      } else {
        out.push(pointFromLiveRecord(item))
      }
    }
  }
  return out.filter(p =>
    typeof p.lat === 'number' && typeof p.lon === 'number'
    && typeof p.altMslFt === 'number' && typeof p.tsUnix === 'number',
  )
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
