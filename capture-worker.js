#!/usr/bin/env node
// Standalone ADS-B live capture worker.
// Polls adsb.lol / airplanes.live every POLL_MS, accumulates tracks in memory,
// and flushes to Postgres (TABLE live_tracks) so the web service can read them.
// Runs as its own Railway service — independent of the Vite web server.

import pg from 'pg'
import { classifyPoint, distFt } from './src/geo.js'
import { NOISE_ZONES } from './src/noiseZones.js'

// Ask #19 — was [KBDU, 15 nm], which clipped every track that
// crossed beyond 15 nm of KBDU before it reached live_tracks. Now
// centred on the geographic centroid of the 6 Front Range fields
// with a 25 nm radius — operator pizza-math 2026-06-03: 25 nm
// reaches all 6 fields (KBDU + KBJC + KLMO + KEIK + KAPA + KGXY)
// with modest headroom for nearby practice areas, while cutting
// ADS-B fetch volume vs. the 36 nm trial. Trim again if cost data
// suggests further reduction.
const CENTER = [40.0211, -105.0063]
const RADIUS_NM = 25
const POLL_MS = 5_000
const ALT_MAX_FT = 11_000
const SEVERITY = { yellow: 1, orange: 2, red: 3, purple: 4 }

// Field elevations (MSL ft) for the airports we cover. Used to coerce
// `alt_baro: "ground"` to a sensible MSL altitude — 0 MSL is physically
// impossible at Front Range elevations and breaks every downstream AGL
// calculation. Mirrors ENRICH_AP in vite.config.js.
const GROUND_APTS = [
  { code: 'KBDU', lat: 40.0394, lon: -105.2258, elev: 5288 },
  { code: 'KBJC', lat: 39.9088, lon: -105.1172, elev: 5673 },
  { code: 'KEIK', lat: 40.0098, lon: -105.0488, elev: 5130 },
  { code: 'KLMO', lat: 40.1636, lon: -105.1636, elev: 5055 },
  { code: 'KAPA', lat: 39.5701, lon: -104.8493, elev: 5885 },
  { code: 'KGXY', lat: 40.4348, lon: -104.6331, elev: 4697 },
  { code: 'KFNL', lat: 40.4518, lon: -105.0166, elev: 5016 },
  { code: 'KDEN', lat: 39.8617, lon: -104.6731, elev: 5434 },
]
const GROUND_MATCH_NM = 3
function groundElevAt(lat, lon) {
  let bestD = Infinity, bestElev = null
  for (const ap of GROUND_APTS) {
    const dLat = (lat - ap.lat) * 60
    const dLon = (lon - ap.lon) * 60 * Math.cos((lat + ap.lat) / 2 * Math.PI / 180)
    const d = Math.hypot(dLat, dLon)
    if (d < bestD) { bestD = d; bestElev = ap.elev }
  }
  return bestD <= GROUND_MATCH_NM ? bestElev : null
}

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
  { name: 'airplanes.live', url: (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}` },
  { name: 'adsb.lol',       url: (lat, lon, nm) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
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

    // Fetch all feeds in parallel; union aircraft by hex, preferring the entry
    // with the freshest position (lowest seen_pos). The existing point-dedup
    // (last lat/lon) keeps the merged track from double-counting.
    const settled = await Promise.allSettled(
      FEEDS.map((f) => fetch(f.url(CENTER[0], CENTER[1], RADIUS_NM))
        .then((r) => (r.ok ? r.json() : null)))
    )
    const byHexThisPoll = new Map()
    let feedsOK = 0
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i]
      if (s.status !== 'fulfilled' || !s.value || !Array.isArray(s.value.ac)) {
        const err = s.status === 'rejected' ? (s.reason?.message || s.reason) : 'no ac array'
        console.warn(`[capture-worker] ${FEEDS[i].name} skipped: ${err}`)
        continue
      }
      feedsOK++
      for (const ac of s.value.ac) {
        if (!ac.hex) continue
        const prev = byHexThisPoll.get(ac.hex)
        const newSeen = typeof ac.seen_pos === 'number' ? ac.seen_pos : Infinity
        const prevSeen = prev && typeof prev.seen_pos === 'number' ? prev.seen_pos : Infinity
        if (!prev || newSeen < prevSeen) byHexThisPoll.set(ac.hex, ac)
      }
    }
    if (!feedsOK) return

    // Per-poll diagnostic counters. Surfacing these in logs so we can see
    // why effective append rates are well below the 12/min poll ceiling.
    let appended = 0
    const skip = { no_pos: 0, alt_str: 0, ground_far: 0, alt_oob: 0, no_hex: 0, dedup_xy: 0 }
    const seenBuckets = { lt2: 0, lt5: 0, lt15: 0, lt60: 0, ge60: 0, missing: 0 }

    for (const ac of byHexThisPoll.values()) {
      const sp = typeof ac.seen_pos === 'number' ? ac.seen_pos : null
      if (sp == null) seenBuckets.missing++
      else if (sp < 2) seenBuckets.lt2++
      else if (sp < 5) seenBuckets.lt5++
      else if (sp < 15) seenBuckets.lt15++
      else if (sp < 60) seenBuckets.lt60++
      else seenBuckets.ge60++

      if (ac.lat == null || ac.lon == null) { skip.no_pos++; continue }
      // Coerce "ground" → nearest-airport field elevation (MSL) so taxi / ramp
      // points enter the pipeline at a physically plausible altitude. Front
      // Range fields sit at ~4700–5900 ft MSL; storing 0 here would break
      // every downstream AGL calc. Aircraft tagged "ground" but >3 nm from
      // any known airport are skipped — we can't safely guess local terrain.
      let alt
      if (typeof ac.alt_baro === 'number') alt = ac.alt_baro
      else if (ac.alt_baro === 'ground') {
        alt = groundElevAt(ac.lat, ac.lon)
        if (alt == null) { skip.ground_far++; continue }
      } else { skip.alt_str++; continue }
      if (alt < 0 || alt >= ALT_MAX_FT) { skip.alt_oob++; continue }
      const hex = ac.hex
      if (!hex) { skip.no_hex++; continue }
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
      const same = last && last[0] === ac.lat && last[1] === ac.lon
      // Suspend lat/lon dedup with CAPTURE_NODEDUP=1 to see raw poll rates.
      // With dedup on (default), a parked aircraft with a stable position
      // doesn't get re-appended even though the feed re-reports it.
      if (same && !process.env.CAPTURE_NODEDUP) { skip.dedup_xy++; continue }
      t.points.push([ac.lat, ac.lon, alt, Date.now()])
      appended++
    }

    console.log(`[poll] merged=${byHexThisPoll.size} appended=${appended} skip=${JSON.stringify(skip)} seen_pos=${JSON.stringify(seenBuckets)}`)

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
