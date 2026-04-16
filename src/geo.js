// Small flat-earth helpers — zones are ~1 nm so local planar approximation is fine.

const FT_PER_DEG_LAT = 364560 // 60 nm * 6076 ft/nm

export function pointInPolygon(lat, lon, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i]
    const [yj, xj] = poly[j]
    const intersect =
      (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function distPointToSegmentFt(lat, lon, aLat, aLon, bLat, bLon) {
  const latRef = (aLat + bLat + lat) / 3
  const cos = Math.cos((latRef * Math.PI) / 180)
  const px = (lon - aLon) * FT_PER_DEG_LAT * cos
  const py = (lat - aLat) * FT_PER_DEG_LAT
  const dx = (bLon - aLon) * FT_PER_DEG_LAT * cos
  const dy = (bLat - aLat) * FT_PER_DEG_LAT
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px, py)
  let t = (px * dx + py * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - t * dx, py - t * dy)
}

// Signed distance (ft) from (lat,lon) to nearest noise-zone edge.
// Negative when inside any zone.
export function signedDistanceToZonesFt(lat, lon, zones) {
  let minAbs = Infinity
  let insideAny = false
  for (const z of zones) {
    const poly = z.polygon
    if (pointInPolygon(lat, lon, poly)) insideAny = true
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const d = distPointToSegmentFt(lat, lon, poly[i][0], poly[i][1], poly[j][0], poly[j][1])
      if (d < minAbs) minAbs = d
    }
  }
  return insideAny ? -minAbs : minAbs
}

// Distance in feet between two lat/lon points (flat-earth, fine at this scale).
export function distFt(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * FT_PER_DEG_LAT
  const dLon = (lon2 - lon1) * FT_PER_DEG_LAT * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180)
  return Math.hypot(dLat, dLon)
}

// Walk a track and return length (ft) broken down by classification band.
//   total   — total path length
//   yellow  — length where either endpoint is within 250 ft of a boundary
//   orange  — length where either endpoint is 250–500 ft inside a zone
//   red     — length where either endpoint is > 500 ft inside a zone
//   inZone  — yellow + orange + red (any incursion)
//   inRed   — orange + red (strict violations)
// Segments are attributed to the MOST-SEVERE endpoint class so the bands are
// mutually exclusive and sum to inZone.
export function trackLengthFt(points, zones) {
  let total = 0, yellow = 0, orange = 0, red = 0
  if (points.length < 2) return { total, yellow, orange, red, inZone: 0, inRed: 0 }
  const tags = points.map((p) => classifyPoint(p[0], p[1], p[2], zones))
  const rank = { yellow: 1, orange: 2, red: 3 }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const seg = distFt(a[0], a[1], b[0], b[1])
    total += seg
    const ta = tags[i - 1], tb = tags[i]
    const worst = (rank[ta] || 0) >= (rank[tb] || 0) ? ta : tb
    if (worst === 'red') red += seg
    else if (worst === 'orange') orange += seg
    else if (worst === 'yellow') yellow += seg
  }
  const inZone = yellow + orange + red
  const inRed = orange + red
  return { total, yellow, orange, red, inZone, inRed }
}

// Classify a point by its signed distance to the nearest zone edge, in 250-ft bands.
//   'red'    — inside a zone by more than 500 ft
//   'orange' — inside a zone, 250–500 ft past the boundary
//   'yellow' — within 250 ft of the boundary (either side)
//   null     — clean (> 250 ft outside all zones)
export function classify(d) {
  if (d < -500) return 'red'
  if (d < -250) return 'orange'
  if (d < 250) return 'yellow'
  return null
}

// Altitude classification — the 7500 ft MSL "overflight below" rule.
//   within ±250 ft of 7500  (7250..7750) → yellow
//   250–500 ft below 7500   (7000..7250) → orange
//   > 500 ft below 7500     (< 7000)     → red
//   at or above 7750                      → null (clean)
const ALT_THRESHOLD_FT = 7500
export function classifyAlt(alt) {
  if (alt == null) return null
  const below = ALT_THRESHOLD_FT - alt
  if (below > 500) return 'red'
  if (below > 250) return 'orange'
  if (below > -250) return 'yellow'
  return null
}

const SEVERITY = { yellow: 1, orange: 2, red: 3 }

// Combined classification: a point only violates when BOTH the zone AND the
// altitude agree. Return the LESS-SEVERE of the two tags (min severity). A
// high aircraft in a zone stays clean; a low aircraft outside a zone stays
// clean; only a low aircraft inside a zone is flagged.
export function classifyPoint(lat, lon, alt, zones) {
  const z = classify(signedDistanceToZonesFt(lat, lon, zones))
  const a = classifyAlt(alt)
  if (!z || !a) return null
  const zs = SEVERITY[z], as = SEVERITY[a]
  return zs <= as ? z : a
}
