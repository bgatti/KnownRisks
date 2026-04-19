// adsb.js — ADS-B flight phase detection, tow cycle extraction, and stats.
//
// Works with the existing live-capture data (tracks_live.json / Postgres
// live_tracks) and historical tracks. Provides the logic behind the
// /api/adsb/* endpoints defined in vite.config.js.

import { readFile, writeFile } from 'fs/promises'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FLEET_PATH = resolve(__dirname, 'data/fleet.json')
const ZONES_PATH = resolve(__dirname, 'data/zones.json')

// ── Config loaders (mtime-cached) ──────────────────────────────────────

const configCache = { fleet: null, zones: null }

export async function loadFleet() {
  try {
    const buf = await readFile(FLEET_PATH, 'utf8')
    const data = JSON.parse(buf)
    configCache.fleet = data
    return data
  } catch {
    return configCache.fleet || {}
  }
}

export async function saveFleet(data) {
  await writeFile(FLEET_PATH, JSON.stringify(data, null, 2))
  configCache.fleet = data
}

export async function loadZones() {
  try {
    const buf = await readFile(ZONES_PATH, 'utf8')
    const data = JSON.parse(buf)
    configCache.zones = data
    return data
  } catch {
    return configCache.zones || {}
  }
}

export async function saveZones(data) {
  await writeFile(ZONES_PATH, JSON.stringify(data, null, 2))
  configCache.zones = data
}

// ── Geo helpers ────────────────────────────────────────────────────────

const NM_TO_FT = 6076.12
const FT_PER_DEG_LAT = 364560

function distNm(lat1, lon1, lat2, lon2) {
  const cos = Math.cos(((lat1 + lat2) / 2) * Math.PI / 180)
  const dx = (lon2 - lon1) * FT_PER_DEG_LAT * cos
  const dy = (lat2 - lat1) * FT_PER_DEG_LAT
  return Math.hypot(dx, dy) / NM_TO_FT
}

// ── Flight phase detection ─────────────────────────────────────────────
//
// Given a track's point array [[lat, lon, alt, ts_ms], ...] and the zone
// config, detect phases: on_ground → taxiing → climbing_on_tow →
// descending → on_ground.
//
// A "tow cycle" is one complete loop: takeoff → climb → release → descend
// → land. We split a continuous track into cycles by finding altitude
// peaks (release points) bracketed by ground segments.

export function detectPhases(points, zoneConfig) {
  if (!points || points.length < 2) return []

  const fieldElev = zoneConfig.field_elevation_ft || 5288
  const groundCeil = fieldElev + (zoneConfig.on_ground_alt_agl_ft || 150)
  const climbThresh = zoneConfig.climb_threshold_fpm || 200
  const descentThresh = zoneConfig.descent_threshold_fpm || -200
  const gsMax = zoneConfig.ground_speed_max_kts || 30

  const phases = []
  let i = 0

  while (i < points.length) {
    const [lat, lon, alt, ts] = points[i]
    const isGround = alt != null && alt <= groundCeil

    if (isGround) {
      // Scan forward through ground segment
      const start = i
      while (i < points.length && (points[i][2] == null || points[i][2] <= groundCeil)) i++
      // Check if there was movement (taxiing vs stationary)
      let moved = false
      for (let j = start + 1; j < i; j++) {
        if (distNm(points[start][0], points[start][1], points[j][0], points[j][1]) > 0.02) {
          moved = true
          break
        }
      }
      phases.push({
        type: moved ? 'taxiing' : 'on_ground',
        start_idx: start,
        end_idx: i - 1,
        start_ts: points[start][3] || null,
        end_ts: points[i - 1][3] || null,
        alt_start: points[start][2],
        alt_end: points[i - 1][2],
      })
      continue
    }

    // Airborne — determine climb vs descent using vertical rate over a
    // sliding window of ~3 points to smooth GPS noise.
    const start = i
    const windowPts = []
    let peakAlt = alt
    let peakIdx = i

    while (i < points.length && (points[i][2] == null || points[i][2] > groundCeil)) {
      if (points[i][2] != null && points[i][2] > peakAlt) {
        peakAlt = points[i][2]
        peakIdx = i
      }
      i++
    }

    // Split airborne segment at peak altitude into climb + descent
    if (peakIdx > start && peakIdx < i - 1) {
      phases.push({
        type: 'climbing_on_tow',
        start_idx: start,
        end_idx: peakIdx,
        start_ts: points[start][3] || null,
        end_ts: points[peakIdx][3] || null,
        alt_start: points[start][2],
        alt_end: points[peakIdx][2],
      })
      phases.push({
        type: 'descending',
        start_idx: peakIdx,
        end_idx: i - 1,
        start_ts: points[peakIdx][3] || null,
        end_ts: points[i - 1][3] || null,
        alt_start: points[peakIdx][2],
        alt_end: points[i - 1][2],
      })
    } else {
      // Monotonic climb or descent
      const firstAlt = points[start][2] || 0
      const lastAlt = points[i - 1][2] || 0
      phases.push({
        type: lastAlt > firstAlt ? 'climbing_on_tow' : 'descending',
        start_idx: start,
        end_idx: i - 1,
        start_ts: points[start][3] || null,
        end_ts: points[i - 1][3] || null,
        alt_start: firstAlt,
        alt_end: lastAlt,
      })
    }
  }

  return phases
}

// ── Current phase (for active-tow) ────────────────────────────────────

export function currentPhase(points, zoneConfig) {
  const phases = detectPhases(points, zoneConfig)
  if (phases.length === 0) return null
  const last = phases[phases.length - 1]
  const lastPt = points[points.length - 1]

  // Compute current climb rate from last few points
  let climbRate = null
  if (points.length >= 3) {
    const recent = points.slice(-5)
    const first = recent[0]
    const end = recent[recent.length - 1]
    const dtMin = ((end[3] || 0) - (first[3] || 0)) / 60000
    if (dtMin > 0 && first[2] != null && end[2] != null) {
      climbRate = Math.round((end[2] - first[2]) / dtMin)
    }
  }

  return {
    phase: last.type,
    current_alt_ft: lastPt[2] || null,
    climb_rate_fpm: climbRate,
    lat: lastPt[0],
    lon: lastPt[1],
    last_seen_ms: lastPt[3] || null,
  }
}

// ── Tow cycle extraction ──────────────────────────────────────────────
//
// A tow cycle = one takeoff → climb → release → descend → land sequence.
// Returns an array of flight records with timing and performance stats.

// Deterministic flight ID from icao + takeoff timestamp
function makeFlightId(icao, tsMs) {
  return `${icao}-${tsMs || Date.now()}`
}

export function extractTowCycles(icao, tail, points, zoneConfig) {
  const phases = detectPhases(points, zoneConfig)
  if (phases.length < 2) return []

  const flights = []
  let cycleStart = null
  let climbPhase = null
  let descentPhase = null

  for (const phase of phases) {
    if (phase.type === 'on_ground' || phase.type === 'taxiing') {
      // If we have a complete cycle, emit it
      if (cycleStart != null && climbPhase) {
        const releaseAlt = climbPhase.alt_end
        const fieldElev = zoneConfig.field_elevation_ft || 5288

        // Climb rate: AGL gained / time in climb phase
        const climbDtMin = ((climbPhase.end_ts || 0) - (climbPhase.start_ts || 0)) / 60000
        const climbFpm = climbDtMin > 0
          ? Math.round((climbPhase.alt_end - climbPhase.alt_start) / climbDtMin)
          : null

        // Total cycle time: from first ground movement to return to ground
        const landTs = descentPhase ? descentPhase.end_ts : climbPhase.end_ts
        const cycleMin = cycleStart && landTs
          ? +((landTs - cycleStart) / 60000).toFixed(1)
          : null

        flights.push({
          id: makeFlightId(icao, cycleStart),
          icao,
          tail,
          date: cycleStart ? new Date(cycleStart).toISOString().slice(0, 10) : null,
          takeoff_ts: cycleStart ? new Date(cycleStart).toISOString() : null,
          release_ts: climbPhase.end_ts ? new Date(climbPhase.end_ts).toISOString() : null,
          landing_ts: landTs ? new Date(landTs).toISOString() : null,
          release_alt_ft: releaseAlt ? Math.round(releaseAlt - fieldElev) : null,
          climb_rate_fpm: climbFpm,
          cycle_time_min: cycleMin,
          phases: [climbPhase, descentPhase].filter(Boolean).map(p => ({
            type: p.type,
            start_ts: p.start_ts ? new Date(p.start_ts).toISOString() : null,
            end_ts: p.end_ts ? new Date(p.end_ts).toISOString() : null,
            alt_start: p.alt_start,
            alt_end: p.alt_end,
          })),
          // Store point indices for track retrieval
          _startIdx: cycleStart ? phases.find(p => p.start_ts === cycleStart)?.start_idx || 0 : 0,
          _endIdx: phase.start_idx,
        })
      }
      // Reset for next cycle — capture the end of this ground segment as
      // potential takeoff time
      cycleStart = phase.end_ts
      climbPhase = null
      descentPhase = null
    } else if (phase.type === 'climbing_on_tow') {
      if (!climbPhase) cycleStart = cycleStart || phase.start_ts
      climbPhase = phase
    } else if (phase.type === 'descending') {
      descentPhase = phase
    }
  }

  // Handle in-progress cycle (airborne, hasn't landed yet)
  if (climbPhase && !flights.length || (climbPhase && !descentPhase)) {
    const releaseAlt = climbPhase.alt_end
    const fieldElev = zoneConfig.field_elevation_ft || 5288
    const climbDtMin = ((climbPhase.end_ts || 0) - (climbPhase.start_ts || 0)) / 60000
    flights.push({
      id: makeFlightId(icao, cycleStart),
      icao,
      tail,
      date: cycleStart ? new Date(cycleStart).toISOString().slice(0, 10) : null,
      takeoff_ts: cycleStart ? new Date(cycleStart).toISOString() : null,
      release_ts: climbPhase.end_ts ? new Date(climbPhase.end_ts).toISOString() : null,
      landing_ts: null, // still airborne
      release_alt_ft: releaseAlt ? Math.round(releaseAlt - fieldElev) : null,
      climb_rate_fpm: climbDtMin > 0
        ? Math.round((climbPhase.alt_end - climbPhase.alt_start) / climbDtMin)
        : null,
      cycle_time_min: null,
      phases: [climbPhase, descentPhase].filter(Boolean).map(p => ({
        type: p.type,
        start_ts: p.start_ts ? new Date(p.start_ts).toISOString() : null,
        end_ts: p.end_ts ? new Date(p.end_ts).toISOString() : null,
        alt_start: p.alt_start,
        alt_end: p.alt_end,
      })),
      _startIdx: 0,
      _endIdx: points.length - 1,
    })
  }

  return flights
}

// ── ETA prediction ────────────────────────────────────────────────────

export function predictEta(phase, currentAlt, climbRate, zoneConfig) {
  const fieldElev = zoneConfig.field_elevation_ft || 5288
  const agl = currentAlt - fieldElev

  if (phase === 'climbing_on_tow' && climbRate > 0) {
    // Estimate time to typical release altitude (2000 AGL default)
    const typicalRelease = 2000
    const remaining = typicalRelease - agl
    if (remaining <= 0) return { est_release_s: 0, est_available_s: 120 }
    const climbSec = (remaining / climbRate) * 60
    // Descent typically takes ~2 min from pattern altitude
    const descentSec = 120
    return {
      est_release_s: Math.round(climbSec),
      est_available_s: Math.round(climbSec + descentSec + 60), // +60s taxi
    }
  }

  if (phase === 'descending') {
    const descentRemaining = agl
    // Assume ~800 fpm descent
    const descentSec = descentRemaining > 0 ? (descentRemaining / 800) * 60 : 0
    return {
      est_release_s: null,
      est_available_s: Math.round(descentSec + 60),
    }
  }

  return { est_release_s: null, est_available_s: null }
}

// ── Tow ↔ glider pairing ──────────────────────────────────────────────
//
// When a glider has ADS-B, we can pair it with its tow plane by checking
// for two aircraft climbing together from the same point: within 0.1 nm
// laterally and 300 ft vertically at the same moment.  The tow plane is
// identified from the fleet config (role === 'tow'); everything else
// climbing nearby is a candidate glider.
//
// Returns a Map<towHex, { glider_hex, glider_tail }> for currently-
// paired tow planes.

const PAIR_LATERAL_NM = 0.1
const PAIR_VERTICAL_FT = 300
const PAIR_STALE_MS = 30_000 // ignore points older than 30s

export function pairTowWithGliders(liveTracks, fleet, zoneConfig) {
  const pairs = new Map()
  const fieldElev = zoneConfig.field_elevation_ft || 5288
  const groundCeil = fieldElev + (zoneConfig.on_ground_alt_agl_ft || 150)
  const now = Date.now()

  // Build snapshot of latest position for each aircraft
  const snapshots = []
  for (const t of liveTracks) {
    if (!t.points?.length) continue
    const last = t.points[t.points.length - 1]
    const ts = last[3] || 0
    if (now - ts > PAIR_STALE_MS) continue
    const alt = last[2]
    if (alt == null || alt <= groundCeil) continue // skip ground
    snapshots.push({
      hex: (t.hex || '').toLowerCase(),
      tail: t.call || t.hex,
      lat: last[0],
      lon: last[1],
      alt,
      ts,
      isTow: !!fleet[(t.hex || '').toLowerCase()]?.role && fleet[(t.hex || '').toLowerCase()].role === 'tow',
    })
  }

  const tows = snapshots.filter(s => s.isTow)
  const others = snapshots.filter(s => !s.isTow)

  for (const tow of tows) {
    let bestDist = Infinity
    let bestGlider = null

    for (const other of others) {
      const lateralNm = distNm(tow.lat, tow.lon, other.lat, other.lon)
      if (lateralNm > PAIR_LATERAL_NM) continue
      const vertFt = Math.abs(tow.alt - other.alt)
      if (vertFt > PAIR_VERTICAL_FT) continue
      // Prefer closest lateral match
      if (lateralNm < bestDist) {
        bestDist = lateralNm
        bestGlider = other
      }
    }

    if (bestGlider) {
      pairs.set(tow.hex, {
        glider_hex: bestGlider.hex,
        glider_tail: bestGlider.tail,
      })
    }
  }

  return pairs
}

// ── Stats aggregation ─────────────────────────────────────────────────

export function aggregateStats(flights, groupBy) {
  const groups = new Map()

  for (const f of flights) {
    if (f.cycle_time_min == null) continue // skip incomplete

    let key
    if (groupBy === 'hour') {
      key = f.takeoff_ts ? new Date(f.takeoff_ts).getUTCHours().toString().padStart(2, '0') + ':00' : 'unknown'
    } else if (groupBy === 'glider') {
      key = f.paired_glider_tail || 'unknown'
    } else if (groupBy === 'da_band') {
      // DA bands: <6000, 6000-7000, 7000-8000, 8000-9000, 9000+
      const da = f.da_ft || 0
      if (da < 6000) key = '<6000'
      else if (da < 7000) key = '6000-7000'
      else if (da < 8000) key = '7000-8000'
      else if (da < 9000) key = '8000-9000'
      else key = '9000+'
    } else {
      key = 'all'
    }

    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(f)
  }

  const result = []
  for (const [key, fls] of groups) {
    const cycles = fls.map(f => f.cycle_time_min).filter(Boolean).sort((a, b) => a - b)
    const climbs = fls.map(f => f.climb_rate_fpm).filter(Boolean)

    const pct = (arr, p) => arr.length === 0 ? null : arr[Math.min(Math.floor(arr.length * p), arr.length - 1)]
    const avg = (arr) => arr.length === 0 ? null : +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1)

    result.push({
      key,
      count: fls.length,
      avg_cycle_min: avg(cycles),
      avg_climb_fpm: avg(climbs) ? Math.round(avg(climbs)) : null,
      p10_cycle: pct(cycles, 0.1),
      p50_cycle: pct(cycles, 0.5),
      p90_cycle: pct(cycles, 0.9),
    })
  }

  return result
}
