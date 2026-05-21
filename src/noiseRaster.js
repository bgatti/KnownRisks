// noiseRaster.js — HP-based noise accumulation raster pipeline.
// Shared between NoiseImpactTest (workbook) and App (main map).
//
// Usage:
//   import { computeNoiseRaster } from './noiseRaster'
//   const result = computeNoiseRaster(tracks, opts)
//   // result = { dataUrl, latLngBounds, stats } or null

import { terrainAt } from './terrain'
const FT_PER_DEG_LAT = 364560
const FT_PER_SEC_PER_KT = 1.6878

// ─── Aircraft HP table ──────────────────────────────────────────────────────
const AIRCRAFT_HP = {
  C152: 110, C172: 160, C72R: 195, C182: 230, C206: 300, C210: 300,
  P28A: 160, P28B: 180, PA28: 180, P28R: 200, PA46: 350, PA44: 360,
  PA25: 235, PA18: 180,
  DV20: 80, DA20: 125, DA40: 180, DA42: 340,
  SR20: 200, SR22: 310, S22T: 315,
  M20P: 200, M20J: 201, M20K: 220,
  BE33: 285, BE35: 285, BE36: 300, BE55: 260, BE58: 600, BE76: 360,
  BE9L: 575, BE95: 360, BE40: 2850,
  C25A: 1500, C25B: 1500, C25C: 1700, C501: 1000, C525: 1900, C551: 850,
  C560: 2100, C56X: 2600, C680: 3600, C68A: 4000, C750: 4800,
  CL30: 8700, CL35: 9200, CL60: 9200,
  GALX: 9100, G200: 9100, H25B: 7000, LJ40: 6500, LJ60: 7600,
  E55P: 3200, E50P: 1900, SF50: 1846,
  TBM7: 700, TBM8: 850, TBM9: 850, PC12: 1200, PC24: 3400,
  DHC6: 1240,
  R22: 124, R44: 245, R66: 320,
  AS50: 847, AS55: 1010, AS65: 1236, AS21: 0,
  EC20: 847, EC30: 847, EC35: 1000, EC45: 1800,
  B06: 420, B407: 813, B429: 1400,
  H500: 420, S76: 1500, S92: 5000,
  BD7T: 600, BDOG: 156, VL3: 100, LGEZ: 180, LONG: 150,
  GLID: 0, AS20: 0, AS26: 0, AS31: 0,
  DG10: 0, DG15: 0, DG80: 0, DG1T: 0,
  DISC: 0, VENT: 0, NIMB: 0, JS1J: 0, ASTR: 0,
  _default: 180,
}
function lookupHp(typeCode) {
  if (!typeCode) return AIRCRAFT_HP._default
  const v = AIRCRAFT_HP[typeCode.toUpperCase()]
  return v ?? AIRCRAFT_HP._default
}

// Typical cruise groundspeed (knots) by aircraft type. Used to estimate
// time-between-points when timestamps are missing: dt ≈ distance / speed.
// Better than guessing a fixed sample period because a 200-knot jet covers
// the same ground in 1 second that a 70-knot trainer takes 3 seconds to do.
const AIRCRAFT_KT = {
  // Light singles
  C152: 100, C172: 110, C72R: 125, C182: 130, C206: 140, C210: 165,
  P28A: 110, P28B: 115, PA28: 115, P28R: 130, PA46: 175,
  PA25: 90, PA18: 80,
  DV20: 90, DA20: 110, DA40: 130, DA42: 165,
  SR20: 140, SR22: 175, S22T: 200,
  M20P: 150, M20J: 155, M20K: 175,
  BE33: 165, BE35: 165, BE36: 170, BE55: 180, BE58: 200, BE76: 165,
  BE9L: 240, BE95: 180, BE40: 350,
  // Jets
  C25A: 380, C25B: 380, C25C: 400, C501: 350, C525: 380, C551: 360,
  C560: 420, C56X: 440, C680: 460, C68A: 470, C750: 500,
  CL30: 470, CL35: 480, CL60: 480,
  GALX: 470, G200: 470, H25B: 460, LJ40: 460, LJ60: 480,
  E55P: 350, E50P: 320, SF50: 300,
  // Turboprops
  TBM7: 280, TBM8: 290, TBM9: 290, PC12: 270, PC24: 420,
  DHC6: 160,
  // Helicopters
  R22: 80, R44: 110, R66: 120,
  AS50: 130, AS55: 140, AS65: 145, AS21: 90,
  EC20: 130, EC30: 130, EC35: 135, EC45: 140,
  B06: 110, B407: 130, B429: 145,
  H500: 110, S76: 145, S92: 155,
  // Experimental / other
  BD7T: 140, BDOG: 110, VL3: 130, LGEZ: 150, LONG: 150,
  // Gliders (towed/launched, soaring speeds)
  GLID: 65, AS20: 60, AS26: 65, AS31: 65,
  DG10: 60, DG15: 65, DG80: 70, DG1T: 70,
  DISC: 65, VENT: 75, NIMB: 70, JS1J: 75, ASTR: 60,
  _default: 120, // generic GA single
}
function lookupCruiseKt(typeCode) {
  if (!typeCode) return AIRCRAFT_KT._default
  const v = AIRCRAFT_KT[typeCode.toUpperCase()]
  return v ?? AIRCRAFT_KT._default
}

// ─── Geometry helpers ───────────────────────────────────────────────────────
function dist3dFt(a, b) {
  const dLat = (b[0] - a[0]) * FT_PER_DEG_LAT
  const dLon = (b[1] - a[1]) * FT_PER_DEG_LAT * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180)
  const dAlt = (b[2] || 0) - (a[2] || 0)
  return Math.sqrt(dLat * dLat + dLon * dLon + dAlt * dAlt)
}

// Ground (2D) distance — what shows up on the map. Use this for arc-length
// walks that must produce visually-uniform spacing on the rendered map.
function distGroundFt(a, b) {
  const dLat = (b[0] - a[0]) * FT_PER_DEG_LAT
  const dLon = (b[1] - a[1]) * FT_PER_DEG_LAT * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180)
  return Math.hypot(dLat, dLon)
}

function bearing(a, b) {
  const dLat = b[0] - a[0]
  const dLon = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180)
  return (Math.atan2(dLon, dLat) * 180) / Math.PI
}

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

// ─── Thinning ───────────────────────────────────────────────────────────────
function movingAverageLL(points, window) {
  if (window < 3 || points.length < 3) return points.map((p) => p.slice())
  const half = Math.floor(window / 2)
  const out = []
  for (let i = 0; i < points.length; i++) {
    let sLat = 0, sLon = 0, n = 0
    const lo = Math.max(0, i - half)
    const hi = Math.min(points.length - 1, i + half)
    for (let j = lo; j <= hi; j++) { sLat += points[j][0]; sLon += points[j][1]; n++ }
    out.push([sLat / n, sLon / n, points[i][2] || 0])
  }
  return out
}

function thinDP(points, epsilonFt) {
  if (points.length < 3 || epsilonFt <= 0) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1; keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop()
    let maxD = 0, idx = -1
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistFt(points[i], points[lo], points[hi])
      if (d > maxD) { maxD = d; idx = i }
    }
    if (maxD > epsilonFt && idx >= 0) {
      keep[idx] = 1; stack.push([lo, idx]); stack.push([idx, hi])
    }
  }
  return points.filter((_, i) => keep[i])
}

function densifyBezierQ3D(points, samples = 8) {
  if (points.length < 3) return points.map((p) => p.slice())
  const out = [points[0].slice()]
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = points[i - 1], p1 = points[i], p2 = points[i + 1]
    const m0 = [(p0[0]+p1[0])/2, (p0[1]+p1[1])/2, (p0[2]+p1[2])/2]
    const m1 = [(p1[0]+p2[0])/2, (p1[1]+p2[1])/2, (p1[2]+p2[2])/2]
    for (let s = 1; s <= samples; s++) {
      const t = s / samples, u = 1 - t
      out.push([u*u*m0[0]+2*u*t*p1[0]+t*t*m1[0], u*u*m0[1]+2*u*t*p1[1]+t*t*m1[1], u*u*m0[2]+2*u*t*p1[2]+t*t*m1[2]])
    }
  }
  out.push(points[points.length - 1].slice())
  return out
}

function splitAtGaps(points, thresholdFt) {
  if (!points || points.length < 2) return [points || []]
  const legs = []; let leg = [points[0]]
  for (let i = 1; i < points.length; i++) {
    if (dist3dFt(points[i - 1], points[i]) > thresholdFt) {
      if (leg.length >= 2) legs.push(leg); leg = []
    }
    leg.push(points[i])
  }
  if (leg.length >= 2) legs.push(leg)
  return legs.length ? legs : [[]]
}

function thinTrack(points, gapFt = 3000) {
  if (!points || points.length < 10) return points
  const legs = splitAtGaps(points, gapFt)
  const out = []
  for (const leg of legs) {
    if (leg.length < 3) { out.push(...leg); continue }
    out.push(...densifyBezierQ3D(thinDP(movingAverageLL(leg, 5), 140), 8))
  }
  return out
}

// ─── Energy profile ─────────────────────────────────────────────────────────
function percentile(arr, p) {
  if (!arr.length) return 0
  const sorted = arr.slice().sort((a, b) => a - b)
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)))]
}

function calibrateMaxClimb(points, samplePeriodS, windowS = 60) {
  if (!points || points.length < 3) return { maxClimbFpm: 700, climbSpeedKt: 74 }
  const perWindow = Math.max(2, Math.round(windowS / samplePeriodS))
  let bestFpm = 0, bestVKt = 70
  for (let i = perWindow; i < points.length - 1; i++) {
    const dAlt = points[i][2] - points[i - perWindow][2]
    if (dAlt <= 0) continue
    const fpm = dAlt / (windowS / 60)
    if (fpm > bestFpm) {
      bestFpm = fpm
      let s = 0, n = 0
      for (let j = i - perWindow + 1; j <= i; j++) {
        const a = points[j-1], b = points[j]
        const dLat = (b[0]-a[0])*FT_PER_DEG_LAT
        const dLon = (b[1]-a[1])*FT_PER_DEG_LAT*Math.cos(((a[0]+b[0])/2)*Math.PI/180)
        s += Math.hypot(dLat, dLon); n++
      }
      bestVKt = n > 0 ? (s / n / samplePeriodS) / FT_PER_SEC_PER_KT : 70
    }
  }
  if (bestFpm < 100) bestFpm = 600
  if (bestVKt < 30) bestVKt = 70
  return { maxClimbFpm: bestFpm, climbSpeedKt: bestVKt }
}

function estimateEnginePower(avgFpm, avgVKt, speedDeltaKt, onGround, stats) {
  const { maxClimbFpm, vMaxKt, maxGroundAccelKt, maxGroundDecelKt, idleDescentFpm } = stats
  if (onGround) {
    if (maxGroundAccelKt > 0 && speedDeltaKt > 0.25 * maxGroundAccelKt) {
      return 0.5 + 0.5 * Math.min(1, speedDeltaKt / Math.max(0.001, maxGroundAccelKt))
    }
    if (maxGroundDecelKt < 0 && speedDeltaKt < 0.25 * maxGroundDecelKt) return 0.1
    return 0.15 + 0.1 * Math.min(1, Math.abs(speedDeltaKt) / 2)
  }
  const climbFrac = Math.max(0, avgFpm / Math.max(1, maxClimbFpm))
  const speedFrac = Math.pow(Math.max(0, avgVKt) / Math.max(1, vMaxKt), 2)
  let power = Math.max(climbFrac, speedFrac)
  if (avgFpm < 0) {
    const idleness = Math.min(1, -avgFpm / Math.max(50, idleDescentFpm))
    power = power * (1 - 0.7 * idleness) + 0.1 * idleness
  }
  return Math.max(0.05, Math.min(1, power))
}

function buildEnergyProfile(points, samplePeriodS, typeCode) {
  if (!points || points.length < 3) return { perPoint: [], cfg: null }
  const ratedHp = lookupHp(typeCode)
  const cal = calibrateMaxClimb(points, samplePeriodS)
  const seg = new Array(points.length).fill(0)
  for (let i = 1; i < points.length; i++) {
    const a = points[i-1], b = points[i]
    const dLat = (b[0]-a[0])*FT_PER_DEG_LAT
    const dLon = (b[1]-a[1])*FT_PER_DEG_LAT*Math.cos(((a[0]+b[0])/2)*Math.PI/180)
    seg[i] = Math.hypot(dLat, dLon)
  }
  const vKt = seg.map((s) => s / samplePeriodS / FT_PER_SEC_PER_KT)
  let minAlt = Infinity
  for (const p of points) if (p[2] < minAlt) minAlt = p[2]
  const isGround = (i) => (points[i][2] - minAlt) < 50
  const airborneV = [], groundAccelPos = [], groundAccelNeg = []
  for (let i = 1; i < points.length; i++) {
    const agl = points[i][2] - minAlt
    if (agl > 300 && vKt[i] < 600) airborneV.push(vKt[i])
    if (isGround(i)) {
      const dv = vKt[i] - vKt[i-1]
      if (dv > 0) groundAccelPos.push(dv); else if (dv < 0) groundAccelNeg.push(dv)
    }
  }
  const cfg = {
    ratedHp, typeCode: typeCode || '?',
    maxClimbFpm: cal.maxClimbFpm, climbSpeedKt: cal.climbSpeedKt,
    vMaxKt: Math.max(cal.climbSpeedKt * 1.3, percentile(airborneV, 0.95)),
    maxGroundAccelKt: percentile(groundAccelPos, 0.9) || 2,
    maxGroundDecelKt: percentile(groundAccelNeg, 0.1) || -2,
    idleDescentFpm: 600,
  }
  const perWindow = Math.max(2, Math.round(10 / samplePeriodS))
  const avgWindow = Math.max(2, Math.round(20 / samplePeriodS))
  const perPoint = new Array(points.length)
  for (let i = 0; i < points.length; i++) {
    const recentEnd = i, recentStart = Math.max(0, i - perWindow)
    const olderEnd = recentStart, olderStart = Math.max(0, olderEnd - perWindow)
    const windowTimeMin = (perWindow * samplePeriodS) / 60
    const dAltRecent = points[recentEnd][2] - points[recentStart][2]
    const dAltOlder = olderStart < olderEnd ? points[olderEnd][2] - points[olderStart][2] : dAltRecent
    const fpmRecent = windowTimeMin > 0 ? dAltRecent / windowTimeMin : 0
    const fpmOlder = windowTimeMin > 0 ? dAltOlder / windowTimeMin : fpmRecent
    const meanV = (lo, hi) => {
      if (hi <= lo) return 0; let s = 0, n = 0
      for (let j = lo + 1; j <= hi; j++) { s += vKt[j]; n++ }
      return n > 0 ? s / n : 0
    }
    const vRecent = meanV(recentStart, recentEnd)
    const vOlder = meanV(olderStart, olderEnd)
    const speedDeltaKt = vRecent - vOlder
    const avgStart = Math.max(0, i - avgWindow)
    let avgV = 0, avgN = 0
    for (let j = avgStart + 1; j <= i; j++) { avgV += vKt[j]; avgN++ }
    const averageAirspeedKt = avgN > 0 ? avgV / avgN : 0
    const avgDAlt = points[i][2] - points[avgStart][2]
    const avgMin = ((i - avgStart) * samplePeriodS) / 60
    const averageVerticalFpm = avgMin > 0 ? avgDAlt / avgMin : 0
    const energy = estimateEnginePower(averageVerticalFpm, averageAirspeedKt, speedDeltaKt, isGround(i), cfg)
    perPoint[i] = { hp: energy * cfg.ratedHp }
  }
  return { perPoint, cfg }
}

// ─── Loudness blobs ─────────────────────────────────────────────────────────
// Keep every point in the blob list so the upsampler can interpolate
// through ground-level or zero-HP sections without breaking the path.
// Points with hp=0 contribute nothing to the raster accumulator but
// they maintain sequence continuity for the interpolation step.
function computeBlobs(points, perPoint, radiusScale) {
  const out = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const prev = points[Math.max(0, i - 1)]
    const next = points[Math.min(points.length - 1, i + 1)]
    const agl = Math.max(0, p[2] - terrainAt(p[0], p[1]))
    const radius_m = Math.max(1, Math.max(50, agl) * 0.3048 * radiusScale)
    const hp = agl < 50 ? 0 : ((perPoint[i] && perPoint[i].hp) || 0)
    out.push({ lat: p[0], lon: p[1], radius_m, hp, heading: bearing(prev, next) })
  }
  return out
}

// ─── Rasterizer ─────────────────────────────────────────────────────────────
const ACCUM_PALETTE = [
  [8,30,95],[25,80,170],[30,160,200],[40,190,140],[100,210,80],
  [200,220,40],[245,185,40],[240,120,30],[225,50,40],[160,0,40],
]
function paletteLookup(t) {
  const c = Math.max(0, Math.min(1, t))
  const pos = c * (ACCUM_PALETTE.length - 1)
  const i = pos | 0, f = pos - i
  const a = ACCUM_PALETTE[i]
  const b = ACCUM_PALETTE[Math.min(ACCUM_PALETTE.length - 1, i + 1)]
  return [(a[0]+(b[0]-a[0])*f)|0, (a[1]+(b[1]-a[1])*f)|0, (a[2]+(b[2]-a[2])*f)|0]
}

// ── Energy accumulator (shared by noise and impact rasters) ────────────────
function accumulate(blobs, gridW, gridH, latMin, latMax, lonMin, lonMax, gain) {
  const mPerDegLat = 111320
  const mPerDegLon = 111320 * Math.cos(((latMin+latMax)/2) * Math.PI / 180)
  const dLat = latMax - latMin, dLon = lonMax - lonMin
  if (dLat <= 0 || dLon <= 0) return null
  const mPerPxY = (dLat * mPerDegLat) / gridH
  const mPerPxX = (dLon * mPerDegLon) / gridW
  const energy = new Float32Array(gridW * gridH)
  const g = Math.max(0, Math.min(0.95, gain))
  const foreAftShrink = 1 - g * 0.85
  const sideBoost = 1 / Math.sqrt(Math.max(0.1, foreAftShrink))
  for (const b of blobs) {
    if (!b || b.hp <= 0) continue
    const cx = ((b.lon - lonMin) / dLon) * gridW
    const cy = ((latMax - b.lat) / dLat) * gridH
    const a = b.radius_m * sideBoost
    const bMinor = b.radius_m * foreAftShrink * sideBoost
    const rPxMax = Math.max(a / mPerPxX, a / mPerPxY) + 1
    const x0 = Math.max(0, Math.floor(cx - rPxMax))
    const x1 = Math.min(gridW - 1, Math.ceil(cx + rPxMax))
    const y0 = Math.max(0, Math.floor(cy - rPxMax))
    const y1 = Math.min(gridH - 1, Math.ceil(cy + rPxMax))
    const hdgRad = ((b.heading || 0) * Math.PI) / 180
    const cosH = Math.cos(hdgRad), sinH = Math.sin(hdgRad)
    const peakDensity = b.hp / (Math.PI * b.radius_m * b.radius_m)
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dxE = (px+0.5-cx)*mPerPxX, dyS = (py+0.5-cy)*mPerPxY
        const lx = -dyS*cosH + dxE*sinH, ly = dyS*sinH + dxE*cosH
        const nx = lx / Math.max(0.1, bMinor), ny = ly / Math.max(0.1, a)
        const d2 = nx*nx + ny*ny
        if (d2 >= 1) continue
        energy[py * gridW + px] += peakDensity * (1 - d2)
      }
    }
  }
  return energy
}

// ── Colorize an energy grid into a canvas PNG ──────────────────────────────
function colorize(energy, gridW, gridH, latMin, latMax, lonMin, lonMax, scaleCfg, palFn) {
  const nonZero = []
  for (let i = 0; i < energy.length; i++) if (energy[i] > 0) nonZero.push(energy[i])
  nonZero.sort((x, y) => x - y)
  const loObs = nonZero.length ? nonZero[Math.floor(nonZero.length * 0.01)] : 0
  const hiObs = nonZero.length ? nonZero[Math.floor(nonZero.length * 0.99)] : 1
  const loObsLog10 = Math.log10(Math.max(1e-12, loObs))
  const hiObsLog10 = Math.log10(Math.max(1e-12, hiObs))
  let loL, hiL
  if (scaleCfg && scaleCfg.autoRange === false) {
    loL = scaleCfg.logLo * Math.LN10; hiL = scaleCfg.logHi * Math.LN10
  } else {
    loL = Math.log(Math.max(1e-12, loObs)); hiL = Math.log(Math.max(1e-12, hiObs))
  }
  const span = Math.max(0.01, hiL - loL)
  const lookup = palFn || paletteLookup
  const LUT_SIZE = 256
  const lutR = new Uint8Array(LUT_SIZE), lutG = new Uint8Array(LUT_SIZE), lutB = new Uint8Array(LUT_SIZE)
  for (let k = 0; k < LUT_SIZE; k++) {
    const [r, g2, b2] = lookup(k / (LUT_SIZE - 1))
    lutR[k] = r; lutG[k] = g2; lutB[k] = b2
  }
  const canvas = document.createElement('canvas')
  canvas.width = gridW; canvas.height = gridH
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(gridW, gridH)
  const data = img.data
  for (let i = 0; i < energy.length; i++) {
    const e = energy[i]
    if (e <= 0) { data[i*4+3] = 0; continue }
    let s = (Math.log(e) - loL) / span
    if (s < 0) s = 0; else if (s > 1) s = 1
    const k = (s * (LUT_SIZE - 1)) | 0
    data[i*4] = lutR[k]; data[i*4+1] = lutG[k]; data[i*4+2] = lutB[k]
    const alphaT = s < (1/3) ? s * 3 : 1
    data[i*4+3] = (alphaT * 230) | 0
  }
  ctx.putImageData(img, 0, 0)
  return {
    dataUrl: canvas.toDataURL('image/png'),
    latLngBounds: [[latMin, lonMin], [latMax, lonMax]],
    stats: {
      loLog10: loObsLog10, hiLog10: hiObsLog10,
      cells: nonZero.length, blobs: energy.length,
    },
  }
}

function rasterize(blobs, gridW, gridH, latMin, latMax, lonMin, lonMax, gain, scaleCfg) {
  if (!blobs.length) return null
  const dLat = latMax - latMin, dLon = lonMax - lonMin
  if (dLat <= 0 || dLon <= 0) return null
  const energy = accumulate(blobs, gridW, gridH, latMin, latMax, lonMin, lonMax, gain)
  if (!energy) return null
  return colorize(energy, gridW, gridH, latMin, latMax, lonMin, lonMax, scaleCfg)
}

// ─── Main export ────────────────────────────────────────────────────────────
// tracks: [{ points: [[lat,lon,alt],...], type: 'C172' }, ...]
// opts:   { radiusScale, directionalGain, noiseResolution, gapThresholdFt,
//           accumAutoRange, accumLogLo, accumLogHi, samplePeriodS,
//           maxBlobs }
//
// `maxBlobs` caps the total blob count fed to the rasterizer. When the raw
// blob pool exceeds this, we thin it down uniformly by keeping every
// N-th blob (with HP scaled up by N so total deposited energy is
// preserved). This lets you render hundreds of tracks without the splat
// loop grinding to a halt — you trade spatial resolution for speed, but
// the accumulated energy integral stays correct.
export function computeNoiseRaster(tracks, opts = {}) {
  const {
    radiusScale = 3.0,
    directionalGain = 0.6,
    noiseResolution = 4,
    gapThresholdFt = 3000,
    accumAutoRange = false,
    accumLogLo = -6.90,
    accumLogHi = -0.60,
    samplePeriodS = 1,
    maxBlobs = 50000,
    rasterPx = 1200,       // pixels on the longer grid axis
    // Distance-based densification: lay down N blobs per nautical mile
    // along each segment, regardless of source point spacing. This gives
    // consistent visual density — fast cruise legs and pattern turns
    // both render with the same blob-to-blob distance on the map.
    // Default 10 blobs/nm = one blob every ~600 ft (~180 m).
    blobsPerNm = 10,
    // Legacy time-based mode kept for backward compat with NoiseImpactTest.
    targetBlobsPerMin = 20,
    // Time-of-day filter (local hour, MST = UTC-7). When set, only points
    // whose local hour falls in [todStart, todEnd) contribute blobs.
    // todStart > todEnd wraps past midnight (e.g. 22→4 = 10PM–4AM).
    // null/undefined = no filtering (all points).
    todStart = null,
    todEnd = null,
    tzOffsetS = -7 * 3600,
  } = opts
  const hasTodFilter = todStart != null && todEnd != null
  function inTodRange(t0, tSec) {
    if (!hasTodFilter || t0 == null || tSec == null) return !hasTodFilter
    const localS = (t0 + tSec + tzOffsetS)
    const hour = Math.floor((((localS % 86400) + 86400) % 86400) / 3600)
    if (todStart <= todEnd) return hour >= todStart && hour < todEnd
    return hour >= todStart || hour < todEnd  // wraps midnight
  }
  // ── Per-track: energy → blobs → TOD filter → distance-densify ──
  // Each segment between consecutive raw points is upsampled so the
  // resulting on-map blob spacing is uniform (~1/blobsPerNm nm apart).
  // This eliminates the variable spacing that made single-aircraft
  // renders look blotchy when ADS-B reporting was uneven.
  const lerp = (a, b, t) => a + (b - a) * t
  let allBlobs = []
  for (const t of tracks) {
    const pts = t.points || []
    if (pts.length < 3) continue
    const prof = buildEnergyProfile(pts, samplePeriodS, t.type)
    let blobs = computeBlobs(pts, prof.perPoint, radiusScale)
    if (hasTodFilter) {
      blobs = blobs.filter((b, i) => {
        const p = pts[i]
        return inTodRange(t.t0, p && p[3])
      })
    }
    // Resample blobs at uniform arc-length spacing using true great-circle
    // (haversine) distance — same algorithm as App.jsx mile markers.
    // Drops duplicate consecutive points, monotonic walk, linear lerp
    // within each segment.
    const stepNm = 1 / Math.max(0.01, blobsPerNm)
    const minRadiusM = (stepNm * 1852) * 0.6 // 1 nm = 1852 m; 60% of step for overlap
    // Drop duplicates so segNm is never zero
    const cleanIdx = [0]
    for (let i = 1; i < blobs.length; i++) {
      const prev = blobs[cleanIdx[cleanIdx.length - 1]]
      const cur = blobs[i]
      if (cur.lat !== prev.lat || cur.lon !== prev.lon) cleanIdx.push(i)
    }
    if (cleanIdx.length < 2) continue
    // Per-segment haversine distances
    const segNm = new Float64Array(cleanIdx.length - 1)
    let totalNm = 0
    for (let i = 0; i < segNm.length; i++) {
      const a = blobs[cleanIdx[i]], b = blobs[cleanIdx[i + 1]]
      const lat1 = a.lat * Math.PI / 180, lat2 = b.lat * Math.PI / 180
      const dLat = lat2 - lat1
      const dLon = (b.lon - a.lon) * Math.PI / 180
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
      segNm[i] = 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(h)))
      totalNm += segNm[i]
    }
    if (totalNm < stepNm) {
      for (const b of blobs) allBlobs.push(b)
      continue
    }
    // Walk and emit
    const emit = (a, b, tf) => {
      const altRadius = lerp(a.radius_m, b.radius_m, tf)
      allBlobs.push({
        lat: lerp(a.lat, b.lat, tf),
        lon: lerp(a.lon, b.lon, tf),
        radius_m: Math.max(minRadiusM, altRadius),
        hp: lerp(a.hp, b.hp, tf),
        heading: bearing([a.lat, a.lon], [b.lat, b.lon]),
      })
    }
    emit(blobs[cleanIdx[0]], blobs[cleanIdx[1]], 0)
    let segIdx = 0
    let segStart = 0
    let nextEmit = stepNm
    while (nextEmit <= totalNm) {
      while (segIdx < segNm.length && segStart + segNm[segIdx] < nextEmit) {
        segStart += segNm[segIdx]
        segIdx++
      }
      if (segIdx >= segNm.length) break
      const tf = (nextEmit - segStart) / segNm[segIdx]
      emit(blobs[cleanIdx[segIdx]], blobs[cleanIdx[segIdx + 1]], tf)
      nextEmit += stepNm
    }
  }
  if (!allBlobs.length) return null

  // ── Budget gate ───────────────────────────────────────────────────
  const rawBlobCount = allBlobs.length
  let decimation = 1
  if (maxBlobs > 0 && allBlobs.length > maxBlobs) {
    decimation = Math.ceil(allBlobs.length / maxBlobs)
    const decimated = []
    for (let i = 0; i < allBlobs.length; i += decimation) {
      decimated.push({ ...allBlobs[i], hp: allBlobs[i].hp * decimation })
    }
    allBlobs = decimated
  }
  const upsampled = allBlobs
  // Bbox
  const g = Math.max(0, Math.min(0.95, directionalGain))
  const sideBoost = 1 / Math.sqrt(Math.max(0.1, 1 - g * 0.85)) * 1.05
  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity
  for (const b of upsampled) {
    const rPad = b.radius_m * sideBoost
    const dLat = rPad / 111320, dLon = rPad / (111320 * Math.cos(b.lat * Math.PI / 180))
    if (b.lat-dLat < latMin) latMin = b.lat-dLat
    if (b.lat+dLat > latMax) latMax = b.lat+dLat
    if (b.lon-dLon < lonMin) lonMin = b.lon-dLon
    if (b.lon+dLon > lonMax) lonMax = b.lon+dLon
  }
  const dLat = latMax - latMin, dLon = lonMax - lonMin
  if (dLat <= 0 || dLon <= 0) return null
  const aspect = (dLon * Math.cos((latMin+latMax)/2 * Math.PI / 180)) / dLat
  const gridW = aspect >= 1 ? rasterPx : Math.max(64, Math.round(rasterPx * aspect))
  const gridH = aspect >= 1 ? Math.max(64, Math.round(rasterPx / aspect)) : rasterPx
  const result = rasterize(upsampled, gridW, gridH, latMin, latMax, lonMin, lonMax, directionalGain, {
    autoRange: accumAutoRange, logLo: accumLogLo, logHi: accumLogHi,
  })
  if (result && result.stats) {
    result.stats.rawBlobs = rawBlobCount
    result.stats.decimation = decimation
    result.stats.tracks = tracks.length
    // Diagnostic: measure actual on-map distances between consecutive
    // emitted blobs so we can verify the walker is producing uniform
    // spacing. Surfaced via window.__noiseDebug for inspection.
    if (typeof window !== 'undefined' && upsampled.length > 1) {
      const spacings = []
      for (let i = 1; i < Math.min(upsampled.length, 200); i++) {
        const a = upsampled[i - 1], b = upsampled[i]
        const dLat = (b.lat - a.lat) * 364560 / 6076.12
        const dLon = (b.lon - a.lon) * 364560 / 6076.12 * Math.cos(a.lat * Math.PI / 180)
        spacings.push(Math.hypot(dLat, dLon)) // nm
      }
      spacings.sort((x, y) => x - y)
      result.stats.spacingNm = {
        min: spacings[0],
        p25: spacings[Math.floor(spacings.length * 0.25)],
        p50: spacings[Math.floor(spacings.length * 0.5)],
        p75: spacings[Math.floor(spacings.length * 0.75)],
        max: spacings[spacings.length - 1],
        sample_count: spacings.length,
      }
    }
  }
  return result
}

// ─── Population impact raster ───────────────────────────────────────────────
// noise energy × population density = "people affected" heat map.
// `popData` is the parsed population_density.json (grid, bounds, gridW, gridH).

// Magenta-based palette for the impact layer — visually distinct from the
// blue→red noise palette and the yellow→brown density palette.
const IMPACT_PALETTE = [
  [ 60,  20, 80],  // deep purple
  [ 90,  30,120],  // purple
  [140,  30,150],  // magenta
  [180,  40,140],  // hot pink
  [220,  60,100],  // raspberry
  [240, 100, 60],  // coral
  [250, 150, 40],  // tangerine
  [255, 200, 60],  // gold
  [255, 240,120],  // pale yellow
  [255, 255,200],  // cream (hottest)
]
function impactPaletteLookup(t) {
  const c = Math.max(0, Math.min(1, t))
  const pos = c * (IMPACT_PALETTE.length - 1)
  const i = pos | 0, f = pos - i
  const a = IMPACT_PALETTE[i]
  const b = IMPACT_PALETTE[Math.min(IMPACT_PALETTE.length - 1, i + 1)]
  return [
    (a[0] + (b[0] - a[0]) * f) | 0,
    (a[1] + (b[1] - a[1]) * f) | 0,
    (a[2] + (b[2] - a[2]) * f) | 0,
  ]
}

// Sample the population density grid at a given (lat, lon). Returns
// people/km² or 0 if outside the grid.
function samplePopDensity(popData, lat, lon) {
  const { bounds, gridW, gridH, grid } = popData
  const { latMin, latMax, lonMin, lonMax } = bounds
  if (lat < latMin || lat > latMax || lon < lonMin || lon > lonMax) return 0
  // grid row 0 = north (latMax), row gridH-1 = south (latMin)
  const row = Math.floor(((latMax - lat) / (latMax - latMin)) * gridH)
  const col = Math.floor(((lon - lonMin) / (lonMax - lonMin)) * gridW)
  if (row < 0 || row >= gridH || col < 0 || col >= gridW) return 0
  return grid[row]?.[col] || 0
}

export function computeImpactRaster(tracks, popData, opts = {}) {
  const {
    radiusScale = 3.0,
    directionalGain = 0.6,
    noiseResolution = 4,
    gapThresholdFt = 3000,
    samplePeriodS = 1,
    maxBlobs = 50000,
    rasterPx = 1200,
    blobsPerNm = 10,
    targetBlobsPerMin = 20,
    todStart = null,
    todEnd = null,
    tzOffsetS = -7 * 3600,
  } = opts

  if (!popData || !popData.grid) return null

  const hasTodFilter = todStart != null && todEnd != null
  function inTodRange(t0, tSec) {
    if (!hasTodFilter || t0 == null || tSec == null) return !hasTodFilter
    const localS = (t0 + tSec + tzOffsetS)
    const hour = Math.floor((((localS % 86400) + 86400) % 86400) / 3600)
    if (todStart <= todEnd) return hour >= todStart && hour < todEnd
    return hour >= todStart || hour < todEnd
  }

  const lerp = (a, b, t) => a + (b - a) * t
  let allBlobs = []
  for (const t of tracks) {
    const pts = t.points || []
    if (pts.length < 3) continue
    const prof = buildEnergyProfile(pts, samplePeriodS, t.type)
    let blobs = computeBlobs(pts, prof.perPoint, radiusScale)
    if (hasTodFilter) {
      blobs = blobs.filter((b, i) => {
        const p = pts[i]
        return inTodRange(t.t0, p && p[3])
      })
    }
    // Haversine resample — same algorithm as computeNoiseRaster.
    const stepNm = 1 / Math.max(0.01, blobsPerNm)
    const minRadiusM = (stepNm * 1852) * 0.6
    const cleanIdx = [0]
    for (let i = 1; i < blobs.length; i++) {
      const prev = blobs[cleanIdx[cleanIdx.length - 1]]
      const cur = blobs[i]
      if (cur.lat !== prev.lat || cur.lon !== prev.lon) cleanIdx.push(i)
    }
    if (cleanIdx.length < 2) continue
    const segNm = new Float64Array(cleanIdx.length - 1)
    let totalNm = 0
    for (let i = 0; i < segNm.length; i++) {
      const a = blobs[cleanIdx[i]], b = blobs[cleanIdx[i + 1]]
      const lat1 = a.lat * Math.PI / 180, lat2 = b.lat * Math.PI / 180
      const dLat = lat2 - lat1
      const dLon = (b.lon - a.lon) * Math.PI / 180
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
      segNm[i] = 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(h)))
      totalNm += segNm[i]
    }
    if (totalNm < stepNm) {
      for (const b of blobs) allBlobs.push(b)
      continue
    }
    const emit = (a, b, tf) => {
      const altRadius = lerp(a.radius_m, b.radius_m, tf)
      allBlobs.push({
        lat: lerp(a.lat, b.lat, tf),
        lon: lerp(a.lon, b.lon, tf),
        radius_m: Math.max(minRadiusM, altRadius),
        hp: lerp(a.hp, b.hp, tf),
        heading: bearing([a.lat, a.lon], [b.lat, b.lon]),
      })
    }
    emit(blobs[cleanIdx[0]], blobs[cleanIdx[1]], 0)
    let segIdx = 0
    let segStart = 0
    let nextEmit = stepNm
    while (nextEmit <= totalNm) {
      while (segIdx < segNm.length && segStart + segNm[segIdx] < nextEmit) {
        segStart += segNm[segIdx]
        segIdx++
      }
      if (segIdx >= segNm.length) break
      const tf = (nextEmit - segStart) / segNm[segIdx]
      emit(blobs[cleanIdx[segIdx]], blobs[cleanIdx[segIdx + 1]], tf)
      nextEmit += stepNm
    }
  }
  if (!allBlobs.length) return null

  let decimation = 1
  if (maxBlobs > 0 && allBlobs.length > maxBlobs) {
    decimation = Math.ceil(allBlobs.length / maxBlobs)
    const decimated = []
    for (let i = 0; i < allBlobs.length; i += decimation) {
      decimated.push({ ...allBlobs[i], hp: allBlobs[i].hp * decimation })
    }
    allBlobs = decimated
  }

  // Bbox from blobs
  const g = Math.max(0, Math.min(0.95, directionalGain))
  const sideBoost = 1 / Math.sqrt(Math.max(0.1, 1 - g * 0.85)) * 1.05
  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity
  for (const b of allBlobs) {
    const rPad = b.radius_m * sideBoost
    const dLat = rPad / 111320, dLon = rPad / (111320 * Math.cos(b.lat * Math.PI / 180))
    if (b.lat-dLat < latMin) latMin = b.lat-dLat
    if (b.lat+dLat > latMax) latMax = b.lat+dLat
    if (b.lon-dLon < lonMin) lonMin = b.lon-dLon
    if (b.lon+dLon > lonMax) lonMax = b.lon+dLon
  }
  const dLat = latMax - latMin, dLon = lonMax - lonMin
  if (dLat <= 0 || dLon <= 0) return null
  const aspect = (dLon * Math.cos((latMin+latMax)/2 * Math.PI / 180)) / dLat
  const gridW = aspect >= 1 ? rasterPx : Math.max(64, Math.round(rasterPx * aspect))
  const gridH = aspect >= 1 ? Math.max(64, Math.round(rasterPx / aspect)) : rasterPx

  // Step 1: accumulate noise energy (same as the baseline noise map)
  const energy = accumulate(allBlobs, gridW, gridH, latMin, latMax, lonMin, lonMax, directionalGain)
  if (!energy) return null

  // Step 2: sample raw population density into a parallel grid.
  // Log-normalize so dense urban (~15k ppl/km²) maps near 1.0 and rural
  // (~10 ppl/km²) maps near 0. Uninhabited stays at 0.
  const POP_LOG_FLOOR = Math.log(10)
  const POP_LOG_CEIL = Math.log(15000)
  const popSpan = POP_LOG_CEIL - POP_LOG_FLOOR
  const pop = new Float32Array(gridW * gridH)
  for (let row = 0; row < gridH; row++) {
    const lat = latMax - (row + 0.5) / gridH * (latMax - latMin)
    for (let col = 0; col < gridW; col++) {
      const lon = lonMin + (col + 0.5) / gridW * (lonMax - lonMin)
      const p = samplePopDensity(popData, lat, lon)
      if (p > 0) pop[row * gridW + col] = Math.max(0, Math.min(1,
        (Math.log(p) - POP_LOG_FLOOR) / popSpan
      ))
    }
  }

  // Step 3: blur the population grid with separable box blur (two passes).
  // Smooths sharp block-group polygon edges so the alpha mask reads as a
  // soft urban density gradient. Radius scales with grid size.
  const blurRadiusPx = Math.max(2, Math.round(gridW / 80))
  const popBlurred = boxBlur2D(pop, gridW, gridH, blurRadiusPx)

  // Step 4: stretch blurred population to full 0-1 range (max → 1, min → 0).
  // After blurring, peak values shrink — re-stretch so dense urban remains
  // fully opaque and rural fades to transparent.
  let popMax = 0
  for (let i = 0; i < popBlurred.length; i++) if (popBlurred[i] > popMax) popMax = popBlurred[i]
  if (popMax > 0) {
    const inv = 1 / popMax
    for (let i = 0; i < popBlurred.length; i++) popBlurred[i] *= inv
  }

  // Step 5: colorize using noise palette (energy → color), alpha from population.
  // Cells with zero noise OR zero population are fully transparent.
  const result = colorizeWithMaskAlpha(
    energy, popBlurred, gridW, gridH, latMin, latMax, lonMin, lonMax,
    paletteLookup, // noise palette — same as the baseline noise map
  )
  if (result) {
    result.stats.tracks = tracks.length
    result.stats.decimation = decimation
    result.stats.blurRadiusPx = blurRadiusPx
  }
  return result
}

// Separable box blur on a Float32 grid. Two 1D passes (horizontal then
// vertical) — O(n) per pixel regardless of radius.
function boxBlur2D(src, w, h, r) {
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  // Horizontal pass: tmp[row, col] = avg of src[row, col-r..col+r]
  for (let y = 0; y < h; y++) {
    const rowOff = y * w
    let sum = 0
    let n = 0
    // Initialize window: cols [0..r]
    for (let x = 0; x <= Math.min(r, w - 1); x++) { sum += src[rowOff + x]; n++ }
    for (let x = 0; x < w; x++) {
      tmp[rowOff + x] = sum / n
      const addCol = x + r + 1
      const dropCol = x - r
      if (addCol < w) { sum += src[rowOff + addCol]; n++ }
      if (dropCol >= 0) { sum -= src[rowOff + dropCol]; n-- }
    }
  }
  // Vertical pass: out[row, col] = avg of tmp[row-r..row+r, col]
  for (let x = 0; x < w; x++) {
    let sum = 0
    let n = 0
    for (let y = 0; y <= Math.min(r, h - 1); y++) { sum += tmp[y * w + x]; n++ }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n
      const addRow = y + r + 1
      const dropRow = y - r
      if (addRow < h) { sum += tmp[addRow * w + x]; n++ }
      if (dropRow >= 0) { sum -= tmp[dropRow * w + x]; n-- }
    }
  }
  return out
}

// Color each cell by `energy` (using palFn), but use `mask` (0–1) to
// modulate alpha. A cell with high energy in an unpopulated area becomes
// fully transparent; a cell with high energy in dense population is solid.
function colorizeWithMaskAlpha(energy, mask, gridW, gridH, latMin, latMax, lonMin, lonMax, palFn) {
  // Auto-fit the noise palette to the energy distribution
  const nonZero = []
  for (let i = 0; i < energy.length; i++) if (energy[i] > 0) nonZero.push(energy[i])
  nonZero.sort((x, y) => x - y)
  const loObs = nonZero.length ? nonZero[Math.floor(nonZero.length * 0.01)] : 0
  const hiObs = nonZero.length ? nonZero[Math.floor(nonZero.length * 0.99)] : 1
  const loL = Math.log(Math.max(1e-12, loObs))
  const hiL = Math.log(Math.max(1e-12, hiObs))
  const span = Math.max(0.01, hiL - loL)
  const LUT_SIZE = 256
  const lutR = new Uint8Array(LUT_SIZE), lutG = new Uint8Array(LUT_SIZE), lutB = new Uint8Array(LUT_SIZE)
  for (let k = 0; k < LUT_SIZE; k++) {
    const [r, g2, b2] = palFn(k / (LUT_SIZE - 1))
    lutR[k] = r; lutG[k] = g2; lutB[k] = b2
  }
  const canvas = document.createElement('canvas')
  canvas.width = gridW; canvas.height = gridH
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(gridW, gridH)
  const data = img.data
  for (let i = 0; i < energy.length; i++) {
    const e = energy[i]
    const m = mask[i]
    if (e <= 0 || m <= 0) { data[i*4+3] = 0; continue }
    let s = (Math.log(e) - loL) / span
    if (s < 0) s = 0; else if (s > 1) s = 1
    const k = (s * (LUT_SIZE - 1)) | 0
    data[i*4] = lutR[k]; data[i*4+1] = lutG[k]; data[i*4+2] = lutB[k]
    // Alpha = population mask × 255. Don't gate by noise intensity here —
    // any noisy area over people should be fully visible.
    data[i*4+3] = (m * 255) | 0
  }
  ctx.putImageData(img, 0, 0)
  return {
    dataUrl: canvas.toDataURL('image/png'),
    latLngBounds: [[latMin, lonMin], [latMax, lonMax]],
    stats: {
      loLog10: Math.log10(Math.max(1e-12, loObs)),
      hiLog10: Math.log10(Math.max(1e-12, hiObs)),
      cells: nonZero.length, blobs: energy.length,
    },
  }
}

// ─── Hourly animation ───────────────────────────────────────────────────────
// Bin blobs by hour-of-day (local time), then rasterize each hour into a
// separate frame. Returns frames via a callback so the caller can animate
// progressively as each hour lands.
//
// Requires timestamped data: t0 (epoch) on the track + p[3] (sec offset)
// on each point. Tracks / points without timestamps are silently skipped.
//
// onFrame(frame) is called for each completed hour:
//   { hour, dataUrl, latLngBounds, blobCount, stats }
// onDone() fires when all hours are built.
const MST_OFFSET_S = -7 * 3600  // Mountain Standard Time

export function computeHourlyRasters(tracks, opts = {}, onFrame, onDone) {
  const {
    radiusScale = 3.0,
    directionalGain = 0.6,
    gapThresholdFt = 3000,
    accumAutoRange = false,
    accumLogLo = -6.90,
    accumLogHi = -0.60,
    samplePeriodS = 1,
    maxBlobs = 50000,
    startHour = 7,
    endHour = 22,     // exclusive — 7..21 = 7 AM to 9 PM
    tzOffsetS = MST_OFFSET_S,
  } = opts

  // Step 1: build ALL blobs with absolute epoch timestamps attached.
  const allBlobs = []
  for (const t of tracks) {
    if (t.t0 == null) continue
    const pts = t.points || []
    if (pts.length < 3) continue
    const prof = buildEnergyProfile(pts, samplePeriodS, t.type)
    const blobs = computeBlobs(pts, prof.perPoint, radiusScale)
    for (let i = 0; i < blobs.length; i++) {
      const p = pts[i + (pts.length - blobs.length)]  // blobs may be shorter (skipped ground)
      // Find the matching source point for this blob to get its timestamp.
      // computeBlobs skips agl < 50, so indices don't line up 1:1. Use
      // lat/lon proximity as a fallback but prefer direct index when the
      // point has p[3].
      const srcIdx = pts.findIndex(
        (pp) => Math.abs(pp[0] - blobs[i].lat) < 0.0001 && Math.abs(pp[1] - blobs[i].lon) < 0.0001
      )
      const srcPt = srcIdx >= 0 ? pts[srcIdx] : null
      if (!srcPt || srcPt[3] == null) continue
      const epochS = t.t0 + srcPt[3]
      const localS = epochS + tzOffsetS
      const hourOfDay = Math.floor((((localS % 86400) + 86400) % 86400) / 3600)
      allBlobs.push({ ...blobs[i], _hour: hourOfDay })
    }
  }

  if (!allBlobs.length) {
    if (onDone) onDone()
    return
  }

  // Step 2: find global bbox across ALL blobs so every frame shares the
  // same grid — this way the animation doesn't jump around.
  const g = Math.max(0, Math.min(0.95, directionalGain))
  const sideBoost = 1 / Math.sqrt(Math.max(0.1, 1 - g * 0.85)) * 1.05
  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity
  for (const b of allBlobs) {
    const rPad = b.radius_m * sideBoost
    const dLat = rPad / 111320, dLon = rPad / (111320 * Math.cos(b.lat * Math.PI / 180))
    if (b.lat - dLat < latMin) latMin = b.lat - dLat
    if (b.lat + dLat > latMax) latMax = b.lat + dLat
    if (b.lon - dLon < lonMin) lonMin = b.lon - dLon
    if (b.lon + dLon > lonMax) lonMax = b.lon + dLon
  }
  const dLat = latMax - latMin, dLon = lonMax - lonMin
  if (dLat <= 0 || dLon <= 0) { if (onDone) onDone(); return }
  const aspect = (dLon * Math.cos((latMin + latMax) / 2 * Math.PI / 180)) / dLat
  const targetPx = 500
  const gridW = aspect >= 1 ? targetPx : Math.max(64, Math.round(targetPx * aspect))
  const gridH = aspect >= 1 ? Math.max(64, Math.round(targetPx / aspect)) : targetPx

  // Step 3: bin blobs by hour.
  const byHour = new Map()
  for (const b of allBlobs) {
    const h = b._hour
    if (!byHour.has(h)) byHour.set(h, [])
    byHour.get(h).push(b)
  }

  // Step 4: progressively rasterize each hour via setTimeout so the UI
  // stays responsive and can animate frames as they arrive.
  const hours = []
  for (let h = startHour; h < endHour; h++) hours.push(h)
  let idx = 0

  function next() {
    if (idx >= hours.length) { if (onDone) onDone(); return }
    const h = hours[idx++]
    let blobs = byHour.get(h) || []
    // Budget gate
    let dec = 1
    if (maxBlobs > 0 && blobs.length > maxBlobs) {
      dec = Math.ceil(blobs.length / maxBlobs)
      const d = []
      for (let i = 0; i < blobs.length; i += dec) d.push({ ...blobs[i], hp: blobs[i].hp * dec })
      blobs = d
    }
    const result = rasterize(
      blobs, gridW, gridH, latMin, latMax, lonMin, lonMax, directionalGain,
      { autoRange: accumAutoRange, logLo: accumLogLo, logHi: accumLogHi },
    )
    if (onFrame) {
      onFrame({
        hour: h,
        dataUrl: result ? result.dataUrl : null,
        latLngBounds: [[latMin, lonMin], [latMax, lonMax]],
        blobCount: blobs.length,
        stats: result ? result.stats : null,
      })
    }
    setTimeout(next, 0)
  }
  setTimeout(next, 0)
}
