// Tests for resolvePurposeWithShape() + pointsToPurposeMLShape() —
// the helpers added in vite.config.js for the purposeML adoption
// (see purposeML/ADOPTING_PURPOSE_ML_API.md §"Boosting an existing
// purpose field").
//
// vite.config.js doesn't export these helpers directly (they're module-
// private), so we re-host self-contained reference implementations
// that mirror the function bodies. Any change in the resolver MUST be
// mirrored here — the unit test exists to lock the priority chain
// contract and the points-shape adapter, NOT to integration-test the
// vite handler.

import { describe, it, expect, vi } from 'vitest'

// Stand-in for vite.config.js's `purposeOf`. The real one returns a
// label per the type/special-use heuristic. For the resolver tests
// we only care that the fallback runs — so a deterministic shim is
// enough.
function purposeOf(type, tail, isSchoolFleet, specialUse) {
  if (specialUse) return `special:${specialUse}`
  if (isSchoolFleet) return 'training'
  const T = String(type || '').toUpperCase()
  if (/^B7\d/.test(T) || /^A3\d/.test(T)) return 'airline'
  if (/^C(17|15)/.test(T)) return 'ga_single'
  return 'unknown'
}

// SPECIAL_USE_MAP fixture — keyed by uppercase tail.
const SPECIAL_USE_MAP = new Map([
  ['N100SCI', 'science'],
  ['N911MED', 'medivac'],
])

// Mirror of vite.config.js's pointsToPurposeMLShape. Lives in the
// test so changes need a synchronized update.
function pointsToPurposeMLShape(points) {
  if (!Array.isArray(points)) return []
  const out = []
  for (const p of points) {
    if (!p) continue
    if (Array.isArray(p)) {
      const [lat, lon, alt, ts] = p
      if (lat == null || lon == null || alt == null || ts == null) continue
      out.push({ lat, lon, altMslFt: alt, tsUnix: ts / 1000 })
    } else if (typeof p === 'object') {
      const lat = p.lat
      const lon = p.lon
      const alt = p.altMslFt ?? p.alt_ft ?? p.alt
      const tsMs = p.tsUnix != null ? p.tsUnix * 1000 : (p.ts_ms ?? p.ts)
      if (lat == null || lon == null || alt == null || tsMs == null) continue
      out.push({ lat, lon, altMslFt: alt, tsUnix: tsMs / 1000 })
    }
  }
  return out
}

// Factory that builds a resolver bound to a supplied classifier shim
// (the test injects mocks for purposeMLClassify). The body is a copy
// of vite.config.js's resolvePurposeWithShape minus the imports.
function makeResolver({ classifier = null } = {}) {
  function resolvePurposeWithShape(stored, type, tail, points, schoolMap) {
    const su = tail ? SPECIAL_USE_MAP.get(String(tail).toUpperCase()) : null
    if (su) return { purpose: purposeOf(type, tail, false, su), source: 'special_use' }
    const T = String(type || '').toUpperCase()
    if (/^(PA25|PA18|PIAT|PC6)$/.test(T)) return { purpose: 'tow_plane', source: 'type' }
    if (/^(GLID|VENT|NIMB|DISC|SGS|ASTR|JS1J|JS\d|LS\d|PIK|ASW|SZD)/.test(T)
        || /^AS\d/.test(T) || /^DG\d/.test(T)) {
      return { purpose: 'glider', source: 'type' }
    }
    if (stored && stored !== 'unknown') return { purpose: stored, source: 'tracked' }
    const tailKey = tail ? String(tail).toUpperCase() : ''
    const isSchoolFleet = !!(schoolMap && tailKey && schoolMap.has(tailKey))
    if (typeof classifier === 'function'
        && Array.isArray(points) && points.length >= 30) {
      try {
        const objPoints = pointsToPurposeMLShape(points)
        const v = classifier(objPoints, {
          typeCode: type || '',
          tail: tail || '',
          isSchoolFleet,
        })
        if (v && v.confidence >= 0.7) {
          return { purpose: v.purpose, source: 'shape', confidence: v.confidence, reasons: v.reasons }
        }
      } catch (err) {
        // Swallow per contract.
      }
    }
    return { purpose: purposeOf(type, tail, isSchoolFleet, null), source: 'type' }
  }
  // 3-arg backwards-compatibility wrapper, returns just .purpose.
  const resolvePurpose = (stored, type, tail) =>
    resolvePurposeWithShape(stored, type, tail, null, null).purpose
  return { resolvePurposeWithShape, resolvePurpose }
}

// Build 50 dummy 4-tuple points — enough to trip the shape branch.
const dummyPoints = Array.from({ length: 50 }, (_, i) => [
  40.04 + i * 0.001,
  -105.22 + i * 0.001,
  6000 + i * 10,
  1700000000000 + i * 2000,
])

describe('resolvePurposeWithShape', () => {
  it('special-use registry wins (SPECIAL_USE_MAP hit) and reports source=special_use', () => {
    const { resolvePurposeWithShape } = makeResolver()
    const v = resolvePurposeWithShape('unknown', 'C172', 'N100SCI', dummyPoints, null)
    expect(v.source).toBe('special_use')
    expect(v.purpose).toBe('special:science')
  })

  it('type regex wins for PA25 → tow_plane with source=type', () => {
    const { resolvePurposeWithShape } = makeResolver()
    const v = resolvePurposeWithShape('unknown', 'PA25', 'N4593Y', dummyPoints, null)
    expect(v.purpose).toBe('tow_plane')
    expect(v.source).toBe('type')
  })

  it('type regex wins for GLID → glider with source=type', () => {
    const { resolvePurposeWithShape } = makeResolver()
    const v = resolvePurposeWithShape('unknown', 'GLID', 'N505PB', dummyPoints, null)
    expect(v.purpose).toBe('glider')
    expect(v.source).toBe('type')
  })

  it('stored DB value wins when not unknown — source=tracked', () => {
    const { resolvePurposeWithShape } = makeResolver()
    const v = resolvePurposeWithShape('training', 'C172', 'N4632F', dummyPoints, null)
    expect(v.purpose).toBe('training')
    expect(v.source).toBe('tracked')
  })

  it('shape inference fires when points >= 30 AND no upstream rule fires', () => {
    const classifier = vi.fn().mockReturnValue({
      purpose: 'pattern_solo',
      confidence: 0.82,
      reasons: ['touch_and_go + landed_full_stop = 24 ≥ 3 (phaseML)'],
    })
    const { resolvePurposeWithShape } = makeResolver({ classifier })
    const v = resolvePurposeWithShape('unknown', 'C172', 'N4632F', dummyPoints, null)
    expect(classifier).toHaveBeenCalledOnce()
    expect(v.purpose).toBe('pattern_solo')
    expect(v.source).toBe('shape')
    expect(v.confidence).toBe(0.82)
    expect(v.reasons).toEqual(['touch_and_go + landed_full_stop = 24 ≥ 3 (phaseML)'])
  })

  it('shape inference returns purpose_source=shape + confidence + reasons', () => {
    const classifier = vi.fn().mockReturnValue({
      purpose: 'survey',
      confidence: 0.91,
      reasons: ['grid_score=0.83 > 0.5'],
    })
    const { resolvePurposeWithShape } = makeResolver({ classifier })
    const v = resolvePurposeWithShape(null, 'C208', 'N777XX', dummyPoints, null)
    expect(v).toEqual({
      purpose: 'survey',
      source: 'shape',
      confidence: 0.91,
      reasons: ['grid_score=0.83 > 0.5'],
    })
  })

  it('shape inference is skipped when points < 30 (falls through to type heuristic)', () => {
    const classifier = vi.fn()
    const { resolvePurposeWithShape } = makeResolver({ classifier })
    const fewPoints = dummyPoints.slice(0, 10)
    const v = resolvePurposeWithShape('unknown', 'C172', 'N4632F', fewPoints, null)
    expect(classifier).not.toHaveBeenCalled()
    expect(v.source).toBe('type')
    expect(v.purpose).toBe('ga_single')
  })

  it('shape inference below confidence threshold falls through to type heuristic', () => {
    const classifier = vi.fn().mockReturnValue({
      purpose: 'pattern_solo',
      confidence: 0.4,        // < 0.7 → hedge
      reasons: ['low signal'],
    })
    const { resolvePurposeWithShape } = makeResolver({ classifier })
    const v = resolvePurposeWithShape(null, 'C172', 'N4632F', dummyPoints, null)
    expect(classifier).toHaveBeenCalledOnce()
    expect(v.source).toBe('type')         // shape verdict rejected
    expect(v.purpose).toBe('ga_single')
    expect(v.confidence).toBeUndefined()
  })

  it('shape inference exception → falls through to type heuristic with source=type', () => {
    const classifier = vi.fn(() => { throw new Error('classifier blew up') })
    const { resolvePurposeWithShape } = makeResolver({ classifier })
    // Malformed-points path: classifier throws → fall through.
    const v = resolvePurposeWithShape('unknown', 'C172', 'N4632F', dummyPoints, null)
    expect(classifier).toHaveBeenCalledOnce()
    expect(v.source).toBe('type')
    expect(v.purpose).toBe('ga_single')
  })

  it('schoolMap.has(tail) upgrades the type-fallback verdict to training', () => {
    const { resolvePurposeWithShape } = makeResolver()
    const schoolMap = new Map([['N4632F', { school: 'CSU', airport: 'KFNL' }]])
    const v = resolvePurposeWithShape(null, 'C172', 'N4632F', null, schoolMap)
    // Falls through to type-based fallback with isSchoolFleet=true →
    // purposeOf returns 'training'.
    expect(v.source).toBe('type')
    expect(v.purpose).toBe('training')
  })

  it('schoolMap absent (null) → isSchoolFleet=false, fallback returns ga_single', () => {
    const { resolvePurposeWithShape } = makeResolver()
    const v = resolvePurposeWithShape(null, 'C172', 'N4632F', null, null)
    expect(v.purpose).toBe('ga_single')
  })

  it('backwards-compat: 3-arg resolvePurpose returns just the verdict string', () => {
    const { resolvePurpose } = makeResolver()
    // PA25 → tow_plane (via type regex), classic legacy behaviour.
    expect(resolvePurpose('unknown', 'PA25', 'N4593Y')).toBe('tow_plane')
    // GA fallback when stored is unknown.
    expect(resolvePurpose('unknown', 'C172', 'N4632F')).toBe('ga_single')
    // Stored value passes through when meaningful.
    expect(resolvePurpose('training', 'C172', 'N4632F')).toBe('training')
  })
})

describe('pointsToPurposeMLShape', () => {
  it('4-tuple → object shape with tsUnix in seconds', () => {
    const tuples = [
      [40.04, -105.22, 6500, 1700000000000],
      [40.05, -105.23, 6600, 1700000002000],
    ]
    const out = pointsToPurposeMLShape(tuples)
    expect(out).toEqual([
      { lat: 40.04, lon: -105.22, altMslFt: 6500, tsUnix: 1700000000 },
      { lat: 40.05, lon: -105.23, altMslFt: 6600, tsUnix: 1700000002 },
    ])
  })

  it('drops tuples missing lat/lon/alt/ts', () => {
    const tuples = [
      [40.04, -105.22, 6500, 1700000000000], // good
      [null, -105.22, 6500, 1700000000000],  // bad lat
      [40.05, null, 6500, 1700000000000],    // bad lon
      [40.05, -105.22, null, 1700000000000], // bad alt
      [40.05, -105.22, 6500, null],          // bad ts
    ]
    const out = pointsToPurposeMLShape(tuples)
    expect(out.length).toBe(1)
    expect(out[0].lat).toBe(40.04)
  })

  it('converts ts_ms → tsUnix (epoch seconds)', () => {
    const out = pointsToPurposeMLShape([[40, -105, 6000, 1_700_000_000_000]])
    expect(out[0].tsUnix).toBe(1_700_000_000)
  })

  it('accepts already-object points with alt_ft + ts_ms fallbacks', () => {
    const objs = [
      { lat: 40.04, lon: -105.22, alt_ft: 6500, ts_ms: 1700000000000 },
      { lat: 40.04, lon: -105.22, alt: 6500, ts: 1700000002000 },
    ]
    const out = pointsToPurposeMLShape(objs)
    expect(out.length).toBe(2)
    expect(out[0].altMslFt).toBe(6500)
    expect(out[0].tsUnix).toBe(1700000000)
    expect(out[1].altMslFt).toBe(6500)
    expect(out[1].tsUnix).toBe(1700000002)
  })

  it('returns [] for non-array input', () => {
    expect(pointsToPurposeMLShape(null)).toEqual([])
    expect(pointsToPurposeMLShape(undefined)).toEqual([])
    expect(pointsToPurposeMLShape('not-an-array')).toEqual([])
  })

  it('skips nullish entries within the array', () => {
    const tuples = [
      [40, -105, 6000, 1700000000000],
      null,
      undefined,
      [41, -106, 7000, 1700000002000],
    ]
    const out = pointsToPurposeMLShape(tuples)
    expect(out.length).toBe(2)
  })
})
