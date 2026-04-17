// Client-side port of noise/noise_heatmap.py. Used to compute a one-shot
// noise footprint for a single selected aircraft's track on the map.

import { terrainAt, buildTerrainArray } from './terrain'

export const DEFAULT_HP = 180

export const HP_BY_ICAO = {
  // --- piston singles ---
  C140: 90, C150: 100, C152: 110, C162: 100,
  C172: 180, C72R: 180, C177: 180,
  C182: 230, C82R: 230, C185: 300,
  C206: 300, C210: 300, C240: 230,
  DA40: 180, DV20: 100,
  SR20: 215, SR22: 310, S22T: 315, SP20: 215,
  COL3: 310, COL4: 310,
  M20P: 200, M20T: 280,
  P28A: 160, P28B: 180, P28R: 200, P28T: 300, P32R: 300,
  PA11: 90, PA12: 115, PA16: 108, PA18: 150,
  BE35: 285, BE36: 300,
  AA5: 150,
  CH7A: 118, CH7B: 150, CRUZ: 100,
  T34P: 285, T6: 600, HUSK: 200,
  RV4: 160, RV6: 180, RV7: 180, RV8: 180, RV12: 100,
  LNC2: 200, LGEZ: 180, ERCO: 75,
  BDOG: 200, EAGL: 180, FOX: 180, ULAC: 100, VL3: 100, EXPR: 210,
  AR65: 420,
  // --- piston twins ---
  BE55: 520, BE76: 360, BE40: 800,
  C310: 520, C421: 750, C425: 900,
  PA34: 440, PA44: 360, P337: 420, P06T: 700,
  SW3: 1400,
  // --- turboprops ---
  BE30: 1250, B350: 2100,
  PC12: 1200, M600: 600,
  TBM7: 700, TBM8: 850, TBM9: 850,
  PA46: 350, P46T: 500, PAY1: 1000,
  AC90: 1400, C208: 675,
  // --- jets ---
  B38M: 8000, B752: 10000,
  C25C: 2500, C25M: 2500, C510: 1800, C525: 2200,
  C55B: 3000, C560: 3500, C56X: 3500, C650: 4500,
  C680: 4500, C68A: 4500, C700: 5000, C750: 5500,
  CL30: 4500, CL35: 4500, CL60: 5000,
  E135: 5000, E145: 5000, E55P: 2500,
  F2TH: 5000, F900: 6000,
  G200: 5000, GLEX: 7000, GLF4: 6500, GLF5: 7000,
  H25B: 5000, HDJT: 1500,
  LJ31: 3000, LJ45: 3500, LJ60: 4500, LJ70: 4500,
  // --- helicopters ---
  R44: 245, B06: 420, B407: 700, H500: 420, AS50: 590, UH1: 1400,
  // --- silent ---
  GLID: 0, BALL: 0, XNOS: 0, COY2: 0,
}

export function hpForType(type) {
  if (!type) return DEFAULT_HP
  const v = HP_BY_ICAO[type.toUpperCase()]
  return v == null ? DEFAULT_HP : v
}

// --- model constants (match noise/noise_heatmap.py) ---
const REF_SOURCE_DB = 110
const HP_REF = 100
const V_REF_KTS = 100
const FT_PER_M = 3.28084
const G_TERRAIN = 0.65
const ALPHA_ATM = 0.0016
const SPREAD_EXP = 40
const MIN_SLANT_FT = 50

/**
 * Compute a one-off noise footprint PNG for a single aircraft track.
 * @param {Array<[lat, lon, altFt]>} points
 * @param {string} icaoType
 * @param {object} opts
 * @returns {{ url: string, bounds: [[number, number], [number, number]], dbMax: number|null } | null}
 */
export function computeSingleTrackHeatmap(points, icaoType, opts = {}) {
  const {
    halfKm = 14,
    cellM = 180,
    dtS = 1,
    maxAglFt = 2500,
    influenceKm = 10,
    visRangeDb = 35,
    spreadExp = 25,  // softer rolloff for single aircraft (aggregate uses 40)
    centerLat = null, // clip points to a circle around this point
    centerLon = null,
    maxDistNm = 6,
  } = opts

  if (!points || points.length < 2) return null
  const hp = hpForType(icaoType)
  if (hp <= 0) {
    return {
      url: null, bounds: null, dbMax: null,
      stats: { hp: 0, points: points.length, skipped: 'no-engine' },
    }
  }
  const hpDb = 10 * Math.log10(hp / HP_REF)

  // drop high-altitude cruise AND any point with a missing altitude
  let base = points.filter(
    (p) => p && p[0] != null && p[1] != null && p[2] != null
           && (p[2] - terrainAt(p[0], p[1])) <= maxAglFt
  )
  // Optional geographic clip. Keeps giant cross-country tracks from
  // blowing up the grid math — only points inside a circle around
  // (centerLat, centerLon) with radius maxDistNm contribute.
  if (centerLat != null && centerLon != null && maxDistNm > 0) {
    const mPerDegLatC = 111320
    const mPerDegLonC = 111320 * Math.cos((centerLat * Math.PI) / 180)
    const maxM = maxDistNm * 1852
    const maxM2 = maxM * maxM
    base = base.filter((p) => {
      const dy = (p[0] - centerLat) * mPerDegLatC
      const dx = (p[1] - centerLon) * mPerDegLonC
      return dx * dx + dy * dy <= maxM2
    })
  }
  if (base.length < 2) return null

  // Grid centered on the clip center when provided (so the output aligns
  // with the 6 nm KBDU ring); otherwise fall back to the track centroid.
  let lat0, lon0
  if (centerLat != null && centerLon != null) {
    lat0 = centerLat
    lon0 = centerLon
  } else {
    let sumLat = 0, sumLon = 0
    for (const p of base) { sumLat += p[0]; sumLon += p[1] }
    lat0 = sumLat / base.length
    lon0 = sumLon / base.length
  }
  const mPerDegLat = 111320
  const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180)

  const n = Math.max(32, Math.round((2 * halfKm * 1000) / cellM))
  const energy = new Float64Array(n * n)
  const terrainGrid = buildTerrainArray(lat0, lon0, n, cellM)
  const halfIdx = (n - 1) / 2
  const infM = influenceKm * 1000
  const infM2 = infM * infM
  const rCells = Math.ceil(infM / cellM)

  // Iterate per ORIGINAL segment. For each cell in the segment's influence
  // window, we compute the closest point Q on segment AB to the cell, then
  // treat Q as the source position. This produces a smooth ribbon with no
  // bead artifacts — the per-cell source slides continuously along the
  // segment as you move across the ground plane.
  for (let i = 1; i < base.length; i++) {
    const a = base[i - 1], b = base[i]
    const xa = (a[1] - lon0) * mPerDegLon
    const ya = (a[0] - lat0) * mPerDegLat
    const xb = (b[1] - lon0) * mPerDegLon
    const yb = (b[0] - lat0) * mPerDegLat
    const segDx = xb - xa, segDy = yb - ya
    const seg2 = segDx * segDx + segDy * segDy
    const segDist = Math.sqrt(seg2)

    const dz = b[2] - a[2]
    const stateDb = dz > 50 ? 0 : dz < -50 ? -6 : -3
    const vKts = Math.max(30, (segDist / dtS) * 1.94384)
    const doseDb = 10 * Math.log10(V_REF_KTS / Math.max(vKts, 20))

    let vx = segDx, vy = segDy
    if (segDist < 1e-3) { vx = 1; vy = 0 } else { vx /= segDist; vy /= segDist }

    const srcDb = REF_SOURCE_DB + hpDb + stateDb + doseDb

    // Bounding window for this segment: union of the two endpoints'
    // influence regions.
    const minX = Math.min(xa, xb), maxX = Math.max(xa, xb)
    const minY = Math.min(ya, yb), maxY = Math.max(ya, yb)
    const x0 = Math.max(0, Math.floor((minX - infM) / cellM + halfIdx))
    const x1 = Math.min(n, Math.ceil((maxX + infM) / cellM + halfIdx) + 1)
    const y0 = Math.max(0, Math.floor((minY - infM) / cellM + halfIdx))
    const y1 = Math.min(n, Math.ceil((maxY + infM) / cellM + halfIdx) + 1)

    for (let row = y0; row < y1; row++) {
      const cellY = (row - halfIdx) * cellM
      for (let col = x0; col < x1; col++) {
        const cellX = (col - halfIdx) * cellM

        // Closest point Q on segment AB to the cell.
        let tParam = 0
        if (seg2 > 1e-6) {
          tParam = ((cellX - xa) * segDx + (cellY - ya) * segDy) / seg2
          if (tParam < 0) tParam = 0
          else if (tParam > 1) tParam = 1
        }
        const qx = xa + segDx * tParam
        const qy = ya + segDy * tParam
        const qAlt = a[2] + (b[2] - a[2]) * tParam
        // AGL relative to the receiving cell's terrain elevation
        const cellTerrain = terrainGrid[row * n + col]
        const qAglFt = Math.max(qAlt - cellTerrain, 0)

        const sdx = cellX - qx
        const sdy = cellY - qy
        const horiz2 = sdx * sdx + sdy * sdy
        if (horiz2 > infM2) continue
        const horizM = Math.sqrt(horiz2)
        const horizFt = horizM * FT_PER_M
        const slantFt = Math.max(Math.hypot(qAglFt, horizFt), MIN_SLANT_FT)

        let db = srcDb - spreadExp * Math.log10(slantFt / 100)
        const theta = Math.atan2(qAglFt, Math.max(horizFt, 1e-6))
        db -= G_TERRAIN * (10 - 8 * Math.sin(theta))
        db -= G_TERRAIN * 9.5 * Math.pow(Math.cos(theta), 2.5)
        db -= ALPHA_ATM * slantFt

        const qAglM = qAglFt / FT_PER_M
        const slantM = Math.sqrt(horiz2 + qAglM * qAglM) + 1e-6
        const cosT = (sdx * vx + sdy * vy) / slantM
        const sin2 = Math.max(0, Math.min(1, 1 - cosT * cosT))
        db += 10 * Math.log10(sin2 + 0.05)

        // Linear energy sum for a single aircraft — LAeq-style dose
        // summation. With closest-point-per-segment this already gives a
        // smooth ribbon (no beads), and keeping the sum lets a longer
        // exposure at the same position read louder than a brief tangent.
        energy[row * n + col] += Math.pow(10, db / 10)
      }
    }
  }

  // Convert to dB, track the real min/max of cells that got any energy.
  const dbArr = new Float32Array(n * n)
  let dbMax = -Infinity
  let dbMin = Infinity
  for (let i = 0; i < energy.length; i++) {
    if (energy[i] > 0) {
      const d = 10 * Math.log10(energy[i])
      dbArr[i] = d
      if (d > dbMax) dbMax = d
      if (d < dbMin) dbMin = d
    } else {
      dbArr[i] = -Infinity
    }
  }
  // Ramp spans the entire observed dB range — every cell that received any
  // contribution shows up, with the quietest as deep blue and the hottest as
  // red. No hard threshold means no cliff-edge falloff. visRangeDb now just
  // caps how wide the ramp can get so a single ultra-bright pixel doesn't
  // wash out the whole track.
  const visMax = isFinite(dbMax) ? dbMax : 60
  const observedSpan = isFinite(dbMin) ? dbMax - dbMin : visRangeDb
  const span = Math.max(1, Math.min(observedSpan, visRangeDb))
  const visMin = visMax - span

  const canvas = document.createElement('canvas')
  canvas.width = n
  canvas.height = n
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(n, n)
  for (let row = 0; row < n; row++) {
    const srcRow = n - 1 - row // flip north-up
    for (let col = 0; col < n; col++) {
      const d = dbArr[srcRow * n + col]
      const idx = (row * n + col) * 4
      if (!isFinite(d)) {
        // cell got zero contribution from any sample — keep transparent
        img.data[idx + 3] = 0
        continue
      }
      // Smooth fade: t in [0,1] linearly in dB over the observed range.
      // Below visMin → t=0 (deep blue) with reduced alpha so the quietest
      // cells don't blot out the tile layer. No hard threshold.
      const raw = (d - visMin) / span
      const t = Math.min(1, Math.max(0, raw))
      const r = t < 0.5 ? 0 : Math.round(255 * (t - 0.5) * 2)
      const g = t < 0.5 ? Math.round(255 * t * 2) : Math.round(255 * (1 - (t - 0.5) * 2))
      const b = t < 0.5 ? Math.round(255 * (1 - t * 2)) : 0
      img.data[idx] = r
      img.data[idx + 1] = g
      img.data[idx + 2] = b
      // Alpha ramps from ~40 at the dim end to 230 at the hot end so weak
      // cells are visibly present but don't dominate.
      img.data[idx + 3] = Math.round(40 + 190 * t)
    }
  }
  ctx.putImageData(img, 0, 0)

  const dLat = (halfKm * 1000) / mPerDegLat
  const dLon = (halfKm * 1000) / mPerDegLon

  // Summary stats from the base (non-subsampled) points for the tooltip.
  const agls = []
  let climb = 0, cruise = 0, descent = 0
  for (let i = 0; i < base.length; i++) {
    agls.push(Math.max(base[i][2] - terrainAt(base[i][0], base[i][1]), 0))
    if (i > 0) {
      const dz = base[i][2] - base[i - 1][2]
      if (dz > 50) climb++
      else if (dz < -50) descent++
      else cruise++
    }
  }
  agls.sort((a, b) => a - b)
  const median = agls.length ? agls[Math.floor(agls.length / 2)] : null
  // (fall through to return below)

  return {
    url: canvas.toDataURL('image/png'),
    bounds: [[lat0 - dLat, lon0 - dLon], [lat0 + dLat, lon0 + dLon]],
    dbMax: isFinite(dbMax) ? dbMax : null,
    stats: {
      hp,
      points: base.length,
      aglMin: agls[0] ?? null,
      aglMax: agls[agls.length - 1] ?? null,
      aglMedian: median,
      climb,
      cruise,
      descent,
    },
  }
}


/**
 * Multi-track aggregate. Accumulates LMax (loudest single-segment dB per
 * cell) across many tracks so the result shows noise SHAPE across a filter
 * slice, not cumulative dose. Designed to be called on-demand with the
 * user's current filter set (school/year/base/origin).
 *
 * @param {Array<{points: Array, type: string}>} tracks
 * @param {object} opts — same as computeSingleTrackHeatmap, plus:
 *   centerLat/centerLon default to KBDU
 * @returns {{ url, bounds, dbMax, stats } | null}
 */
export function computeMultiTrackHeatmap(tracks, opts = {}) {
  const {
    halfKm = 12,
    cellM = 100,
    dtS = 1,
    maxAglFt = 2500,
    influenceKm = 10,
    visRangeDb = 35,
    spreadExp = 25,
    centerLat = 40.0394,    // KBDU
    centerLon = -105.2258,
    maxDistNm = 5,
  } = opts

  if (!tracks || tracks.length === 0) return null

  const lat0 = centerLat
  const lon0 = centerLon
  const mPerDegLat = 111320
  const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180)
  const maxM2 = (maxDistNm * 1852) ** 2

  const n = Math.max(32, Math.round((2 * halfKm * 1000) / cellM))
  const energy = new Float64Array(n * n) // holds LMax linear power per cell
  const terrainGrid = buildTerrainArray(lat0, lon0, n, cellM)
  const halfIdx = (n - 1) / 2
  const infM = influenceKm * 1000
  const infM2 = infM * infM

  let aircraftUsed = 0
  let pointsUsed = 0

  for (const track of tracks) {
    const pts = track.points
    if (!pts || pts.length < 2) continue
    const hp = hpForType(track.type || '')
    if (hp <= 0) continue
    const hpDb = 10 * Math.log10(hp / HP_REF)

    // Filter points: AGL cap + KBDU 5 nm clip. Keeps giant
    // transits from contributing outside the local area.
    const base = []
    for (const p of pts) {
      if (!p || p[0] == null || p[1] == null || p[2] == null) continue
      if ((p[2] - terrainAt(p[0], p[1])) > maxAglFt) continue
      const dy = (p[0] - lat0) * mPerDegLat
      const dx = (p[1] - lon0) * mPerDegLon
      if (dx * dx + dy * dy > maxM2) continue
      base.push(p)
    }
    if (base.length < 2) continue

    aircraftUsed++
    pointsUsed += base.length

    for (let i = 1; i < base.length; i++) {
      const a = base[i - 1], b = base[i]
      const xa = (a[1] - lon0) * mPerDegLon
      const ya = (a[0] - lat0) * mPerDegLat
      const xb = (b[1] - lon0) * mPerDegLon
      const yb = (b[0] - lat0) * mPerDegLat
      const segDx = xb - xa, segDy = yb - ya
      const seg2 = segDx * segDx + segDy * segDy
      const segDist = Math.sqrt(seg2)

      const dz = b[2] - a[2]
      const stateDb = dz > 50 ? 0 : dz < -50 ? -6 : -3
      const vKts = Math.max(30, (segDist / dtS) * 1.94384)
      const doseDb = 10 * Math.log10(V_REF_KTS / Math.max(vKts, 20))

      let vx = segDx, vy = segDy
      if (segDist < 1e-3) { vx = 1; vy = 0 } else { vx /= segDist; vy /= segDist }

      const srcDb = REF_SOURCE_DB + hpDb + stateDb + doseDb

      const minX = Math.min(xa, xb), maxX = Math.max(xa, xb)
      const minY = Math.min(ya, yb), maxY = Math.max(ya, yb)
      const x0 = Math.max(0, Math.floor((minX - infM) / cellM + halfIdx))
      const x1 = Math.min(n, Math.ceil((maxX + infM) / cellM + halfIdx) + 1)
      const y0 = Math.max(0, Math.floor((minY - infM) / cellM + halfIdx))
      const y1 = Math.min(n, Math.ceil((maxY + infM) / cellM + halfIdx) + 1)

      for (let row = y0; row < y1; row++) {
        const cellY = (row - halfIdx) * cellM
        for (let col = x0; col < x1; col++) {
          const cellX = (col - halfIdx) * cellM

          let tParam = 0
          if (seg2 > 1e-6) {
            tParam = ((cellX - xa) * segDx + (cellY - ya) * segDy) / seg2
            if (tParam < 0) tParam = 0
            else if (tParam > 1) tParam = 1
          }
          const qx = xa + segDx * tParam
          const qy = ya + segDy * tParam
          const qAlt = a[2] + (b[2] - a[2]) * tParam
          const cellTerrain = terrainGrid[row * n + col]
          const qAglFt = Math.max(qAlt - cellTerrain, 0)

          const sdx = cellX - qx
          const sdy = cellY - qy
          const horiz2 = sdx * sdx + sdy * sdy
          if (horiz2 > infM2) continue
          const horizM = Math.sqrt(horiz2)
          const horizFt = horizM * FT_PER_M
          const slantFt = Math.max(Math.hypot(qAglFt, horizFt), MIN_SLANT_FT)

          let db = srcDb - spreadExp * Math.log10(slantFt / 100)
          const theta = Math.atan2(qAglFt, Math.max(horizFt, 1e-6))
          db -= G_TERRAIN * (10 - 8 * Math.sin(theta))
          db -= G_TERRAIN * 9.5 * Math.pow(Math.cos(theta), 2.5)
          db -= ALPHA_ATM * slantFt

          const qAglM = qAglFt / FT_PER_M
          const slantM = Math.sqrt(horiz2 + qAglM * qAglM) + 1e-6
          const cosT = (sdx * vx + sdy * vy) / slantM
          const sin2 = Math.max(0, Math.min(1, 1 - cosT * cosT))
          db += 10 * Math.log10(sin2 + 0.05)

          // LMax across all segments of all tracks.
          const lin = Math.pow(10, db / 10)
          const idx = row * n + col
          if (lin > energy[idx]) energy[idx] = lin
        }
      }
    }
  }

  if (aircraftUsed === 0) return null

  // Convert to dB + colorize
  const dbArr = new Float32Array(n * n)
  let dbMax = -Infinity
  let dbMin = Infinity
  for (let i = 0; i < energy.length; i++) {
    if (energy[i] > 0) {
      const d = 10 * Math.log10(energy[i])
      dbArr[i] = d
      if (d > dbMax) dbMax = d
      if (d < dbMin) dbMin = d
    } else {
      dbArr[i] = -Infinity
    }
  }
  const visMax = isFinite(dbMax) ? dbMax : 60
  const observedSpan = isFinite(dbMin) ? dbMax - dbMin : visRangeDb
  const span = Math.max(1, Math.min(observedSpan, visRangeDb))
  const visMin = visMax - span

  const canvas = document.createElement('canvas')
  canvas.width = n
  canvas.height = n
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(n, n)
  for (let row = 0; row < n; row++) {
    const srcRow = n - 1 - row
    for (let col = 0; col < n; col++) {
      const d = dbArr[srcRow * n + col]
      const idx = (row * n + col) * 4
      if (!isFinite(d)) {
        img.data[idx + 3] = 0
        continue
      }
      const t = Math.min(1, Math.max(0, (d - visMin) / span))
      const r = t < 0.5 ? 0 : Math.round(255 * (t - 0.5) * 2)
      const g = t < 0.5 ? Math.round(255 * t * 2) : Math.round(255 * (1 - (t - 0.5) * 2))
      const b = t < 0.5 ? Math.round(255 * (1 - t * 2)) : 0
      img.data[idx] = r
      img.data[idx + 1] = g
      img.data[idx + 2] = b
      img.data[idx + 3] = Math.round(40 + 190 * t)
    }
  }
  ctx.putImageData(img, 0, 0)

  const dLat = (halfKm * 1000) / mPerDegLat
  const dLon = (halfKm * 1000) / mPerDegLon
  return {
    url: canvas.toDataURL('image/png'),
    bounds: [[lat0 - dLat, lon0 - dLon], [lat0 + dLat, lon0 + dLon]],
    dbMax: isFinite(dbMax) ? dbMax : null,
    stats: {
      aircraftUsed,
      pointsUsed,
      dbMin: isFinite(dbMin) ? dbMin : null,
      dbMax: isFinite(dbMax) ? dbMax : null,
    },
  }
}
