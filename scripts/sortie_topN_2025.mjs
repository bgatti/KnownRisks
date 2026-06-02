// sortie_topN_2025.mjs — run sortie extraction over the 2025 archive
// and print the two goal queries:
//   A. Top 10 sorties ranked by metrics.height.agl_max_ft, filtered
//      to metrics.distance.furthest_nm > 40
//   B. Top 10 tails by sorties/day in 2025
//
// Run:  cd noise/web && node scripts/sortie_topN_2025.mjs
//
// Reads C:/tmp/noise_data/tracks_2025.json (370 MB). The archive
// shape per CLAUDE.md:
//   { year, center, region, alt_max_ft: 9000, tracks: [
//       { call, type, desc, ownOp, src: "globe/YYYY-MM-DD/<hex>",
//         points: [[lat, lon, alt_msl_ft, sec_within_utc_day], ...] }
//   ] }
//
// Cross-day sorties get split — the archive is per-UTC-day, and we
// don't try to stitch across days in v0. Acceptable trade-off for
// the goal queries which both work on within-day data.

import fs from 'fs'
import path from 'path'
import url from 'url'
import { extractSorties } from '../sortieExtract.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ARCHIVE = process.env.ARCHIVE || 'C:/tmp/noise_data/tracks_2025.json'

// Front Range airport reference catalog. Same set the prod handler
// uses (ENRICH_AP); inlined here to keep the script self-contained.
const AIRPORTS = [
  { code: 'KBDU', lat: 40.0394, lon: -105.2258, elev: 5288 },
  { code: 'KBJC', lat: 39.9088, lon: -105.1172, elev: 5673 },
  { code: 'KAPA', lat: 39.5701, lon: -104.8487, elev: 5885 },
  { code: 'KFNL', lat: 40.4519, lon: -105.0114, elev: 5016 },
  { code: 'KEIK', lat: 40.0186, lon: -105.0497, elev: 5025 },
  { code: 'KLMO', lat: 40.1639, lon: -105.1631, elev: 5054 },
  { code: 'KGXY', lat: 40.4374, lon: -104.6336, elev: 4697 },
  { code: 'KDEN', lat: 39.8617, lon: -104.6731, elev: 5434 },
  { code: 'KCOS', lat: 38.8058, lon: -104.7008, elev: 6187 },
  { code: 'KPUB', lat: 38.2891, lon: -104.4969, elev: 4730 },
  { code: 'KAJZ', lat: 39.0917, lon: -106.0481, elev: 6539 },
  { code: 'KEGE', lat: 39.6426, lon: -106.9177, elev: 6540 },
]

function dateUtcStart(yyyymmdd) {
  // "2025-12-21" → epoch ms for start of that UTC day
  const [y, m, d] = yyyymmdd.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

function parseSrcDate(src) {
  // src like "globe/2025-12-21/<hex>"
  const m = /globe\/(\d{4}-\d{2}-\d{2})/.exec(src || '')
  return m ? m[1] : null
}

console.log(`[sortie] loading ${ARCHIVE} ...`)
const t0 = Date.now()
const raw = fs.readFileSync(ARCHIVE, 'utf8')
const archive = JSON.parse(raw)
console.log(`[sortie] loaded ${archive.tracks.length} tracks in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

// Walk every track, convert t_offset → ms, run extractSorties, collect.
const allSorties = []
const tailDays = new Map() // tail -> Set<yyyymmdd>
const tailSortieCount = new Map() // tail -> count

const tStart = Date.now()
let trackI = 0
for (const t of archive.tracks) {
  trackI++
  if (trackI % 5000 === 0) {
    console.log(`  ... ${trackI}/${archive.tracks.length} tracks processed, ${allSorties.length} sorties found`)
  }
  const tail = (t.call || '').trim()
  if (!tail || tail.startsWith('~')) continue  // skip anonymized tails
  const dateStr = parseSrcDate(t.src)
  if (!dateStr) continue
  const dayStartMs = dateUtcStart(dateStr)
  // Convert points: [lat, lon, alt, secs_within_day] → [lat, lon, alt, ms_epoch]
  const pts = []
  for (const p of t.points || []) {
    if (!Array.isArray(p) || p.length < 4) continue
    const tsMs = dayStartMs + (p[3] * 1000)
    pts.push([p[0], p[1], p[2], tsMs])
  }
  if (pts.length < 5) continue
  const sorties = extractSorties(pts, {
    airports: AIRPORTS,
    tail,
    type: t.type || null,
    desc: t.desc || null,
    ownOp: t.ownOp || null,
    source: `archive:tracks_2025.json#track=${trackI - 1}`,
    copyPoints: false, // metrics-only for this analysis to save RAM
  })
  for (const s of sorties) {
    allSorties.push(s)
    if (!tailSortieCount.has(tail)) tailSortieCount.set(tail, 0)
    tailSortieCount.set(tail, tailSortieCount.get(tail) + 1)
    if (!tailDays.has(tail)) tailDays.set(tail, new Set())
    tailDays.get(tail).add(dateStr)
  }
}
const tEnd = Date.now()
console.log(`[sortie] extracted ${allSorties.length} sorties from ${trackI} tracks in ${((tEnd - tStart) / 1000).toFixed(1)}s`)

// === A. Top 10 by height.agl_max_ft filtered to distance.furthest_nm > 40 ===
const A = allSorties
  .filter(s => s.metrics && s.metrics.distance.furthest_nm > 40)
  .sort((a, b) => (b.metrics.height.agl_max_ft || 0) - (a.metrics.height.agl_max_ft || 0))
  .slice(0, 10)

console.log('\n=========================================================================')
console.log('A. Top 10 sorties ranked by metrics.height.agl_max_ft')
console.log('   filtered to metrics.distance.furthest_nm > 40 nm')
console.log('   (archive caps alt at 9000 ft MSL — see CLAUDE.md)')
console.log('=========================================================================')
console.log('  rank  tail            type   agl_max  msl_max  furthest  dep  arr   duration  date')
console.log('  ----  --------------  -----  -------  -------  --------  ----  ----  --------  ----------')
A.forEach((s, i) => {
  const m = s.metrics
  const dt = (s.departure.time || '').slice(0, 10)
  const dep = s.departure.airport || '----'
  const arr = s.arrival.airport || '----'
  const dur = `${m.duration_min}m`
  console.log(
    `  ${String(i + 1).padStart(4)}  ${(s.tail || '').padEnd(14)}  ${(s.type || '----').padEnd(5)}  ${String(m.height.agl_max_ft).padStart(7)}  ${String(m.height.msl_max_ft).padStart(7)}  ${m.distance.furthest_nm.toFixed(1).padStart(8)}  ${dep.padEnd(4)}  ${arr.padEnd(4)}  ${dur.padStart(8)}  ${dt}`
  )
})

// === B. Top 10 tails by sorties/day in 2025 ===
const B = [...tailSortieCount.entries()]
  .map(([tail, count]) => {
    const days = tailDays.get(tail)?.size || 1
    return { tail, sorties: count, days, perDay: count / days }
  })
  .filter(r => r.days >= 5)  // ignore tails with < 5 active days (noise)
  .sort((a, b) => b.perDay - a.perDay)
  .slice(0, 10)

console.log('\n=========================================================================')
console.log('B. Top 10 tails by sorties / active day in 2025')
console.log('   (active day = day the tail appears in the archive at all;')
console.log('   tails with < 5 active days excluded as noise)')
console.log('=========================================================================')
console.log('  rank  tail            sorties  active_days  sorties_per_day')
console.log('  ----  --------------  -------  -----------  ---------------')
B.forEach((r, i) => {
  console.log(
    `  ${String(i + 1).padStart(4)}  ${r.tail.padEnd(14)}  ${String(r.sorties).padStart(7)}  ${String(r.days).padStart(11)}  ${r.perDay.toFixed(2).padStart(15)}`
  )
})

console.log('\nDone.')
