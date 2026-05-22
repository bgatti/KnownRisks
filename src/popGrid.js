// popGrid.js — population-density lookup + per-track population-noise impact.
// Used by backfill.js to precompute a `pop_impact` scalar per track so the
// leaderboard can SUM it (SQL can't do grid lookups). Pure/self-contained so
// it's unit-testable against public/population_density.json.

import fs from 'fs'

// Load population_density.json → { popAt(lat,lon) → people/km², bounds, ... }.
// Grid row 0 is the north (latMax) edge, col 0 the west (lonMin) edge — matching
// how the raster is drawn as an ImageOverlay.
export function loadPopGrid(filePath) {
  const d = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const { gridW, gridH, grid, bounds } = d
  const { latMin, latMax, lonMin, lonMax } = bounds
  const popAt = (lat, lon) => {
    if (lat < latMin || lat > latMax || lon < lonMin || lon > lonMax) return 0
    const col = Math.round(((lon - lonMin) / (lonMax - lonMin)) * (gridW - 1))
    const row = Math.round(((latMax - lat) / (latMax - latMin)) * (gridH - 1))
    const r = grid[row]
    return (r && r[col]) || 0
  }
  return { popAt, bounds, gridW, gridH }
}

// Tuning constants for the noise-vs-altitude term (relative units; the
// leaderboard normalizes the result, so absolute scale only needs to be
// consistent across tracks).
export const POP_KERNEL = {
  GROUND_REF_FT: 5300, // approx Front Range ground elevation (MSL)
  REF_AGL_FT: 1000,    // AGL at which the attenuation factor == 1
  MIN_AGL_FT: 300,     // floor so very-low passes don't blow up
}

// Per-segment population-noise impact for one track's points ([lat,lon,alt_msl]).
// For each segment: (segment length) × (people/km² beneath it) × (1/AGL²
// attenuation) — louder when lower, more when over more people. Returns the
// total plus the per-segment breakdown (for the explainer map). distFn →ft.
export function impactSegments(points, popAt, distFn) {
  const { GROUND_REF_FT, REF_AGL_FT, MIN_AGL_FT } = POP_KERNEL
  const segments = []
  let total = 0, lenFt = 0
  if (!points || points.length < 2) return { total, lenFt, segments }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    const ft = distFn(a[0], a[1], b[0], b[1])
    lenFt += ft
    const midAlt = ((a[2] || 0) + (b[2] || 0)) / 2
    const pop = ft > 0 ? popAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) : 0
    const agl = Math.max(MIN_AGL_FT, midAlt - GROUND_REF_FT)
    const atten = (REF_AGL_FT / agl) ** 2
    const contribution = pop > 0 && ft > 0 ? ft * pop * atten : 0
    total += contribution
    segments.push({ ft: Math.round(ft), alt: Math.round(midAlt), agl: Math.round(agl), pop: Math.round(pop), atten: Math.round(atten * 100) / 100, contribution: Math.round(contribution) })
  }
  return { total, lenFt, segments }
}

// Scalar total only (used by the backfill).
export function trackPopImpact(points, popAt, distFn) {
  return impactSegments(points, popAt, distFn).total
}
