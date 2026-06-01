// geometry.js — pure geometry primitives for the phaseML package.
//
// All inputs/outputs use degrees for angles, nautical miles for distance,
// feet for altitude, knots for groundspeed. Internal trig converts to
// radians only where Math.sin/cos need them.
//
// Flat-Earth helpers are exact enough at <50 nm scales (the Boulder corridor
// is ~40 nm wide) and are much cheaper than haversine in hot loops. Use
// haversineNm at the boundary (e.g. distance-to-airport once per tick).
//
// Port of phase-ml/phase_ml/geometry.py — keep them in lock-step.

export const EARTH_RADIUS_NM = 3440.065
export const FT_PER_NM = 6076.12
export const DEG_TO_RAD = Math.PI / 180
export const RAD_TO_DEG = 180 / Math.PI
export const KT_TO_FPS = 1.68781
export const G_FT_S2 = 32.174

export function haversineNm(lat1, lon1, lat2, lon2) {
  const phi1 = lat1 * DEG_TO_RAD
  const phi2 = lat2 * DEG_TO_RAD
  const dphi = (lat2 - lat1) * DEG_TO_RAD
  const dlam = (lon2 - lon1) * DEG_TO_RAD
  const a = Math.sin(dphi / 2) ** 2
          + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = lat1 * DEG_TO_RAD
  const phi2 = lat2 * DEG_TO_RAD
  const dlam = (lon2 - lon1) * DEG_TO_RAD
  const y = Math.sin(dlam) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2)
          - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dlam)
  return (Math.atan2(y, x) * RAD_TO_DEG + 360) % 360
}

// Signed smallest angular difference (a - b), wrapped to (-180, 180].
//
// JS `%` follows the sign of the dividend, so we add 360 before the mod to
// guarantee a non-negative remainder (matching Python's behavior).
export function angleDiffDeg(a, b) {
  const d = (((a - b + 180) % 360) + 360) % 360 - 180
  return d === -180 ? 180 : d
}

export function angleDiffAbs(a, b) {
  return Math.abs(angleDiffDeg(a, b))
}

export function normalizeBearing(b) {
  return ((b % 360) + 360) % 360
}

// ── Local-tangent (flat-Earth) projection ───────────────────────────────

export function latLonToXyNm(lat, lon, lat0, lon0) {
  const dlat = lat - lat0
  const dlon = lon - lon0
  const cosLat0 = Math.cos(lat0 * DEG_TO_RAD)
  return {
    xNm: dlon * 60 * cosLat0,   // 60 nm / deg of longitude * cos(lat)
    yNm: dlat * 60,              // 60 nm / deg of latitude
  }
}

export function xyNmToLatLon(xNm, yNm, lat0, lon0) {
  const cosLat0 = Math.cos(lat0 * DEG_TO_RAD)
  return {
    lat: lat0 + yNm / 60,
    lon: lon0 + xNm / (60 * cosLat0),
  }
}

// ── Runway frame ────────────────────────────────────────────────────────
//
// Make a frame anchored at a runway threshold with the +along axis pointing
// down the departure direction (so an aircraft on final has alongNm < 0,
// increasing toward 0 at touchdown). +crossNm is to the right of the
// runway centerline looking down-runway.

export function makeRunwayFrame({ thresholdLat, thresholdLon, headingDeg, fieldElevFt }) {
  return {
    thresholdLat,
    thresholdLon,
    headingDeg,
    fieldElevFt,
    project(lat, lon) {
      const { xNm, yNm } = latLonToXyNm(lat, lon, thresholdLat, thresholdLon)
      const theta = headingDeg * DEG_TO_RAD
      const sinT = Math.sin(theta)
      const cosT = Math.cos(theta)
      return {
        alongNm: xNm * sinT + yNm * cosT,
        crossNm: xNm * cosT - yNm * sinT,
      }
    },
  }
}

// ── Path / heading helpers ──────────────────────────────────────────────

export function haversinePathLengthNm(points) {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += haversineNm(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon)
  }
  return total
}

export function displacementNm(points) {
  if (points.length < 2) return 0
  return haversineNm(points[0].lat, points[0].lon,
                     points[points.length - 1].lat, points[points.length - 1].lon)
}

export function signedHeadingChange(prev, next) {
  return angleDiffDeg(next, prev)
}

export function cumulativeSignedTurnDeg(headings) {
  let total = 0
  for (let i = 1; i < headings.length; i++) {
    total += signedHeadingChange(headings[i - 1], headings[i])
  }
  return total
}

export function cumulativeAbsTurnDeg(headings) {
  let total = 0
  for (let i = 1; i < headings.length; i++) {
    total += Math.abs(signedHeadingChange(headings[i - 1], headings[i]))
  }
  return total
}

// ── Curvature / kinematics ──────────────────────────────────────────────

export function turnRateDegPerS(prevHeading, newHeading, dtS) {
  if (dtS <= 0) return 0
  return signedHeadingChange(prevHeading, newHeading) / dtS
}

// Coordinated turn:  tan(bank) = (ω * V) / g     with ω in rad/s, V in ft/s.
export function bankAngleDegFromTurnRate(turnRateDps, groundspeedKts) {
  if (groundspeedKts <= 1) return 0
  const omegaRadS = Math.abs(turnRateDps) * DEG_TO_RAD
  const vFps = groundspeedKts * KT_TO_FPS
  return Math.atan2(omegaRadS * vFps, G_FT_S2) * RAD_TO_DEG
}

// Steady-state orbit radius. Near-straight track returns Infinity.
export function orbitRadiusNm(turnRateDps, groundspeedKts) {
  if (Math.abs(turnRateDps) < 0.05) return Infinity
  const omegaRadS = Math.abs(turnRateDps) * DEG_TO_RAD
  const vNmPerS = groundspeedKts / 3600
  return vNmPerS / omegaRadS
}

// ── Small statistics ────────────────────────────────────────────────────

export function centroidLatLon(points) {
  let n = 0, latSum = 0, lonSum = 0
  for (const p of points) {
    latSum += p.lat
    lonSum += p.lon
    n++
  }
  if (n === 0) return { lat: NaN, lon: NaN }
  return { lat: latSum / n, lon: lonSum / n }
}

export function std(values) {
  const n = values.length
  if (n < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / n
  return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1))
}

export function percentile(values, q) {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  if (q <= 0) return s[0]
  if (q >= 1) return s[s.length - 1]
  const idx = q * (s.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return s[lo] + (s[hi] - s[lo]) * (idx - lo)
}
