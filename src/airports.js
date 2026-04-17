// Airports near the Front Range monitoring area.
// Used by both client (App.jsx) and server (backfill.js) to determine
// which airport a track originates from / terminates at.

export const AIRPORTS = [
  { code: 'KBDU', lat: 40.0394, lon: -105.2258 },
  { code: 'KBJC', lat: 39.9088, lon: -105.1172 },
  { code: 'KEIK', lat: 40.0098, lon: -105.0488 },
  { code: 'KLMO', lat: 40.1636, lon: -105.1636 },
  { code: 'KAPA', lat: 39.5701, lon: -104.8493 },
  { code: 'KDEN', lat: 39.8617, lon: -104.6731 },
  { code: 'KBKF', lat: 39.7017, lon: -104.7517 },
  { code: 'KCFO', lat: 39.7831, lon: -104.5369 },
  { code: 'KGXY', lat: 40.4348, lon: -104.6331 },
  { code: 'KFTG', lat: 39.7850, lon: -104.5428 },
  { code: 'KLIC', lat: 39.2744, lon: -103.6662 },
  { code: 'KFNL', lat: 40.4517, lon: -105.0114 },
]

export const KBDU = [40.0394, -105.2258]
export const LOCAL_RADIUS_NM = 3

export function nmFrom(lat, lon, refLat, refLon) {
  const dLat = (lat - refLat) * 60
  const dLon = (lon - refLon) * 60 * Math.cos(((lat + refLat) / 2) * Math.PI / 180)
  return Math.hypot(dLat, dLon)
}

export function nearestAirport(lat, lon, maxNm = 3) {
  let best = null, bestD = Infinity
  for (const ap of AIRPORTS) {
    const d = nmFrom(lat, lon, ap.lat, ap.lon)
    if (d < bestD) { bestD = d; best = ap }
  }
  return bestD <= maxNm ? best.code : null
}
