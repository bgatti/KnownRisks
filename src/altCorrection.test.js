// altCorrection.test.js — unit tests for the per-flight alt-offset pipeline.
//
// Mirrors the structure of flightCycles.test.js: vitest, describe blocks,
// hand-built fixtures with realistic numbers (KBDU elev 5288 ft, gs ~0
// on the runway, alt-clustered fixes, etc.). The math under test was
// extracted verbatim from vite.config.js — these tests are the
// regression net that prevents the inline-in-vite version from drifting
// from the extracted module.
//
// Run:  cd noise/web && npx vitest run src/altCorrection.test.js

import { describe, it, expect } from 'vitest'
import {
  findRunwayAnchors,
  computeFlightAltOffset,
  regionalOffsetSeries,
  smoothedOffsetFor,
  applyOffsetToPoints,
  VERIFIED_ALT_CAL_MAX_AGL_FT,
  VERIFIED_ALT_CAL_RADIUS_NM,
  REGIONAL_OFFSET_NEAR_N,
} from './altCorrection.js'

const KBDU = { code: 'KBDU', lat: 40.0394, lon: -105.2258, elev: 5288 }
const KBJC = { code: 'KBJC', lat: 39.9088, lon: -105.1172, elev: 5673 }

// Build a [lat, lon, alt_ft, ts_ms] point. Default lat/lon = KBDU center.
const p = (alt, ts, lat = KBDU.lat, lon = KBDU.lon) => [lat, lon, alt, ts]

// A 1-second-apart sequence of identical-position fixes at the same alt —
// the canonical "stationary on the runway" pattern. Yields gs=0, vs=0,
// and a tight alt cluster: max score on every interior fix.
function stationaryRun(altFt, n = 6, t0 = 1_000_000_000_000) {
  const pts = []
  for (let i = 0; i < n; i++) pts.push(p(altFt, t0 + i * 1000))
  return pts
}

describe('findRunwayAnchors', () => {
  it('returns empty for empty / null inputs', () => {
    expect(findRunwayAnchors([], KBDU)).toEqual([])
    expect(findRunwayAnchors(null, KBDU)).toEqual([])
    expect(findRunwayAnchors([p(5300, 0)], null)).toEqual([])
  })

  it('high-confidence anchor (gs=0, vs=0, alt-clustered) scores the maximum', () => {
    // Six identical fixes at 5298 ft (10 ft above field) — gs=0, vs=0,
    // alt cluster all hit. Score = 3 (gs) + 2 (vs) + 2 (cluster) = 7.
    const anchors = findRunwayAnchors(stationaryRun(5298, 6), KBDU)
    expect(anchors.length).toBeGreaterThan(0)
    expect(anchors[0].score).toBe(7)
    expect(anchors[0].alt).toBe(5298)
  })

  it('airborne fix outside the radius is excluded', () => {
    // 3 nm north of KBDU at 7500 ft, otherwise stationary. Outside the
    // 2-nm anchor radius — anchors must be empty.
    const farLat = KBDU.lat + 3 / 60 // 3 nm north
    const pts = []
    for (let i = 0; i < 5; i++) pts.push(p(7500, i * 1000, farLat, KBDU.lon))
    const anchors = findRunwayAnchors(pts, KBDU)
    expect(anchors).toEqual([])
  })

  it('cruise-level fix in range with no neighbors scores zero from cluster', () => {
    // Single fix at 5288 ft in-radius — no neighbors at same alt, can't
    // compute gs/vs without a prior fix → score 0 → not emitted.
    const anchors = findRunwayAnchors([p(5288, 0)], KBDU)
    expect(anchors).toEqual([])
  })

  it('higher-score anchor beats a lower-score one at the same alt', () => {
    // Run A: 5298 ft, all signals → score 7.
    // Run B: same alt but spaced 30s apart (still gs ≈ 0, vs = 0) — also
    // collects cluster credit. Sort puts highest score first.
    const a = findRunwayAnchors(stationaryRun(5298, 5), KBDU)
    expect(a[0].score).toBeGreaterThanOrEqual(a[a.length - 1].score)
  })

  it('ties on score break to the lower altitude', () => {
    // Two stationary runs concatenated at different alts. Same score.
    // Sort must put the lower alt first.
    const low = stationaryRun(5290, 4, 1_000_000_000_000)
    const high = stationaryRun(5340, 4, 1_000_000_000_000 + 10_000)
    const anchors = findRunwayAnchors([...low, ...high], KBDU)
    // Top-scoring anchors should sort with the lower alt first.
    const topScore = anchors[0].score
    const topCohort = anchors.filter(a => a.score === topScore)
    expect(topCohort[0].alt).toBeLessThanOrEqual(topCohort[topCohort.length - 1].alt)
  })
})

describe('computeFlightAltOffset', () => {
  it('returns zero / source=none on missing inputs', () => {
    expect(computeFlightAltOffset(null, KBDU)).toEqual({ offset_ft: 0, calibration_fixes: 0, source: 'none' })
    expect(computeFlightAltOffset([], KBDU)).toEqual({ offset_ft: 0, calibration_fixes: 0, source: 'none' })
    expect(computeFlightAltOffset([p(5300, 0)], null)).toEqual({ offset_ft: 0, calibration_fixes: 0, source: 'none' })
  })

  it('high-confidence path → source=anchors, positive offset for over-reporting transponder', () => {
    // Transponder reports 5408 ft on the runway (true elev 5288) →
    // expected offset = +120 ft. Six fixes at the same alt → all
    // anchors with score 7, cohort size 6.
    const pts = stationaryRun(5408, 6)
    const r = computeFlightAltOffset(pts, KBDU)
    expect(r.source).toBe('anchors')
    expect(r.offset_ft).toBe(120)
    // First fix lacks a prior point → can't compute gs/vs → only the
    // cluster signal fires (score 2). Top-cohort threshold is topScore/2
    // = 7/2 = 3.5 → first fix is excluded, cohort is the 5 interior fixes.
    expect(r.calibration_fixes).toBe(5)
  })

  it('high-confidence path → negative offset for under-reporting transponder', () => {
    // Transponder reports 5200 ft on a 5288 ft runway → offset = -88 ft.
    const pts = stationaryRun(5200, 6)
    const r = computeFlightAltOffset(pts, KBDU)
    expect(r.source).toBe('anchors')
    expect(r.offset_ft).toBe(-88)
  })

  it('lowest-25% fallback fires when anchor signals are absent', () => {
    // No two adjacent points (timestamps 5 min apart → dtSec=300 → gs/vs
    // skipped) and no alt clustering. The anchor scorer yields 0 fixes,
    // so we fall back to the lowest-25%. Lowest-25% of 12 in-range
    // fixes = ceil(12 * 0.25) = 3 → averages the lowest 3.
    const t0 = 1_000_000_000_000
    const alts = [5320, 5310, 5400, 5500, 5800, 6200, 6900, 7100, 7400, 7800, 8100, 8500]
    const pts = alts.map((a, i) => p(a, t0 + i * 5 * 60_000))
    const r = computeFlightAltOffset(pts, KBDU)
    expect(r.source).toBe('lowest25')
    // Lowest 3 = 5310, 5320, 5400 → mean 5343.33 → offset 5343 - 5288 = 55.
    expect(r.offset_ft).toBe(55)
    expect(r.calibration_fixes).toBe(3)
  })

  it('returns offset=0 with source=none when the lowest-25% cohort is too high', () => {
    // All in-range fixes well above field elevation (overflight only —
    // never approached the runway). cohort avg > 500 ft AGL → source=none.
    const t0 = 1_000_000_000_000
    const alts = [7200, 7300, 7400, 7500, 7600, 7700, 7800, 7900, 8000, 8100, 8200, 8300]
    const pts = alts.map((a, i) => p(a, t0 + i * 5 * 60_000))
    const r = computeFlightAltOffset(pts, KBDU)
    expect(r.offset_ft).toBe(0)
    expect(r.source).toBe('none')
    // Pre-existing semantics: calibration_fixes is still the cohort size
    // here (the fallback ran but failed the sanity bound).
    expect(r.calibration_fixes).toBeGreaterThan(0)
  })

  it('returns source=none when no fixes are in range at all', () => {
    // Fixes 5 nm away — none within 2 nm of the airport.
    const t0 = 1_000_000_000_000
    const pts = []
    for (let i = 0; i < 6; i++) pts.push(p(7000, t0 + i * 1000, KBDU.lat + 0.1, KBDU.lon))
    const r = computeFlightAltOffset(pts, KBDU)
    expect(r).toEqual({ offset_ft: 0, calibration_fixes: 0, source: 'none' })
  })

  it('respects the MAX_AGL_FT sanity bound on the anchor cohort', () => {
    // Transponder over-reports by 600 ft (5288 + 600 = 5888 ft) while
    // sitting on the runway — exceeds VERIFIED_ALT_CAL_MAX_AGL_FT.
    // The anchor cohort qualifies on signals but fails the sanity bound
    // → handler falls through to lowest-25%, which uses the same data
    // and also fails the same bound → returns offset=0.
    const tooHighAlt = KBDU.elev + VERIFIED_ALT_CAL_MAX_AGL_FT + 100
    const pts = stationaryRun(tooHighAlt, 6)
    const r = computeFlightAltOffset(pts, KBDU)
    expect(r.offset_ft).toBe(0)
  })
})

describe('regionalOffsetSeries', () => {
  it('returns an empty Map for empty input', () => {
    expect(regionalOffsetSeries([])).toEqual(new Map())
    expect(regionalOffsetSeries(null)).toEqual(new Map())
  })

  it('groups by airport and sorts ascending by landingMs', () => {
    const flights = [
      { airport: 'KBDU', midMs: 3000, offsetFt: 120, calibrationFixes: 4 },
      { airport: 'KBDU', midMs: 1000, offsetFt: 100, calibrationFixes: 5 },
      { airport: 'KBJC', midMs: 2000, offsetFt: -50, calibrationFixes: 3 },
      { airport: 'KBDU', midMs: 2000, offsetFt: 110, calibrationFixes: 6 },
    ]
    const series = regionalOffsetSeries(flights)
    expect(series.size).toBe(2)
    expect(series.get('KBDU').map(e => e.landingMs)).toEqual([1000, 2000, 3000])
    expect(series.get('KBDU').map(e => e.offsetFt)).toEqual([100, 110, 120])
    expect(series.get('KBJC').map(e => e.offsetFt)).toEqual([-50])
  })

  it('drops entries with calibrationFixes == 0', () => {
    const flights = [
      { airport: 'KBDU', midMs: 1000, offsetFt: 0, calibrationFixes: 0 },
      { airport: 'KBDU', midMs: 2000, offsetFt: 120, calibrationFixes: 4 },
    ]
    const series = regionalOffsetSeries(flights)
    expect(series.get('KBDU')).toHaveLength(1)
    expect(series.get('KBDU')[0].offsetFt).toBe(120)
  })

  it('skips entries with missing airport or non-finite midMs', () => {
    const flights = [
      { airport: null, midMs: 1000, offsetFt: 100, calibrationFixes: 4 },
      { airport: 'KBDU', midMs: NaN, offsetFt: 100, calibrationFixes: 4 },
      { airport: 'KBDU', midMs: 1000, offsetFt: 100, calibrationFixes: 4 },
    ]
    const series = regionalOffsetSeries(flights)
    expect(series.size).toBe(1)
    expect(series.get('KBDU')).toHaveLength(1)
  })
})

describe('smoothedOffsetFor', () => {
  it('returns null for empty / missing series', () => {
    expect(smoothedOffsetFor('KBDU', 1000, new Map())).toBeNull()
    expect(smoothedOffsetFor('KBDU', 1000, null)).toBeNull()
    const empty = new Map([['KBDU', []]])
    expect(smoothedOffsetFor('KBDU', 1000, empty)).toBeNull()
  })

  it('selects ±N neighbors and averages', () => {
    // 5 events at KBDU with the same offset → smoother returns it.
    const flights = []
    for (let i = 0; i < 5; i++) flights.push({
      airport: 'KBDU', midMs: 1000 + i * 100, offsetFt: 120, calibrationFixes: 4,
    })
    const series = regionalOffsetSeries(flights)
    const smoothed = smoothedOffsetFor('KBDU', 1250, series)
    expect(smoothed).not.toBeNull()
    expect(smoothed.offset_ft).toBe(120)
    // 2 events strictly before midMs=1250 + 2 events ≥ midMs.
    expect(smoothed.n_landings).toBe(2 * REGIONAL_OFFSET_NEAR_N)
  })

  it('filters outliers more than max(50, stddev) ft from the mean', () => {
    // 4 events at 120 ft, 1 wild outlier at 500 ft. Mean ≈ 196,
    // stddev ≈ 152 → band ≈ 152. The 500-ft sample is 304 ft from the
    // mean → dropped. Filtered mean = 120.
    const flights = [
      { airport: 'KBDU', midMs: 1000, offsetFt: 120, calibrationFixes: 4 },
      { airport: 'KBDU', midMs: 1100, offsetFt: 120, calibrationFixes: 4 },
      { airport: 'KBDU', midMs: 1200, offsetFt: 120, calibrationFixes: 4 },
      { airport: 'KBDU', midMs: 1300, offsetFt: 120, calibrationFixes: 4 },
      { airport: 'KBDU', midMs: 1400, offsetFt: 500, calibrationFixes: 4 },
    ]
    const series = regionalOffsetSeries(flights)
    // midMs=1250 selects the 2 before (120, 120) and 2 after (120, 500).
    const smoothed = smoothedOffsetFor('KBDU', 1250, series)
    expect(smoothed.n_landings).toBe(4)
    expect(smoothed.offset_ft).toBe(120)
  })

  it('returns null for an unknown airport', () => {
    const series = regionalOffsetSeries([
      { airport: 'KBDU', midMs: 1000, offsetFt: 120, calibrationFixes: 4 },
    ])
    expect(smoothedOffsetFor('KAPA', 1000, series)).toBeNull()
  })
})

describe('applyOffsetToPoints', () => {
  it('returns the input by reference when offset is 0', () => {
    const pts = [p(7000, 1000), p(7100, 2000)]
    const out = applyOffsetToPoints(pts, 0)
    expect(out).toBe(pts)
  })

  it('returns the input by reference when offset is null/undefined', () => {
    const pts = [p(7000, 1000)]
    expect(applyOffsetToPoints(pts, null)).toBe(pts)
    expect(applyOffsetToPoints(pts, undefined)).toBe(pts)
  })

  it('subtracts offset from alt while preserving lat/lon/ts', () => {
    const pts = [
      [40.04, -105.22, 7000, 1000],
      [40.05, -105.23, 7100, 2000],
    ]
    const out = applyOffsetToPoints(pts, 120)
    expect(out).not.toBe(pts)
    expect(out[0]).toEqual([40.04, -105.22, 6880, 1000])
    expect(out[1]).toEqual([40.05, -105.23, 6980, 2000])
    // Original untouched.
    expect(pts[0][2]).toBe(7000)
  })

  it('preserves a null altitude', () => {
    const pts = [[40.04, -105.22, null, 1000]]
    const out = applyOffsetToPoints(pts, 120)
    expect(out[0]).toEqual([40.04, -105.22, null, 1000])
  })

  it('handles a negative offset (under-reporting transponder)', () => {
    const pts = [[40.04, -105.22, 5200, 1000]]
    const out = applyOffsetToPoints(pts, -88)
    expect(out[0][2]).toBe(5288)
  })
})
