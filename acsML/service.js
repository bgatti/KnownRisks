// service.js — entry point.

import { identifyAcsSegments } from './identifier.js'
import {
  pointFromArchiveTuple,
  pointFromLiveRecord,
} from '../phaseML/features.js'

// QUALITY: 5-tuple [lat, lon, alt, ts, quality] is the sortie_path
// wire shape. Drop unless quality === 'real'. Bridged/repaired
// points are NOT safe for ACS classification per the sortie contract.
//
// SANITY: drop fixes that can't physically be flying (bad lat/lon/alt/ts).
const NOW_EPOCH_S = () => Math.floor(Date.now() / 1000)
const SANE_FUTURE_S = 86400

function qualityOk(quality) {
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

export function inputToPoints(raw, opts) {
  return inputToPointsWithStats(raw, opts).points
}

export function inputToPointsWithStats(raw, { archive = false, t0Seconds = 0 } = {}) {
  const dropped = { quality: 0, sanity: 0, malformed: 0 }
  if (!Array.isArray(raw)) return { points: [], dropped }
  const out = []
  for (const item of raw) {
    let p = null
    if (Array.isArray(item)) {
      if (item.length >= 5 && !qualityOk(item[4])) { dropped.quality++; continue }
      if (archive) p = pointFromArchiveTuple(item, t0Seconds)
      else if (item.length >= 4) {
        p = { lat: item[0], lon: item[1], altMslFt: item[2], tsUnix: item[3] }
        if (p.tsUnix > 1e10) p.tsUnix = p.tsUnix / 1000   // sortie ms → s
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

export function identifyOneTrack(points, opts = {}) {
  return identifyAcsSegments(points, opts)
}
