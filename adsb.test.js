// adsb.test.js — Tests for ADS-B flight phase detection, tow cycle
// extraction, stats aggregation, ETA prediction, and live API endpoints.
//
// Unit tests exercise the pure functions in adsb.js with synthetic track
// data.  Integration tests hit the running Vite dev server endpoints.
//
// Run:  npx vitest run adsb.test.js          (unit only, fast)
//       ADSB_BASE=http://localhost:5174 npx vitest run adsb.test.js  (+ integration)

import { describe, it, expect } from 'vitest'
import {
  detectPhases,
  currentPhase,
  extractTowCycles,
  predictEta,
  aggregateStats,
  pairTowWithGliders,
} from './adsb.js'

// ── Fixtures ───────────────────────────────────────────────────────────

const ZONE = {
  airport: 'KBDU',
  lat: 40.0394,
  lon: -105.2258,
  field_elevation_ft: 5288,
  pattern_radius_nm: 2,
  runway_heading: 8,
  ground_speed_max_kts: 30,
  climb_threshold_fpm: 200,
  descent_threshold_fpm: -200,
  release_alt_min_ft: 500,
  release_alt_max_ft: 3500,
  on_ground_alt_agl_ft: 150,
}

const GROUND_CEIL = ZONE.field_elevation_ft + ZONE.on_ground_alt_agl_ft // 5438

// Helper: build a point array from an altitude profile.  Each entry is
// [alt_ft, dt_sec] where dt_sec is seconds since previous point.  All
// points share the same lat/lon (stationary) unless overridden.
function makeTrack(profile, { lat = 40.039, lon = -105.226, moveLat = 0 } = {}) {
  let ts = 1_700_000_000_000 // arbitrary epoch-ms base
  return profile.map(([alt, dt], idx) => {
    ts += (dt || 2) * 1000
    return [lat + idx * moveLat, lon, alt, ts]
  })
}

// A realistic single tow cycle:
//   ground → taxi → climb to 7300 → descend to 5400 → taxi → ground
function singleCycleTrack() {
  return makeTrack([
    // Ground / taxi
    [5300, 0], [5300, 10], [5310, 10],
    // Climb
    [5500, 10], [5800, 10], [6200, 10], [6600, 10], [7000, 10], [7300, 10],
    // Descent
    [7100, 10], [6700, 10], [6200, 10], [5800, 10], [5450, 10],
    // Back on ground
    [5400, 10], [5350, 10], [5300, 10],
  ], { moveLat: 0 }) // stationary lat to trigger on_ground (not taxiing)
}

// Two complete tow cycles back to back
function doubleCycleTrack() {
  return makeTrack([
    // --- cycle 1 ---
    [5300, 0], [5320, 10],           // ground
    [5500, 10], [6000, 10], [6800, 10], [7200, 10],  // climb
    [6800, 10], [6200, 10], [5500, 10],              // descent
    [5400, 10], [5350, 10],           // ground
    // --- cycle 2 ---
    [5500, 10], [6000, 10], [6500, 10], [7500, 10],  // climb
    [7000, 10], [6300, 10], [5600, 10],              // descent
    [5400, 10], [5300, 10],           // ground
  ])
}

// Track that's still airborne (no final ground segment)
function inProgressTrack() {
  return makeTrack([
    [5300, 0], [5320, 10],
    [5500, 10], [6000, 10], [6500, 10], [7000, 10],
  ])
}

// Pure ground track (never breaks ground ceiling)
function groundOnlyTrack() {
  return makeTrack([
    [5300, 0], [5300, 10], [5350, 10], [5400, 10], [5380, 10],
  ])
}

// Monotonic climb only (no peak then descent)
function climbOnlyTrack() {
  return makeTrack([
    [5500, 0], [5800, 10], [6200, 10], [6600, 10], [7000, 10],
  ])
}

// Monotonic descent only
function descentOnlyTrack() {
  return makeTrack([
    [7000, 0], [6600, 10], [6200, 10], [5800, 10], [5500, 10],
  ])
}

// Track with taxiing (points that move laterally on the ground)
function taxiTrack() {
  const base = 1_700_000_000_000
  return [
    [40.039, -105.226, 5300, base],
    [40.039, -105.226, 5300, base + 10_000],
    // Move >0.02 nm laterally (~120 ft) while staying on ground
    [40.0394, -105.226, 5350, base + 20_000],
    [40.0398, -105.226, 5400, base + 30_000],
  ]
}


// ════════════════════════════════════════════════════════════════════════
// Unit tests — detectPhases
// ════════════════════════════════════════════════════════════════════════

describe('detectPhases', () => {
  it('returns empty for null / short input', () => {
    expect(detectPhases(null, ZONE)).toEqual([])
    expect(detectPhases([], ZONE)).toEqual([])
    expect(detectPhases([[40, -105, 5300, 0]], ZONE)).toEqual([])
  })

  it('detects ground-only track as single on_ground phase', () => {
    const phases = detectPhases(groundOnlyTrack(), ZONE)
    expect(phases.length).toBe(1)
    expect(phases[0].type).toBe('on_ground')
    expect(phases[0].alt_start).toBeLessThanOrEqual(GROUND_CEIL)
  })

  it('detects taxiing when points move laterally on ground', () => {
    const phases = detectPhases(taxiTrack(), ZONE)
    expect(phases.length).toBe(1)
    expect(phases[0].type).toBe('taxiing')
  })

  it('detects climb + descent in a single cycle', () => {
    const phases = detectPhases(singleCycleTrack(), ZONE)
    const types = phases.map(p => p.type)
    expect(types).toContain('climbing_on_tow')
    expect(types).toContain('descending')
  })

  it('splits airborne segment at peak altitude', () => {
    const phases = detectPhases(singleCycleTrack(), ZONE)
    const climb = phases.find(p => p.type === 'climbing_on_tow')
    const desc = phases.find(p => p.type === 'descending')
    expect(climb).toBeDefined()
    expect(desc).toBeDefined()
    // climb ends at peak, descent starts at peak
    expect(climb.alt_end).toBeGreaterThanOrEqual(desc.alt_start)
  })

  it('labels monotonic climb as climbing_on_tow', () => {
    const phases = detectPhases(climbOnlyTrack(), ZONE)
    expect(phases.length).toBe(1)
    expect(phases[0].type).toBe('climbing_on_tow')
    expect(phases[0].alt_end).toBeGreaterThan(phases[0].alt_start)
  })

  it('labels monotonic descent as descending', () => {
    const phases = detectPhases(descentOnlyTrack(), ZONE)
    expect(phases.length).toBe(1)
    expect(phases[0].type).toBe('descending')
    expect(phases[0].alt_end).toBeLessThan(phases[0].alt_start)
  })

  it('preserves timestamp ordering', () => {
    const phases = detectPhases(singleCycleTrack(), ZONE)
    for (let i = 1; i < phases.length; i++) {
      if (phases[i].start_ts && phases[i - 1].end_ts) {
        expect(phases[i].start_ts).toBeGreaterThanOrEqual(phases[i - 1].end_ts)
      }
    }
  })

  it('index ranges cover full track without gaps', () => {
    const track = singleCycleTrack()
    const phases = detectPhases(track, ZONE)
    // First phase starts at 0
    expect(phases[0].start_idx).toBe(0)
    // Last phase ends at last index
    expect(phases[phases.length - 1].end_idx).toBe(track.length - 1)
    // No gaps between adjacent phases
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i].start_idx).toBeLessThanOrEqual(phases[i - 1].end_idx + 1)
    }
  })

  it('handles double cycle producing multiple climb/descent pairs', () => {
    const phases = detectPhases(doubleCycleTrack(), ZONE)
    const climbs = phases.filter(p => p.type === 'climbing_on_tow')
    const descents = phases.filter(p => p.type === 'descending')
    expect(climbs.length).toBe(2)
    expect(descents.length).toBe(2)
  })
})


// ════════════════════════════════════════════════════════════════════════
// Unit tests — currentPhase
// ════════════════════════════════════════════════════════════════════════

describe('currentPhase', () => {
  it('returns null for empty track', () => {
    expect(currentPhase([], ZONE)).toBeNull()
  })

  it('returns last phase type', () => {
    const state = currentPhase(singleCycleTrack(), ZONE)
    expect(state).not.toBeNull()
    // Single cycle track ends on ground
    expect(['on_ground', 'taxiing']).toContain(state.phase)
  })

  it('reports current altitude from last point', () => {
    const track = singleCycleTrack()
    const state = currentPhase(track, ZONE)
    const lastAlt = track[track.length - 1][2]
    expect(state.current_alt_ft).toBe(lastAlt)
  })

  it('computes climb rate for in-progress climb', () => {
    const state = currentPhase(inProgressTrack(), ZONE)
    expect(state.phase).toBe('climbing_on_tow')
    expect(state.climb_rate_fpm).toBeGreaterThan(0)
  })

  it('includes lat/lon from last point', () => {
    const track = inProgressTrack()
    const state = currentPhase(track, ZONE)
    expect(state.lat).toBe(track[track.length - 1][0])
    expect(state.lon).toBe(track[track.length - 1][1])
  })
})


// ════════════════════════════════════════════════════════════════════════
// Unit tests — extractTowCycles
// ════════════════════════════════════════════════════════════════════════

describe('extractTowCycles', () => {
  it('returns empty for ground-only track', () => {
    const flights = extractTowCycles('a59663', 'N4593Y', groundOnlyTrack(), ZONE)
    expect(flights).toEqual([])
  })

  it('extracts one flight from single cycle', () => {
    const flights = extractTowCycles('a59663', 'N4593Y', singleCycleTrack(), ZONE)
    expect(flights.length).toBe(1)
    const f = flights[0]
    expect(f.icao).toBe('a59663')
    expect(f.tail).toBe('N4593Y')
    expect(f.takeoff_ts).toBeTruthy()
    expect(f.release_ts).toBeTruthy()
    expect(f.landing_ts).toBeTruthy()
    expect(f.cycle_time_min).toBeGreaterThan(0)
    expect(f.release_alt_ft).toBeGreaterThan(0)
  })

  it('extracts two flights from double cycle', () => {
    const flights = extractTowCycles('a59663', 'N4593Y', doubleCycleTrack(), ZONE)
    expect(flights.length).toBe(2)
    // Both should have distinct IDs
    expect(flights[0].id).not.toBe(flights[1].id)
    // Both should have complete timing
    for (const f of flights) {
      expect(f.takeoff_ts).toBeTruthy()
      expect(f.landing_ts).toBeTruthy()
      expect(f.cycle_time_min).toBeGreaterThan(0)
    }
  })

  it('marks in-progress flight with null landing_ts', () => {
    const flights = extractTowCycles('a59663', 'N4593Y', inProgressTrack(), ZONE)
    expect(flights.length).toBeGreaterThanOrEqual(1)
    const last = flights[flights.length - 1]
    expect(last.landing_ts).toBeNull()
    expect(last.cycle_time_min).toBeNull()
  })

  it('computes release_alt_ft relative to field elevation', () => {
    const flights = extractTowCycles('a59663', 'N4593Y', singleCycleTrack(), ZONE)
    const f = flights[0]
    // Peak alt in our track is 7300; field elev is 5288 → AGL ≈ 2012
    expect(f.release_alt_ft).toBeGreaterThan(1500)
    expect(f.release_alt_ft).toBeLessThan(2500)
  })

  it('computes positive climb_rate_fpm', () => {
    const flights = extractTowCycles('a59663', 'N4593Y', singleCycleTrack(), ZONE)
    expect(flights[0].climb_rate_fpm).toBeGreaterThan(0)
  })

  it('generates deterministic flight IDs', () => {
    const track = singleCycleTrack()
    const a = extractTowCycles('a59663', 'N4593Y', track, ZONE)
    const b = extractTowCycles('a59663', 'N4593Y', track, ZONE)
    expect(a[0].id).toBe(b[0].id)
  })

  it('flight date is ISO date string', () => {
    const flights = extractTowCycles('a59663', 'N4593Y', singleCycleTrack(), ZONE)
    expect(flights[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('each flight has phases array', () => {
    const flights = extractTowCycles('a59663', 'N4593Y', singleCycleTrack(), ZONE)
    expect(Array.isArray(flights[0].phases)).toBe(true)
    expect(flights[0].phases.length).toBeGreaterThan(0)
    for (const p of flights[0].phases) {
      expect(p.type).toBeTruthy()
      expect(typeof p.alt_start).toBe('number')
      expect(typeof p.alt_end).toBe('number')
    }
  })
})


// ════════════════════════════════════════════════════════════════════════
// Unit tests — predictEta
// ════════════════════════════════════════════════════════════════════════

describe('predictEta', () => {
  it('returns est_release_s during climb below release alt', () => {
    const eta = predictEta('climbing_on_tow', 6000, 500, ZONE)
    // AGL = 6000 - 5288 = 712; remaining to 2000 AGL = 1288; at 500 fpm ≈ 155s
    expect(eta.est_release_s).toBeGreaterThan(100)
    expect(eta.est_release_s).toBeLessThan(200)
    expect(eta.est_available_s).toBeGreaterThan(eta.est_release_s)
  })

  it('returns 0 release time when already above typical release', () => {
    const eta = predictEta('climbing_on_tow', 7500, 500, ZONE)
    // AGL = 7500 - 5288 = 2212 > 2000
    expect(eta.est_release_s).toBe(0)
    expect(eta.est_available_s).toBe(120) // descent only
  })

  it('estimates descent-only time when descending', () => {
    const eta = predictEta('descending', 6500, -600, ZONE)
    // AGL = 6500 - 5288 = 1212; at 800 fpm ≈ 91s; +60s taxi
    expect(eta.est_release_s).toBeNull()
    expect(eta.est_available_s).toBeGreaterThan(60)
    expect(eta.est_available_s).toBeLessThan(200)
  })

  it('returns nulls for on_ground phase', () => {
    const eta = predictEta('on_ground', 5300, 0, ZONE)
    expect(eta.est_release_s).toBeNull()
    expect(eta.est_available_s).toBeNull()
  })

  it('returns nulls for non-positive climb rate during climb', () => {
    // climb_rate is 0 — edge case, should not divide by zero
    const eta = predictEta('climbing_on_tow', 6000, 0, ZONE)
    expect(eta.est_release_s).toBeNull()
    expect(eta.est_available_s).toBeNull()
  })
})


// ════════════════════════════════════════════════════════════════════════
// Unit tests — aggregateStats
// ════════════════════════════════════════════════════════════════════════

describe('aggregateStats', () => {
  const baseFlight = {
    icao: 'a59663', tail: 'N4593Y',
    takeoff_ts: '2026-04-19T14:00:00.000Z',
    cycle_time_min: 8.5,
    climb_rate_fpm: 450,
  }

  it('returns empty for no flights', () => {
    expect(aggregateStats([], 'all')).toEqual([])
  })

  it('skips flights with null cycle_time_min', () => {
    const result = aggregateStats([{ ...baseFlight, cycle_time_min: null }], 'all')
    expect(result).toEqual([])
  })

  it('groups by "all" with correct stats', () => {
    const flights = [
      { ...baseFlight, cycle_time_min: 8 },
      { ...baseFlight, cycle_time_min: 10 },
      { ...baseFlight, cycle_time_min: 12 },
    ]
    const result = aggregateStats(flights, 'all')
    expect(result.length).toBe(1)
    expect(result[0].key).toBe('all')
    expect(result[0].count).toBe(3)
    expect(result[0].avg_cycle_min).toBe(10)
    expect(result[0].p50_cycle).toBe(10) // median
  })

  it('groups by hour', () => {
    const flights = [
      { ...baseFlight, takeoff_ts: '2026-04-19T14:30:00Z', cycle_time_min: 8 },
      { ...baseFlight, takeoff_ts: '2026-04-19T14:45:00Z', cycle_time_min: 9 },
      { ...baseFlight, takeoff_ts: '2026-04-19T16:00:00Z', cycle_time_min: 10 },
    ]
    const result = aggregateStats(flights, 'hour')
    expect(result.length).toBe(2)
    const h14 = result.find(r => r.key === '14:00')
    const h16 = result.find(r => r.key === '16:00')
    expect(h14.count).toBe(2)
    expect(h16.count).toBe(1)
  })

  it('groups by da_band', () => {
    const flights = [
      { ...baseFlight, da_ft: 5500, cycle_time_min: 7 },
      { ...baseFlight, da_ft: 7200, cycle_time_min: 9 },
      { ...baseFlight, da_ft: 7800, cycle_time_min: 11 },
    ]
    const result = aggregateStats(flights, 'da_band')
    expect(result.length).toBe(2)
    const low = result.find(r => r.key === '<6000')
    const mid = result.find(r => r.key === '7000-8000')
    expect(low.count).toBe(1)
    expect(mid.count).toBe(2)
  })

  it('computes p10, p50, p90 percentiles', () => {
    const flights = Array.from({ length: 20 }, (_, i) => ({
      ...baseFlight,
      cycle_time_min: 5 + i, // 5..24
    }))
    const result = aggregateStats(flights, 'all')
    expect(result[0].p10_cycle).toBeLessThan(result[0].p50_cycle)
    expect(result[0].p50_cycle).toBeLessThan(result[0].p90_cycle)
  })

  it('reports avg_climb_fpm', () => {
    const flights = [
      { ...baseFlight, cycle_time_min: 8, climb_rate_fpm: 400 },
      { ...baseFlight, cycle_time_min: 9, climb_rate_fpm: 600 },
    ]
    const result = aggregateStats(flights, 'all')
    expect(result[0].avg_climb_fpm).toBe(500)
  })
})


// ════════════════════════════════════════════════════════════════════════
// Unit tests — pairTowWithGliders
// ════════════════════════════════════════════════════════════════════════

describe('pairTowWithGliders', () => {
  const fleet = {
    'aaa111': { tail: 'N4593Y', type: 'PA25', role: 'tow' },
  }

  function makeLiveTrack(hex, call, lat, lon, alt) {
    const ts = Date.now()
    return {
      hex,
      call,
      points: [[lat, lon, alt, ts]],
    }
  }

  it('pairs tow plane with nearby glider at same altitude', () => {
    const tracks = [
      makeLiveTrack('aaa111', 'N4593Y', 40.04, -105.22, 6500),
      makeLiveTrack('bbb222', 'N505PB', 40.04001, -105.22001, 6480), // ~10 ft away
    ]
    const pairs = pairTowWithGliders(tracks, fleet, ZONE)
    expect(pairs.size).toBe(1)
    expect(pairs.get('aaa111').glider_hex).toBe('bbb222')
    expect(pairs.get('aaa111').glider_tail).toBe('N505PB')
  })

  it('does not pair when glider is too far laterally', () => {
    const tracks = [
      makeLiveTrack('aaa111', 'N4593Y', 40.04, -105.22, 6500),
      makeLiveTrack('bbb222', 'N505PB', 40.05, -105.22, 6500), // ~0.6 nm away
    ]
    const pairs = pairTowWithGliders(tracks, fleet, ZONE)
    expect(pairs.size).toBe(0)
  })

  it('does not pair when altitude difference exceeds threshold', () => {
    const tracks = [
      makeLiveTrack('aaa111', 'N4593Y', 40.04, -105.22, 6500),
      makeLiveTrack('bbb222', 'N505PB', 40.04001, -105.22001, 7200), // 700 ft apart
    ]
    const pairs = pairTowWithGliders(tracks, fleet, ZONE)
    expect(pairs.size).toBe(0)
  })

  it('does not pair aircraft that are on the ground', () => {
    const tracks = [
      makeLiveTrack('aaa111', 'N4593Y', 40.04, -105.22, 5300),
      makeLiveTrack('bbb222', 'N505PB', 40.04001, -105.22001, 5310),
    ]
    const pairs = pairTowWithGliders(tracks, fleet, ZONE)
    expect(pairs.size).toBe(0)
  })

  it('does not pair two tow planes together', () => {
    const twoTowFleet = {
      'aaa111': { tail: 'N4593Y', type: 'PA25', role: 'tow' },
      'bbb222': { tail: 'N4785F', type: 'PA18', role: 'tow' },
    }
    const tracks = [
      makeLiveTrack('aaa111', 'N4593Y', 40.04, -105.22, 6500),
      makeLiveTrack('bbb222', 'N4785F', 40.04001, -105.22001, 6480),
    ]
    const pairs = pairTowWithGliders(tracks, twoTowFleet, ZONE)
    expect(pairs.size).toBe(0)
  })

  it('picks closest glider when multiple are nearby', () => {
    const tracks = [
      makeLiveTrack('aaa111', 'N4593Y', 40.04, -105.22, 6500),
      makeLiveTrack('bbb222', 'GLIDER1', 40.04001, -105.22001, 6490), // closer
      makeLiveTrack('ccc333', 'GLIDER2', 40.0405, -105.2205, 6510),   // farther but still in range
    ]
    const pairs = pairTowWithGliders(tracks, fleet, ZONE)
    expect(pairs.get('aaa111').glider_hex).toBe('bbb222')
  })

  it('returns empty for no live tracks', () => {
    const pairs = pairTowWithGliders([], fleet, ZONE)
    expect(pairs.size).toBe(0)
  })
})


// ════════════════════════════════════════════════════════════════════════
// Integration tests — hit the running Vite dev server
// ════════════════════════════════════════════════════════════════════════

const BASE = process.env.ADSB_BASE
const itLive = BASE ? it : it.skip

async function get(path) {
  const res = await fetch(`${BASE}${path}`)
  return { status: res.status, data: await res.json() }
}

describe('API endpoints (integration)', () => {
  describe('GET /api/adsb/config/fleet', () => {
    itLive('returns fleet object with known tow planes', async () => {
      const { status, data } = await get('/api/adsb/config/fleet')
      expect(status).toBe(200)
      expect(typeof data).toBe('object')
      // Should have at least the seeded tow planes
      const tails = Object.values(data).map(e => e.tail)
      expect(tails).toContain('N4593Y')
    })
  })

  describe('GET /api/adsb/config/zones', () => {
    itLive('returns zone config with airport and field elevation', async () => {
      const { status, data } = await get('/api/adsb/config/zones')
      expect(status).toBe(200)
      expect(data.airport).toBe('KBDU')
      expect(data.field_elevation_ft).toBe(5288)
      expect(data.pattern_radius_nm).toBeGreaterThan(0)
    })
  })

  describe('GET /api/adsb/live', () => {
    itLive('returns aircraft array', async () => {
      const { status, data } = await get('/api/adsb/live')
      expect(status).toBe(200)
      expect(Array.isArray(data.aircraft)).toBe(true)
    })

    itLive('each aircraft has required fields', async () => {
      const { data } = await get('/api/adsb/live')
      if (data.aircraft.length === 0) return // no live data
      const ac = data.aircraft[0]
      expect(ac).toHaveProperty('icao')
      expect(ac).toHaveProperty('tail')
      expect(ac).toHaveProperty('lat')
      expect(ac).toHaveProperty('lon')
      expect(ac).toHaveProperty('alt_ft')
      expect(ac).toHaveProperty('last_seen_s')
    })

    itLive('filters by icao query param', async () => {
      const { data: all } = await get('/api/adsb/live')
      if (all.aircraft.length === 0) return
      const icao = all.aircraft[0].icao
      const { data: filtered } = await get(`/api/adsb/live?icao=${icao}`)
      expect(filtered.aircraft.length).toBeLessThanOrEqual(1)
      if (filtered.aircraft.length === 1) {
        expect(filtered.aircraft[0].icao).toBe(icao)
      }
    })
  })

  describe('GET /api/adsb/track/:icao', () => {
    itLive('returns 404 for unknown icao', async () => {
      const { status } = await get('/api/adsb/track/000000')
      expect(status).toBe(404)
    })

    itLive('returns track with points and phases for known aircraft', async () => {
      const { data: live } = await get('/api/adsb/live')
      if (live.aircraft.length === 0) return
      const icao = live.aircraft[0].icao
      const { status, data } = await get(`/api/adsb/track/${icao}?since=2026-01-01T00:00:00Z`)
      expect(status).toBe(200)
      expect(data.icao).toBe(icao)
      expect(data).toHaveProperty('tail')
      expect(Array.isArray(data.points)).toBe(true)
      expect(Array.isArray(data.phases)).toBe(true)
    })

    itLive('phase objects have type and altitude fields', async () => {
      const { data: live } = await get('/api/adsb/live')
      if (live.aircraft.length === 0) return
      const icao = live.aircraft[0].icao
      const { data } = await get(`/api/adsb/track/${icao}?since=2026-01-01T00:00:00Z`)
      for (const p of data.phases) {
        expect(p).toHaveProperty('type')
        expect(p).toHaveProperty('alt_start')
        expect(p).toHaveProperty('alt_end')
        expect(['on_ground', 'taxiing', 'climbing_on_tow', 'descending']).toContain(p.type)
      }
    })
  })

  describe('GET /api/adsb/flights', () => {
    itLive('returns flights array', async () => {
      const { status, data } = await get('/api/adsb/flights')
      expect(status).toBe(200)
      expect(Array.isArray(data.flights)).toBe(true)
    })

    itLive('accepts tail filter', async () => {
      const { status, data } = await get('/api/adsb/flights?tail=N4593Y')
      expect(status).toBe(200)
      expect(Array.isArray(data.flights)).toBe(true)
      for (const f of data.flights) {
        expect(f.tail).toBe('N4593Y')
      }
    })

    itLive('flight objects have required schema fields', async () => {
      const { data } = await get('/api/adsb/flights')
      for (const f of data.flights) {
        expect(f).toHaveProperty('id')
        expect(f).toHaveProperty('icao')
        expect(f).toHaveProperty('tail')
        expect(f).toHaveProperty('takeoff_ts')
        expect(f).toHaveProperty('release_alt_ft')
        expect(f).toHaveProperty('climb_rate_fpm')
        expect(f).toHaveProperty('cycle_time_min')
        // Internal fields should be stripped
        expect(f).not.toHaveProperty('_startIdx')
        expect(f).not.toHaveProperty('_endIdx')
      }
    })
  })

  describe('GET /api/adsb/stats', () => {
    itLive('returns groups array', async () => {
      const { status, data } = await get('/api/adsb/stats')
      expect(status).toBe(200)
      expect(Array.isArray(data.groups)).toBe(true)
    })

    itLive('accepts group_by param', async () => {
      const { status, data } = await get('/api/adsb/stats?group_by=hour')
      expect(status).toBe(200)
      expect(Array.isArray(data.groups)).toBe(true)
      for (const g of data.groups) {
        expect(g).toHaveProperty('key')
        expect(g).toHaveProperty('count')
        expect(g).toHaveProperty('avg_cycle_min')
        expect(g).toHaveProperty('p50_cycle')
      }
    })
  })

  describe('GET /api/adsb/active-tow', () => {
    itLive('returns tow_planes array', async () => {
      const { status, data } = await get('/api/adsb/active-tow')
      expect(status).toBe(200)
      expect(Array.isArray(data.tow_planes)).toBe(true)
    })

    itLive('tow plane entries have required fields', async () => {
      const { data } = await get('/api/adsb/active-tow')
      for (const tp of data.tow_planes) {
        expect(tp).toHaveProperty('tail')
        expect(tp).toHaveProperty('icao')
        expect(tp).toHaveProperty('phase')
        expect(tp).toHaveProperty('current_alt_ft')
        expect(tp).toHaveProperty('climb_rate_fpm')
        expect(['climbing_on_tow', 'descending', 'on_ground', 'taxiing']).toContain(tp.phase)
      }
    })
  })
})
