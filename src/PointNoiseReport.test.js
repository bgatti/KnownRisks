// PointNoiseReport.test.js — §11-CLIENT What-If helpers.
//
// Tests the pure helpers extracted into src/whatif.js (so this file can
// stay React- and leaflet-free under the existing node-only vitest
// config — see scenarioSubstitutes.test.js for the same pattern).
//
// applyScenarioToRow has dependencies on the page's dBA kernel +
// distFt so we don't import it here; instead, the test mirrors the
// scenario world by constructing rows directly and using the pure
// helpers (pickSubstituted + segmentDba) to verify divergence from
// baseline.
//
// Run:  cd noise/web && npx vitest run src/PointNoiseReport.test.js

import { describe, it, expect } from 'vitest'
import {
  pickSubstituted,
  shouldWinchSegment,
  segmentDba,
  npv,
  businessModelColumn,
  purposeSourceBadgeProps,
} from './whatif.js'

/* ─── pickSubstituted ─────────────────────────────────────────────── */

describe('pickSubstituted', () => {
  const tracks = [
    { tail: 'N3', altAirframeCandidates: ['VELE'] },
    { tail: 'N1', altAirframeCandidates: ['VELE'] },
    { tail: 'N2', altAirframeCandidates: ['VELE'] },
    { tail: 'N5', altAirframeCandidates: ['VELE'] },
    { tail: 'N4', altAirframeCandidates: ['VELE'] },
    { tail: 'NX', altAirframeCandidates: [] },
  ]
  it('returns an empty Set when pct is 0', () => {
    expect(pickSubstituted(tracks, 'VELE', 0).size).toBe(0)
  })
  it('returns an empty Set when no track has the candidate', () => {
    expect(pickSubstituted(tracks, 'EFOX', 100).size).toBe(0)
  })
  it('takes the first floor(N * pct/100) tails after sorting ascending', () => {
    const picked = pickSubstituted(tracks, 'VELE', 60)
    // 5 eligible × 60% = 3 tails, sorted asc: N1, N2, N3
    expect([...picked].sort()).toEqual(['N1', 'N2', 'N3'])
  })
  it('is deterministic across re-runs (same input → same output)', () => {
    const a = pickSubstituted(tracks, 'VELE', 40)
    const b = pickSubstituted(tracks, 'VELE', 40)
    expect([...a].sort()).toEqual([...b].sort())
  })
  it('handles missing altAirframeCandidates gracefully', () => {
    expect(pickSubstituted([{ tail: 'N1' }], 'VELE', 100).size).toBe(0)
  })
})

/* ─── shouldWinchSegment ──────────────────────────────────────────── */

describe('shouldWinchSegment', () => {
  const seg = { points: [
    [40, -105, 5500, 0],  // 5500 - 5000 = 500 AGL
    [40, -105, 5800, 1],  // 800 AGL
    [40, -105, 6500, 2],  // 1500 AGL
  ]}
  it('false when threshold is 0 or negative (winch off)', () => {
    expect(shouldWinchSegment(seg, 0, 5000)).toBe(false)
    expect(shouldWinchSegment(seg, -100, 5000)).toBe(false)
  })
  it('true when the lowest AGL point is below the threshold', () => {
    expect(shouldWinchSegment(seg, 1000, 5000)).toBe(true)  // 500 < 1000
  })
  it('false when even the lowest AGL is above the threshold', () => {
    expect(shouldWinchSegment(seg, 200, 5000)).toBe(false)  // 500 > 200
  })
  it('handles empty / missing points', () => {
    expect(shouldWinchSegment({ points: [] }, 1000, 5000)).toBe(false)
    expect(shouldWinchSegment({}, 1000, 5000)).toBe(false)
  })
})

/* ─── segmentDba ──────────────────────────────────────────────────── */

describe('segmentDba', () => {
  const track = { tail: 'N42' }
  const seg = {
    points: [[40, -105, 5500, 0], [40, -105, 6000, 1]],
    alt_dba_by_substitute: { VELE: 53 },
  }
  const baseDba = 70
  it('returns 0 when winch is active for this track and segment qualifies', () => {
    const scenario = {
      winchTracks: new Set(['N42']),
      winch_agl_ft: 1000,
      substituted: { VELE: new Set(), EFOX: new Set(), SINU: new Set() },
    }
    expect(segmentDba(track, seg, scenario, 5000, baseDba)).toBe(0)
  })
  it('returns the substitute value when the track is VELE-picked and the segment has a value', () => {
    const scenario = {
      winchTracks: new Set(),
      winch_agl_ft: 0,
      substituted: { VELE: new Set(['N42']), EFOX: new Set(), SINU: new Set() },
    }
    expect(segmentDba(track, seg, scenario, 5000, baseDba)).toBe(53)
  })
  it('falls back to baseline when the substitute entry is null (not applicable to this segment)', () => {
    const segNull = { ...seg, alt_dba_by_substitute: { VELE: null } }
    const scenario = {
      winchTracks: new Set(),
      substituted: { VELE: new Set(['N42']), EFOX: new Set(), SINU: new Set() },
    }
    expect(segmentDba(track, segNull, scenario, 5000, baseDba)).toBe(baseDba)
  })
  it('returns baseline when no scenario applies', () => {
    const scenario = {
      winchTracks: new Set(),
      substituted: { VELE: new Set(), EFOX: new Set(), SINU: new Set() },
    }
    expect(segmentDba(track, seg, scenario, 5000, baseDba)).toBe(baseDba)
  })
})

/* ─── scenario divergence ─────────────────────────────────────────── */

// End-to-end-ish test: build a track set with alt_airframe_candidates,
// move the slider, and assert the scenario aggregate diverges from
// baseline. Mirrors what the page does in scenarioRows + scenarioHourly
// — we re-create the per-segment dBA projection by walking
// pickSubstituted → segmentDba directly so the test stays pure-JS.

describe('scenario aggregates diverge from baseline as sliders move', () => {
  // 4 C172 training tracks, each carrying a single segment with a baseline
  // peak dBA of 70 and a VELE substitute value of 53.
  const buildRow = (tail) => ({
    tail,
    type: 'C172',
    altAirframeCandidates: ['VELE'],
    altSegmentCandidates: [],
    baselineDba: 70,
    segments: [{
      points: [[40, -105, 6288, 0]],  // 1000 AGL overhead
      alt_dba_by_substitute: { VELE: 53 },
    }],
  })
  const rows = ['N1', 'N2', 'N3', 'N4'].map(buildRow)
  const listener = { elev_ft: 5288 }

  // Helper: replay the page's row projection using the pure helpers —
  // peak per row = max segmentDba across the row's segments.
  const projectRow = (row, scenario) => {
    let peak = 0
    for (const seg of row.segments) {
      const dba = segmentDba(row, seg, scenario, listener.elev_ft, row.baselineDba)
      if (dba > peak) peak = dba
    }
    return { ...row, dba: peak }
  }

  it('50% electric slider drops the mean but not the peak (two tails still loud)', () => {
    const picks = pickSubstituted(rows, 'VELE', 50)
    expect(picks.size).toBe(2)
    const scenario = {
      substituted: { VELE: picks, EFOX: new Set(), SINU: new Set() },
      winchTracks: new Set(),
      winch_agl_ft: 0,
    }
    const baseRows = rows.map((r) => projectRow(r, { substituted: { VELE: new Set(), EFOX: new Set(), SINU: new Set() }, winchTracks: new Set() }))
    const scenarioRows = rows.map((r) => projectRow(r, scenario))
    const basePeak = Math.max(...baseRows.map((r) => r.dba))
    const scnPeak = Math.max(...scenarioRows.map((r) => r.dba))
    const baseMean = baseRows.reduce((s, r) => s + r.dba, 0) / baseRows.length
    const scnMean = scenarioRows.reduce((s, r) => s + r.dba, 0) / scenarioRows.length
    expect(basePeak).toBe(70)
    expect(scnPeak).toBe(70)             // 2 unsubstituted tails still loud
    expect(scnMean).toBeLessThan(baseMean)
  })
  it('100% electric slider drops peak too — all tracks substituted', () => {
    const picks = pickSubstituted(rows, 'VELE', 100)
    const scenario = {
      substituted: { VELE: picks, EFOX: new Set(), SINU: new Set() },
      winchTracks: new Set(),
      winch_agl_ft: 0,
    }
    const scenarioRows = rows.map((r) => projectRow(r, scenario))
    expect(Math.max(...scenarioRows.map((r) => r.dba))).toBe(53)
  })
})

/* ─── npv ─────────────────────────────────────────────────────────── */

describe('npv', () => {
  it('returns −capex when there are no cash flows', () => {
    expect(npv({ capex: 100000, annualSavings: 0, salvage: 0, rate: 0.05, years: 10 })).toBe(-100000)
  })
  it('handles the textbook positive-NPV case', () => {
    // $100k capex, $20k/yr for 10 yr, no salvage, 5% rate.
    // Annuity PV factor at 5% / 10 yr ≈ 7.7217.
    // NPV ≈ -100000 + 20000 × 7.7217 ≈ +54,434.
    const out = npv({ capex: 100000, annualSavings: 20000, salvage: 0, rate: 0.05, years: 10 })
    expect(out).toBeGreaterThan(54000)
    expect(out).toBeLessThan(55000)
  })
  it('adds the discounted salvage at the end of the horizon', () => {
    const a = npv({ capex: 100000, annualSavings: 0, salvage: 0, rate: 0.05, years: 10 })
    const b = npv({ capex: 100000, annualSavings: 0, salvage: 10000, rate: 0.05, years: 10 })
    // b − a = 10000 / 1.05^10 ≈ 6,139
    expect(b - a).toBeGreaterThan(6100)
    expect(b - a).toBeLessThan(6200)
  })
})

/* ─── businessModelColumn ─────────────────────────────────────────── */

describe('businessModelColumn', () => {
  const sub = {
    code: 'VELE', name: 'Pipistrel Velis Electro',
    cap_ex_usd: 210000, op_savings_per_hr_usd: 30,
    useful_life_years: 12, residual_value_pct: 0.30,
    annual_hours_typical: 600,
  }
  const scenario = {
    annual_hours_override: {},
    fuel_multiplier: 1,
    horizon_yr: 10,
    rate: 0.05,
  }
  it('returns null when nAirframes <= 0', () => {
    expect(businessModelColumn({ sub, scenario, nAirframes: 0, dbDelta: 5 })).toBeNull()
  })
  it('rolls capex × N and salvage × residual_pct', () => {
    const col = businessModelColumn({ sub, scenario, nAirframes: 10, dbDelta: 10 })
    expect(col.capex).toBe(2_100_000)
    expect(col.salvage).toBe(630_000)
    expect(col.code).toBe('VELE')
    expect(col.nAirframes).toBe(10)
  })
  it('respects the per-substitute annual_hours override', () => {
    const out = businessModelColumn({
      sub,
      scenario: { ...scenario, annual_hours_override: { VELE: 1000 } },
      nAirframes: 1,
      dbDelta: 1,
    })
    expect(out.hoursPerYr).toBe(1000)
    // Annual savings = 30 × 1000 × 1 = $30k
    expect(out.annualSavings).toBe(30000)
  })
  it('reports break-even hours only when NPV is negative', () => {
    // 1 airframe at default hours → likely NPV-negative or positive depending
    // on the numbers; force one of each:
    const negative = businessModelColumn({
      sub: { ...sub, annual_hours_typical: 50 }, // way below break-even
      scenario,
      nAirframes: 1,
      dbDelta: 5,
    })
    expect(negative.npv).toBeLessThan(0)
    expect(negative.breakEvenHours).toBeGreaterThan(0)
    expect(negative.dollarsPerDb).toBeGreaterThan(0)
    const positive = businessModelColumn({
      sub: { ...sub, annual_hours_typical: 2000 }, // way above break-even
      scenario,
      nAirframes: 1,
      dbDelta: 5,
    })
    expect(positive.npv).toBeGreaterThan(0)
    expect(positive.breakEvenHours).toBeNull()  // already paying
    expect(positive.dollarsPerDb).toBeNull()
  })
})

/* ─── purposeSourceBadgeProps ─────────────────────────────────────── */

// §11-CLIENT V3 §5: one assertion per purpose_source value plus the
// confidence-percent rounding for the 'shape' variants. The badge
// component is a thin <span> wrapper around these props (see
// PurposeSourceBadge in PointNoiseReport.jsx) — verifying the pure
// helper gives the same coverage without pulling React into this
// node-only test config.
describe('purposeSourceBadgeProps', () => {
  it('returns null when source is missing (older API row)', () => {
    expect(purposeSourceBadgeProps(null)).toBeNull()
    expect(purposeSourceBadgeProps(undefined, 0.85)).toBeNull()
    expect(purposeSourceBadgeProps('')).toBeNull()
  })
  it('returns null for an unrecognised source value', () => {
    expect(purposeSourceBadgeProps('mystery-source', 0.5)).toBeNull()
  })
  it("renders '★ curated' (gold) for special_use", () => {
    const out = purposeSourceBadgeProps('special_use')
    expect(out.text).toBe('★ curated')
    expect(out.color).toBe('#f59e0b')
    expect(out.title).toMatch(/Authoritative/i)
  })
  it("renders 'T' (slate) for type", () => {
    const out = purposeSourceBadgeProps('type')
    expect(out.text).toBe('T')
    expect(out.color).toBe('#94a3b8')
    expect(out.title).toMatch(/ICAO type code/i)
  })
  it("renders 'DB' (slate) for tracked", () => {
    const out = purposeSourceBadgeProps('tracked')
    expect(out.text).toBe('DB')
    expect(out.color).toBe('#94a3b8')
    expect(out.title).toMatch(/tracks database/i)
  })
  it("renders '~ shape (NN%)' (cyan) for shape with confidence", () => {
    const out = purposeSourceBadgeProps('shape', 0.873)
    expect(out.text).toBe('~ shape (87%)')   // rounded to nearest %
    expect(out.color).toBe('#22d3ee')
    expect(out.title).toMatch(/purposeML/i)
  })
  it("renders '~ shape' (no percent) when shape confidence is missing", () => {
    const out = purposeSourceBadgeProps('shape', null)
    expect(out.text).toBe('~ shape')
  })
  it("renders '~ hedge (NN%)' (faded cyan) for shape-hedged", () => {
    const out = purposeSourceBadgeProps('shape-hedged', 0.62)
    expect(out.text).toBe('~ hedge (62%)')
    expect(out.color).toBe('#67e8f9')
    expect(out.title).toMatch(/Hedged/i)
  })
})
