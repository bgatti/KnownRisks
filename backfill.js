#!/usr/bin/env node
// backfill.js — Pre-compute noise violation stats for all tracks in Postgres.
// Reads each track's points, classifies against noise zones + altitude,
// computes segment counts/lengths, determines base airport and origin,
// generates pre-banded runs for map rendering, and stores everything
// as columns on the tracks table.
//
// Run: node backfill.js
// Env: DATABASE_URL or DATABASE_PUBLIC_URL must be set.
//
// Safe to re-run — updates existing rows via UPDATE.

import pg from 'pg'
import { classifyPoint, distFt } from './src/geo.js'
import { NOISE_ZONES } from './src/noiseZones.js'
import { nearestAirport, nmFrom, KBDU, LOCAL_RADIUS_NM } from './src/airports.js'

const VIOLATION_RADIUS_NM = 6
const MAP_RADIUS_NM = 6
const SEVERITY = { yellow: 1, orange: 2, red: 3, purple: 4 }

// Airport elevations for AGL calculation (MSL ft)
const AIRPORT_ELEVATIONS = {
  KBDU: 5288, KBJC: 5673, KEIK: 5130, KLMO: 5055,
  KAPA: 5885, KGXY: 4697, KFNL: 5016, KBKF: 5663, KFTG: 5512,
}
const TZ_OFFSET_S = -7 * 3600 // MST

// Detect touch-and-go during quiet hours (5 PM – 5 AM MST).
// Returns array of {startIdx, endIdx} ranges to mark as 'purple'.
function detectQuietHourTnG(points, t0, fieldElev) {
  if (!points || points.length < 10 || t0 == null) return []
  const LOW_AGL = 250, HIGH_AGL = 800, MAX_TNG_SEC = 90
  const lowThresh = fieldElev + LOW_AGL
  const highThresh = fieldElev + HIGH_AGL
  const results = []
  let inLow = false, lowStart = -1
  for (let i = 0; i < points.length; i++) {
    const alt = points[i][2]
    if (alt < lowThresh && !inLow) { inLow = true; lowStart = i }
    else if (alt > highThresh && inLow) {
      let bottomIdx = lowStart
      for (let j = lowStart; j < i; j++) {
        if (points[j][2] < points[bottomIdx][2]) bottomIdx = j
      }
      let ascStart = -1
      for (let j = bottomIdx; j < Math.min(i + 5, points.length - 3); j++) {
        if (points[j+1]?.[2] > points[j][2] && points[j+2]?.[2] > points[j+1][2]) {
          ascStart = j; break
        }
      }
      if (ascStart >= 0) {
        const hasTs = points[bottomIdx].length > 3 && points[ascStart].length > 3
        const gapSec = hasTs ? points[ascStart][3] - points[bottomIdx][3] : null
        const gapOk = gapSec != null ? gapSec <= MAX_TNG_SEC : (ascStart - bottomIdx) <= 30
        if (gapOk) {
          const bottomTs = points[bottomIdx].length > 3 ? points[bottomIdx][3] : null
          if (bottomTs != null) {
            const localS = (t0 + bottomTs + TZ_OFFSET_S)
            const hour = Math.floor((((localS % 86400) + 86400) % 86400) / 3600)
            if (hour >= 17 || hour < 5) {
              results.push({ startIdx: lowStart, endIdx: i })
            }
          }
        }
      }
      inLow = false
    }
  }
  return results
}

const connStr = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL
if (!connStr) { console.error('Set DATABASE_URL'); process.exit(1) }

const pool = new pg.Pool({
  connectionString: connStr,
  ssl: { rejectUnauthorized: false },
})

// --- Migration: add columns if they don't exist ---
async function migrate() {
  const cols = [
    ['year', 'TEXT'],
    ['date', 'TEXT'],
    ['base_airport', 'TEXT'],
    ['origin', 'TEXT'],           // 'local' or 'transient'
    ['worst_class', 'TEXT'],      // 'red','orange','yellow', or NULL
    ['seg_total', 'INT DEFAULT 0'],
    ['seg_red', 'INT DEFAULT 0'],
    ['seg_orange', 'INT DEFAULT 0'],
    ['seg_yellow', 'INT DEFAULT 0'],
    ['len_total_ft', 'REAL DEFAULT 0'],
    ['len_red_ft', 'REAL DEFAULT 0'],
    ['len_orange_ft', 'REAL DEFAULT 0'],
    ['len_yellow_ft', 'REAL DEFAULT 0'],
    ['seg_purple', 'INT DEFAULT 0'],
    ['len_purple_ft', 'REAL DEFAULT 0'],
    ['in_ring', 'BOOLEAN DEFAULT false'],
    ['school', 'TEXT'],
    ['bands', 'JSONB'],
  ]
  for (const [name, type] of cols) {
    await pool.query(`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS ${name} ${type}`).catch(() => {})
  }
  // Indexes for the query patterns we need
  await pool.query('CREATE INDEX IF NOT EXISTS idx_tracks_year ON tracks(year)').catch(() => {})
  await pool.query('CREATE INDEX IF NOT EXISTS idx_tracks_worst ON tracks(worst_class)').catch(() => {})
  await pool.query('CREATE INDEX IF NOT EXISTS idx_tracks_base ON tracks(base_airport)').catch(() => {})
  await pool.query('CREATE INDEX IF NOT EXISTS idx_tracks_school ON tracks(school)').catch(() => {})
  await pool.query('CREATE INDEX IF NOT EXISTS idx_tracks_origin ON tracks(origin)').catch(() => {})
  console.log('[backfill] migration done')
}

// --- Load school→tail mapping ---
async function loadSchoolMap() {
  const map = new Map() // tail → school name
  try {
    const res = await pool.query('SELECT data FROM flight_schools ORDER BY id DESC LIMIT 1')
    if (res.rows.length) {
      const schools = res.rows[0].data.schools || []
      for (const s of schools) {
        for (const ac of s.aircraft || []) {
          if (ac.tail) map.set(ac.tail, s.name)
        }
      }
    }
  } catch {}
  console.log(`[backfill] loaded ${map.size} tail→school mappings`)
  return map
}

// --- Classify one track ---
function classifyTrack(points, call, src, schoolMap) {
  // Extract date/year from src (e.g. "globe/2023-08-15/hex")
  const m = (src || '').match(/(\d{4})-(\d{2})-(\d{2})/)
  const year = m ? m[1] : null
  const date = m ? `${m[1]}-${m[2]}-${m[3]}` : null

  // All points for band rendering; low points for classification
  const allPts = points || []
  const pts = allPts.filter(p => p[2] < 7500)

  if (allPts.length < 2) {
    return {
      year, date,
      base_airport: null, origin: null, worst_class: null,
      seg_total: 0, seg_red: 0, seg_orange: 0, seg_yellow: 0,
      len_total_ft: 0, len_red_ft: 0, len_orange_ft: 0, len_yellow_ft: 0,
      in_ring: false, school: schoolMap.get(call) || null,
      bands: [],
    }
  }

  // Use all points for base/origin determination
  const first = allPts[0]
  const last = allPts[allPts.length - 1]
  const firstBase = nearestAirport(first[0], first[1], 3)
  const lastBase = nearestAirport(last[0], last[1], 3)
  const base_airport = firstBase || lastBase
  const isLocal = nmFrom(first[0], first[1], KBDU[0], KBDU[1]) <= LOCAL_RADIUS_NM
  const origin = isLocal ? 'local' : 'transient'

  // Total track length from ALL points (full flight)
  let len_total_ft = 0
  for (let i = 1; i < allPts.length; i++) {
    len_total_ft += distFt(allPts[i-1][0], allPts[i-1][1], allPts[i][0], allPts[i][1])
  }

  // Classify low points against noise zones for infraction stats
  let seg_total = 0, seg_red = 0, seg_orange = 0, seg_yellow = 0
  let len_red_ft = 0, len_orange_ft = 0, len_yellow_ft = 0
  let worst_class = null

  if (pts.length >= 2) {
    const tags = pts.map(p => classifyPoint(p[0], p[1], p[2], NOISE_ZONES))
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i]
      const seg = distFt(a[0], a[1], b[0], b[1])
      seg_total++
      const ta = tags[i-1], tb = tags[i]
      const worst = (SEVERITY[ta]||0) >= (SEVERITY[tb]||0) ? ta : tb
      if (worst === 'red') { seg_red++; len_red_ft += seg }
      else if (worst === 'orange') { seg_orange++; len_orange_ft += seg }
      else if (worst === 'yellow') { seg_yellow++; len_yellow_ft += seg }
      if (worst && (!worst_class || SEVERITY[worst] > SEVERITY[worst_class])) {
        worst_class = worst
      }
    }
  }

  // Check if track passes through map ring
  let in_ring = false
  let ringCount = 0
  for (const p of points || []) {
    if (nmFrom(p[0], p[1], KBDU[0], KBDU[1]) <= MAP_RADIUS_NM) {
      ringCount++
      if (ringCount >= 2) { in_ring = true; break }
    }
  }

  // Detect quiet-hour T&G (purple excursions) — KBDU only.
  // Only KBDU has the voluntary quiet-hour noise abatement procedure.
  const t0 = m ? Math.floor(Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`) / 1000) : null
  const isKbdu = base_airport === 'KBDU' || nearestAirport(allPts[0][0], allPts[0][1], 3) === 'KBDU'
  const tngRanges = isKbdu
    ? detectQuietHourTnG(allPts, t0, AIRPORT_ELEVATIONS.KBDU)
    : []

  // Build a set of point indices that are in purple T&G ranges
  const purpleIdx = new Set()
  for (const r of tngRanges) {
    for (let i = r.startIdx; i <= r.endIdx && i < allPts.length; i++) purpleIdx.add(i)
  }

  // Compute purple segment stats
  let seg_purple = 0, len_purple_ft = 0
  for (let i = 1; i < allPts.length; i++) {
    if (purpleIdx.has(i) || purpleIdx.has(i - 1)) {
      seg_purple++
      len_purple_ft += distFt(allPts[i-1][0], allPts[i-1][1], allPts[i][0], allPts[i][1])
    }
  }

  // Update worst_class if purple is present
  if (seg_purple > 0 && (!worst_class || SEVERITY.purple > SEVERITY[worst_class])) {
    worst_class = 'purple'
  }

  // Build banded runs for map rendering (using ALL points, not just <7500)
  // Purple T&G ranges override the zone classification
  const ringPts = points || []
  const bands = []
  if (ringPts.length >= 2) {
    let cur = null
    for (let i = 0; i < ringPts.length; i++) {
      const p = ringPts[i]
      const klass = purpleIdx.has(i) ? 'purple' : classifyPoint(p[0], p[1], p[2], NOISE_ZONES)
      if (cur && cur.k === klass) {
        cur.p.push([p[0], p[1], p[2]])
      } else {
        if (cur) {
          cur.p.push([p[0], p[1], p[2]])
          bands.push(cur)
        }
        cur = { k: klass, p: [[p[0], p[1], p[2]]] }
      }
    }
    if (cur) bands.push(cur)
  }

  return {
    year, date, base_airport, origin, worst_class,
    seg_total, seg_red, seg_orange, seg_yellow, seg_purple,
    len_total_ft, len_red_ft, len_orange_ft, len_yellow_ft, len_purple_ft,
    in_ring,
    school: schoolMap.get(call) || null,
    bands: bands.map(b => ({ klass: b.k, points: b.p })),
  }
}

// --- Main ---
// Only processes tracks where year IS NULL (not yet backfilled).
// Uses transactions per batch. Safe to re-run — picks up where it left off.
async function main() {
  await migrate()
  const schoolMap = await loadSchoolMap()

  const BATCH = 100
  let processed = 0

  // Loop until no un-backfilled tracks remain
  while (true) {
    const res = await pool.query(
      'SELECT id, call, src, points FROM tracks WHERE year IS NULL ORDER BY id LIMIT $1',
      [BATCH]
    )
    if (res.rows.length === 0) break

    // Classify all tracks in this batch in JS
    const updates = res.rows.map(row => ({
      id: row.id,
      stats: classifyTrack(row.points, row.call, row.src, schoolMap),
    }))

    // Write the whole batch in a single transaction
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const { id, stats } of updates) {
        await client.query(`
          UPDATE tracks SET
            year=$2, date=$3, base_airport=$4, origin=$5, worst_class=$6,
            seg_total=$7, seg_red=$8, seg_orange=$9, seg_yellow=$10, seg_purple=$11,
            len_total_ft=$12, len_red_ft=$13, len_orange_ft=$14, len_yellow_ft=$15, len_purple_ft=$16,
            in_ring=$17, school=$18, bands=$19
          WHERE id=$1
        `, [
          id, stats.year, stats.date, stats.base_airport, stats.origin, stats.worst_class,
          stats.seg_total, stats.seg_red, stats.seg_orange, stats.seg_yellow, stats.seg_purple,
          stats.len_total_ft, stats.len_red_ft, stats.len_orange_ft, stats.len_yellow_ft, stats.len_purple_ft,
          stats.in_ring, stats.school, JSON.stringify(stats.bands),
        ])
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      console.error(`[backfill] batch error at ${processed}, retrying...`, e.message)
      client.release()
      continue // retry same batch
    }
    client.release()

    processed += res.rows.length
    if (processed % 2000 < BATCH) {
      const remaining = await pool.query('SELECT count(*)::int AS n FROM tracks WHERE year IS NULL')
      console.log(`[backfill] ${processed} done, ${remaining.rows[0].n} remaining`)
    }
  }

  // Final stats
  const statsRes = await pool.query(`
    SELECT
      count(*) as total,
      count(*) FILTER (WHERE worst_class IS NOT NULL) as with_violations,
      count(*) FILTER (WHERE in_ring) as in_ring,
      count(DISTINCT year) as years,
      pg_size_pretty(pg_database_size(current_database())) as db_size
    FROM tracks
  `)
  const s = statsRes.rows[0]
  console.log(`[backfill] COMPLETE! ${s.total} tracks, ${s.with_violations} with violations, ${s.in_ring} in ring, ${s.years} years, DB=${s.db_size}`)

  await pool.end()
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
