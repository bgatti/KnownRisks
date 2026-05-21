// populationContours.js — Vectorize the population-density grid into smooth
// iso-contour polygons (marching squares) so it can be drawn as crisp,
// scale-independent SVG instead of a blocky raster overlay.
//
//   import { buildPopulationContours } from './populationContours'
//   const levels = buildPopulationContours(data)
//   // levels = [{ value, fill, fillOpacity, polygons: [ [[lat,lon],...], ... ] }]
//
// Levels are returned low→high so the caller draws them in order; under a
// `screen` blend the nested rings accumulate into a soft gradient toward each
// dense core, with vector-clean edges at any zoom.

// Coarsen the grid by box-averaging f×f blocks (missing cells count as 0).
function coarsen(grid, gridW, gridH, f) {
  const CW = Math.ceil(gridW / f)
  const CH = Math.ceil(gridH / f)
  const out = Array.from({ length: CH }, () => new Float32Array(CW))
  for (let R = 0; R < CH; R++) {
    for (let C = 0; C < CW; C++) {
      let sum = 0, n = 0
      for (let r = R * f; r < Math.min((R + 1) * f, gridH); r++) {
        const row = grid[r]
        for (let c = C * f; c < Math.min((C + 1) * f, gridW); c++) {
          sum += (row && row[c]) || 0; n++
        }
      }
      out[R][C] = n ? sum / n : 0
    }
  }
  return { g: out, CW, CH }
}

// One pass of a 3×3 box blur to soften contour staircasing.
function blur(g, W, H) {
  const out = Array.from({ length: H }, () => new Float32Array(W))
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      let sum = 0, n = 0
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr; if (rr < 0 || rr >= H) continue
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc; if (cc < 0 || cc >= W) continue
          sum += g[rr][cc]; n++
        }
      }
      out[r][c] = sum / n
    }
  }
  return out
}

// Pad with a one-cell ring of zeros so every contour closes into a loop
// (no contour ever runs off the grid edge).
function padZero(g, W, H) {
  const PW = W + 2, PH = H + 2
  const out = Array.from({ length: PH }, () => new Float32Array(PW))
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) out[r + 1][c + 1] = g[r][c]
  return { g: out, W: PW, H: PH }
}

const interp = (T, va, vb) => (va === vb ? 0.5 : (T - va) / (vb - va))

// Marching-squares isoline for one threshold → array of undirected segments,
// each [[x,y],[x,y]] in grid coordinates (x=col, y=row, fractional on edges).
function marchingSquares(g, W, H, T) {
  const segs = []
  for (let r = 0; r < H - 1; r++) {
    for (let c = 0; c < W - 1; c++) {
      const tl = g[r][c], tr = g[r][c + 1], br = g[r + 1][c + 1], bl = g[r + 1][c]
      const idx = (tl >= T ? 8 : 0) | (tr >= T ? 4 : 0) | (br >= T ? 2 : 0) | (bl >= T ? 1 : 0)
      if (idx === 0 || idx === 15) continue
      // Edge crossing points
      const top = () => [c + interp(T, tl, tr), r]
      const right = () => [c + 1, r + interp(T, tr, br)]
      const bottom = () => [c + interp(T, bl, br), r + 1]
      const left = () => [c, r + interp(T, tl, bl)]
      const push = (a, b) => segs.push([a, b])
      switch (idx) {
        case 1: case 14: push(left(), bottom()); break
        case 2: case 13: push(bottom(), right()); break
        case 3: case 12: push(left(), right()); break
        case 4: case 11: push(top(), right()); break
        case 6: case 9: push(top(), bottom()); break
        case 7: case 8: push(top(), left()); break
        case 5: { // saddle — resolve by center average
          const center = (tl + tr + br + bl) / 4
          if (center >= T) { push(top(), right()); push(bottom(), left()) }
          else { push(top(), left()); push(bottom(), right()) }
          break
        }
        case 10: {
          const center = (tl + tr + br + bl) / 4
          if (center >= T) { push(top(), left()); push(bottom(), right()) }
          else { push(top(), right()); push(bottom(), left()) }
          break
        }
      }
    }
  }
  return segs
}

// Stitch undirected segments into closed loops. Contour vertices are degree-2,
// so each connected component is a simple cycle.
function stitch(segs) {
  const key = (p) => `${Math.round(p[0] * 1e4)}_${Math.round(p[1] * 1e4)}`
  const adj = new Map() // key → [{ pt, segId }]
  segs.forEach((s, id) => {
    for (const [a, b] of [[s[0], s[1]], [s[1], s[0]]]) {
      const k = key(a)
      if (!adj.has(k)) adj.set(k, { pt: a, links: [] })
      adj.get(k).links.push({ to: key(b), pt: b, segId: id })
    }
  })
  const usedSeg = new Set()
  const loops = []
  for (const startK of adj.keys()) {
    const startNode = adj.get(startK)
    const seed = startNode.links.find((l) => !usedSeg.has(l.segId))
    if (!seed) continue
    const loop = [startNode.pt]
    let curK = startK
    let nextK = seed.to
    usedSeg.add(seed.segId)
    loop.push(seed.pt)
    let guard = 0
    while (nextK !== startK && guard++ < 100000) {
      const node = adj.get(nextK)
      if (!node) break
      const next = node.links.find((l) => !usedSeg.has(l.segId))
      if (!next) break
      usedSeg.add(next.segId)
      loop.push(next.pt)
      curK = nextK
      nextK = next.to
    }
    if (loop.length >= 4) loops.push(loop)
  }
  return loops
}

/**
 * @param {Object} data  parsed population_density.json
 * @param {Object} [opts]
 * @param {number} [opts.factor=4]   grid coarsening factor
 * @param {number[]} [opts.levels]   density thresholds (people/km²), low→high
 */
export function buildPopulationContours(data, opts = {}) {
  if (!data || !data.grid) return []
  const { gridW, gridH, grid, bounds } = data
  const { latMin, latMax, lonMin, lonMax } = bounds
  const factor = opts.factor ?? 4
  const levels = opts.levels ?? [40, 130, 400, 1200, 3500]

  const { g: coarse, CW, CH } = coarsen(grid, gridW, gridH, factor)
  const smoothed = blur(coarse, CW, CH)
  const { g: pg, W: PW, H: PH } = padZero(smoothed, CW, CH)

  // A padded contour coord (x,y) → lat/lon. Padding shifts indices by 1 and
  // the unpadded coarse grid spans the full bounds over [0..CW-1]/[0..CH-1].
  const toLatLng = (p) => {
    const cx = p[0] - 1, cy = p[1] - 1
    const lon = lonMin + (cx / (CW - 1)) * (lonMax - lonMin)
    const lat = latMax - (cy / (CH - 1)) * (latMax - latMin)
    return [lat, lon]
  }

  const out = []
  levels.forEach((value, i) => {
    const segs = marchingSquares(pg, PW, PH, value)
    if (!segs.length) return
    const loops = stitch(segs).map((loop) => loop.map(toLatLng))
    if (!loops.length) return
    // Brightness ramps with level; under `screen` the nested fills accumulate.
    const v = Math.round(70 + (255 - 70) * (i / Math.max(1, levels.length - 1)))
    out.push({ value, fill: `rgb(${v},${v},${v})`, fillOpacity: 0.22, polygons: loops })
  })
  return out
}
