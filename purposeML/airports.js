// airports.js — airport traits for the purpose classifier.
import {
  AIRPORTS,
  allAirports,
  candidateAirports,
  getAirport,
  nearestAirport,
} from '../phaseML/airports.js'
import { haversineNm } from '../phaseML/geometry.js'

const TRAITS = {
  KBDU: { gliderPort: true, primaryTrainer: true, towered: false, busyClassD: false },
  KBJC: { gliderPort: false, primaryTrainer: true, towered: true, busyClassD: true },
  KEIK: { gliderPort: false, primaryTrainer: true, towered: false, busyClassD: false },
  KLMO: { gliderPort: true, primaryTrainer: true, towered: false, busyClassD: false },
  KAPA: { gliderPort: false, primaryTrainer: true, towered: true, busyClassD: true, bizjetHub: true },
  KGXY: { gliderPort: false, primaryTrainer: true, towered: false, busyClassD: false },
  KFNL: { gliderPort: false, primaryTrainer: true, towered: true, busyClassD: true },
  KDEN: { gliderPort: false, primaryTrainer: false, towered: true, airlineHub: true },
  KPRO: { gliderPort: true, primaryTrainer: false, towered: false },
  '17V': { gliderPort: true, primaryTrainer: false, towered: false },
}

const DEFAULT_TRAITS = {
  gliderPort: false, primaryTrainer: false, towered: false,
  busyClassD: false, airlineHub: false, bizjetHub: false,
}

export function airportTraits(icao) {
  if (!icao) return { ...DEFAULT_TRAITS }
  return { ...DEFAULT_TRAITS, ...(TRAITS[icao] || {}) }
}

export function homeFieldFor(points, { maxNm = 5 } = {}) {
  if (!points.length) return null
  let latSum = 0, lonSum = 0
  for (const p of points) { latSum += p.lat; lonSum += p.lon }
  const cLat = latSum / points.length
  const cLon = lonSum / points.length
  const { airport, distanceNm } = nearestAirport(cLat, cLon, { maxNm })
  if (!airport) return null
  return { icao: airport.icao, distanceNm, traits: airportTraits(airport.icao) }
}

export function endpointAirports(points, { maxNm = 2 } = {}) {
  if (points.length < 2) return { startIcao: null, endIcao: null, returned: false }
  const first = points[0], last = points[points.length - 1]
  const start = nearestAirport(first.lat, first.lon, { maxNm })
  const end = nearestAirport(last.lat, last.lon, { maxNm })
  const returned = haversineNm(first.lat, first.lon, last.lat, last.lon) < 2
  return {
    startIcao: start.airport?.icao || null,
    endIcao: end.airport?.icao || null,
    returned,
  }
}

// Inferred origin / destination from the FIRST / LAST captured fix,
// regardless of distance. The capture-radius archive often clips real
// takeoff/landing points, so we use the closest known airport with the
// distance reported. Reason at call site if distance > some threshold.
export function inferredEndpoints(points, { maxNm = 50 } = {}) {
  if (points.length < 2) {
    return { originIcao: null, originDistNm: Infinity,
             destIcao: null, destDistNm: Infinity }
  }
  const first = points[0], last = points[points.length - 1]
  const start = nearestAirport(first.lat, first.lon, { maxNm })
  const end = nearestAirport(last.lat, last.lon, { maxNm })
  return {
    originIcao: start.airport?.icao || null,
    originDistNm: start.distanceNm,
    destIcao: end.airport?.icao || null,
    destDistNm: end.distanceNm,
  }
}

export { AIRPORTS, allAirports, candidateAirports, getAirport, nearestAirport }
