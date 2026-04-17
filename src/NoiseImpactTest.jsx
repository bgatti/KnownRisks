import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, Polyline, Circle, Marker, Polygon, Tooltip, ImageOverlay } from 'react-leaflet'
import L from 'leaflet'
import { NOISE_ZONES } from './noiseZones'
import { terrainAt } from './terrain'

// ─── Shared constants ─────────────────────────────────────────────────────────
const KBDU = [40.0394, -105.2258]
const FT_PER_DEG_LAT = 364560
const MILE_FT = 5280
const FT_PER_SEC_PER_KT = 1.6878

// ─── Geometry helpers (duplicated from ThinningTest for self-containment) ───

function dist3dFt(a, b) {
  const dLat = (b[0] - a[0]) * FT_PER_DEG_LAT
  const dLon = (b[1] - a[1]) * FT_PER_DEG_LAT * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180)
  const dAlt = b[2] - a[2]
  return Math.sqrt(dLat * dLat + dLon * dLon + dAlt * dAlt)
}

function bearing(a, b) {
  const dLat = b[0] - a[0]
  const dLon = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180)
  return (Math.atan2(dLon, dLat) * 180) / Math.PI
}

// ─── Track thinning pipeline ─────────────────────────────────────────────────
// movavg(5) → DP(140 ft) matches the settings tuned in ThinningTest:
//   89% point reduction, 2.7% path-length loss, altitude preserved.

// 3D perpendicular distance — includes altitude so a point that deviates
// vertically from the a→b line gets a nonzero distance even if its
// lat/lon projection is on the line. This prevents DP from dropping
// points whose altitude matters.
function perpDistFt(p, a, b) {
  const latRef = (a[0] + b[0] + p[0]) / 3
  const cos = Math.cos((latRef * Math.PI) / 180)
  const px = (p[1] - a[1]) * FT_PER_DEG_LAT * cos
  const py = (p[0] - a[0]) * FT_PER_DEG_LAT
  const pz = (p[2] || 0) - (a[2] || 0)
  const dx = (b[1] - a[1]) * FT_PER_DEG_LAT * cos
  const dy = (b[0] - a[0]) * FT_PER_DEG_LAT
  const dz = (b[2] || 0) - (a[2] || 0)
  const len2 = dx * dx + dy * dy + dz * dz
  if (len2 === 0) return Math.hypot(px, py, pz)
  const t = Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / len2))
  return Math.hypot(px - t * dx, py - t * dy, pz - t * dz)
}

// Smooth lat/lon only — altitude is preserved verbatim from the original
// point so we don't round off altitude peaks/troughs during corner
// smoothing. The 2D moving average removes GPS jitter in the horizontal
// plane while keeping the vertical profile intact.
function movingAverageLL(points, window) {
  if (window < 3 || points.length < 3) return points.map((p) => p.slice())
  const half = Math.floor(window / 2)
  const out = []
  for (let i = 0; i < points.length; i++) {
    let sLat = 0, sLon = 0, n = 0
    const lo = Math.max(0, i - half)
    const hi = Math.min(points.length - 1, i + half)
    for (let j = lo; j <= hi; j++) {
      sLat += points[j][0]; sLon += points[j][1]; n++
    }
    out.push([sLat / n, sLon / n, points[i][2] || 0])
  }
  return out
}

function thinDP(points, epsilonFt) {
  if (points.length < 3 || epsilonFt <= 0) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop()
    let maxD = 0, idx = -1
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistFt(points[i], points[lo], points[hi])
      if (d > maxD) { maxD = d; idx = i }
    }
    if (maxD > epsilonFt && idx >= 0) {
      keep[idx] = 1
      stack.push([lo, idx])
      stack.push([idx, hi])
    }
  }
  return points.filter((_, i) => keep[i])
}

// Re-densify thinned [lat,lon,alt] control points via quadratic Bezier,
// interpolating altitude along with position. Uses midpoints between
// consecutive controls as the curve "on" points and the original thinned
// points as the Bezier control points — same geometry as bezierQ in
// ThinningTest but carrying altitude through. `samples` controls how
// many interpolated sub-points per segment (8 = good balance).
function densifyBezierQ3D(points, samples = 8) {
  if (points.length < 3) return points.map((p) => p.slice())
  const out = [points[0].slice()]
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = points[i - 1]
    const p1 = points[i]
    const p2 = points[i + 1]
    const m0 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2]
    const m1 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2]
    for (let s = 1; s <= samples; s++) {
      const t = s / samples
      const u = 1 - t
      out.push([
        u * u * m0[0] + 2 * u * t * p1[0] + t * t * m1[0],
        u * u * m0[1] + 2 * u * t * p1[1] + t * t * m1[1],
        u * u * m0[2] + 2 * u * t * p1[2] + t * t * m1[2],
      ])
    }
  }
  out.push(points[points.length - 1].slice())
  return out
}

// Split a point array into continuous legs wherever the gap between
// consecutive points exceeds `thresholdFt`. Returns an array of arrays.
function splitAtGaps(points, thresholdFt) {
  if (!points || points.length < 2) return [points || []]
  const legs = []
  let leg = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const d = dist3dFt(points[i - 1], points[i])
    if (d > thresholdFt) {
      if (leg.length >= 2) legs.push(leg)
      leg = []
    }
    leg.push(points[i])
  }
  if (leg.length >= 2) legs.push(leg)
  return legs.length ? legs : [[]]
}

function thinTrack(points, gapFt = 3000) {
  if (!points || points.length < 10) return points
  // 1. Split at data gaps so nothing downstream connects across dropouts.
  const legs = splitAtGaps(points, gapFt)
  // 2. Per-leg: smooth corners → DP thin → bezierQ re-densify with altitude.
  const out = []
  for (const leg of legs) {
    if (leg.length < 3) { out.push(...leg); continue }
    const thinned = thinDP(movingAverageLL(leg, 5), 140)
    const dense = densifyBezierQ3D(thinned, 8)
    out.push(...dense)
  }
  return out
}

function buildPathIndex(latLons) {
  const cum = [0]
  const segFt = [0]
  for (let i = 1; i < latLons.length; i++) {
    const a = latLons[i - 1]
    const b = latLons[i]
    const dLat = (b[0] - a[0]) * FT_PER_DEG_LAT
    const dLon = (b[1] - a[1]) * FT_PER_DEG_LAT * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180)
    const seg = Math.hypot(dLat, dLon)
    segFt.push(seg)
    cum.push(cum[cum.length - 1] + seg)
  }
  return { cum, segFt, total: cum[cum.length - 1] }
}

// Segment length that a given along-path distance falls within. Used to
// detect data gaps during animation (a plane whose current segment is
// unusually long is sitting inside a missing-data stretch).
function segmentLenAtDist(pathIndex, distFt) {
  const { cum, segFt } = pathIndex
  if (cum.length < 2) return 0
  if (distFt <= 0) return segFt[1] || 0
  if (distFt >= cum[cum.length - 1]) return segFt[segFt.length - 1]
  let lo = 0, hi = cum.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= distFt) lo = mid; else hi = mid
  }
  return segFt[hi] || 0
}

function positionOnPath(latLons, index, distFt) {
  const { cum, total } = index
  if (latLons.length === 0) return { lat: 0, lon: 0, heading: 0 }
  if (distFt <= 0) return { lat: latLons[0][0], lon: latLons[0][1], heading: 0 }
  if (distFt >= total) {
    const last = latLons[latLons.length - 1]
    const prev = latLons[latLons.length - 2] || last
    return { lat: last[0], lon: last[1], heading: bearing(prev, last) }
  }
  let lo = 0, hi = cum.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= distFt) lo = mid; else hi = mid
  }
  const a = latLons[lo]
  const b = latLons[hi]
  const segLen = cum[hi] - cum[lo]
  const t = segLen > 0 ? (distFt - cum[lo]) / segLen : 0
  return {
    lat: a[0] + (b[0] - a[0]) * t,
    lon: a[1] + (b[1] - a[1]) * t,
    heading: bearing(a, b),
  }
}

// Build a directional footprint polygon for one noise source.
// Aircraft engines radiate broadside more than fore/aft, so the shape is an
// ellipse with its major axis perpendicular to travel. `gain` (0..1) pinches
// the fore/aft axis: 0 = circle, 1 = fully collapsed along travel.
// Total radiated "area" is kept roughly constant (semi_minor grows a touch
// to compensate for the pinched semi_major) so gain changes redirect energy
// rather than add or remove it.
function ellipseFootprint(lat, lon, radiusM, headingDeg, gain, steps = 28) {
  const g = Math.max(0, Math.min(0.95, gain))
  const foreAftShrink = 1 - g * 0.85
  const sideBoost = 1 / Math.sqrt(Math.max(0.1, foreAftShrink))
  const a = radiusM * sideBoost        // side (semi-major, perpendicular to heading)
  const b = radiusM * foreAftShrink * sideBoost  // fore/aft (semi-minor)
  const hdgRad = ((headingDeg || 0) * Math.PI) / 180
  const cosH = Math.cos(hdgRad)
  const sinH = Math.sin(hdgRad)
  const mPerDegLat = 111320
  const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180)
  const ring = new Array(steps)
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI
    // Local ellipse: x = fore/aft (b), y = side (a). heading points along +x.
    const lx = b * Math.cos(t)
    const ly = a * Math.sin(t)
    // Rotate so local +x aligns with the compass heading (north = 0, CW).
    // East = +lon, North = +lat. Compass heading h means the travel vector
    // has dLat = cos(h), dLon = sin(h). So a local (lx, ly) maps to:
    //   dLat = lx*cos(h) - ly*sin(h)
    //   dLon = lx*sin(h) + ly*cos(h)
    const dLat = lx * cosH - ly * sinH
    const dLon = lx * sinH + ly * cosH
    ring[i] = [lat + dLat / mPerDegLat, lon + dLon / mPerDegLon]
  }
  return ring
}

function makePlaneIcon(heading, color, size = 22) {
  const sz = Math.max(8, Math.min(60, Math.round(size)))
  return L.divIcon({
    className: 'impact-plane',
    iconSize: [sz, sz],
    iconAnchor: [sz / 2, sz / 2],
    html: `
      <div style="transform: rotate(${heading || 0}deg); width:${sz}px; height:${sz}px;">
        <svg viewBox="0 0 24 24" width="${sz}" height="${sz}" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2 L14 10 L22 12 L14 14 L13 22 L12 18 L11 22 L10 14 L2 12 L10 10 Z"
                fill="${color}" stroke="#0f172a" stroke-width="1" stroke-linejoin="round"/>
        </svg>
      </div>
    `,
  })
}

// ─── Noise impact model ──────────────────────────────────────────────────────
// HP-to-intensity calibration. Intensity is hp / (π·r²) in HP / m². The
// log-normalized scalar (0..1) is mapped so that the user's reference
// aircraft/altitude sits at scalar = 0.5 (neutral). `logLo`..`logHi`
// defines the full cool→hot range on the log10 axis.
//
// Default reference (see DEFAULT_PARAMS): a 172 cruising at pattern
// altitude (80 HP, 1000 ft AGL, radiusScale 1.0) → neutral.
function calibrationBounds(refHp, refAglFt, radiusScale, spanDecades) {
  const refR = Math.max(1, refAglFt * 0.3048 * radiusScale)
  const refI = Math.max(1e-10, refHp / (Math.PI * refR * refR))
  const logMid = Math.log10(refI)
  return {
    logLo: logMid - spanDecades / 2,
    logHi: logMid + spanDecades / 2,
    logMid,
  }
}

// Nested-ellipse gradient rings, outer → inner. Each blob is drawn as this
// many concentric ellipses at fractional radii; the inner rings are
// physically closer to the source so their hp/(π·r²) intensity is higher
// and they naturally render warmer than the outer rings.
const IMPACT_RING_FRACTIONS = [1.0, 0.75, 0.55, 0.38, 0.22]

function hpIntensityScalar(hp, radiusM, logLo, logHi) {
  if (hp <= 0 || radiusM <= 0) return 0
  const intensity = hp / (Math.PI * radiusM * radiusM)
  const lg = Math.log10(Math.max(1e-10, intensity))
  const span = logHi - logLo
  if (span <= 0) return 0.5
  return Math.max(0, Math.min(1, (lg - logLo) / span))
}

// Compute per-track-point ground impact. Pairs each track point with its
// HP draw (from the energy profile) and turns it into a footprint: radius
// from AGL, color scalar from HP density via `hpIntensityScalar`, opacity
// scaled by that same scalar so quiet points fade into the map and loud
// ones dominate.
function computeLoudnessPerPoint(points, params, perPoint, bounds) {
  const { radiusScale, baseOpacity, opacityMult } = params
  const { logLo, logHi } = bounds
  const out = new Array(points.length)
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const prev = points[Math.max(0, i - 1)]
    const next = points[Math.min(points.length - 1, i + 1)]
    const agl = Math.max(0, p[2] - terrainAt(p[0], p[1]))
    if (agl < 50) { out[i] = null; continue }
    const radius_m = Math.max(1, agl * 0.3048 * radiusScale)
    const hp = (perPoint && perPoint[i] && perPoint[i].hp) || 0
    const scalar = hpIntensityScalar(hp, radius_m, logLo, logHi)
    // Floor keeps quiet (blue) points visible at pattern altitude; loud
    // points ramp up linearly above that floor.
    const floor = baseOpacity * opacityMult * 0.5
    const opacity = Math.min(0.95, floor + baseOpacity * opacityMult * scalar * 4)
    if (opacity <= 0) { out[i] = null; continue }
    out[i] = {
      lat: p[0],
      lon: p[1],
      radius_m,
      opacity,
      alt: p[2],
      scalar,
      hp,
      heading: bearing(prev, next),
    }
  }
  return out
}

// Thermal green → yellow → orange → red color for a 0..1 loudness value.
function loudnessColor(t) {
  const c = Math.max(0, Math.min(1, t))
  const hue = 120 - 120 * c
  return `hsl(${hue}, 85%, 50%)`
}

// Rasterize the blob list into a real per-cell energy accumulator, then
// colorize on a log scale with the same calibration the rest of the app
// uses. Returns { dataUrl, bounds } or null if there's nothing to draw.
//
// Why not just render nested Polygons? Leaflet's RGBA blending gives you
// "sort of" accumulation — overlapping transparent fills add up visually,
// but the math is wrong (each layer blocks some of the layer below), and
// the color scale is applied PER blob rather than to the total energy. A
// real raster fixes both: one energy value per cell = hp/(π·r_eff²) from
// every splat that touches it, summed, then log-normalized once at the
// end.
// Turbo-inspired multi-stop palette. 10 stops give enough discrimination
// that a 3× accumulation over a 1× accumulation doesn't both read "red".
// RGB tuples, cool → hot.
const ACCUM_PALETTE = [
  [  8,  30, 95 ],  // deep navy
  [ 25,  80,170 ],  // blue
  [ 30,160,200 ],  // cyan
  [ 40,190,140 ],  // teal
  [100,210, 80 ],  // lime
  [200,220, 40 ],  // yellow
  [245,185, 40 ],  // orange
  [240,120, 30 ],  // dark orange
  [225, 50, 40 ],  // red
  [160,  0, 40 ],  // crimson
]

function paletteLookup(t) {
  const c = Math.max(0, Math.min(1, t))
  const pos = c * (ACCUM_PALETTE.length - 1)
  const i = pos | 0
  const f = pos - i
  const a = ACCUM_PALETTE[i]
  const b = ACCUM_PALETTE[Math.min(ACCUM_PALETTE.length - 1, i + 1)]
  return [
    (a[0] + (b[0] - a[0]) * f) | 0,
    (a[1] + (b[1] - a[1]) * f) | 0,
    (a[2] + (b[2] - a[2]) * f) | 0,
  ]
}

function rasterizeImpact(blobs, gridW, gridH, latMin, latMax, lonMin, lonMax, bounds, gain, scaleCfg) {
  if (!blobs.length) return null
  const mPerDegLat = 111320
  const mPerDegLon = 111320 * Math.cos(((latMin + latMax) / 2) * Math.PI / 180)
  const dLat = latMax - latMin
  const dLon = lonMax - lonMin
  if (dLat <= 0 || dLon <= 0) return null
  const mPerPxY = (dLat * mPerDegLat) / gridH
  const mPerPxX = (dLon * mPerDegLon) / gridW
  const energy = new Float32Array(gridW * gridH)
  const g = Math.max(0, Math.min(0.95, gain))
  const foreAftShrink = 1 - g * 0.85
  const sideBoost = 1 / Math.sqrt(Math.max(0.1, foreAftShrink))

  for (const b of blobs) {
    if (!b || b.hp <= 0) continue
    const cxNorm = (b.lon - lonMin) / dLon
    const cyNorm = (latMax - b.lat) / dLat
    const cx = cxNorm * gridW
    const cy = cyNorm * gridH
    const a = b.radius_m * sideBoost            // side (semi-major)
    const bMinor = b.radius_m * foreAftShrink * sideBoost  // fore/aft
    // Pixel footprint bounding box, padded by 1 to catch edge cells.
    const rPxMax = Math.max(a / mPerPxX, a / mPerPxY) + 1
    const x0 = Math.max(0, Math.floor(cx - rPxMax))
    const x1 = Math.min(gridW - 1, Math.ceil(cx + rPxMax))
    const y0 = Math.max(0, Math.floor(cy - rPxMax))
    const y1 = Math.min(gridH - 1, Math.ceil(cy + rPxMax))
    const hdgRad = ((b.heading || 0) * Math.PI) / 180
    const cosH = Math.cos(hdgRad)
    const sinH = Math.sin(hdgRad)
    // Peak energy density at the source (hp / (π · r²)) in HP / m². Each
    // cell accumulates a share of this, scaled by a quadratic falloff
    // from the center to the edge of the directional ellipse.
    const peakDensity = b.hp / (Math.PI * b.radius_m * b.radius_m)
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        // World offset from center in meters (east, south).
        const dxE = (px + 0.5 - cx) * mPerPxX
        const dyS = (py + 0.5 - cy) * mPerPxY
        // Convert to (dLat_m, dLon_m) in compass axes. py is south-down;
        // north is -dyS.
        const worldDLat = -dyS
        const worldDLon = dxE
        // Rotate into aircraft-local frame (fore-aft = x, side = y).
        // Inverse of the rotation used in ellipseFootprint.
        const lx =  worldDLat * cosH + worldDLon * sinH
        const ly = -worldDLat * sinH + worldDLon * cosH
        // Normalized distance in the directional ellipse.
        const nx = lx / Math.max(0.1, bMinor)
        const ny = ly / Math.max(0.1, a)
        const d2 = nx * nx + ny * ny
        if (d2 >= 1) continue
        // Quadratic falloff — hottest at the center (where the plane is),
        // coldest at the rim. Integrates to roughly hp/2 over the disk.
        const falloff = 1 - d2
        energy[py * gridW + px] += peakDensity * falloff
      }
    }
  }

  // ─── Stage 2: colorize ────────────────────────────────────────────
  // Two modes: auto-range (p1/p99 of nonzero cells, natural log) OR a
  // fixed-scale mode driven by `scaleCfg.logLo` / `scaleCfg.logHi`
  // (log10 values, so they're readable & copy-pasteable in the UI). The
  // auto-range path still computes the observed range and returns it in
  // stats so the UI can echo the live values back to the user.
  const nonZero = []
  for (let i = 0; i < energy.length; i++) {
    if (energy[i] > 0) nonZero.push(energy[i])
  }
  nonZero.sort((x, y) => x - y)
  const loObs = nonZero.length ? nonZero[Math.floor(nonZero.length * 0.01)] : 0
  const hiObs = nonZero.length ? nonZero[Math.floor(nonZero.length * 0.99)] : 1
  const loObsLog10 = Math.log10(Math.max(1e-12, loObs))
  const hiObsLog10 = Math.log10(Math.max(1e-12, hiObs))
  let loL, hiL
  if (scaleCfg && scaleCfg.autoRange === false) {
    // Fixed scale — interpret cfg values as log10. Convert to natural
    // log to match Math.log(e) used below.
    loL = scaleCfg.logLo * Math.LN10
    hiL = scaleCfg.logHi * Math.LN10
  } else {
    loL = Math.log(Math.max(1e-12, loObs))
    hiL = Math.log(Math.max(1e-12, hiObs))
  }
  const span = Math.max(0.01, hiL - loL)

  // Palette LUT (256 entries → 10 stops interpolated).
  const LUT_SIZE = 256
  const lutR = new Uint8Array(LUT_SIZE)
  const lutG = new Uint8Array(LUT_SIZE)
  const lutB = new Uint8Array(LUT_SIZE)
  for (let k = 0; k < LUT_SIZE; k++) {
    const [r, g, b] = paletteLookup(k / (LUT_SIZE - 1))
    lutR[k] = r; lutG[k] = g; lutB[k] = b
  }

  const canvas = document.createElement('canvas')
  canvas.width = gridW
  canvas.height = gridH
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(gridW, gridH)
  const data = img.data
  for (let i = 0; i < energy.length; i++) {
    const e = energy[i]
    if (e <= 0) {
      data[i * 4 + 3] = 0
      continue
    }
    const lg = Math.log(e)
    let s = (lg - loL) / span
    if (s < 0) s = 0; else if (s > 1) s = 1
    const k = (s * (LUT_SIZE - 1)) | 0
    data[i * 4 + 0] = lutR[k]
    data[i * 4 + 1] = lutG[k]
    data[i * 4 + 2] = lutB[k]
    // Alpha ramps through the bottom third of the palette (0 → full), then
    // stays solid above it. This makes the edges of the accumulator fade
    // smoothly into the basemap while busy areas stay opaque.
    const alphaT = s < (1 / 3) ? s * 3 : 1
    data[i * 4 + 3] = (alphaT * 230) | 0
  }
  ctx.putImageData(img, 0, 0)
  return {
    dataUrl: canvas.toDataURL('image/png'),
    latLngBounds: [[latMin, lonMin], [latMax, lonMax]],
    stats: {
      loRaw: loObs,
      hiRaw: hiObs,
      loLog10: loObsLog10,
      hiLog10: hiObsLog10,
      cells: nonZero.length,
      blobs: blobs.length,
    },
  }
}

function hslToRgb(h, s, l) {
  let r, g, b
  if (s === 0) {
    r = g = b = l
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1
      if (t > 1) t -= 1
      if (t < 1 / 6) return p + (q - p) * 6 * t
      if (t < 1 / 2) return q
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
      return p
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1 / 3)
  }
  return { r: Math.round(r * 255), gC: Math.round(g * 255), bC: Math.round(b * 255) }
}

// Bipolar blue → white → red for a -1..+1 value. Negative = cool, positive
// = warm, zero = neutral. Used for "is the plane going faster or slower
// than its recent average" and for climb-vs-descent track shading.
function bipolarColor(t) {
  const c = Math.max(-1, Math.min(1, t))
  if (c >= 0) {
    // 0 → white, 1 → deep red
    const hue = 15
    const light = 95 - 45 * c
    return `hsl(${hue}, 90%, ${light}%)`
  }
  // 0 → white, -1 → deep blue
  const hue = 210
  const light = 95 + 45 * c
  return `hsl(${hue}, 90%, ${light}%)`
}

// ─── Aircraft power ratings ──────────────────────────────────────────────────
// ICAO type code → rated horsepower. For piston singles this is the straight
// POH number. For turboprops and jets it's an HP-equivalent used only for
// relative scaling (real noise scales more with SHP / thrust / BPR than
// with raw HP, so jets will render "quieter" than they really are here).
const AIRCRAFT_HP = {
  C152: 110, C172: 160, C72R: 195, C182: 230, C206: 300, C210: 300,
  P28A: 160, P28B: 180, PA28: 180, P28R: 200, PA46: 350, PA44: 360,
  PA25: 235,  // Pawnee tow plane
  DV20: 80, DA20: 125, DA40: 180, DA42: 340,
  SR20: 200, SR22: 310, S22T: 315,
  M20P: 200, M20J: 201, M20K: 220,
  BE33: 285, BE35: 285, BE36: 300, BE55: 260, BE58: 600, BE76: 360,
  BE9L: 575, BE95: 360, BE40: 2850,
  C25A: 1500, C25B: 1500, C25C: 1700, C501: 1000, C525: 1900, C551: 850,
  C560: 2100, C56X: 2600, C680: 3600, C68A: 4000, C750: 4800,
  CL30: 8700, CL35: 9200, CL60: 9200,
  GALX: 9100, G200: 9100, H25B: 7000, LJ40: 6500, LJ60: 7600,
  E55P: 3200, E50P: 1900,
  SF50: 1846,
  TBM7: 700, TBM8: 850, TBM9: 850, PC12: 1200, PC24: 3400,
  DHC6: 1240,
  R22: 124, R44: 245, R66: 320,
  AS50: 847, AS55: 1010, AS65: 1236, AS21: 847,
  EC20: 847, EC30: 847, EC35: 1000, EC45: 1800,
  B06: 420, B407: 813, B429: 1400,
  H500: 420, S76: 1500, S92: 5000,
  BD7T: 600, BDOG: 156, VL3: 100, LGEZ: 180, LONG: 150,
  // Unpowered sailplanes — airframe noise only, treat as zero HP so they
  // deposit no energy into the accumulator.
  GLID: 0, AS20: 0, AS21: 0, AS26: 0, AS31: 0,
  DG10: 0, DG15: 0, DG80: 0, DG1T: 0,
  DISC: 0, VENT: 0, NIMB: 0, JS1J: 0, ASTR: 0,
  _default: 180,
}
function lookupHp(typeCode) {
  if (!typeCode) return AIRCRAFT_HP._default
  const v = AIRCRAFT_HP[typeCode.toUpperCase()]
  // `??` so a legitimate 0 (gliders) isn't replaced by the default.
  return v ?? AIRCRAFT_HP._default
}

// Scan the track for the best sustained climb window (≥60 s of continuous
// climb) and return its mean fpm and mean airspeed. This is what the
// aircraft's engine can ACTUALLY do; we use it as the max-power reference
// for everything else.
function calibrateMaxClimb(points, samplePeriodS, windowS = 60) {
  if (!points || points.length < 3) {
    return { maxClimbFpm: 700, climbSpeedKt: 74 } // C172 POH fallback
  }
  const perWindow = Math.max(2, Math.round(windowS / samplePeriodS))
  let bestFpm = 0
  let bestVKt = 70
  const limit = Math.min(points.length, points.length - 1)
  for (let i = perWindow; i < limit; i++) {
    const dAlt = points[i][2] - points[i - perWindow][2]
    if (dAlt <= 0) continue
    const fpm = dAlt / (windowS / 60)
    if (fpm > bestFpm) {
      bestFpm = fpm
      let s = 0, n = 0
      for (let j = i - perWindow + 1; j <= i; j++) {
        const a = points[j - 1]
        const b = points[j]
        const dLat = (b[0] - a[0]) * FT_PER_DEG_LAT
        const dLon = (b[1] - a[1]) * FT_PER_DEG_LAT * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180)
        s += Math.hypot(dLat, dLon)
        n++
      }
      const meanSegLen = n > 0 ? s / n : 0
      bestVKt = (meanSegLen / samplePeriodS) / FT_PER_SEC_PER_KT
    }
  }
  // Floor so we always have a sensible reference even on tracks with no
  // sustained climb (transit flights etc.)
  if (bestFpm < 100) bestFpm = 600
  if (bestVKt < 30) bestVKt = 70
  return { maxClimbFpm: bestFpm, climbSpeedKt: bestVKt }
}

// Percentile helper on a pre-computed array slice.
function percentile(arr, p) {
  if (!arr.length) return 0
  const sorted = arr.slice().sort((a, b) => a - b)
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)))
  return sorted[idx]
}

// Engine-state estimator. Returns a 0..1 HP fraction given one point's
// observed state + track-level reference stats. Rules (in priority order):
//
//   ON GROUND (agl < 50 ft):
//     accelerating hard  → 1.0 (takeoff roll)
//     decelerating hard  → 0.1 (landing rollout / braking)
//     otherwise          → 0.15..0.35 interpolated (taxi)
//
//   AIRBORNE:
//     climbFrac = max(0, avgFpm / maxClimbFpm)         in [0..1]
//     speedFrac = (avgVKt / vMaxKt)²                   in [0..1]  (drag ~ v²)
//     power     = max(climbFrac, speedFrac)
//
//     if descending at ~idle rate, decay toward 0.1.
//
// The rationale: a C172 bolted to max climb at best-rate speed is using
// every horse it has; a C172 level at redline is also using every horse
// (just burning it on parasite drag); a C172 gliding down at 600 fpm idle
// is using ~10%.
function estimateEnginePower(avgFpm, avgVKt, speedDeltaKt, onGround, stats) {
  const { maxClimbFpm, vMaxKt, maxGroundAccelKt, maxGroundDecelKt, idleDescentFpm } = stats
  if (onGround) {
    if (maxGroundAccelKt > 0 && speedDeltaKt > 0.25 * maxGroundAccelKt) {
      // Takeoff roll — map accel up to full.
      const t = Math.min(1, speedDeltaKt / Math.max(0.001, maxGroundAccelKt))
      return 0.5 + 0.5 * t
    }
    if (maxGroundDecelKt < 0 && speedDeltaKt < 0.25 * maxGroundDecelKt) {
      return 0.1 // braking / landing rollout
    }
    // Taxi / slow ground movement.
    return 0.15 + 0.1 * Math.min(1, Math.abs(speedDeltaKt) / 2)
  }
  const climbFrac = Math.max(0, avgFpm / Math.max(1, maxClimbFpm))
  const speedFrac = Math.pow(Math.max(0, avgVKt) / Math.max(1, vMaxKt), 2)
  let power = Math.max(climbFrac, speedFrac)
  if (avgFpm < 0) {
    // Descending: blend toward idle floor. Full idle descent (≥ idleDescentFpm
    // down) → 0.1; less aggressive descents mix in the cruise drag term.
    const idleness = Math.min(1, -avgFpm / Math.max(50, idleDescentFpm))
    power = power * (1 - 0.7 * idleness) + 0.1 * idleness
  }
  return Math.max(0.05, Math.min(1, power))
}

// Build a per-point energy profile. Uses the aircraft type to set rated HP,
// auto-calibrates max-climb + climb-speed from the track itself, and emits
// a per-point `energy` = fraction of rated HP being used right now.
//
// Per point:
//   vKt           ground-speed (knots) — 10s window mean
//   fpmWeighted   vertical speed (75% recent 10 s / 25% prior 10 s)
//   speedDeltaKt  Δ ground-speed between recent and prior 10 s windows
//   energy        HP fraction via computeSegmentPowerFraction
//   hp            absolute HP burned (for the HUD)
//
// Global:
//   cfg           { ratedHp, maxClimbFpm, climbSpeedKt, vCruiseKt, vFastKt, ... }
//   avgClimbFpm   mean fpm over climbing points
//   avgAccelKt    mean Δv over accelerating points
function buildEnergyProfile(points, samplePeriodS, typeCode) {
  if (!points || points.length < 3) {
    return { perPoint: [], cfg: null, avgClimbFpm: 0, avgAccelKt: 0 }
  }
  const ratedHp = lookupHp(typeCode)
  const cal = calibrateMaxClimb(points, samplePeriodS)
  const perWindow = Math.max(2, Math.round(10 / samplePeriodS))
  // Sliding-window size for the display averages (20 s trailing).
  const avgWindow = Math.max(2, Math.round(20 / samplePeriodS))

  // Segment lengths (ft) between i-1 and i. seg[0] = 0.
  const seg = new Array(points.length).fill(0)
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const dLat = (b[0] - a[0]) * FT_PER_DEG_LAT
    const dLon = (b[1] - a[1]) * FT_PER_DEG_LAT * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180)
    seg[i] = Math.hypot(dLat, dLon)
  }
  // Instant ground speed (kt) at each point = segment length / period
  const vKt = seg.map((s) => s / samplePeriodS / FT_PER_SEC_PER_KT)

  // ── Track-level reference stats ─────────────────────────────────────
  // "Ground" ≈ altitude within 50 ft of the track's minimum altitude; the
  // historical data has no field-elev column so we infer the airport floor
  // from the track itself. Works for arrivals/departures/pattern work.
  let minAlt = Infinity
  for (const p of points) if (p[2] < minAlt) minAlt = p[2]
  const isGround = (i) => (points[i][2] - minAlt) < 50

  // Single-sample accelerations (vKt[i] - vKt[i-1]) for ground phases —
  // used to find takeoff / braking reference signatures. Positive = accel,
  // negative = decel.
  const airborneV = []       // airborne airspeeds above "pattern"
  const groundAccelPos = []  // accelerations while on the ground
  const groundAccelNeg = []
  const patternAglFt = 300   // "above the pattern" threshold for vMax
  for (let i = 1; i < points.length; i++) {
    const agl = points[i][2] - minAlt
    if (agl > patternAglFt && vKt[i] < 600) airborneV.push(vKt[i])
    if (isGround(i)) {
      const dv = vKt[i] - vKt[i - 1]
      if (dv > 0) groundAccelPos.push(dv)
      else if (dv < 0) groundAccelNeg.push(dv)
    }
  }
  // p95 of the fast airborne samples → "this aircraft's Vmax in this track"
  const vMaxKt = Math.max(cal.climbSpeedKt * 1.3, percentile(airborneV, 0.95))
  // p90 of positive ground accel samples → "takeoff roll"
  const maxGroundAccelKt = percentile(groundAccelPos, 0.9) || 2
  // p10 of negative ground accel samples (most negative) → "braking"
  const maxGroundDecelKt = percentile(groundAccelNeg, 0.1) || -2

  const cfg = {
    ratedHp,
    typeCode: typeCode || '?',
    maxClimbFpm: cal.maxClimbFpm,
    climbSpeedKt: cal.climbSpeedKt,
    vMaxKt,
    maxGroundAccelKt,
    maxGroundDecelKt,
    idleDescentFpm: 600,
    // Kept so older UI code doesn't crash while it still reads these.
    vCruiseKt: cal.climbSpeedKt * 1.1,
    vFastKt: vMaxKt,
  }

  const perPoint = new Array(points.length)
  let climbSum = 0, climbN = 0
  let accelSum = 0, accelN = 0
  for (let i = 0; i < points.length; i++) {
    const recentEnd = i
    const recentStart = Math.max(0, i - perWindow)
    const olderEnd = recentStart
    const olderStart = Math.max(0, olderEnd - perWindow)
    const windowTimeMin = (perWindow * samplePeriodS) / 60
    // Weighted fpm
    const dAltRecent = points[recentEnd][2] - points[recentStart][2]
    const dAltOlder = olderStart < olderEnd
      ? points[olderEnd][2] - points[olderStart][2]
      : dAltRecent
    const fpmRecent = windowTimeMin > 0 ? dAltRecent / windowTimeMin : 0
    const fpmOlder = windowTimeMin > 0 ? dAltOlder / windowTimeMin : fpmRecent
    const fpmWeighted = 0.75 * fpmRecent + 0.25 * fpmOlder
    // Mean V over each window
    const meanV = (lo, hi) => {
      if (hi <= lo) return 0
      let s = 0, n = 0
      for (let j = lo + 1; j <= hi; j++) { s += vKt[j]; n++ }
      return n > 0 ? s / n : 0
    }
    const vRecent = meanV(recentStart, recentEnd)
    const vOlder = meanV(olderStart, olderEnd)
    const speedDeltaKt = vRecent - vOlder
    // Trailing 20 s sliding averages for display mapping + engine state.
    const avgStart = Math.max(0, i - avgWindow)
    let avgV = 0, avgN = 0
    for (let j = avgStart + 1; j <= i; j++) { avgV += vKt[j]; avgN++ }
    const averageAirspeedKt = avgN > 0 ? avgV / avgN : 0
    const avgDAlt = points[i][2] - points[avgStart][2]
    const avgMin = ((i - avgStart) * samplePeriodS) / 60
    const averageVerticalFpm = avgMin > 0 ? avgDAlt / avgMin : 0
    // New engine-state estimator — rules in `estimateEnginePower` above.
    const onGround = isGround(i)
    const energy = estimateEnginePower(
      averageVerticalFpm, averageAirspeedKt, speedDeltaKt, onGround, cfg,
    )
    const hp = energy * cfg.ratedHp
    perPoint[i] = {
      vKt: vRecent,
      fpmWeighted,
      speedDeltaKt,
      energy,
      hp,
      averageAirspeedKt,
      averageVerticalFpm,
    }
    if (fpmWeighted > 0) { climbSum += fpmWeighted; climbN++ }
    if (speedDeltaKt > 0) { accelSum += speedDeltaKt; accelN++ }
  }
  return {
    perPoint,
    cfg,
    avgClimbFpm: climbN > 0 ? climbSum / climbN : 0,
    avgAccelKt: accelN > 0 ? accelSum / accelN : 0,
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

const DEFAULT_PARAMS = {
  radiusScale: 3.0,
  baseOpacity: 0.015,
  opacityMult: 1.0,
  directionalGain: 0.6,
  suppressGaps: true,
  gapThresholdFt: 3000,
  noiseResolution: 4,
  accumAutoRange: false,
  accumLogLo: -6.90,
  accumLogHi: -0.60,
  referenceHp: 80,
  referenceAglFt: 1000,
  spanDecades: 3.0,
}

// Curated example tracks — picked to exercise the model across a useful
// range of aircraft classes. Each entry points at a `src` that should
// exist in /tracks_yearly.json from the overnight ingestion runs.
const EXAMPLE_TRACKS = [
  { label: 'Tow (PA18)',       src: 'globe/2026-02-21/a5e1df' }, // N4785F
  { label: 'C172 N52993',      src: 'globe/2026-03-07/a6ae0c' }, // clean 1212 ft pattern
  { label: 'C172 N3547L',      src: 'globe/2026-01-07/a3f701' }, // 2928 pts, 96% low AGL
  { label: 'C172 N2168D',      src: 'globe/2023-10-07/a1d340' }, // 1042 pts, 100% pattern-low
  { label: 'C172 N9222H',      src: 'globe/2025-01-15/acc83e' }, // 961 pts
  { label: 'C172 N24280',      src: 'globe/2024-11-15/a23af6' }, // 891 pts
  { label: 'Glider',           src: 'globe/2026-01-01/a64dca' }, // N505PB
  { label: 'Citation X',       src: 'globe/2023-09-15/ac838f' }, // N905UP
]

export default function NoiseImpactTest() {
  const [data, setData] = useState(null)
  const [selectedSrc, setSelectedSrc] = useState(null)
  // Additional tracks overlaid into the static raster (primary track
  // still drives animation, polyline, HUD, stats). Clicking a chip in
  // "overlay" mode adds or removes the track here.
  const [overlaySrcs, setOverlaySrcs] = useState(() => new Set())
  const [lastRasterStats, setLastRasterStats] = useState(null)
  const [params, setParams] = useState(DEFAULT_PARAMS)
  // Second, debounced copy of params used by the expensive memos (the
  // raster accumulator especially). The sliders write `params` immediately
  // so the UI stays responsive; 180 ms after the last change we copy the
  // whole snapshot into `committedParams` and the heavy work re-runs once.
  const [committedParams, setCommittedParams] = useState(DEFAULT_PARAMS)
  const commitTimerRef = useRef(null)
  useEffect(() => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current)
    commitTimerRef.current = setTimeout(() => setCommittedParams(params), 180)
    return () => {
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current)
    }
  }, [params])
  const [showZones, setShowZones] = useState(true)
  const [showRawTrack, setShowRawTrack] = useState(false)
  const [animating, setAnimating] = useState(false)
  const [speedMult, setSpeedMult] = useState(3)        // × data speed
  const [planeCount, setPlaneCount] = useState(5) // planes in the train (1..20)
  const [samplePeriodS, setSamplePeriodS] = useState(1)   // assumed s between points
  const [distAlong, setDistAlong] = useState(0)

  const set = (k) => (v) => setParams((p) => ({ ...p, [k]: v }))

  useEffect(() => {
    fetch('/tracks_yearly.json')
      .then((r) => r.json())
      .then(setData)
      .catch((e) => console.error(e))
  }, [])

  // Only the four curated example tracks — one per aircraft class. The
  // combo is kept in the same order as EXAMPLE_TRACKS so the labels line
  // up with the quick-pick button row below the selector.
  const candidates = useMemo(() => {
    if (!data?.tracks) return []
    const bySrc = new Map(data.tracks.map((t) => [t.src, t]))
    return EXAMPLE_TRACKS
      .map((ex) => {
        const t = bySrc.get(ex.src)
        return t ? { ...t, _exampleLabel: ex.label } : null
      })
      .filter(Boolean)
  }, [data])

  useEffect(() => {
    if (candidates.length && !selectedSrc) setSelectedSrc(candidates[0].src)
  }, [candidates, selectedSrc])

  const track = useMemo(
    () => candidates.find((t) => t.src === selectedSrc) || null,
    [candidates, selectedSrc],
  )

  const rawPoints = track?.points || []
  const thinnedPoints = useMemo(
    () => thinTrack(rawPoints, params.gapThresholdFt),
    [rawPoints, params.gapThresholdFt],
  )
  // A/B toggle: raw (before) vs thinned (after). Switches the entire
  // pipeline — energy profile, loudness, raster, polyline, animation.
  const points = showRawTrack ? rawPoints : thinnedPoints

  // Energy profile per point + cfg/avg. Recomputed when the track, sample
  // period, or aircraft type changes. The track's own `type` field drives
  // the rated-HP lookup.
  const energyProfile = useMemo(
    () => buildEnergyProfile(points, samplePeriodS, track?.type),
    [points, samplePeriodS, track?.type],
  )

  // Calibration bounds from the reference (hp, agl). Scalar = 0.5 sits
  // at (referenceHp, referenceAglFt) — that aircraft/altitude combo reads
  // as neutral white on the map.
  const impactBounds = useMemo(
    () => calibrationBounds(
      committedParams.referenceHp, committedParams.referenceAglFt,
      committedParams.radiusScale, committedParams.spanDecades,
    ),
    [committedParams.referenceHp, committedParams.referenceAglFt, committedParams.radiusScale, committedParams.spanDecades],
  )

  // Per-point ground impact — indices line up with `points`. Feeds the
  // static aggregate heatmap and the animated per-plane footprints. Reads
  // `committedParams` so dragging a slider doesn't re-run this path on
  // every mouse tick; it waits for the user to settle.
  const loudnessPts = useMemo(
    () => computeLoudnessPerPoint(points, committedParams, energyProfile.perPoint, impactBounds),
    [points, committedParams, energyProfile, impactBounds],
  )
  const staticBlobs = useMemo(() => loudnessPts.filter((b) => b != null), [loudnessPts])

  // Per-overlay-track blobs. Each overlay track runs through the same
  // energy-profile → loudness pipeline as the primary, but uses that
  // track's own `points` and `type`. The results are flattened into
  // `combinedBlobs` which feeds the static raster. Overlay does not
  // drive animation, HUD, or polyline — the primary track still owns
  // those.
  const overlayBlobs = useMemo(() => {
    if (!candidates.length || overlaySrcs.size === 0) return []
    const out = []
    for (const src of overlaySrcs) {
      if (src === selectedSrc) continue // don't double-count the primary
      const t = candidates.find((c) => c.src === src)
      if (!t) continue
      const pts = showRawTrack ? (t.points || []) : thinTrack(t.points || [], committedParams.gapThresholdFt)
      if (pts.length < 3) continue
      const prof = buildEnergyProfile(pts, samplePeriodS, t.type)
      const blobs = computeLoudnessPerPoint(pts, committedParams, prof.perPoint, impactBounds)
      for (const b of blobs) if (b) out.push(b)
    }
    return out
  }, [candidates, overlaySrcs, selectedSrc, samplePeriodS, committedParams, impactBounds, showRawTrack])

  const combinedBlobs = useMemo(
    () => (overlayBlobs.length ? staticBlobs.concat(overlayBlobs) : staticBlobs),
    [staticBlobs, overlayBlobs],
  )

  const latLons = useMemo(() => points.map((p) => [p[0], p[1]]), [points])
  const pathIndex = useMemo(() => buildPathIndex(latLons), [latLons])

  // 5-point sliding windows (i-2..i+2) over the track. Heading uses a
  // circular (vector) mean so 355°→5° doesn't average to 180°. Speed and
  // energy are plain means. The real track data is noisy — an aircraft
  // can't jink 40° of heading or swing 40 kt between consecutive ADS-B
  // pings — so we smooth everything the animation reads before rendering.
  const smoothedSeries = useMemo(() => {
    const n = latLons.length
    const heading = new Float32Array(n)
    const vKt = new Float32Array(n)
    const energy = new Float32Array(n)
    const hp = new Float32Array(n)
    if (n < 2) return { heading, vKt, energy, hp }
    // Per-segment raw bearings from latLons.
    const rawBearing = new Float32Array(n)
    for (let i = 1; i < n; i++) rawBearing[i] = bearing(latLons[i - 1], latLons[i])
    rawBearing[0] = rawBearing[1] || 0
    const perPoint = energyProfile.perPoint
    for (let i = 0; i < n; i++) {
      let sumSin = 0, sumCos = 0
      let sumV = 0, sumE = 0, sumH = 0, cnt = 0
      for (let k = -2; k <= 2; k++) {
        const j = i + k
        if (j < 0 || j >= n) continue
        const hdgRad = (rawBearing[j] * Math.PI) / 180
        sumSin += Math.sin(hdgRad)
        sumCos += Math.cos(hdgRad)
        const m = perPoint[j] || {}
        sumV += m.vKt || 0
        sumE += m.energy || 0
        sumH += m.hp || 0
        cnt++
      }
      heading[i] = (Math.atan2(sumSin, sumCos) * 180) / Math.PI
      vKt[i] = cnt > 0 ? sumV / cnt : 0
      energy[i] = cnt > 0 ? sumE / cnt : 0
      hp[i] = cnt > 0 ? sumH / cnt : 0
    }
    return { heading, vKt, energy, hp }
  }, [latLons, energyProfile])

  // Animation — plane train moves at `speedMult × data speed`, NOT a uniform
  // user-picked groundspeed. At each frame we look up the current segment's
  // actual ground speed (ft/s derived from segment length / samplePeriod)
  // and advance distAlong by that × speedMult × dt. So fast parts of the
  // flight visibly fly fast, slow parts (holding, pattern turns) visibly
  // slow down.
  const lastTsRef = useRef(null)
  useEffect(() => {
    if (!animating || pathIndex.total === 0) { lastTsRef.current = null; return }
    let raf = 0
    const tick = (ts) => {
      if (lastTsRef.current == null) lastTsRef.current = ts
      const dt = (ts - lastTsRef.current) / 1000
      lastTsRef.current = ts
      setDistAlong((d) => {
        // Find the current segment's real speed (ft/s)
        let lo = 0, hi = pathIndex.cum.length - 1
        while (lo < hi - 1) {
          const mid = (lo + hi) >> 1
          if (pathIndex.cum[mid] <= d) lo = mid; else hi = mid
        }
        const segLen = pathIndex.cum[hi] - pathIndex.cum[lo]
        const realFps = segLen / samplePeriodS
        const step = realFps * speedMult * dt
        return (d + step) % pathIndex.total
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); lastTsRef.current = null }
  }, [animating, speedMult, samplePeriodS, pathIndex])

  // Binary-search helper: lat/lon-index that's "under" a given cumulative
  // distance along the path. Used to look up per-plane loudness.
  const pointAtDist = (distFt) => {
    const { cum } = pathIndex
    if (cum.length < 2) return 0
    if (distFt <= 0) return 0
    if (distFt >= pathIndex.total) return cum.length - 1
    let lo = 0, hi = cum.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (cum[mid] <= distFt) lo = mid; else hi = mid
    }
    return lo
  }

  // Train of planes with attached loudness + energy metrics. Capped at 50
  // planes total; if the path × spacing would yield more, the effective
  // spacing auto-widens so we never exceed the cap.
  // Direct-count mode: distribute `planeCount` planes evenly along the
  // path, so the slider maps 1:1 to markers rendered.
  const spacingFt = pathIndex.total > 0 ? pathIndex.total / Math.max(1, planeCount) : 1
  const train = useMemo(() => {
    if (!animating || latLons.length < 2 || pathIndex.total === 0) return []
    const n = Math.max(1, Math.min(20, planeCount))
    const out = []
    for (let i = 0; i < n; i++) {
      const d = (((distAlong - i * spacingFt) % pathIndex.total) + pathIndex.total) % pathIndex.total
      const inGap = segmentLenAtDist(pathIndex, d) > params.gapThresholdFt
      const pos = positionOnPath(latLons, pathIndex, d)
      const idx = pointAtDist(d)
      const blob = loudnessPts[idx]
      const m = energyProfile.perPoint[idx] || {}
      // Replace raw per-segment heading/speed/power with the 5-point
      // smoothed series so the animation doesn't jerk on noisy data.
      const smoothHeading = smoothedSeries.heading[idx]
      const smoothV = smoothedSeries.vKt[idx]
      const smoothE = smoothedSeries.energy[idx]
      const smoothHp = smoothedSeries.hp[idx]
      out.push({
        ...pos,
        heading: smoothHeading,
        inGap,
        radius_m: blob ? blob.radius_m : 0,
        opacity: blob ? blob.opacity : 0,
        alt: blob ? blob.alt : 0,
        vKt: smoothV,
        fpmWeighted: m.fpmWeighted || 0,
        speedDeltaKt: m.speedDeltaKt || 0,
        energy: smoothE,
        hp: smoothHp,
        averageAirspeedKt: smoothV,
        averageVerticalFpm: m.averageVerticalFpm || 0,
      })
    }
    return out
  }, [latLons, pathIndex, distAlong, animating, spacingFt, planeCount, loudnessPts, energyProfile, smoothedSeries, params.gapThresholdFt])

  // Rasterized accumulation: sum real energy per ground cell across every
  // static blob, then log-normalize + colorize once. This replaces the
  // old stack-of-polygons aggregate which was using Leaflet's RGBA blend
  // as a (bad) stand-in for real accumulation.
  const staticRaster = useMemo(() => {
    if (animating || !combinedBlobs.length) return null
    // Upsample: insert `noiseResolution - 1` interpolated sub-blobs between
    // each consecutive pair of real blobs. Headings average circularly.
    // Each sub-blob's deposit is divided by `noiseResolution` so the
    // total energy integrates to the same value as the un-upsampled case —
    // we're just laying it down in more places along the track.
    const upsampled = []
    const mult = Math.max(1, Math.min(16, committedParams.noiseResolution | 0))
    const lerp = (a, b, t) => a + (b - a) * t
    const circMean = (hA, hB, t) => {
      const rA = (hA * Math.PI) / 180
      const rB = (hB * Math.PI) / 180
      const x = lerp(Math.cos(rA), Math.cos(rB), t)
      const y = lerp(Math.sin(rA), Math.sin(rB), t)
      return (Math.atan2(y, x) * 180) / Math.PI
    }
    for (let i = 0; i < combinedBlobs.length; i++) {
      const a = combinedBlobs[i]
      const b = combinedBlobs[i + 1]
      // Always keep the real sample.
      upsampled.push({ ...a, hp: a.hp / mult })
      if (!b || mult <= 1) continue
      // Skip interpolation across large data gaps (≥ threshold): joining
      // two distant points with a line of fresh splats would invent
      // flyovers that never happened.
      const mPerDegLat = 111320
      const mPerDegLon = 111320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180)
      const dxM = (b.lon - a.lon) * mPerDegLon
      const dyM = (b.lat - a.lat) * mPerDegLat
      const segM = Math.hypot(dxM, dyM)
      if (committedParams.suppressGaps && segM * 3.281 > committedParams.gapThresholdFt) continue
      for (let k = 1; k < mult; k++) {
        const t = k / mult
        upsampled.push({
          lat: lerp(a.lat, b.lat, t),
          lon: lerp(a.lon, b.lon, t),
          radius_m: lerp(a.radius_m, b.radius_m, t),
          hp: lerp(a.hp, b.hp, t) / mult,
          opacity: lerp(a.opacity, b.opacity, t),
          alt: lerp(a.alt, b.alt, t),
          heading: circMean(a.heading, b.heading, t),
          scalar: 0,  // not used by the rasterizer
        })
      }
    }
    let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity
    // Directional gain stretches the cross-axis beyond `radius_m`, so we
    // pad the bbox by the fully-expanded semi-major. sideBoost matches the
    // constant used inside rasterizeImpact/ellipseFootprint.
    const g = Math.max(0, Math.min(0.95, committedParams.directionalGain))
    const foreAftShrink = 1 - g * 0.85
    const sideBoost = 1 / Math.sqrt(Math.max(0.1, foreAftShrink))
    const padRatio = sideBoost * 1.05  // tiny extra slack for edge cells
    for (const b of upsampled) {
      const rPad = b.radius_m * padRatio
      const dLat = rPad / 111320
      const dLon = rPad / (111320 * Math.cos(b.lat * Math.PI / 180))
      if (b.lat - dLat < latMin) latMin = b.lat - dLat
      if (b.lat + dLat > latMax) latMax = b.lat + dLat
      if (b.lon - dLon < lonMin) lonMin = b.lon - dLon
      if (b.lon + dLon > lonMax) lonMax = b.lon + dLon
    }
    // Target ~500 px on the longer axis; keep aspect ratio.
    const dLat = latMax - latMin
    const dLon = lonMax - lonMin
    if (dLat <= 0 || dLon <= 0) return null
    const aspect = (dLon * Math.cos((latMin + latMax) / 2 * Math.PI / 180)) / dLat
    const targetPx = 600
    const gridW = aspect >= 1 ? targetPx : Math.max(64, Math.round(targetPx * aspect))
    const gridH = aspect >= 1 ? Math.max(64, Math.round(targetPx / aspect)) : targetPx
    return rasterizeImpact(
      upsampled, gridW, gridH, latMin, latMax, lonMin, lonMax,
      impactBounds, committedParams.directionalGain,
      {
        autoRange: committedParams.accumAutoRange,
        logLo: committedParams.accumLogLo,
        logHi: committedParams.accumLogHi,
      },
    )
  }, [animating, combinedBlobs, impactBounds, committedParams])

  // Echo the raster's observed range into a state blob so the settings
  // textarea can display/capture it. Fires once per raster build.
  useEffect(() => {
    if (staticRaster && staticRaster.stats) setLastRasterStats(staticRaster.stats)
  }, [staticRaster])

  // Aggregate exposure — sum of opacity × area over the static blobs.
  // Used in the stats panel regardless of animation state.
  const totalExposure = useMemo(() => {
    let sum = 0
    for (const b of staticBlobs) {
      const area = Math.PI * b.radius_m * b.radius_m
      sum += area * b.opacity
    }
    return sum
  }, [staticBlobs])

  return (
    <div className="h-full flex">
      <aside className="w-80 border-r border-white/10 p-3 overflow-y-auto space-y-4">
        {/* Track picker */}
        <div>
          <div className="text-xs text-white/50 uppercase tracking-wide mb-1">Track</div>
          <select
            value={selectedSrc || ''}
            onChange={(e) => setSelectedSrc(e.target.value)}
            style={{ backgroundColor: '#1f2937', color: '#e5e7eb' }}
            className="w-full border border-white/15 text-xs rounded px-2 py-1"
          >
            {candidates.map((t) => (
              <option
                key={t.src}
                value={t.src}
                style={{ backgroundColor: '#1f2937', color: '#e5e7eb' }}
              >
                {t._exampleLabel} · {t.call || '?'} · {t.type || '—'} · {t.points.length} pts
              </option>
            ))}
          </select>
          <div className="mt-1 flex flex-wrap gap-1">
            {EXAMPLE_TRACKS.map((ex) => {
              const found = candidates.find((c) => c.src === ex.src)
              const isPrimary = selectedSrc === ex.src
              const isOverlay = overlaySrcs.has(ex.src)
              return (
                <div key={ex.src} className="flex items-stretch gap-0.5">
                  <button
                    disabled={!found}
                    onClick={() => found && setSelectedSrc(found.src)}
                    className={`text-[9px] px-1.5 py-0.5 rounded-l border ${
                      isPrimary
                        ? 'border-cyan-400 text-cyan-200 bg-cyan-500/20'
                        : found
                        ? 'border-white/20 text-white/70 hover:border-white/40 hover:text-white'
                        : 'border-white/10 text-white/20 cursor-not-allowed'
                    }`}
                    title={found ? `primary: ${ex.src}` : `${ex.src} (not in current dataset)`}
                  >
                    {ex.label}
                  </button>
                  <button
                    disabled={!found || isPrimary}
                    onClick={() => {
                      setOverlaySrcs((s) => {
                        const next = new Set(s)
                        if (next.has(ex.src)) next.delete(ex.src)
                        else next.add(ex.src)
                        return next
                      })
                    }}
                    className={`text-[9px] px-1 py-0.5 rounded-r border-t border-r border-b ${
                      isOverlay
                        ? 'border-amber-400 text-amber-200 bg-amber-500/20'
                        : found && !isPrimary
                        ? 'border-white/20 text-white/40 hover:border-white/40 hover:text-white/70'
                        : 'border-white/10 text-white/10 cursor-not-allowed'
                    }`}
                    title={isOverlay ? 'remove from overlay' : 'add to overlay (accumulator only)'}
                  >
                    +
                  </button>
                </div>
              )
            })}
          </div>
          <div className="text-[9px] text-white/40 mt-0.5 italic">
            Click label = primary (drives animation, HUD, polyline).
            Click "+" = add to overlay — multiple tracks accumulate into
            the ground-impact raster.
          </div>
        </div>

        {/* Impact calibration */}
        <div className="border-t border-white/10 pt-3">
          <div className="text-xs text-white/50 uppercase tracking-wide mb-2">Impact calibration</div>
          <div className="text-[9px] text-white/40 mb-1 italic">
            The reference HP × AGL combo that reads as neutral white. Default:
            C172 cruise (80 HP) at pattern altitude (1000 ft AGL). Planes
            using more HP per unit footprint area → warmer; less → cooler.
          </div>
          <ParamSlider
            label="Reference HP"
            unit="HP"
            min={20} max={400} step={10}
            value={params.referenceHp}
            onChange={set('referenceHp')}
          />
          <ParamSlider
            label="Reference AGL"
            unit="ft"
            min={200} max={4000} step={100}
            value={params.referenceAglFt}
            onChange={set('referenceAglFt')}
          />
          <ParamSlider
            label="Span"
            unit="dec"
            min={1.5} max={5} step={0.25}
            value={params.spanDecades}
            onChange={set('spanDecades')}
            format={(v) => v.toFixed(2)}
          />
          <div className="text-[9px] text-white/40 mt-0.5 italic">
            log10 axis: neutral at{' '}
            {impactBounds.logMid.toFixed(2)}, hot above{' '}
            {impactBounds.logHi.toFixed(2)}, cold below{' '}
            {impactBounds.logLo.toFixed(2)}.
          </div>
        </div>

        {/* Raster color scale */}
        <div className="border-t border-white/10 pt-3">
          <div className="text-xs text-white/50 uppercase tracking-wide mb-2">Color scale (raster)</div>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={params.accumAutoRange}
              onChange={(e) => set('accumAutoRange')(e.target.checked)}
            />
            <span>Auto-range (p1/p99)</span>
          </label>
          <div className="text-[9px] text-white/40 mb-2 italic">
            Auto mode scales the palette to the raster's own nonzero range,
            then echoes the values below. Off = fixed scale, so two
            different tracks render on the same absolute color.
          </div>
          <ParamSlider
            label="log10 lo"
            unit=""
            min={-10} max={0} step={0.1}
            value={params.accumLogLo}
            onChange={set('accumLogLo')}
            format={(v) => v.toFixed(2)}
          />
          <ParamSlider
            label="log10 hi"
            unit=""
            min={-10} max={0} step={0.1}
            value={params.accumLogHi}
            onChange={set('accumLogHi')}
            format={(v) => v.toFixed(2)}
          />
          {lastRasterStats && (
            <div className="text-[9px] text-white/50 mt-1 font-mono">
              observed: lo={lastRasterStats.loLog10.toFixed(2)}{' '}
              hi={lastRasterStats.hiLog10.toFixed(2)}{' '}
              · {lastRasterStats.cells} cells · {lastRasterStats.blobs} blobs
              <button
                onClick={() => {
                  set('accumLogLo')(+lastRasterStats.loLog10.toFixed(2))
                  set('accumLogHi')(+lastRasterStats.hiLog10.toFixed(2))
                  set('accumAutoRange')(false)
                }}
                className="ml-1 text-cyan-300 hover:text-white underline"
              >
                pin
              </button>
            </div>
          )}
        </div>

        {/* Footprint geometry */}
        <div className="border-t border-white/10 pt-3">
          <div className="text-xs text-white/50 uppercase tracking-wide mb-2">Footprint</div>
          <ParamSlider
            label="Radius scale"
            unit="×"
            min={0.1} max={3.0} step={0.1}
            value={params.radiusScale}
            onChange={set('radiusScale')}
          />
          <div className="text-[9px] text-white/40 mt-0.5 italic">
            Radius = AGL × 0.3048 m × this. 1× = 1 ft AGL → 1 m radius.
          </div>
          <ParamSlider
            label="Base opacity"
            unit=""
            min={0.005} max={0.1} step={0.005}
            value={params.baseOpacity}
            onChange={set('baseOpacity')}
            format={(v) => v.toFixed(3)}
          />
          <ParamSlider
            label="Global opacity ×"
            unit=""
            min={0.1} max={5.0} step={0.1}
            value={params.opacityMult}
            onChange={set('opacityMult')}
          />
          <ParamSlider
            label="Directional gain"
            unit=""
            min={0} max={0.95} step={0.05}
            value={params.directionalGain}
            onChange={set('directionalGain')}
            format={(v) => v.toFixed(2)}
          />
          <div className="text-[9px] text-white/40 mt-0.5 italic">
            0 = omnidirectional circle. Higher = more side-dominant
            (engine noise radiates broadside more than fore/aft).
          </div>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer mt-2">
            <input
              type="checkbox"
              checked={params.suppressGaps}
              onChange={(e) => set('suppressGaps')(e.target.checked)}
            />
            <span>Suppress data-gap segments</span>
          </label>
          <ParamSlider
            label="Gap threshold"
            unit="ft"
            min={500} max={20000} step={500}
            value={params.gapThresholdFt}
            onChange={set('gapThresholdFt')}
          />
          <ParamSlider
            label="Noise resolution"
            unit="×"
            min={1} max={16} step={1}
            value={params.noiseResolution}
            onChange={set('noiseResolution')}
          />
          <div className="text-[9px] text-white/40 mt-0.5 italic">
            Sub-samples per track segment for the accumulator. Higher =
            smoother raster, more cells touched. Per-sample HP is divided
            by this so total deposited energy is preserved. Drop back to 1
            when rendering many aircraft at once.
          </div>
          <div className="text-[9px] text-white/40 mt-0.5 italic">
            Any segment longer than this is treated as missing data and
            hidden from the track + animated planes.
          </div>
        </div>

        {/* Animation */}
        <div className="border-t border-white/10 pt-3">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={animating}
              onChange={(e) => setAnimating(e.target.checked)}
            />
            <span>Animate plane train</span>
          </label>
          <div className="text-[10px] text-white/40 mt-0.5 italic">
            Animation replaces the aggregate heatmap with per-plane
            instantaneous footprints colored by loudness.
          </div>
          {animating && (
            <div className="mt-2 space-y-2">
              <ParamSlider
                label="Speed ×" unit="× data"
                min={1} max={10} step={1}
                value={speedMult} onChange={setSpeedMult}
              />
              <div className="text-[9px] text-white/40 italic -mt-1">
                Plane speed = real segment speed × this multiplier. 3× is
                the default — fast enough to read, slow enough to watch.
              </div>
              <ParamSlider
                label="Plane count" unit=""
                min={1} max={20} step={1}
                value={planeCount} onChange={setPlaneCount}
              />
              <ParamSlider
                label="Sample period" unit="s"
                min={0.5} max={5} step={0.5}
                value={samplePeriodS} onChange={setSamplePeriodS}
                format={(v) => v.toFixed(1)}
              />
              <div className="text-[9px] text-white/40 italic">
                Assumed seconds between historical track points. adsb.lol
                globe_history is typically 1 s; bump up if the track feels
                too "zippy" for the aircraft type. Drives fpm / airspeed
                / Δ-V calculations.
              </div>
              <div className="text-[9px] text-white/40 italic">
                {train.length} planes currently in flight
              </div>
            </div>
          )}
        </div>

        {/* Zones overlay */}
        <div className="border-t border-white/10 pt-3">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={showZones}
              onChange={(e) => setShowZones(e.target.checked)}
            />
            <span>Show noise-abatement zones</span>
          </label>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer mt-1">
            <input
              type="checkbox"
              checked={showRawTrack}
              onChange={(e) => setShowRawTrack(e.target.checked)}
            />
            <span>Use raw track (A/B)</span>
          </label>
          <div className="text-[9px] text-white/40 italic mt-0.5">
            {showRawTrack ? 'SHOWING RAW' : 'SHOWING THINNED'} ·{' '}
            raw: {rawPoints.length} → thinned: {thinnedPoints.length}{' '}
            ({rawPoints.length > 0 ? ((1 - thinnedPoints.length / rawPoints.length) * 100).toFixed(1) : 0}% reduction)
            · dashed = {showRawTrack ? 'thinned' : 'raw'}
          </div>
        </div>

        {/* Stats */}
        <div className="border-t border-white/10 pt-3 space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-white/50">Track length</span>
            <span className="font-mono">{(pathIndex.total / 6076).toFixed(2)} nm</span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/50">Impact points</span>
            <span className="font-mono text-cyan-300">{staticBlobs.length}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/50">Total exposure</span>
            <span className="font-mono text-red-400">
              {(totalExposure / 1e6).toFixed(2)}M m²·α
            </span>
          </div>
          {energyProfile && energyProfile.cfg && (
            <>
              <div className="flex justify-between mt-2">
                <span className="text-white/50">Avg climb</span>
                <span className="font-mono text-green-400">
                  +{Math.round(energyProfile.avgClimbFpm)} fpm
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/50">Avg acceleration</span>
                <span className="font-mono text-green-400">
                  +{energyProfile.avgAccelKt.toFixed(2)} kt
                </span>
              </div>
              <div className="flex justify-between mt-2">
                <span className="text-white/50">Aircraft</span>
                <span className="font-mono text-cyan-300">
                  {energyProfile.cfg.typeCode || '—'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/50">Rated HP</span>
                <span className="font-mono text-amber-300">
                  {energyProfile.cfg.ratedHp}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/50">Max climb</span>
                <span className="font-mono text-amber-300">
                  {Math.round(energyProfile.cfg.maxClimbFpm)} fpm
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/50">Climb speed</span>
                <span className="font-mono text-amber-300">
                  {Math.round(energyProfile.cfg.climbSpeedKt)} kt
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/50">V max (p95)</span>
                <span className="font-mono text-amber-300">
                  {Math.round(energyProfile.cfg.vMaxKt)} kt
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/50">TO / brake Δv</span>
                <span className="font-mono text-amber-300">
                  +{energyProfile.cfg.maxGroundAccelKt.toFixed(1)} /{' '}
                  {energyProfile.cfg.maxGroundDecelKt.toFixed(1)} kt
                </span>
              </div>
            </>
          )}
          <div className="text-[9px] text-white/40 italic mt-1">
            Engine state: ground = accel/decel ratio (TO full, brake idle).
            Airborne = max(climb/maxClimb, (v/vMax)²), decayed toward idle
            on descent.
          </div>
        </div>

        {/* Reset */}
        <button
          onClick={() => setParams(DEFAULT_PARAMS)}
          className="w-full text-[10px] border border-white/15 rounded px-2 py-1 text-white/70 hover:text-white hover:border-white/30"
        >
          reset parameters to defaults
        </button>

        {/* Settings textbox */}
        <div className="border-t border-white/10 pt-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-white/50 uppercase tracking-wide">Settings</span>
            <button
              onClick={() => {
                const el = document.getElementById('impact-settings-box')
                if (el) { el.select(); try { document.execCommand('copy') } catch {} }
              }}
              className="text-[10px] text-cyan-300 hover:text-white"
            >
              copy
            </button>
          </div>
          <textarea
            id="impact-settings-box"
            readOnly
            value={(() => {
              const lines = [
                `primary:    ${track?.call || '?'} · ${track?.type || '—'} · ${track?.src || ''}`,
                `overlay:    ${overlaySrcs.size ? Array.from(overlaySrcs).join(', ') : '(none)'}`,
                `---`,
                `radiusScale:     ${params.radiusScale}`,
                `baseOpacity:     ${params.baseOpacity}`,
                `opacityMult:     ${params.opacityMult}`,
                `directionalGain: ${params.directionalGain.toFixed(2)}`,
                `noiseResolution: ${params.noiseResolution}`,
                `suppressGaps:    ${params.suppressGaps}`,
                `gapThresholdFt:  ${params.gapThresholdFt}`,
                `---`,
                `referenceHp:     ${params.referenceHp}`,
                `referenceAglFt:  ${params.referenceAglFt}`,
                `spanDecades:     ${params.spanDecades.toFixed(2)}`,
                `log_mid:         ${impactBounds.logMid.toFixed(2)}`,
                `---`,
                `accumAutoRange:  ${params.accumAutoRange}`,
                `accumLogLo:      ${params.accumLogLo.toFixed(2)}`,
                `accumLogHi:      ${params.accumLogHi.toFixed(2)}`,
                ...(lastRasterStats ? [
                  `observed_loL10:  ${lastRasterStats.loLog10.toFixed(2)}`,
                  `observed_hiL10:  ${lastRasterStats.hiLog10.toFixed(2)}`,
                  `observed_cells:  ${lastRasterStats.cells}`,
                  `observed_blobs:  ${lastRasterStats.blobs}`,
                ] : []),
                `---`,
                `track_length_nm: ${(pathIndex.total / 6076).toFixed(2)}`,
                `impact_points:   ${staticBlobs.length}`,
                `overlay_points:  ${overlayBlobs.length}`,
                `combined_points: ${combinedBlobs.length}`,
                `total_exposure:  ${totalExposure.toFixed(0)} m²·α`,
                ...(energyProfile && energyProfile.cfg ? [
                  `avg_climb_fpm:   ${Math.round(energyProfile.avgClimbFpm)}`,
                  `avg_accel_kt:    ${energyProfile.avgAccelKt.toFixed(2)}`,
                  `---`,
                  `aircraft:        ${energyProfile.cfg.typeCode || '—'}`,
                  `rated_hp:        ${energyProfile.cfg.ratedHp}`,
                  `max_climb_fpm:   ${Math.round(energyProfile.cfg.maxClimbFpm)}`,
                  `climb_speed_kt:  ${Math.round(energyProfile.cfg.climbSpeedKt)}`,
                  `v_max_kt:        ${Math.round(energyProfile.cfg.vMaxKt)}`,
                  `ground_accel_kt: ${energyProfile.cfg.maxGroundAccelKt.toFixed(2)}`,
                  `ground_decel_kt: ${energyProfile.cfg.maxGroundDecelKt.toFixed(2)}`,
                ] : []),
              ]
              return lines.join('\n')
            })()}
            style={{ backgroundColor: '#1f2937', color: '#e5e7eb' }}
            className="w-full h-44 border border-white/15 rounded px-2 py-1 text-[10px] font-mono resize-none"
            onFocus={(e) => e.target.select()}
          />
        </div>
      </aside>

      <div className="flex-1 relative">
        {/* Live-plane HUD: fixed overlay in the top-right. Always shows the
            "lead" plane's current metrics — tooltips are unusable on fast-
            moving markers so we mirror the info here. */}
        {animating && train.length > 0 && (() => {
          const p = train[0]
          return (
            <div className="absolute top-3 right-3 z-[1000] bg-black/80 backdrop-blur-sm border border-white/15 rounded-lg p-2 text-[11px] w-56 pointer-events-none">
              <div className="text-white/50 uppercase tracking-wide text-[9px] mb-1 px-1">
                lead plane · real-time
              </div>
              <div className="space-y-0.5 px-1">
                <div className="flex justify-between">
                  <span className="text-white/60">altitude</span>
                  <span className="font-mono text-white/90">{Math.round(p.alt)} ft</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/60">ground speed</span>
                  <span className="font-mono text-white/90">{Math.round(p.vKt)} kt</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/60">fpm 10s/20s</span>
                  <span className={`font-mono ${
                    p.fpmWeighted > 50 ? 'text-green-400'
                    : p.fpmWeighted < -50 ? 'text-red-400'
                    : 'text-white/70'
                  }`}>
                    {p.fpmWeighted > 0 ? '+' : ''}{Math.round(p.fpmWeighted)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/60">Δ airspeed</span>
                  <span className={`font-mono ${
                    p.speedDeltaKt > 1 ? 'text-green-400'
                    : p.speedDeltaKt < -1 ? 'text-red-400'
                    : 'text-white/70'
                  }`}>
                    {p.speedDeltaKt > 0 ? '+' : ''}{p.speedDeltaKt.toFixed(1)} kt
                  </span>
                </div>
                <div className="flex justify-between mt-1 pt-1 border-t border-white/15">
                  <span className="text-white/60 font-semibold">power</span>
                  <span className={`font-mono font-semibold ${
                    p.energy > 0.7 ? 'text-red-400'
                    : p.energy > 0.4 ? 'text-yellow-300'
                    : 'text-green-400'
                  }`}>
                    {Math.round(p.hp)} HP ({(p.energy * 100).toFixed(0)}%)
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/60 font-semibold">ground impact</span>
                  {(() => {
                    const s = hpIntensityScalar(p.hp || 0, p.radius_m || 1, impactBounds.logLo, impactBounds.logHi)
                    return (
                      <span className="font-mono font-semibold" style={{ color: bipolarColor(2 * s - 1) }}>
                        {(s * 100).toFixed(0)}%
                      </span>
                    )
                  })()}
                </div>
              </div>
              <div className="text-[9px] text-white/30 italic mt-1 px-1">
                {energyProfile.cfg && (
                  <>
                    {energyProfile.cfg.typeCode} · {energyProfile.cfg.ratedHp} HP rated ·{' '}
                    max {Math.round(energyProfile.cfg.maxClimbFpm)} fpm @ {Math.round(energyProfile.cfg.climbSpeedKt)} kt
                    <br />
                  </>
                )}
                {train.length} planes · spacing ≈{(spacingFt / 6076).toFixed(1)} nm
              </div>
            </div>
          )
        })()}
        <MapContainer center={KBDU} zoom={12} className="h-full w-full" preferCanvas={true}>
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

          {/* Noise zones */}
          {showZones && NOISE_ZONES.map((z, i) => (
            <Polygon
              key={i}
              positions={z.polygon}
              pathOptions={{
                color: '#7e22ce',
                weight: 2,
                fillColor: '#a855f7',
                fillOpacity: 0.1,
                dashArray: '4 4',
              }}
            >
              <Tooltip sticky>
                <div className="text-xs font-semibold text-purple-300">{z.name}</div>
              </Tooltip>
            </Polygon>
          ))}

          {/* A/B comparison line: when showing raw, overlay the thinned
              path as a dashed line (and vice versa) so you can see the
              difference. */}
          {(() => {
            const altPts = showRawTrack ? thinnedPoints : rawPoints
            const altLL = altPts.map((p) => [p[0], p[1]])
            return altLL.length > 1 ? (
              <Polyline
                positions={altLL}
                pathOptions={{ color: '#9ca3af', weight: 1, opacity: 0.4, dashArray: '4 4' }}
                interactive={false}
              />
            ) : null
          })()}

          {/* Reference track polyline — per-segment coloring by 20 s
              averaged vertical speed (climb warm, descend cool) and weight
              inverted against 20 s averaged airspeed (slow = fat line). */}
          {latLons.length > 1 && energyProfile.perPoint.length === latLons.length &&
            latLons.slice(1).map((b, idx) => {
              // Skip segments that span a data gap.
              if (params.suppressGaps && (pathIndex.segFt[idx + 1] || 0) > params.gapThresholdFt) {
                return null
              }
              const a = latLons[idx]
              const m = energyProfile.perPoint[idx + 1] || {}
              const vs = m.averageVerticalFpm || 0
              // ±1000 fpm to full scale
              const vsNorm = Math.max(-1, Math.min(1, vs / 1000))
              const color = bipolarColor(vsNorm)
              const spd = m.averageAirspeedKt || 0
              // 30 kt → 8 px, 200 kt → 1.5 px
              const weight = Math.max(1.5, Math.min(8, 8 - (spd - 30) / 25))
              return (
                <Polyline
                  key={`trk-${idx}`}
                  positions={[a, b]}
                  pathOptions={{ color, weight, opacity: 0.85 }}
                  interactive={false}
                />
              )
            })}
          {latLons.length > 1 && energyProfile.perPoint.length !== latLons.length && (
            <Polyline
              positions={latLons}
              pathOptions={{ color: '#9ca3af', weight: 2, opacity: 0.5 }}
            />
          )}

          {/* Static aggregate heatmap — real per-cell energy accumulation.
              Rendered as a single ImageOverlay so colors reflect the sum
              of hp/(π·r²) from every splat at that ground point, not
              Leaflet's RGBA blending of independent polygons. */}
          {!animating && staticRaster && (
            <ImageOverlay
              url={staticRaster.dataUrl}
              bounds={staticRaster.latLngBounds}
              opacity={Math.min(1, params.opacityMult)}
              interactive={false}
            />
          )}

          {/* Animated per-plane footprints — same nested-ring gradient. */}
          {animating && train.flatMap((p, i) => {
            if (p.radius_m <= 0) return []
            if (params.suppressGaps && p.inGap) return []
            return IMPACT_RING_FRACTIONS.map((frac, ri) => {
              const r = Math.max(0.5, p.radius_m * frac)
              const s = hpIntensityScalar(p.hp || 0, r, impactBounds.logLo, impactBounds.logHi)
              return (
                <Polygon
                  key={`imp-${i}-${ri}`}
                  positions={ellipseFootprint(
                    p.lat, p.lon, r, p.heading, params.directionalGain,
                  )}
                  pathOptions={{
                    stroke: false,
                    fillColor: bipolarColor(2 * s - 1),
                    fillOpacity: Math.min(0.7, 0.15 + s * 0.6),
                  }}
                  interactive={false}
                />
              )
            })
          })}
          {animating && train.map((p, i) => {
            if (params.suppressGaps && p.inGap) return null
            // Size from 20 s avg airspeed — slow = big, fast = small.
            // 30 kt → 2.0×, 200 kt → 0.5×, linear between.
            const spd = p.averageAirspeedKt || 0
            const t = Math.max(0, Math.min(1, (spd - 30) / (200 - 30)))
            const sizeMult = 2.0 - 1.5 * t
            const size = 22 * sizeMult
            // Color from HP fraction (time-averaged via `energy`). 1.0 →
            // red (full power), 0.5 → white, 0.0 → deep blue (idle).
            const e = Math.max(0, Math.min(1, p.energy || 0))
            return (
              <Marker
                key={`pl-${i}`}
                position={[p.lat, p.lon]}
                icon={makePlaneIcon(p.heading, bipolarColor(2 * e - 1), size)}
                interactive={false}
              />
            )
          })}
        </MapContainer>
      </div>
    </div>
  )
}

// Compact reusable slider row
function ParamSlider({ label, unit, min, max, step, value, onChange, format }) {
  const display = format ? format(value) : value
  return (
    <div className="mt-2">
      <div className="flex justify-between text-[10px] text-white/60">
        <span>{label}</span>
        <span className="font-mono text-white/80">{display}{unit ? ` ${unit}` : ''}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
    </div>
  )
}
