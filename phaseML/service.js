// service.js — the function that ties oracle + maneuvers + intent together.
//
// Called by apiPlugin.js for HTTP requests and by anything else that wants
// the full classification of a single track without hand-wiring the layers.

import { buildWindow, enrich, pointFromArchiveTuple, pointFromLiveRecord } from './features.js'
import { classifyTrack } from './oracle.js'
import { detectAll } from './maneuvers.js'
import { summarise } from './intent.js'

/**
 * Normalise inputs from either the archive (4-tuples + t0) or the live feed
 * (records) or the canonical Point shape into Point[].
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
        // Looks like a live-feed record
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
 *   typeCode         — ICAO type, helps slow_flight and thermalling
 *   intentWindowS    — trailing window used for the intent prediction (default 180)
 *   priorByAirport   — { ICAO: number } prior multiplier for intent
 * @returns { phases, maneuvers, intent }
 */
export function classifyOneTrack(points, {
  typeCode = '',
  intentWindowS = 180,
  priorByAirport = null,
} = {}) {
  const phases = classifyTrack(points)
  const samples = enrich(points)
  const maneuvers = detectAll(samples, typeCode)

  let intent = null
  if (samples.length >= 2) {
    const endTs = samples[samples.length - 1].point.tsUnix
    let startIdx = 0
    for (let i = samples.length - 1; i >= 0; i--) {
      if (endTs - samples[i].point.tsUnix >= intentWindowS) { startIdx = i; break }
    }
    const window = buildWindow(samples.slice(startIdx))
    intent = summarise(window, { priorByAirport })
  }
  return { phases, maneuvers, intent }
}
