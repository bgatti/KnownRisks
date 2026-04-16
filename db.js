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
      connectionTimeoutMillis: 10000,
    })
    pool.on('error', (err) => console.error('[db] pool error', err.message))
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

export const loadTracksFromDb = cached('tracks', 30_000, async () => {
  console.log('[db] loadTracksFromDb: querying...')
  const p = getPool()
  const res = await p.query('SELECT call, hex, type, desc_text, own_op, src, points FROM tracks')
  const tracks = res.rows.map(r => ({
    call: r.call, hex: r.hex, type: r.type, desc: r.desc_text,
    ownOp: r.own_op, src: r.src, points: r.points,
  }))
  return { tracks, _byTail: indexByTail(tracks) }
})

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
