// db.js — Postgres data layer for the web app.
// When DATABASE_URL is set (Railway), all reads/writes go to Postgres.
// When absent (local dev), callers fall back to their file-based paths.
import pg from 'pg'

const DATABASE_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL
export const useDb = !!DATABASE_URL
console.log(`[db] useDb=${useDb}, DATABASE_URL=${DATABASE_URL ? DATABASE_URL.replace(/:[^:@]+@/, ':***@') : 'not set'}`)

let pool = null
function getPool() {
  if (!pool && DATABASE_URL) {
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      // Connection sizing. Railway's Postgres add-on typically allows
      // 20-25 concurrent connections; staying well under cap leaves room
      // for migrations and any other consumers.
      max: 8,
      // Acquisition timeout. When the pool is full, new requests wait
      // this long for a slot before throwing. Under 30 s = upstream
      // returns a clear error rather than hanging the user.
      connectionTimeoutMillis: 5000,
      // Release idle connections so a burst doesn't permanently
      // colonize the pool. 30 s is long enough that steady traffic
      // keeps the warm set; bursts get cleaned up afterward.
      idleTimeoutMillis: 30000,
      // Hard kill any query that runs longer than 20 s. Without this,
      // an unbounded SELECT can hold a slot forever, starving the pool.
      // 20 s < 30 s Railway HTTP proxy timeout, so client gets a real
      // error rather than a generic gateway timeout.
      query_timeout: 20000,
      statement_timeout: 25000,
    })
    pool.on('error', (err) => console.error('[db] pool error', err.message))
    // Also enforce statement_timeout server-side at session start
    // (belt and suspenders — query_timeout above is client-side).
    pool.on('connect', (client) => {
      client.query('SET statement_timeout = 25000').catch(() => {})
    })
  }
  return pool
}

// ── Tracks (yearly + live) ─────────────────────────────────────────────

// Cache with TTL so we don't hit PG on every request
const cache = new Map()
function cached(key, ttlMs, fn) {
  return async () => {
    const c = cache.get(key)
    if (c && Date.now() - c.ts < ttlMs) return c.data
    const data = await fn()
    cache.set(key, { data, ts: Date.now() })
    return data
  }
}

// Build a by-tail Map index (same shape the file-based code expects)
function indexByTail(tracks) {
  const byTail = new Map()
  for (const t of tracks) {
    const k = (t.call || '').trim()
    if (!k) continue
    let arr = byTail.get(k)
    if (!arr) { arr = []; byTail.set(k, arr) }
    arr.push(t)
  }
  return byTail
}

// Direct query helper for paginated endpoints
export async function queryDb(sql, params) {
  return getPool().query(sql, params)
}

// Bulk historical load — DANGEROUS at full table scope (143k+ rows × JSONB
// points = multi-GB result, OOMs the Node heap). Always pass a date range.
// Default windows to "last 90 days" so any caller that forgets won't kill
// the server. Callers needing wider history must opt in explicitly.
//
// The `key` arg lets the cache discriminate between window sizes so a
// /segments?hours=24 call doesn't wipe out a /excursions?from=2024-01-01
// cache entry.
export async function loadTracksFromDb({ fromDate = null, toDate = null, hardCap = 50000 } = {}) {
  const p = getPool()
  // Default window: last 90 days. Any caller that wants more must say so.
  if (!fromDate) {
    const ms90 = 90 * 24 * 3600 * 1000
    fromDate = new Date(Date.now() - ms90).toISOString().slice(0, 10)
  }
  if (!toDate) toDate = new Date().toISOString().slice(0, 10)
  // Cache key: window + cap. Same window served from cache for 30 s.
  const cacheKey = `tracks:${fromDate}:${toDate}:${hardCap}`
  const cached = trackWindowCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < 30_000) return cached.data
  console.log(`[db] loadTracksFromDb: ${fromDate}..${toDate} (cap ${hardCap})...`)
  const res = await p.query(
    `SELECT call, hex, type, desc_text, own_op, src, points
     FROM tracks
     WHERE date >= $1 AND date <= $2
     ORDER BY date DESC
     LIMIT $3`,
    [fromDate, toDate, hardCap],
  )
  const currentYear = new Date().getFullYear()
  const tracks = res.rows.map(r => {
    const m = (r.src || '').match(/(\d{4})-(\d{2})-(\d{2})/)
    const year = m ? m[1] : null
    const t0 = m ? Math.floor(Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`) / 1000) : null
    return {
      call: r.call, hex: r.hex, type: r.type, desc: r.desc_text,
      ownOp: r.own_op, src: r.src, points: r.points,
      year, t0, years_back: year ? currentYear - parseInt(year) : null,
    }
  })
  const data = { tracks, _byTail: indexByTail(tracks) }
  trackWindowCache.set(cacheKey, { ts: Date.now(), data })
  // Drop oldest cached windows if we have more than 8 (avoid leaking memory
  // when many distinct windows are queried).
  if (trackWindowCache.size > 8) {
    const oldest = [...trackWindowCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
    if (oldest) trackWindowCache.delete(oldest[0])
  }
  console.log(`[db] loadTracksFromDb: loaded ${tracks.length} rows`)
  return data
}
const trackWindowCache = new Map()

export const loadLiveFromDb = cached('live', 5_000, async () => {
  const p = getPool()
  const res = await p.query(
    'SELECT day, started_at, updated_at, tracks FROM live_tracks ORDER BY id DESC LIMIT 1'
  )
  if (res.rows.length === 0) return { tracks: [], _byTail: new Map(), updated_at: null }
  const row = res.rows[0]
  const tracks = row.tracks || []
  return { tracks, _byTail: indexByTail(tracks), updated_at: row.updated_at }
})

// Load live_tracks across a date range (inclusive). Each day has exactly
// one current row in live_tracks (older versions are pruned by the capture
// worker), so we fetch one row per day and concatenate their tracks.
// Returns { tracks, _byTail, updated_at (latest), days_loaded } where
// tracks carry their original per-point timestamps so the caller can
// filter to sub-second precision.
const liveRangeCache = new Map()
const LIVE_RANGE_TTL = 30_000
export async function loadLiveFromDbByDateRange(fromDate, toDate) {
  const key = `${fromDate}..${toDate}`
  const c = liveRangeCache.get(key)
  if (c && Date.now() - c.ts < LIVE_RANGE_TTL) return c.data
  const p = getPool()
  // DISTINCT ON keeps only the most-recent row per day (highest id).
  const res = await p.query(
    `SELECT DISTINCT ON (day) day, started_at, updated_at, tracks
       FROM live_tracks
      WHERE day >= $1 AND day <= $2
      ORDER BY day DESC, id DESC`,
    [fromDate, toDate]
  )
  const all = []
  let latestUpdated = null
  for (const row of res.rows) {
    if (!row.tracks) continue
    for (const t of row.tracks) all.push(t)
    if (!latestUpdated || (row.updated_at && row.updated_at > latestUpdated)) {
      latestUpdated = row.updated_at
    }
  }
  const data = {
    tracks: all,
    _byTail: indexByTail(all),
    updated_at: latestUpdated,
    days_loaded: res.rows.length,
  }
  liveRangeCache.set(key, { ts: Date.now(), data })
  return data
}

// Return the oldest and newest day available in live_tracks, for
// surfacing "data_horizon" so callers can detect when their query
// window pre-dates available history.
export async function getLiveDataHorizon() {
  const p = getPool()
  const res = await p.query('SELECT MIN(day) AS oldest, MAX(day) AS newest FROM live_tracks')
  const r = res.rows[0] || {}
  const fmt = (d) => d ? new Date(d).toISOString().slice(0, 10) : null
  return { oldest_day: fmt(r.oldest), newest_day: fmt(r.newest) }
}

export const loadSchoolsFromDb = cached('schools', 60_000, async () => {
  const p = getPool()
  const res = await p.query('SELECT data FROM flight_schools ORDER BY id DESC LIMIT 1')
  if (res.rows.length === 0) return { schools: [] }
  return res.rows[0].data
})

// ── Complaints ──────────────────────────────────────────────────────────

export async function getComplaints(tail) {
  const p = getPool()
  if (tail) {
    const res = await p.query('SELECT raw FROM complaints WHERE tail = $1 ORDER BY created_at DESC', [tail])
    return res.rows.map(r => r.raw)
  }
  const res = await p.query('SELECT raw FROM complaints ORDER BY created_at DESC')
  return res.rows.map(r => r.raw)
}

export async function addComplaint(record) {
  const p = getPool()
  await p.query(
    'INSERT INTO complaints (id, tail, started_at, ended_at, klass, zone, notes, type, score, raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [record.id, record.tail, record.startedAt, record.endedAt, record.klass,
     record.zone, record.notes, record.type, record.score, JSON.stringify(record)]
  )
}

// ── Notifications ───────────────────────────────────────────────────────

export async function getNotifications(tail, kind) {
  const p = getPool()
  let sql = 'SELECT raw FROM notifications WHERE 1=1'
  const params = []
  if (tail) { params.push(tail); sql += ` AND tail = $${params.length}` }
  if (kind) { params.push(kind); sql += ` AND kind = $${params.length}` }
  sql += ' ORDER BY at DESC'
  const res = await p.query(sql, params)
  return res.rows.map(r => r.raw)
}

export async function addNotification(record) {
  const p = getPool()
  await p.query(
    'INSERT INTO notifications (kind, tail, at, raw) VALUES ($1,$2,$3,$4)',
    [record.kind, record.tail, record.at, JSON.stringify(record)]
  )
}

// ── Noise Reports ───────────────────────────────────────────────────────

export async function getNoiseReports(reporter) {
  const p = getPool()
  if (reporter) {
    const res = await p.query(
      "SELECT raw FROM noise_reports WHERE raw->>'reporter' = $1 OR raw->'reporter'->>'email' = $1 OR raw->'reporter'->>'id' = $1 OR raw->'reporter'->>'name' = $1 ORDER BY received_at DESC",
      [reporter]
    )
    return res.rows.map(r => r.raw)
  }
  const res = await p.query('SELECT raw FROM noise_reports ORDER BY received_at DESC')
  return res.rows.map(r => r.raw)
}

export async function addNoiseReport(record) {
  const p = getPool()
  await p.query(
    'INSERT INTO noise_reports (id, received_at, reporter, raw) VALUES ($1,$2,$3,$4)',
    [record.id, record.receivedAt, JSON.stringify(record.reporter || null), JSON.stringify(record)]
  )
}

// ── Noise Audio ─────────────────────────────────────────────────────────
// Binary MP3 clips attached to a noise report (e.g. spliced10s, loudest5s).
// Stored separately from the JSONB report body so list endpoints stay small.

let audioTableReady = null
async function ensureAudioTable() {
  if (audioTableReady) return audioTableReady
  audioTableReady = (async () => {
    const p = getPool()
    await p.query(`
      CREATE TABLE IF NOT EXISTS noise_audio (
        report_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        mime TEXT NOT NULL DEFAULT 'audio/mpeg',
        bytes BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (report_id, slot)
      )
    `)
  })()
  return audioTableReady
}

export async function addAudio(reportId, slot, buf, mime = 'audio/mpeg') {
  await ensureAudioTable()
  const p = getPool()
  // Upsert so re-uploads replace prior bytes (idempotent retries).
  await p.query(
    `INSERT INTO noise_audio (report_id, slot, mime, bytes)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (report_id, slot)
     DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, created_at = NOW()`,
    [reportId, slot, mime, buf]
  )
}

export async function getAudio(reportId, slot) {
  await ensureAudioTable()
  const p = getPool()
  const res = await p.query(
    'SELECT mime, bytes FROM noise_audio WHERE report_id = $1 AND slot = $2',
    [reportId, slot]
  )
  if (res.rows.length === 0) return null
  return { mime: res.rows[0].mime, bytes: res.rows[0].bytes }
}
