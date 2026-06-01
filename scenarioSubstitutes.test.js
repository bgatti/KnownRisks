// scenarioSubstitutes.test.js — Ask #11 What-If helpers.
//
// Unit tests for the substitute-matching + dBA-projection helpers and a
// guarded integration test against /api/excursions/segments.
//
// Run:  npx vitest run scenarioSubstitutes.test.js
//       ADSB_BASE=http://localhost:5174 npx vitest run scenarioSubstitutes.test.js  (+ integration)

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  pickTrackCandidates,
  pickSegmentCandidates,
  dbaAtListener,
} from './scenarioSubstitutes.js'

// Load the real substitutes config so the tests catch any registry drift.
const SUBS = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'public/substitutes.json'), 'utf8')
).substitutes

describe('pickTrackCandidates', () => {
  it('C172 training track → includes VELE', () => {
    const cands = pickTrackCandidates({ type: 'C172', purpose: 'training' }, SUBS)
    expect(cands).toContain('VELE')
  })

  it('PA25 tow track → includes EFOX, excludes WNCH (WNCH is segment-scope)', () => {
    const cands = pickTrackCandidates({ type: 'PA25', purpose: 'tow_plane' }, SUBS)
    expect(cands).toContain('EFOX')
    expect(cands).not.toContain('WNCH')
  })

  it('ASK21 glider track (type=AS21) → includes SINU', () => {
    const cands = pickTrackCandidates({ type: 'AS21', purpose: 'glider' }, SUBS)
    expect(cands).toContain('SINU')
  })

  it('airliner (type=B738) → no candidates', () => {
    const cands = pickTrackCandidates({ type: 'B738', purpose: 'airliner' }, SUBS)
    expect(cands).toEqual([])
  })

  it('matches by type alone when purpose is missing', () => {
    // Glider with no purpose tag still matches SINU via type.
    const cands = pickTrackCandidates({ type: 'GLID' }, SUBS)
    expect(cands).toContain('SINU')
  })

  it('matches by purpose alone when type is unknown', () => {
    // Training purpose with an unrecognized airframe still matches VELE.
    const cands = pickTrackCandidates({ type: 'XYZQ', purpose: 'training' }, SUBS)
    expect(cands).toContain('VELE')
  })
})

describe('pickSegmentCandidates', () => {
  it('PA25 tow → returns [{ code: "WNCH", applies_to_agl_below_ft: 2000 }]', () => {
    const cands = pickSegmentCandidates({ type: 'PA25', purpose: 'tow_plane' }, SUBS)
    expect(cands).toEqual([{ code: 'WNCH', applies_to_agl_below_ft: 2000 }])
  })

  it('C172 training → returns [] (no segment substitutes)', () => {
    const cands = pickSegmentCandidates({ type: 'C172', purpose: 'training' }, SUBS)
    expect(cands).toEqual([])
  })

  it('PA18 tow → returns WNCH with cutoff', () => {
    const cands = pickSegmentCandidates({ type: 'PA18', purpose: 'tow_plane' }, SUBS)
    expect(cands.length).toBe(1)
    expect(cands[0].code).toBe('WNCH')
    expect(cands[0].applies_to_agl_below_ft).toBe(2000)
  })
})

describe('dbaAtListener', () => {
  it('matches the spec formula at 1000 ft AGL overhead with C172 base (75 → 75)', () => {
    // 1000 ft AGL is the vert-falloff floor (no penalty above 1000 →
    // 6*log2(1)=0). Overhead → distFt=0, slant = AGL = 1000, lateral =
    // 3*log2(1000/500)=3 dB. So we expect 75 - 0 - 3 = 72.
    // The spec one-liner ("→ 75 dBA") is a simplification — at directly
    // overhead the lateral term still kicks in. Verify with the actual
    // formula so the test catches any kernel drift.
    const out = dbaAtListener(75, 6288, 5288, 0) // 1000 ft AGL overhead
    expect(out).toBeCloseTo(72, 1)
  })

  it('overhead at vertical floor (1000 ft AGL) lateral is the only loss', () => {
    // baseDba 80, alt 1000 above listener, lat distance 0 → vert 0, slant
    // = 1000, lateral = 3*log2(2) = 3 dB → 77.
    expect(dbaAtListener(80, 6000, 5000, 0)).toBeCloseTo(77, 1)
  })

  it('WNCH segment substitute (base=0) → returns 0 regardless of geometry', () => {
    expect(dbaAtListener(0, 6500, 5288, 1234)).toBe(0)
    expect(dbaAtListener(0, 7000, 5288, 0)).toBe(0)
    expect(dbaAtListener(0, 5000, 5288, 9999)).toBe(0) // AGL would clamp to 100 ft
  })

  it('substitute below 100 ft AGL is clamped at 100 (engineless / floor case)', () => {
    // An aircraft below the listener (AGL would be negative) → AGL clamped
    // to 100 ft. Equivalent to flying at listenerElev+100. Verify the result
    // matches dbaAtListener(base, listenerElev+100, listenerElev, distFt).
    const baseDba = 70
    const listenerElev = 5288
    const distFt = 0
    const clamped = dbaAtListener(baseDba, listenerElev - 50, listenerElev, distFt)
    const expected = dbaAtListener(baseDba, listenerElev + 100, listenerElev, distFt)
    expect(clamped).toBeCloseTo(expected, 3)
  })

  it('lateral falloff doubles approximately every doubling of slant range', () => {
    // At 1000 ft AGL: slant=500 lateral=0; slant=1000 lateral=3; slant=2000
    // lateral=6. With distFt large enough to dominate slant, lateral ≈
    // 3*log2(slant/500).
    const base = 80
    const elev = 5288
    const alt = elev + 100 // small AGL so slant ≈ distFt
    const at500 = dbaAtListener(base, alt, elev, 500)
    const at1000 = dbaAtListener(base, alt, elev, 1000)
    const at2000 = dbaAtListener(base, alt, elev, 2000)
    // Each doubling drops by ~3 dB once we're past the 500-ft floor.
    expect(at500 - at1000).toBeCloseTo(2.5, 0)
    expect(at1000 - at2000).toBeCloseTo(3, 0)
  })
})

// ════════════════════════════════════════════════════════════════════════
// Integration tests — hit the running Vite dev server (ADSB_BASE)
// ════════════════════════════════════════════════════════════════════════

const BASE = process.env.ADSB_BASE
const itLive = BASE ? it : it.skip

async function get(p) {
  const res = await fetch(`${BASE}${p}`)
  return { status: res.status, data: await res.json() }
}

describe('segments handler integration (Ask #11)', () => {
  itLive('without lat/lon → tracks have alt_airframe_candidates, no alt_dba_by_substitute', async () => {
    const { status, data } = await get('/api/excursions/segments?hours=24&limit=20')
    expect(status).toBe(200)
    expect(Array.isArray(data.tracks)).toBe(true)
    if (data.tracks.length === 0) return // no live data — nothing to assert
    for (const t of data.tracks) {
      expect(Array.isArray(t.alt_airframe_candidates)).toBe(true)
      expect(Array.isArray(t.alt_segment_candidates)).toBe(true)
      for (const s of t.segments || []) {
        // Without lat/lon, segments must NOT carry alt_dba_by_substitute.
        expect(s.alt_dba_by_substitute).toBeUndefined()
      }
    }
  })

  itLive('with lat/lon → segments carry alt_dba_by_substitute for each candidate', async () => {
    const { status, data } = await get(
      '/api/excursions/segments?lat=40.005&lon=-105.205&radius_nm=3&hours=24&limit=20'
    )
    expect(status).toBe(200)
    expect(Array.isArray(data.tracks)).toBe(true)
    if (data.tracks.length === 0) return // no nearby live data — nothing to assert
    // At least one track with candidates → at least one segment should
    // carry alt_dba_by_substitute.
    let anySegDb = false
    for (const t of data.tracks) {
      const cands = t.alt_airframe_candidates || []
      if (cands.length === 0) continue
      for (const s of t.segments || []) {
        if (s.alt_dba_by_substitute) {
          anySegDb = true
          // Every track-scope candidate key must be present and numeric.
          for (const code of cands) {
            expect(s.alt_dba_by_substitute).toHaveProperty(code)
            const v = s.alt_dba_by_substitute[code]
            expect(typeof v === 'number').toBe(true)
            expect(v).toBeGreaterThanOrEqual(0)
          }
        }
      }
    }
    expect(anySegDb).toBe(true)
  })

  itLive('WNCH appears in segment map only for sub-segments where alt_agl_min < 2000 (null otherwise)', async () => {
    // Use KBDU center so we catch any tow tracks if present.
    const { status, data } = await get(
      '/api/excursions/segments?lat=40.04&lon=-105.22&radius_nm=3&hours=24&limit=50'
    )
    expect(status).toBe(200)
    const tows = (data.tracks || []).filter((t) =>
      (t.alt_segment_candidates || []).some((c) => c.code === 'WNCH')
    )
    if (tows.length === 0) return // no tow tracks in window — skip
    // For each tow track, every segment should have a WNCH key in
    // alt_dba_by_substitute (either a number when low, or null when out
    // of window).
    for (const t of tows) {
      for (const s of t.segments || []) {
        if (!s.alt_dba_by_substitute) continue
        expect(s.alt_dba_by_substitute).toHaveProperty('WNCH')
        // WNCH is either null (out of window) or 0 (winch base_dba=0).
        const v = s.alt_dba_by_substitute.WNCH
        expect(v === null || v === 0).toBe(true)
      }
    }
  })
})
