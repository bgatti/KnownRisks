// flightScore.test.js — Unit tests for the Good Neighbor impact score.
//
// Run:  npx vitest run flightScore.test.js

import { describe, it, expect } from 'vitest'
import {
  popDensityAt,
  buildImpactGrid,
  neighborhoodOverlap,
  matchVoices,
  matchReportSegments,
  projectComplaint,
  matchComplaintsForKiosk,
  recentComplaintsForKiosk,
  attachComplaintsToBands,
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

describe('complaint projection / kiosk overlay', () => {
  const iso = (n) => new Date(sec(n)).toISOString()
  const mk = (overrides) => ({
    id: 'cpl-1',
    tail: 'N123AB',
    klass: 'red',
    notes: 'Score 5/10 (Useful) · sustained -82 dBFS · flight pos: 39.9984,-105.2406',
    lat: 39.9984, lon: -105.2406,
    distanceMiles: 1.3,
    startedAt: iso(30),
    endedAt: iso(60),
    createdAt: iso(90),
    ...overrides,
  })

  it('projectComplaint extracts dBFS and converts to estimated dBA (+132)', () => {
    const p = projectComplaint(mk())
    expect(p.dbfs).toBe(-82)
    expect(p.dba_estimate).toBe(50) // -82 + 132
    expect(p.lat).toBe(39.9984)
    expect(p.klass).toBe('red')
  })

  it('projectComplaint returns null dbfs when notes lack a dBFS pattern', () => {
    const p = projectComplaint(mk({ notes: 'just words, no measurement' }))
    expect(p.dbfs).toBeNull()
    expect(p.dba_estimate).toBeNull()
  })

  it('matchComplaintsForKiosk filters by tail (case-insensitive) and window', () => {
    const other = mk({ id: 'cpl-other', tail: 'N999ZZ' })
    const inWin = mk({ id: 'cpl-in' })
    const outWin = mk({ id: 'cpl-out', startedAt: iso(60 + 11 * 60), endedAt: iso(60 + 11 * 60 + 5) })
    const out = matchComplaintsForKiosk([other, inWin, outWin], 'n123ab', sec(0), sec(60))
    expect(out.map(c => c.id)).toEqual(['cpl-in'])
  })

  it('matchComplaintsForKiosk preserves all projected fields including notes', () => {
    const out = matchComplaintsForKiosk([mk()], 'N123AB', sec(0), sec(120))
    expect(out[0].notes).toContain('dBFS')
    expect(out[0].started_at).toBe(iso(30))
    expect(out[0].lat).toBe(39.9984)
  })

  it('recentComplaintsForKiosk returns complaints within window, newest first', () => {
    const now = Date.now()
    const recent = mk({ id: 'recent', createdAt: new Date(now - 5 * 60 * 1000).toISOString() })
    const oldOne = mk({ id: 'old',    createdAt: new Date(now - 90 * 60 * 1000).toISOString() })
    const out = recentComplaintsForKiosk([oldOne, recent], 30)
    expect(out.map(c => c.id)).toEqual(['recent'])
  })

  it('matchComplaintsForKiosk: tail-only (no lat/lon) still matches by tail+window', () => {
    const tailOnly = mk({ id: 'cpl-tail-only', lat: null, lon: null, distanceMiles: null })
    const out = matchComplaintsForKiosk([tailOnly], 'N123AB', sec(0), sec(120))
    expect(out).toHaveLength(1)
    expect(out[0].lat).toBeNull()
    expect(out[0].lon).toBeNull()
    expect(out[0].dba_estimate).toBe(50)
  })
})

describe('attachComplaintsToBands (per-segment glow)', () => {
  const iso = (n) => new Date(sec(n)).toISOString()
  // Three timestamped bands spanning 0–90s of the flight.
  const mkBands = () => ([
    { klass: null,     points: [[40, -105, 6000, sec(0)],  [40, -105, 6000, sec(30)]] },
    { klass: 'orange', points: [[40, -105, 6000, sec(30)], [40, -105, 6000, sec(60)]] },
    { klass: 'red',    points: [[40, -105, 6000, sec(60)], [40, -105, 6000, sec(90)]] },
  ])
  const projectedComplaint = (overrides = {}) => ({
    id: 'cpl-x', tail: 'N123AB', klass: 'orange',
    started_at: iso(40), ended_at: iso(45),
    dbfs: -75, dba_estimate: 57,
    notes: '', lat: null, lon: null,
    ...overrides,
  })

  it('attaches a complaint to only the band(s) whose window it overlaps', () => {
    const bands = mkBands()
    // Complaint at 40–45s sits in band 1 (the orange one), not 0 or 2 once pad is removed.
    const c = projectedComplaint()
    attachComplaintsToBands(bands, [c], { pad: 0 })
    expect(c.band_indices).toEqual([1])
    expect(bands[0].complaints).toHaveLength(0)
    expect(bands[1].complaints).toHaveLength(1)
    expect(bands[2].complaints).toHaveLength(0)
  })

  it('aggregates complaint_dba_max and complaint_worst_klass per band', () => {
    const bands = mkBands()
    const cs = [
      projectedComplaint({ id: 'c1', dba_estimate: 55, klass: 'yellow', started_at: iso(40), ended_at: iso(40) }),
      projectedComplaint({ id: 'c2', dba_estimate: 62, klass: 'red',    started_at: iso(42), ended_at: iso(42) }),
    ]
    attachComplaintsToBands(bands, cs, { pad: 0 })
    expect(bands[1].complaint_count).toBe(2)
    expect(bands[1].complaint_dba_max).toBe(62)
    expect(bands[1].complaint_worst_klass).toBe('red')
  })

  it('spans multiple bands when a complaint window crosses a transition', () => {
    const bands = mkBands()
    // 55–65s straddles band 1 (ends 60) and band 2 (starts 60).
    const c = projectedComplaint({ started_at: iso(55), ended_at: iso(65) })
    attachComplaintsToBands(bands, [c], { pad: 0 })
    expect(c.band_indices.sort()).toEqual([1, 2])
    expect(bands[1].complaints).toHaveLength(1)
    expect(bands[2].complaints).toHaveLength(1)
  })

  it('respects the ±10-min pad (the default) when a complaint just misses', () => {
    const bands = mkBands()
    // 9 min after band 2 ends (band 2 ends at sec 90). Pad is 10 min → still attaches.
    const c = projectedComplaint({ started_at: iso(90 + 9 * 60), ended_at: iso(90 + 9 * 60) })
    attachComplaintsToBands(bands, [c]) // default pad
    expect(c.band_indices).toContain(2)
  })

  it('falls back to ALL bands when none of the bands have point timestamps', () => {
    // Historical 3-tuple shape — no ts available, attach to every band.
    const bands = [
      { klass: 'yellow', points: [[40, -105, 6000], [40, -105, 6000]] },
      { klass: 'red',    points: [[40, -105, 6000], [40, -105, 6000]] },
    ]
    const c = projectedComplaint()
    attachComplaintsToBands(bands, [c])
    expect(c.band_indices).toEqual([0, 1])
    expect(bands[0].complaints).toHaveLength(1)
    expect(bands[1].complaints).toHaveLength(1)
  })

  it('uses explicit start_ms/end_ms on a band when points carry impact (not ts) in slot 3', () => {
    // This is the shape that bandsFromPoints emits: points carry per-point
    // impact in [3], and the band itself carries start_ms/end_ms.
    const bands = [
      { klass: null,     start_ms: sec(0),  end_ms: sec(30), points: [[40, -105, 6000, 123 /* impact */], [40, -105, 6000, 456]] },
      { klass: 'orange', start_ms: sec(30), end_ms: sec(60), points: [[40, -105, 6000, 789], [40, -105, 6000, 1011]] },
    ]
    const c = projectedComplaint({ started_at: iso(40), ended_at: iso(50) })
    attachComplaintsToBands(bands, [c], { pad: 0 })
    expect(c.band_indices).toEqual([1])
  })

  it('initialises empty fields on bands with no matching complaint', () => {
    const bands = mkBands()
    attachComplaintsToBands(bands, []) // no complaints at all
    for (const b of bands) {
      expect(b.complaints).toEqual([])
      expect(b.complaint_dba_max).toBeNull()
      expect(b.complaint_count).toBe(0)
      expect(b.complaint_worst_klass).toBeNull()
    }
  })
})

describe('VNAP exemption for engineless aircraft', () => {
  // A track that flies low (6000 ft) and inside the test zone — a Pawnee
  // would clearly trigger red; a Schweizer must not.
  const lowInZone = track([
    [40.0, -105.2, 6000, 0],
    [40.005, -105.2, 6000, 60],
  ])

  it('Schweizer (SGS) inside the zone never lights up overlap', () => {
    const o = neighborhoodOverlap(lowInZone, ZONES, { typeCode: 'SGS' })
    expect(o.feet.inZone).toBe(0)
    expect(o.seconds.inZone).toBe(0)
    expect(o.seconds.red).toBe(0)
  })

  it('powered aircraft (C172) on the same track DOES register', () => {
    const o = neighborhoodOverlap(lowInZone, ZONES, { typeCode: 'C172' })
    expect(o.feet.inZone).toBeGreaterThan(0)
    expect(o.seconds.red).toBeGreaterThan(0)
  })

  it('common engineless ICAO codes are all exempt', () => {
    for (const t of ['GLID', 'SGS', 'AS21', 'DG10', 'VENT', 'NIMB', 'DISC', 'ASW', 'JS1', 'BALL']) {
      const o = neighborhoodOverlap(lowInZone, ZONES, { typeCode: t })
      expect(o.feet.inZone, `${t} should not register zone overlap`).toBe(0)
      expect(o.seconds.inZone, `${t} should not register zone seconds`).toBe(0)
    }
  })

  it('unknown / empty type code defaults to non-exempt (powered)', () => {
    const o1 = neighborhoodOverlap(lowInZone, ZONES, { typeCode: '' })
    const o2 = neighborhoodOverlap(lowInZone, ZONES, {})
    expect(o1.feet.inZone).toBeGreaterThan(0)
    expect(o2.feet.inZone).toBeGreaterThan(0)
  })
})

describe('matchReportSegments', () => {
  // Helpers — build reports with explicit segments and meter readings.
  const iso = (n) => new Date(sec(n)).toISOString()
  const mkReport = (overrides = {}) => ({
    id: 'nr-test-1',
    submittedAt: '2026-05-20T15:01:00Z',
    reporter: { email: 'me@example.com', name: 'Test' },
    noiseMeter: { liveDba: 62, sustainedDba: 71 },
    reportedSegments: [{
      tail: 'N123AB',
      klass: 'yellow',
      autoMaxCalculatedDba: 67,
      points: [
        { ts: iso(30), lat: 40.05, lon: -105.17, alt: 6500 },
        { ts: iso(60), lat: 40.05, lon: -105.16, alt: 6400 },
      ],
    }],
    ...overrides,
  })

  it('emits one entry per reportedSegments[] element', () => {
    const r = mkReport({
      reportedSegments: [
        { tail: 'N123AB', klass: 'yellow', points: [{ ts: iso(10), lat: 40, lon: -105 }, { ts: iso(20), lat: 40, lon: -105 }] },
        { tail: 'N123AB', klass: 'orange', points: [{ ts: iso(50), lat: 40, lon: -105 }, { ts: iso(70), lat: 40, lon: -105 }] },
      ],
    })
    const out = matchReportSegments([r], 'N123AB', sec(0), sec(120))
    expect(out).toHaveLength(2)
    expect(out[0].klass).toBe('yellow')
    expect(out[1].klass).toBe('orange')
  })

  it('tail match is case-insensitive', () => {
    const out = matchReportSegments([mkReport()], 'n123ab', sec(0), sec(120))
    expect(out).toHaveLength(1)
    expect(out[0].report_id).toBe('nr-test-1')
  })

  it('excludes segments outside the ±10 min pad and includes ones inside', () => {
    // 11 min past the flight end window → should be excluded
    const justOutside = mkReport({
      id: 'nr-outside',
      reportedSegments: [{
        tail: 'N123AB', klass: 'yellow',
        points: [{ ts: iso(120 + 11 * 60), lat: 40, lon: -105 }, { ts: iso(120 + 11 * 60 + 5), lat: 40, lon: -105 }],
      }],
    })
    // 9 min past → inside the pad
    const justInside = mkReport({
      id: 'nr-inside',
      reportedSegments: [{
        tail: 'N123AB', klass: 'yellow',
        points: [{ ts: iso(120 + 9 * 60), lat: 40, lon: -105 }, { ts: iso(120 + 9 * 60 + 5), lat: 40, lon: -105 }],
      }],
    })
    const out = matchReportSegments([justOutside, justInside], 'N123AB', sec(0), sec(120))
    expect(out).toHaveLength(1)
    expect(out[0].report_id).toBe('nr-inside')
  })

  it('falls back to excursion.startedAt/endedAt when seg.points is missing', () => {
    const r = {
      id: 'nr-ex-fallback',
      submittedAt: '2026-05-20T15:01:00Z',
      excursion: { tail: 'N123AB', klass: 'red', startedAt: iso(30), endedAt: iso(90) },
      reportedSegments: [{ tail: 'N123AB', klass: 'red' /* no points */ }],
    }
    const out = matchReportSegments([r], 'N123AB', sec(0), sec(120))
    expect(out).toHaveLength(1)
    expect(out[0].segment.start_ts).toBe(iso(30))
    expect(out[0].segment.end_ts).toBe(iso(90))
  })

  it('falls back through calculatedNoise.maxDba then .dba when seg.autoMaxCalculatedDba is missing', () => {
    const r1 = mkReport({
      id: 'nr-m',
      calculatedNoise: { maxDba: 71 },
      reportedSegments: [{ tail: 'N123AB', klass: 'yellow', points: [{ ts: iso(10) }, { ts: iso(20) }] }],
    })
    const r2 = mkReport({
      id: 'nr-d',
      calculatedNoise: { dba: 64 },
      reportedSegments: [{ tail: 'N123AB', klass: 'yellow', points: [{ ts: iso(10) }, { ts: iso(20) }] }],
    })
    const out1 = matchReportSegments([r1], 'N123AB', sec(0), sec(120))
    const out2 = matchReportSegments([r2], 'N123AB', sec(0), sec(120))
    expect(out1[0].calculated_dba.max).toBe(71)
    expect(out2[0].calculated_dba.max).toBe(64)
  })

  it('free-mode reports (no seg.tail) never match', () => {
    const r = {
      id: 'nr-free', submittedAt: '2026-05-20T15:01:00Z',
      reportedSegments: [{ klass: 'yellow', points: [{ ts: iso(30) }, { ts: iso(60) }] /* no tail */ }],
    }
    expect(matchReportSegments([r], 'N123AB', sec(0), sec(120))).toHaveLength(0)
  })

  it('falls back to a synthetic segment from excursion when reportedSegments[] is absent', () => {
    // This is the shape of records currently on disk in data/noise_reports.json.
    const r = {
      id: 'nr-legacy', submittedAt: '2026-05-20T15:01:00Z',
      excursion: { tail: 'N123AB', klass: 'yellow', startedAt: iso(30), endedAt: iso(60) },
    }
    const out = matchReportSegments([r], 'N123AB', sec(0), sec(120))
    expect(out).toHaveLength(1)
    expect(out[0].klass).toBe('yellow')
  })

  it('does not emit any audio / media / mp3 fields', () => {
    const r = mkReport({
      media: ['s3://noise-audio/nr-test-1/spliced10s.mp3'],
      noise_audio: { spliced10s: { mime: 'audio/mpeg', size: 12345 } },
    })
    const out = matchReportSegments([r], 'N123AB', sec(0), sec(120))
    expect(out).toHaveLength(1)
    const flat = JSON.stringify(out[0])
    expect(flat).not.toMatch(/audio|mp3|media/i)
  })

  it('infers source: manual when a human reporter is present, auto otherwise', () => {
    const manual = mkReport({ id: 'nr-man' })
    const autoR = mkReport({ id: 'nr-auto', reporter: null, autoGenerated: true })
    const both = matchReportSegments([manual, autoR], 'N123AB', sec(0), sec(120))
    expect(both.map(r => r.source).sort()).toEqual(['auto', 'manual'])
  })

  it('accepts segment points as raw [lat, lon, alt, ts_ms] tuples (prod shape)', () => {
    // This is the shape we see in Postgres on Railway: reportedSegments[0].points
    // is an array of 4-tuples, not objects with .ts.
    const r = {
      id: 'nr-tuple', submittedAt: '2026-05-20T15:01:00Z', auto: true,
      reportedSegments: [{
        tail: 'N123AB', klass: 'red', autoMaxCalculatedDba: 78,
        points: [
          [40.05, -105.17, 6500, sec(30)],
          [40.05, -105.16, 6400, sec(60)],
        ],
      }],
    }
    const out = matchReportSegments([r], 'N123AB', sec(0), sec(120))
    expect(out).toHaveLength(1)
    expect(out[0].segment.start_ts).toBe(iso(30))
    expect(out[0].segment.end_ts).toBe(iso(60))
    // Output points must be normalised to objects regardless of input shape.
    expect(out[0].segment.points[0]).toMatchObject({ lat: 40.05, lon: -105.17, alt: 6500 })
    expect(out[0].segment.points[0].ts).toBe(iso(30))
  })

  it('treats reporter "anon:..." (prod auto-report shape) as auto', () => {
    const r = {
      id: 'nr-anon', submittedAt: '2026-05-20T15:01:00Z',
      reporter: 'anon:phep2io4ah',
      reportedSegments: [{ tail: 'N123AB', points: [{ ts: iso(30) }, { ts: iso(60) }] }],
    }
    const out = matchReportSegments([r], 'N123AB', sec(0), sec(120))
    expect(out[0].source).toBe('auto')
  })

  it('filters by source when opts.source = "manual" or "auto"', () => {
    const manual = mkReport({ id: 'nr-man' })
    const autoR = mkReport({ id: 'nr-auto', reporter: null, autoGenerated: true })
    const m = matchReportSegments([manual, autoR], 'N123AB', sec(0), sec(120), { source: 'manual' })
    const a = matchReportSegments([manual, autoR], 'N123AB', sec(0), sec(120), { source: 'auto' })
    expect(m.map(r => r.report_id)).toEqual(['nr-man'])
    expect(a.map(r => r.report_id)).toEqual(['nr-auto'])
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
