#!/usr/bin/env node
// Standalone ADS-B live capture worker.
// Polls adsb.lol / airplanes.live every POLL_MS, accumulates tracks in memory,
// and flushes to Postgres (TABLE live_tracks) so the web service can read them.
// Runs as its own Railway service — independent of the Vite web server.

import pg from 'pg'
import { classifyPoint, distFt } from './src/geo.js'
import { NOISE_ZONES } from './src/noiseZones.js'

const CENTER = [40.0394, -105.2258]
const RADIUS_NM = 15
const POLL_MS = 5_000
const ALT_MAX_FT = 10_000
const SEVERITY = { yellow: 1, orange: 2, red: 3, purple: 4 }

// Build bands + stats from a track's points
function classifyTrackLive(points) {
  const bands = []
  let cur = null
  let worst = null
  let seg_total = 0, seg_red = 0, seg_orange = 0, seg_yellow = 0
  let len_total_ft = 0, len_red_ft = 0, len_orange_ft = 0, len_yellow_ft = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const klass = classifyPoint(p[0], p[1], p[2], NOISE_ZONES)
    if (klass && (!worst || SEVERITY[klass] > SEVERITY[worst])) worst = klass
    // Bands — preserve the epoch-ms timestamp (p[3]) when present so
    // downstream consumers can trim points to a time window.
    const pt = p.length > 3 ? [p[0], p[1], p[2], p[3]] : [p[0], p[1], p[2]]
    if (cur && cur.klass === klass) {
      cur.points.push(pt)
    } else {
      if (cur) { cur.points.push(pt); bands.push(cur) }
      cur = { klass, points: [pt] }
    }
    // Segment stats
    if (i > 0) {
      const a = points[i - 1]
      const seg = distFt(a[0], a[1], p[0], p[1])
      len_total_ft += seg
      seg_total++
      // Use worst of adjacent point classes for segment
      const prevK = classifyPoint(a[0], a[1], a[2], NOISE_ZONES)
      const segK = (SEVERITY[klass] || 0) >= (SEVERITY[prevK] || 0) ? klass : prevK
      if (segK === 'red') { seg_red++; len_red_ft += seg }
      else if (segK === 'orange') { seg_orange++; len_orange_ft += seg }
      else if (segK === 'yellow') { seg_yellow++; len_yellow_ft += seg }
    }
  }
  if (cur) bands.push(cur)
  return { bands, worst, seg_total, seg_red, seg_orange, seg_yellow, len_total_ft, len_red_ft, len_orange_ft, len_yellow_ft }
}

const FEEDS = [
  (lat, lon, nm) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
  (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}`,
]

const todayUTC = () => new Date().toISOString().slice(0, 10)
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, '')

// In-memory state, flushed to DB periodically
let state = { day: todayUTC(), startedAt: nowIso(), byHex: new Map() }
let pollInFlight = false

const connStr = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL
console.log('[capture-worker] DB URL:', connStr?.replace(/:[^:@]+@/, ':***@'))
const pool = new pg.Pool({
  connectionString: connStr,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
})
pool.on('error', (err) => console.error('[capture-worker] pool error', err.message))

async function initDb() {
  console.log('[capture-worker] connecting to DB...', connStr?.replace(/:[^:@]+@/, ':***@'))
  await pool.query(`
    CREATE TABLE IF NOT EXISTS live_tracks (
      id SERIAL PRIMARY KEY,
      day DATE NOT NULL,
      started_at TEXT,
      updated_at TEXT,
      center JSONB,
      radius_nm INT,
      alt_max_ft INT,
      tracks JSONB NOT NULL
    )
  `)
  // Index for fast lookups by day
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_live_tracks_day ON live_tracks (day)
  `)
  console.log('[capture-worker] DB initialized')

  // Load today's data if it exists
  const res = await pool.query(
    'SELECT tracks, started_at FROM live_tracks WHERE day = $1 ORDER BY id DESC LIMIT 1',
    [todayUTC()]
  )
  if (res.rows.length > 0) {
    const row = res.rows[0]
    const byHex = new Map()
    for (const t of row.tracks || []) {
      const hex = t.hex || t.call
      if (!hex) continue
      byHex.set(hex, {
        hex,
        call: t.call || hex,
        type: t.type || '',
        reg: t.reg || '',
        points: Array.isArray(t.points) ? t.points : [],
      })
    }
    state = { day: todayUTC(), startedAt: row.started_at || nowIso(), byHex }
    console.log(`[capture-worker] resumed ${state.byHex.size} tracks for ${state.day}`)
  }
}

function serializeTracks(byHex) {
  return Array.from(byHex.values()).map((t) => {
    const cls = classifyTrackLive(t.points)
    return {
      hex: t.hex, call: t.call, type: t.type, reg: t.reg, src: 'live',
      points: t.points,
      bands: cls.bands.map(b => ({ klass: b.klass, points: b.points })),
      worst: cls.worst,
      seg_total: cls.seg_total, seg_red: cls.seg_red,
      seg_orange: cls.seg_orange, seg_yellow: cls.seg_yellow,
      len_total_ft: cls.len_total_ft, len_red_ft: cls.len_red_ft,
      len_orange_ft: cls.len_orange_ft, len_yellow_ft: cls.len_yellow_ft,
    }
  })
}

async function flush() {
  const tracks = serializeTracks(state.byHex)
  const now = nowIso()

  await pool.query(`
    INSERT INTO live_tracks (day, started_at, updated_at, center, radius_nm, alt_max_ft, tracks)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO NOTHING
  `, [state.day, state.startedAt, now, JSON.stringify(CENTER), RADIUS_NM, ALT_MAX_FT, JSON.stringify(tracks)])

  // Upsert: delete old rows for today, keep only the latest
  await pool.query('DELETE FROM live_tracks WHERE day = $1 AND id < (SELECT MAX(id) FROM live_tracks WHERE day = $1)', [state.day])
}

async function rotateIfNeeded() {
  const today = todayUTC()
  if (state.day === today) return

  // Archive previous day
  console.log(`[capture-worker] rotating ${state.day} → ${today}`)
  await flush() // final flush of old day
  state = { day: today, startedAt: nowIso(), byHex: new Map() }
}

async function poll() {
  if (pollInFlight) return
  pollInFlight = true
  try {
    await rotateIfNeeded()

    let d = null
    for (const make of FEEDS) {
      try {
        const r = await fetch(make(CENTER[0], CENTER[1], RADIUS_NM))
        if (!r.ok) continue
        const j = await r.json()
        if (j && Array.isArray(j.ac)) { d = j; break }
      } catch {}
    }
    if (!d) return

    for (const ac of d.ac) {
      if (ac.lat == null || ac.lon == null) continue
      const alt = typeof ac.alt_baro === 'number' ? ac.alt_baro : null
      if (alt == null || alt <= 0 || alt >= ALT_MAX_FT) continue
      const hex = ac.hex
      if (!hex) continue
      const reg = ((ac.r || '') + '').trim()
      const call = reg || ((ac.flight || '') + '').trim() || hex
      let t = state.byHex.get(hex)
      if (!t) {
        t = { hex, call, type: ((ac.t || '') + '').trim(), reg, points: [] }
        state.byHex.set(hex, t)
      } else if (reg && !t.reg) {
        t.reg = reg
        t.call = reg
      }
      const last = t.points[t.points.length - 1]
      if (!last || last[0] !== ac.lat || last[1] !== ac.lon) {
        t.points.push([ac.lat, ac.lon, alt, Date.now()])
      }
    }

    await flush()
  } catch (e) {
    console.error('[capture-worker] poll error', e)
  } finally {
    pollInFlight = false
  }
}

// --- Main ---
console.log('[capture-worker] starting...')
console.log(`[capture-worker] center=${CENTER}, radius=${RADIUS_NM}nm, poll=${POLL_MS}ms`)
await initDb()
poll()
setInterval(() => poll().catch(e => console.error('[capture-worker] poll error', e)), POLL_MS)

// Keep alive
process.on('SIGTERM', async () => {
  console.log('[capture-worker] SIGTERM, flushing...')
  await flush().catch(() => {})
  process.exit(0)
})
