// sortiesPlugin.js — GET /api/sorties?airport=KBDU&hours=12[&tail=N123]
//
// A `sortie` is one airborne flight from engine-running takeoff to the
// landing where the aircraft actually parks/shuts down. Touch-and-goes
// and brief full-stop-with-taxi-backs inside one sortie are collapsed
// (inter-cycle ground time < SORTIE_GROUND_MS = 5 min). The sortie ends
// when post-touchdown ground time crosses SORTIE_GROUND_MS — the pilot
// was on the ground long enough to count as a real pause.
//
// The endpoint returns each sortie as a single contiguous object with
// `sortie_path` (a literal slice of the track) AND `sortie_max_pop_segment`
// (the 30 s window inside `sortie_path` with the highest population
// impact). The max-pop segment is emitted with explicit start/end
// INDICES into `sortie_path` so the consumer can verify the coupling
// by-construction — no orphan-vs-track mismatch is possible.
//
// Wire-shape invariant — load-bearing:
//   sortie_path[sortie_max_pop_index_start..sortie_max_pop_index_end]
//   === sortie_max_pop_points
//
// Replaces the worst_segment / flight_path duality on the existing
// /api/flights/current and /api/excursions/boot surface, which let the
// two slip out of sync.

import { impactSegments } from './src/popGrid.js'
import { distFt } from './src/geo.js'

const SORTIE_GROUND_MS = 5 * 60_000
const SORTIE_GROUND_AGL_FT = 200
const SORTIE_AIRPORT_NEAR_NM = 4
const SORTIE_MAX_POP_WINDOW_MS = 30_000
const SORTIE_IMPACT_SCALE = 40
const POP_SCALE_LOCAL = 100_000 // matches the server's POP_SCALE

function distNmAp(la1, lo1, la2, lo2) {
  const R = 3440.065
  const p1 = la1 * Math.PI / 180
  const p2 = la2 * Math.PI / 180
  const dp = (la2 - la1) * Math.PI / 180
  const dl = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

function detectSortiesInTrack(sortieAllPts, sortieGroundCeil) {
  const sortieList = []
  if (!Array.isArray(sortieAllPts) || sortieAllPts.length < 2) return sortieList
  const sortieSessions = []
  let sortieInAir = false
  let sortieSessionStart = -1
  for (let i = 0; i < sortieAllPts.length; i++) {
    const p = sortieAllPts[i]
    if (p[2] == null || p[3] == null) continue
    const isAir = p[2] > sortieGroundCeil
    if (!sortieInAir && isAir) {
      sortieInAir = true
      sortieSessionStart = i
    } else if (sortieInAir && !isAir) {
      sortieInAir = false
      sortieSessions.push({ s: sortieSessionStart, e: i, open: false })
      sortieSessionStart = -1
    }
  }
  if (sortieInAir && sortieSessionStart >= 0) {
    sortieSessions.push({ s: sortieSessionStart, e: sortieAllPts.length - 1, open: true })
  }
  if (!sortieSessions.length) return sortieList
  let sortieCur = { ...sortieSessions[0], cycles: 1 }
  for (let i = 1; i < sortieSessions.length; i++) {
    const next = sortieSessions[i]
    const sortieGroundGapMs = (sortieAllPts[next.s][3] || 0) - (sortieAllPts[sortieCur.e][3] || 0)
    if (sortieGroundGapMs < SORTIE_GROUND_MS) {
      sortieCur.e = next.e
      sortieCur.cycles += 1
      if (next.open) sortieCur.open = true
    } else {
      sortieList.push(sortieCur)
      sortieCur = { ...next, cycles: 1 }
    }
  }
  sortieList.push(sortieCur)
  return sortieList
}

function findSortieMaxPopSegment(sortiePath, popAt, sortieFieldElevFt) {
  if (!Array.isArray(sortiePath) || sortiePath.length < 3 || !popAt) return null
  let sortieBest = null
  for (let i = 0; i < sortiePath.length; i++) {
    let j = i
    while (j < sortiePath.length && (sortiePath[j][3] - sortiePath[i][3]) < SORTIE_MAX_POP_WINDOW_MS) j++
    const sortieEndIdx = j - 1
    if (sortieEndIdx - i < 2) continue
    const sortieWin = sortiePath.slice(i, sortieEndIdx + 1)
    let sortiePeakPop = 0, sortiePeakDba = 0
    for (const p of sortieWin) {
      const popv = popAt(p[0], p[1]) || 0
      if (popv > sortiePeakPop) sortiePeakPop = popv
      const agl = Math.max(100, (p[2] || 0) - (sortieFieldElevFt || 0))
      const baseDba = 75
      const atten = agl > 1000 ? 6 * Math.log2(agl / 1000) : 0
      const dba = Math.max(0, baseDba - atten)
      if (dba > sortiePeakDba) sortiePeakDba = dba
    }
    if (sortiePeakPop <= 0) continue
    const { total, lenFt } = impactSegments(sortieWin, popAt, distFt)
    const sortieImpactIndex = lenFt > 0 ? (total / lenFt) / POP_SCALE_LOCAL : 0
    const sortieScore = Math.round(sortieImpactIndex * SORTIE_IMPACT_SCALE)
    if (!sortieBest || sortieScore > sortieBest.score) {
      sortieBest = {
        startIdx: i,
        endIdx: sortieEndIdx,
        score: Math.max(0, Math.min(100, sortieScore)),
        dba_peak: Math.round(sortiePeakDba),
        density_peak: Math.round(sortiePeakPop),
        length_nm: Math.round((lenFt / 6076.12) * 100) / 100,
      }
    }
  }
  return sortieBest
}

// sortiesApiPlugin — Vite middleware. Caller passes injected deps:
//   { db, ENRICH_AP, POPGRID } — references to the host server's
//   already-loaded resources so this plugin doesn't reload them.
export function sortiesApiPlugin({ db, ENRICH_AP, POPGRID }) {
  return {
    name: 'sorties-api',
    configureServer(server) {
      server.middlewares.use('/api/sorties', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Cache-Control', 'public, max-age=15')
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const sortieAirport = (u.searchParams.get('airport') || 'KBDU').trim().toUpperCase()
          const sortieHours = Math.max(0.5, Math.min(48, Number(u.searchParams.get('hours')) || 12))
          const sortieTailFilter = (u.searchParams.get('tail') || '').trim().toUpperCase() || null
          const sortieAp = ENRICH_AP.find(a => a.code === sortieAirport)
          if (!sortieAp) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: `unknown airport ${sortieAirport}` }))
          }
          const sortieGroundCeil = sortieAp.elev + SORTIE_GROUND_AGL_FT
          const sortieFieldElev = sortieAp.elev
          let sortieLive
          if (db && db.useDb) sortieLive = await db.loadLiveFromDb(sortieHours)
          else {
            try {
              const fs = await import('fs/promises')
              const path = await import('path')
              const buf = await fs.default.readFile(path.default.resolve('public/tracks_live.json'), 'utf8')
              sortieLive = JSON.parse(buf)
            } catch { sortieLive = { tracks: [] } }
          }
          const sortieTracks = sortieLive.tracks || []
          const sortieCutoffMs = Date.now() - sortieHours * 3600 * 1000
          const sortieResults = []
          for (const sortieTrack of sortieTracks) {
            const sortieTail = (sortieTrack.call || '').trim().toUpperCase()
            if (!sortieTail || sortieTail.startsWith('~')) continue
            if (sortieTailFilter && sortieTail !== sortieTailFilter) continue
            const sortieAllPts = (sortieTrack.points || []).slice().sort((a, b) => (a[3] || 0) - (b[3] || 0))
            if (sortieAllPts.length < 3) continue
            const sortieList = detectSortiesInTrack(sortieAllPts, sortieGroundCeil)
            for (const s of sortieList) {
              const sortieStartPt = sortieAllPts[s.s]
              const sortieEndPt = sortieAllPts[s.e]
              if (!sortieStartPt || !sortieEndPt) continue
              if ((sortieEndPt[3] || 0) < sortieCutoffMs) continue
              const sortieLandingDistNm = distNmAp(sortieEndPt[0], sortieEndPt[1], sortieAp.lat, sortieAp.lon)
              if (sortieLandingDistNm > SORTIE_AIRPORT_NEAR_NM) continue
              const sortiePath = []
              for (let k = s.s; k <= s.e; k++) {
                const p = sortieAllPts[k]
                if (p[0] == null || p[1] == null || p[2] == null || p[3] == null) continue
                sortiePath.push([p[0], p[1], p[2], p[3]])
              }
              if (sortiePath.length < 3) continue
              const sortieMaxPop = findSortieMaxPopSegment(sortiePath, POPGRID?.popAt, sortieFieldElev)
              const sortieTakeoffTs = new Date(sortieStartPt[3]).toISOString()
              const sortieLandingTs = new Date(sortieEndPt[3]).toISOString()
              const sortieDurationMin = Math.round((sortieEndPt[3] - sortieStartPt[3]) / 60_000 * 10) / 10
              const sortieId = `${sortieAirport.toLowerCase()}-${sortieTail.toLowerCase()}-${new Date(sortieStartPt[3]).toISOString().slice(0, 16).replace(/[-T:]/g, '')}`
              const sortieRow = {
                sortie_id: sortieId,
                sortie_tail: sortieTail,
                sortie_type: sortieTrack.type || null,
                sortie_takeoff_ts: sortieTakeoffTs,
                sortie_landing_ts: sortieLandingTs,
                sortie_landed_at_airport: sortieAirport,
                sortie_landing_dist_nm: Math.round(sortieLandingDistNm * 10) / 10,
                sortie_duration_min: sortieDurationMin,
                sortie_cycles: s.cycles,
                sortie_is_open: !!s.open,
                sortie_path_point_count: sortiePath.length,
                sortie_path: sortiePath,
                sortie_max_pop_segment: null,
              }
              if (sortieMaxPop) {
                const sortieMaxPopPoints = sortiePath.slice(sortieMaxPop.startIdx, sortieMaxPop.endIdx + 1)
                sortieRow.sortie_max_pop_segment = {
                  sortie_max_pop_index_start: sortieMaxPop.startIdx,
                  sortie_max_pop_index_end: sortieMaxPop.endIdx,
                  sortie_max_pop_score: sortieMaxPop.score,
                  sortie_max_pop_dba_peak: sortieMaxPop.dba_peak,
                  sortie_max_pop_density_peak: sortieMaxPop.density_peak,
                  sortie_max_pop_length_nm: sortieMaxPop.length_nm,
                  sortie_max_pop_start_ts: new Date(sortieMaxPopPoints[0][3]).toISOString(),
                  sortie_max_pop_end_ts: new Date(sortieMaxPopPoints[sortieMaxPopPoints.length - 1][3]).toISOString(),
                  sortie_max_pop_points: sortieMaxPopPoints,
                }
              }
              sortieResults.push(sortieRow)
            }
          }
          sortieResults.sort((a, b) => b.sortie_landing_ts.localeCompare(a.sortie_landing_ts))
          res.end(JSON.stringify({
            sortie_airport: sortieAirport,
            sortie_window_hours: sortieHours,
            sortie_count: sortieResults.length,
            sortie_invariant: 'sortie_max_pop_segment.sortie_max_pop_points === sortie_path.slice(sortie_max_pop_index_start, sortie_max_pop_index_end + 1). The max-pop segment is a literal subset of the sortie_path by construction.',
            sorties: sortieResults,
          }))
        } catch (err) {
          console.error('[sorties-api] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}
