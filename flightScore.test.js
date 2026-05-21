// flightScore.test.js — Unit tests for the Good Neighbor impact score.
//
// Run:  npx vitest run flightScore.test.js

import { describe, it, expect } from 'vitest'
import {
  popDensityAt,
  buildImpactGrid,
  neighborhoodOverlap,
  matchVoices,
  scoreFlight,
} from './flightScore.js'

// ── Fixtures ───────────────────────────────────────────────────────────

// A 2x2 population grid covering a small box around KBDU. Row 0 = north
// (latMax), matching population_density.json's emitted orientation.
const POP_GRID = {
  bounds: { latMin: 39.9, latMax: 40.1, lonMin: -105.3, lonMax: -105.1 },
  gridW: 2,
  gridH: 2,
  unit: 'people_per_km2',
  // [north-west, north-east]
  // [south-west, south-east]
  grid: [
    [1000, 2000],
    [0, 500],
  ],
}

// One square noise-abatement zone around (40.00, -105.20).
const ZONES = [
  {
    name: 'KBDU Test Zone',
    polygon: [
      [40.01, -105.21],
      [40.01, -105.19],
      [39.99, -105.19],
      [39.99, -105.21],
      [40.01, -105.21],
    ],
  },
]

const T0 = Date.parse('2026-05-20T15:00:00.000Z')
const sec = (n) => T0 + n * 1000

// Build a track from [lat, lon, alt, secOffset] rows.
const track = (rows) => rows.map(([lat, lon, alt, s]) => [lat, lon, alt, sec(s)])

describe('popDensityAt', () => {
  it('maps north rows to latMax and reads the right cell', () => {
    // NW quadrant (north, west) → grid[0][0] = 1000
    expect(popDensityAt(40.05, -105.25, POP_GRID)).toBe(1000)
    // NE quadrant → grid[0][1] = 2000
    expect(popDensityAt(40.05, -105.15, POP_GRID)).toBe(2000)
    // SE quadrant → grid[1][1] = 500
    expect(popDensityAt(39.95, -105.15, POP_GRID)).toBe(500)
  })

  it('returns 0 outside the grid bounds', () => {
    expect(popDensityAt(50, 0, POP_GRID)).toBe(0)
    expect(popDensityAt(40, 0, null)).toBe(0)
  })
})

describe('buildImpactGrid', () => {
  it('produces a grid with positive exposure over populated ground', () => {
    const pts = track([
      [40.0, -105.2, 6000, 0],
      [40.0, -105.18, 6000, 30],
      [40.0, -105.16, 6000, 60],
    ])
    const g = buildImpactGrid(pts, 'C172', POP_GRID)
    expect(g.bounds).toBeTruthy()
    expect(g.exposure).toBeGreaterThan(0)
    expect(g.peakDb).toBeGreaterThan(0)
  })

  it('treats engineless aircraft as silent (no exposure)', () => {
    const pts = track([
      [40.0, -105.2, 6000, 0],
      [40.0, -105.18, 6000, 30],
    ])
    const g = buildImpactGrid(pts, 'GLID', POP_GRID)
    expect(g.silent).toBe(true)
    expect(g.exposure).toBe(0)
  })

  it('a lower flight exposes the community more than a high one', () => {
    const low = track([[40.0, -105.2, 5800, 0], [40.0, -105.16, 5800, 60]])
    const high = track([[40.0, -105.2, 9000, 0], [40.0, -105.16, 9000, 60]])
    const lo = buildImpactGrid(low, 'C172', POP_GRID).exposure
    const hi = buildImpactGrid(high, 'C172', POP_GRID).exposure
    expect(lo).toBeGreaterThan(hi)
  })
})

describe('neighborhoodOverlap', () => {
  it('counts feet and seconds spent low inside a zone', () => {
    // All points low (6000 ft, well below the 7500 rule) and inside the zone.
    const pts = track([
      [40.0, -105.2, 6000, 0],
      [40.0, -105.2, 6000, 30],
      [40.005, -105.2, 6000, 60],
    ])
    const o = neighborhoodOverlap(pts, ZONES)
    expect(o.feet.inZone).toBeGreaterThan(0)
    expect(o.seconds.inZone).toBeCloseTo(60, 0)
    expect(o.seconds.red).toBeGreaterThan(0) // 6000 is >500 below 7500 = red
  })

  it('reports no overlap for a high flight clear of the zone', () => {
    const pts = track([
      [40.2, -105.2, 9000, 0],
      [40.2, -105.18, 9000, 30],
    ])
    const o = neighborhoodOverlap(pts, ZONES)
    expect(o.feet.inZone).toBe(0)
    expect(o.seconds.inZone).toBe(0)
  })
})

describe('matchVoices', () => {
  const complaints = [
    { tail: 'N123AB', startedAt: '2026-05-20T15:00:30.000Z', endedAt: '2026-05-20T15:01:00.000Z', klass: 'orange' },
    { tail: 'N999ZZ', startedAt: '2026-05-20T15:00:30.000Z', endedAt: '2026-05-20T15:01:00.000Z', klass: 'red' },
    { tail: 'N123AB', startedAt: '2026-05-20T20:00:00.000Z', endedAt: '2026-05-20T20:01:00.000Z', klass: 'red' },
  ]

  it('matches voices for the right tail overlapping the flight window', () => {
    const v = matchVoices(complaints, 'N123AB', sec(0), sec(120))
    expect(v).toHaveLength(1)
    expect(v[0].klass).toBe('orange')
  })

  it('is case-insensitive on tail and ignores other tails', () => {
    expect(matchVoices(complaints, 'n123ab', sec(0), sec(120))).toHaveLength(1)
    expect(matchVoices(complaints, 'N555AA', sec(0), sec(120))).toHaveLength(0)
  })
})

describe('scoreFlight', () => {
  const highCleanFlight = {
    id: 'x-1', tail: 'N100AA', cycle_time_min: 9,
    landing_ts: '2026-05-20T15:09:00.000Z',
  }
  const highCleanPts = track([
    [40.2, -105.2, 9500, 0],
    [40.2, -105.18, 9500, 270],
    [40.2, -105.16, 9500, 540],
  ])

  const lowNoisyFlight = {
    id: 'y-1', tail: 'N200BB', cycle_time_min: 9,
    landing_ts: '2026-05-20T15:09:00.000Z',
  }
  const lowNoisyPts = track([
    [40.0, -105.2, 5800, 0],
    [40.0, -105.2, 5800, 270],
    [40.005, -105.2, 5800, 540],
  ])

  it('gives a higher score to the higher, cleaner flight', () => {
    const clean = scoreFlight(highCleanFlight, highCleanPts, {
      type: 'C172', zones: ZONES, complaints: [], popGrid: POP_GRID,
    })
    const noisy = scoreFlight(lowNoisyFlight, lowNoisyPts, {
      type: 'C172', zones: ZONES, complaints: [], popGrid: POP_GRID,
    })
    expect(clean.score).toBeGreaterThan(noisy.score)
    expect(clean.score).toBeLessThanOrEqual(100)
    expect(noisy.score).toBeGreaterThanOrEqual(0)
  })

  it('lowers the score when community voices are raised', () => {
    const base = scoreFlight(lowNoisyFlight, lowNoisyPts, {
      type: 'C172', zones: ZONES, complaints: [], popGrid: POP_GRID,
    })
    const withVoices = scoreFlight(lowNoisyFlight, lowNoisyPts, {
      type: 'C172', zones: ZONES, popGrid: POP_GRID,
      complaints: [
        { tail: 'N200BB', startedAt: '2026-05-20T15:02:00.000Z', endedAt: '2026-05-20T15:03:00.000Z', klass: 'red' },
      ],
    })
    expect(withVoices.score).toBeLessThan(base.score)
    expect(withVoices.detail.voices_heard).toBe(1)
  })

  it('greets based aircraft as home and visitors as welcome', () => {
    const home = scoreFlight(highCleanFlight, highCleanPts, {
      type: 'C172', zones: ZONES, popGrid: POP_GRID, isHome: true, airport: 'KBDU',
    })
    const visitor = scoreFlight(highCleanFlight, highCleanPts, {
      type: 'C172', zones: ZONES, popGrid: POP_GRID, isHome: false, airport: 'KBDU',
    })
    expect(home.home).toBe(true)
    expect(home.greeting).toMatch(/welcome home/i)
    expect(visitor.home).toBe(false)
    expect(visitor.greeting).toMatch(/visiting/i)
  })

  it('never uses scolding language in highlights', () => {
    const r = scoreFlight(lowNoisyFlight, lowNoisyPts, {
      type: 'C172', zones: ZONES, popGrid: POP_GRID,
      complaints: [
        { tail: 'N200BB', startedAt: '2026-05-20T15:02:00.000Z', endedAt: '2026-05-20T15:03:00.000Z', klass: 'red' },
      ],
    })
    const stick = /violation|incursion|penalt|breach|illegal|fault|bad|noise complaint|offend/i
    for (const h of r.highlights) expect(h).not.toMatch(stick)
    expect(r.score).toBeGreaterThanOrEqual(0)
  })

  it('scores a perfectly clean high flight near the top', () => {
    const r = scoreFlight(highCleanFlight, highCleanPts, {
      type: 'C172', zones: ZONES, complaints: [], popGrid: POP_GRID,
    })
    expect(r.score).toBeGreaterThanOrEqual(85)
    expect(['Gold', 'Silver']).toContain(r.tier)
  })
})
