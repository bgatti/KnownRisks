// airports.js — multi-airport database (Front Range Colorado).
//
// Each airport has lat/lon/field-elevation/pattern-altitude plus a pair of
// runway records with thresholds computed from the airport reference point.
// Use AIRPORTS, nearestAirport(), candidateAirports() from the rest of the
// phaseML package.
//
// Port of phase-ml/phase_ml/airports.py.

import {
  DEG_TO_RAD,
  haversineNm,
  makeRunwayFrame,
  xyNmToLatLon,
} from './geometry.js'

const FT_PER_NM_HALF = 12152.24   // 2 × 6076.12 (so length_ft / FT_PER_NM_HALF = half_nm)

function runwayPair(airportLat, airportLon, heading, lengthFt,
                    primaryName, primaryPattern, reciprocalName, reciprocalPattern) {
  const halfNm = (lengthFt / 2) / 6076.12
  const theta = heading * DEG_TO_RAD
  // Walk *backwards* along the runway by halfNm to place the primary threshold.
  const xBack = -Math.sin(theta) * halfNm
  const yBack = -Math.cos(theta) * halfNm
  const primary = xyNmToLatLon(xBack, yBack, airportLat, airportLon)
  const reciprocal = xyNmToLatLon(-xBack, -yBack, airportLat, airportLon)
  return [
    {
      name: primaryName, headingDeg: heading,
      thresholdLat: primary.lat, thresholdLon: primary.lon,
      lengthFt, pattern: primaryPattern,
    },
    {
      name: reciprocalName, headingDeg: (heading + 180) % 360,
      thresholdLat: reciprocal.lat, thresholdLon: reciprocal.lon,
      lengthFt, pattern: reciprocalPattern,
    },
  ]
}

function makeAirport(icao, name, lat, lon, fieldElevFt, tpaMslFt, runways) {
  return {
    icao, name, lat, lon, fieldElevFt, tpaMslFt, runways,
    tpaAglFt: () => tpaMslFt - fieldElevFt,
    distanceNm: (lat2, lon2) => haversineNm(lat2, lon2, lat, lon),
  }
}

function makeAirports() {
  const out = {}

  // KBDU — Boulder Municipal
  out.KBDU = makeAirport('KBDU', 'Boulder Municipal', 40.0394, -105.2258, 5288, 6300,
    runwayPair(40.0394, -105.2258, 80, 4100, '08', 'left', '26', 'left'))

  // KBJC — Rocky Mountain Metropolitan (parallels simplified to one pair)
  out.KBJC = makeAirport('KBJC', 'Rocky Mountain Metropolitan', 39.9088, -105.1172, 5673, 7173,
    runwayPair(39.9088, -105.1172, 119, 9000, '12', 'right', '30', 'left'))

  // KEIK — Erie Municipal
  out.KEIK = makeAirport('KEIK', 'Erie Municipal', 40.0103, -105.0489, 5130, 6130,
    runwayPair(40.0103, -105.0489, 152, 4700, '15', 'left', '33', 'left'))

  // KLMO — Vance Brand (Longmont)
  out.KLMO = makeAirport('KLMO', 'Vance Brand (Longmont)', 40.1639, -105.1633, 5054, 6054,
    runwayPair(40.1639, -105.1633, 113, 4800, '11', 'left', '29', 'left'))

  // KAPA — Centennial
  out.KAPA = makeAirport('KAPA', 'Centennial', 39.5701, -104.8492, 5885, 7385,
    runwayPair(39.5701, -104.8492, 174, 10001, '17', 'left', '35', 'right'))

  // KGXY — Greeley-Weld County
  out.KGXY = makeAirport('KGXY', 'Greeley-Weld County', 40.4375, -104.6333, 4658, 5658,
    runwayPair(40.4375, -104.6333, 90, 10000, '09', 'left', '27', 'left'))

  // KFNL — Northern Colorado Regional
  out.KFNL = makeAirport('KFNL', 'Northern Colorado Regional', 40.4519, -105.0114, 5016, 6016,
    runwayPair(40.4519, -105.0114, 60, 8500, '06', 'left', '24', 'left'))

  // KDEN — Denver International (one pair of six runways; enough for intent)
  out.KDEN = makeAirport('KDEN', 'Denver International', 39.8617, -104.6731, 5431, 6931,
    runwayPair(39.8617, -104.6731, 80, 12000, '08', 'left', '26', 'left'))

  return out
}

export const AIRPORTS = makeAirports()

export function allAirports() {
  return Object.values(AIRPORTS)
}

export function getAirport(icao) {
  return AIRPORTS[icao]
}

export function nearestAirport(lat, lon, { maxNm = 100 } = {}) {
  let best = null
  let bestD = Infinity
  for (const ap of allAirports()) {
    const d = ap.distanceNm(lat, lon)
    if (d < bestD) { bestD = d; best = ap }
  }
  if (bestD > maxNm) return { airport: null, distanceNm: Infinity }
  return { airport: best, distanceNm: bestD }
}

export function candidateAirports(lat, lon, { maxNm = 30 } = {}) {
  const out = []
  for (const ap of allAirports()) {
    const d = ap.distanceNm(lat, lon)
    if (d <= maxNm) out.push({ airport: ap, distanceNm: d })
  }
  out.sort((a, b) => a.distanceNm - b.distanceNm)
  return out
}

export function runwayFrameFor(airport, runway) {
  return makeRunwayFrame({
    thresholdLat: runway.thresholdLat,
    thresholdLon: runway.thresholdLon,
    headingDeg: runway.headingDeg,
    fieldElevFt: airport.fieldElevFt,
  })
}
