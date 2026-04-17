// terrain.js — SRTM-derived elevation grid for per-cell AGL calculations.
//
// Load once at app startup with `await loadTerrain()`, then use:
//   terrainAt(lat, lon) → elevation in feet (bilinear interpolation)
//   buildTerrainArray(lat0, lon0, n, cellM) → Float64Array for a noise grid

const FALLBACK_ELEV_FT = 5300

let _grid = null  // { lat0, lon0, half_km, cell_m, n, elev_ft[] }

export async function loadTerrain() {
  if (_grid) return
  try {
    const r = await fetch('/terrain.json')
    if (!r.ok) throw new Error(r.status)
    _grid = await r.json()
  } catch (e) {
    console.warn('terrain.json not available, using flat elevation fallback:', e)
  }
}

export function isLoaded() {
  return _grid !== null
}

/**
 * Bilinear elevation lookup from the terrain grid.
 * Returns feet MSL.
 */
export function terrainAt(lat, lon) {
  if (!_grid) return FALLBACK_ELEV_FT
  const { lat0, lon0, half_km, cell_m, n, elev_ft } = _grid
  const mPerDegLat = 111320
  const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180)

  // Convert lat/lon to fractional row/col in the terrain grid
  const dy = (lat - lat0) * mPerDegLat  // meters north of center
  const dx = (lon - lon0) * mPerDegLon  // meters east of center
  const col = dx / cell_m + (n - 1) / 2
  const row = dy / cell_m + (n - 1) / 2

  // Clamp to grid bounds
  if (col < 0 || col >= n - 1 || row < 0 || row >= n - 1) return FALLBACK_ELEV_FT

  // Bilinear interpolation
  const c0 = Math.floor(col), c1 = c0 + 1
  const r0 = Math.floor(row), r1 = r0 + 1
  const fc = col - c0, fr = row - r0

  const e00 = elev_ft[r0 * n + c0]
  const e01 = elev_ft[r0 * n + c1]
  const e10 = elev_ft[r1 * n + c0]
  const e11 = elev_ft[r1 * n + c1]

  return e00 * (1 - fc) * (1 - fr)
       + e01 * fc * (1 - fr)
       + e10 * (1 - fc) * fr
       + e11 * fc * fr
}

/**
 * Build a flat Float64Array of terrain elevations (ft) matching a noise
 * grid with the given center, cell count, and cell size. Row-major order
 * matching the noise.js grid layout (row = y/north, col = x/east).
 */
export function buildTerrainArray(lat0, lon0, n, cellM) {
  const arr = new Float64Array(n * n)
  const mPerDegLat = 111320
  const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180)
  const halfIdx = (n - 1) / 2
  for (let row = 0; row < n; row++) {
    const cellY = (row - halfIdx) * cellM  // meters north
    const lat = lat0 + cellY / mPerDegLat
    for (let col = 0; col < n; col++) {
      const cellX = (col - halfIdx) * cellM  // meters east
      const lon = lon0 + cellX / mPerDegLon
      arr[row * n + col] = terrainAt(lat, lon)
    }
  }
  return arr
}
