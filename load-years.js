#!/usr/bin/env node
// load-years.js — Load tracks from JSON files into Postgres.
// Reads tracks_YYYY.json from C:\tmp\noise_data, thins points (DP 100ft),
// inserts into tracks table. Backfill.js then classifies them.
//
// Usage: node load-years.js 2025 2026
// Env: DATABASE_URL or supply as first-positional after years

import fs from 'fs'
import pg from 'pg'

// --- Douglas-Peucker thinning (same as original load) ---
function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.sqrt((p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2)
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const px = a[0] + t * dx, py = a[1] + t * dy
  return Math.sqrt((p[0] - px) ** 2 + (p[1] - py) ** 2)
}

function dpThin(pts, eps) {
  if (pts.length <= 2) return pts
  let maxD = 0, idx = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], pts[0], pts[pts.length - 1])
    if (d > maxD) { maxD = d; idx = i }
  }
  if (maxD > eps) {
    const left = dpThin(pts.slice(0, idx + 1), eps)
    const right = dpThin(pts.slice(idx), eps)
    return left.slice(0, -1).concat(right)
  }
  return [pts[0], pts[pts.length - 1]]
}

// eps in degrees (~100ft ≈ 0.00027°)
const THIN_EPS = 0.00027

const connStr = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL
if (!connStr) { console.error('Set DATABASE_URL'); process.exit(1) }

const years = process.argv.slice(2).filter(a => /^\d{4}$/.test(a))
if (!years.length) { console.error('Usage: node load-years.js 2025 2026'); process.exit(1) }

const pool = new pg.Pool({
  connectionString: connStr,
  ssl: { rejectUnauthorized: false },
})

async function loadYear(year) {
  const path = `C:/tmp/noise_data/tracks_${year}.json`
  if (!fs.existsSync(path)) { console.error(`File not found: ${path}`); return 0 }

  console.log(`[load] Reading ${path}...`)
  const data = JSON.parse(fs.readFileSync(path, 'utf8'))
  const tracks = data.tracks || []
  console.log(`[load] ${year}: ${tracks.length} tracks`)

  // Check for duplicates by src
  const srcs = tracks.map(t => t.src)
  const existRes = await pool.query(
    'SELECT src FROM tracks WHERE src = ANY($1)',
    [srcs]
  )
  const existing = new Set(existRes.rows.map(r => r.src))
  const newTracks = tracks.filter(t => !existing.has(t.src))
  console.log(`[load] ${year}: ${newTracks.length} new (${existing.size} already loaded)`)

  if (!newTracks.length) return 0

  // Insert in batches
  const BATCH = 100
  let inserted = 0
  for (let i = 0; i < newTracks.length; i += BATCH) {
    const batch = newTracks.slice(i, i + BATCH)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const t of batch) {
        const hex = t.hex || t.src.split('/').pop()
        const thinned = dpThin(t.points || [], THIN_EPS)
        const randKey = Math.floor(Math.random() * 1000000)
        await client.query(
          `INSERT INTO tracks (call, hex, type, desc_text, own_op, src, points, rand_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [t.call, hex, t.type, t.desc, t.ownOp, t.src, JSON.stringify(thinned), randKey]
        )
      }
      await client.query('COMMIT')
      inserted += batch.length
      if (inserted % 1000 < BATCH) {
        console.log(`[load] ${year}: ${inserted}/${newTracks.length}`)
      }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      console.error(`[load] batch error at ${inserted}:`, e.message)
    }
    client.release()
  }

  console.log(`[load] ${year}: inserted ${inserted} tracks`)
  return inserted
}

let total = 0
for (const y of years) {
  total += await loadYear(y)
}
console.log(`[load] DONE — ${total} tracks inserted. Run backfill.js to classify.`)
await pool.end()
