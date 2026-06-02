// service.js — entry point.

import { identifyAcsSegments } from './identifier.js'
import {
  pointFromArchiveTuple,
  pointFromLiveRecord,
} from '../phaseML/features.js'

export function inputToPoints(raw, { archive = false, t0Seconds = 0 } = {}) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (Array.isArray(item)) {
      if (archive) out.push(pointFromArchiveTuple(item, t0Seconds))
      else if (item.length >= 4) out.push({ lat: item[0], lon: item[1], altMslFt: item[2], tsUnix: item[3] })
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

export function identifyOneTrack(points, opts = {}) {
  return identifyAcsSegments(points, opts)
}
