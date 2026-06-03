// sortiesPlugin.js — GET /api/sorties?airport=KBDU&hours=12[&tail=N123]
//                                       [&school=<slug>][&day=YYYY-MM-DD][&days=N]
//
// A `sortie` is one airborne flight from engine-running takeoff to the
// landing where the aircraft actually parks/shuts down. T&Gs and brief
// full-stop-with-taxi-backs inside one sortie are collapsed (inter-cycle
// ground time < SORTIE_GROUND_MS = 5 min). The sortie ends when
// post-touchdown ground time crosses SORTIE_GROUND_MS — the pilot was
// on the ground long enough to count as a real pause.
//
// Returns each sortie with:
// - sortie_path: literal slice of the track [lat, lon, alt_msl, ts_ms,
//   quality] where quality ∈ {"observed", "bridged"}. Altitudes are
//   alt_offset-corrected uniformly across the sortie.
// - sortie_path_amendment: { alt_offset_ft, alt_offset_source,
//   bridged_count, bridged_max_gap_s, bridged_total_gap_s }.
// - sortie_max_pop_segment: the 30 s window with highest pop impact,
//   constructed AS A LITERAL SLICE of sortie_path. Wire-shape invariant:
//   sortie_path[start..end+1] === sortie_max_pop_points.
//
// New v2 fields (added 2026-06-02 per sorties-test channel Asks S-1..S-5):
//   sortie_operator + sortie_operator_name
//   sortie_base
//   sortie_purpose ∈ {pattern, local, cross_country, transient, unknown}
//   sortie_path_length_nm
//   sortie_max_excursion_nm
//   sortie_takeoff_day (UTC YYYY-MM-DD)
//
// Path quality (also v2): every point carries a quality flag so the
// client can render bridged spans distinctly (dashed line, faded
// color). Wire-shape stays backwards-compatible — old consumers
// ignoring the 5th tuple slot keep working.

import fs from 'fs'
import { impactSegments } from './src/popGrid.js'
import { distFt, isEnginelessType } from './src/geo.js'
import { perfForType } from './aircraftPerf.js'
import { estimateThrottle } from './throttleEstimate.js'

// ── purposeML — lazy loaded so a missing sibling library (which has
// happened mid-deploy before) doesn't crash module init. First call
// sticks the result. Returns null when the library isn't installed
// and we fall through to the geometry classifier.
let _purposeMLClassify = null
let _purposeMLAttempted = false
async function getPurposeMLClassify() {
  if (_purposeMLAttempted) return _purposeMLClassify
  _purposeMLAttempted = true
  try {
    const mod = await import('./purposeML/index.js')
    if (mod && typeof mod.classifyOneTrack === 'function') {
      _purposeMLClassify = mod.classifyOneTrack
    }
  } catch (err) {
    console.warn('[sorties] purposeML unavailable, falling through to geometry classifier:', err && err.message)
  }
  return _purposeMLClassify
}

// ── acsML — same lazy-load pattern. Identifies ACS tasks demonstrated
// + emits FAR 61.57 currency events from the real-only points. Falls
// through to null (no sortie_acs field) when unavailable.
let _acsMLIdentify = null
let _acsMLAttempted = false
async function getAcsMLIdentify() {
  if (_acsMLAttempted) return _acsMLIdentify
  _acsMLAttempted = true
  try {
    const mod = await import('./acsML/index.js')
    if (mod && typeof mod.identifyOneTrack === 'function') {
      _acsMLIdentify = mod.identifyOneTrack
    }
  } catch (err) {
    console.warn('[sorties] acsML unavailable, sortie_acs will be null:', err && err.message)
  }
  return _acsMLIdentify
}

const SORTIE_GROUND_MS = 5 * 60_000
// Gliders AND tow planes turn around faster than typical powered
// aircraft: unhitch, pull back to launch position, hook the next
// tow. 2-3 min is normal at busy glider ops (KBDU on a thermal day).
// With the 5-min powered threshold, two adjacent tow sorties (or
// glider sorties) get merged into one bogus "double tow." Operator
// brief 2026-06-02.
const SORTIE_GROUND_MS_SHORT_TURN = 2 * 60_000
// Tow-plane type codes — Pawnee / Super Cub / Pilatus Porter / PC-6.
// Same set the server's `purposeOf` regex uses for `tow_plane`.
const TOW_PLANE_TYPE_RE = /^(PA25|PA18|PIAT|PC6)$/
function isTowPlaneType(type) {
  return TOW_PLANE_TYPE_RE.test(String(type || '').toUpperCase())
}
const SORTIE_GROUND_AGL_FT = 200
const SORTIE_AIRPORT_NEAR_NM = 4
const SORTIE_MAX_POP_WINDOW_MS = 30_000
const SORTIE_IMPACT_SCALE = 40
const POP_SCALE_LOCAL = 100_000
const SORTIE_PURPOSE_XC_NM = 15        // max-excursion threshold for cross_country
const SORTIE_BRIDGE_GAP_MS = 15_000    // gap above this triggers bridge eval
const SORTIE_BRIDGE_MAX_MS = 5 * 60_000 // never bridge > 5 min
const SORTIE_BRIDGE_TOLERANCE = 0.75   // ±75% of neighbor groundspeed
const SORTIE_BRIDGE_TARGET_S = 15      // target inter-bridge spacing
const SORTIE_ALT_CAL_RADIUS_NM = 2.0
const SORTIE_ALT_CAL_FRACTION = 0.25
const SORTIE_ALT_CAL_MIN = 3
const SORTIE_ALT_CAL_MAX_AGL = 500

function distNmAp(la1, lo1, la2, lo2) {
  const R = 3440.065
  const p1 = la1 * Math.PI / 180
  const p2 = la2 * Math.PI / 180
  const dp = (la2 - la1) * Math.PI / 180
  const dl = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// ── Schools index ─────────────────────────────────────────────────
// Same source `/api/schools` uses (post-the-cache-fix). Cached at
// module scope; mtime-checked so dev edits hot-reload.
let SCHOOLS_INDEX = null
function loadSchoolsIndex() {
  const PATH = 'public/flight_schools_fleets.json'
  let mt = 0
  try { mt = fs.statSync(PATH).mtimeMs } catch { mt = -1 }
  if (SCHOOLS_INDEX && SCHOOLS_INDEX.mt === mt) return SCHOOLS_INDEX
  // tailToSchool — uppercase tail → { slug, name, airport }
  const tailToSchool = new Map()
  try {
    const raw = JSON.parse(fs.readFileSync(PATH, 'utf8'))
    for (const s of (raw.schools || [])) {
      const slug = slugifySchool(s.name)
      if (!slug) continue
      const airport = ((s.airport || '').split(/[\s/]/, 1)[0] || '').trim().toUpperCase()
      for (const ac of (s.aircraft || [])) {
        const tail = (ac.tail || '').toUpperCase()
        if (tail) tailToSchool.set(tail, { slug, name: s.name, airport })
      }
    }
  } catch (e) {
    console.error('[sorties] schools index load failed:', e.message)
  }
  SCHOOLS_INDEX = { mt, tailToSchool }
  return SCHOOLS_INDEX
}
function slugifySchool(name) {
  if (!name) return null
  return String(name).toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ── Sortie detection ──────────────────────────────────────────────
function detectSortiesInTrack(sortieAllPts, sortieGroundCeil, sortieGroundMs = SORTIE_GROUND_MS) {
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
    if (sortieGroundGapMs < sortieGroundMs) {
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

// ── Altitude calibration (self-only — no cross-flight smoothing in
// this surface; sorties are short enough that one calibration per
// sortie is fine for the operator's amended_msl check) ────────────
function computeSortieAltOffset(rawPath, sortieAp) {
  if (!sortieAp || !Array.isArray(rawPath) || rawPath.length < SORTIE_ALT_CAL_MIN) {
    return { offset_ft: 0, source: 'none', cohort: 0 }
  }
  // Candidates: fixes within 2 nm of airport center, sorted by alt asc.
  const candidates = rawPath
    .filter(p => p[0] != null && p[1] != null && p[2] != null
      && distNmAp(p[0], p[1], sortieAp.lat, sortieAp.lon) <= SORTIE_ALT_CAL_RADIUS_NM)
    .map(p => p[2])
    .sort((a, b) => a - b)
  if (candidates.length < SORTIE_ALT_CAL_MIN) return { offset_ft: 0, source: 'none', cohort: 0 }
  const k = Math.max(SORTIE_ALT_CAL_MIN, Math.ceil(candidates.length * SORTIE_ALT_CAL_FRACTION))
  const cohort = candidates.slice(0, k)
  const mean = cohort.reduce((s, v) => s + v, 0) / cohort.length
  const offset = Math.round(mean - sortieAp.elev)
  if (Math.abs(offset) > SORTIE_ALT_CAL_MAX_AGL) {
    // Suspicious — refuse to apply
    return { offset_ft: 0, source: 'none', cohort: cohort.length }
  }
  return { offset_ft: offset, source: 'self', cohort: cohort.length }
}

// ── Path bridging — patch coverage gaps with synthesized fixes ───
// Returns { path, bridgedCount, bridgedMaxGapS, bridgedTotalGapS,
//           gaps: [{ before_index, gap_seconds, reason }] }
// where path is the augmented 5-tuple array with quality flags AND
// gaps[] surfaces every UNBRIDGED coverage gap so the client can
// break the rendered polyline there (instead of drawing a misleading
// straight line through the missing data).
function bridgeSortiePath(rawPath, altOffset) {
  if (!Array.isArray(rawPath) || rawPath.length < 2) {
    return { path: [], bridgedCount: 0, bridgedMaxGapS: 0, bridgedTotalGapS: 0, gaps: [] }
  }
  const out = []
  let bridged = 0, maxGap = 0, totalGap = 0
  const gaps = []
  // Helper to append a corrected real point
  const pushReal = (p) => out.push([p[0], p[1], (p[2] != null) ? p[2] - altOffset : null, p[3], 'real'])
  // Record an UNBRIDGED gap. `before_index` is the index of the next
  // observed point — i.e. the polyline should be broken just BEFORE
  // out.length.
  const recordGap = (dtMs, reason) => {
    gaps.push({ before_index: out.length, gap_seconds: Math.round(dtMs / 1000), reason })
  }
  pushReal(rawPath[0])
  for (let i = 1; i < rawPath.length; i++) {
    const a = rawPath[i - 1]
    const b = rawPath[i]
    const dtMs = (b[3] || 0) - (a[3] || 0)
    if (dtMs <= SORTIE_BRIDGE_GAP_MS) {
      pushReal(b)
      continue
    }
    if (dtMs > SORTIE_BRIDGE_MAX_MS) {
      recordGap(dtMs, 'too_long')
      pushReal(b)
      continue
    }
    // Neighbor groundspeeds (kts) — average of prev edge + next edge.
    let prevKts = null, nextKts = null
    if (i >= 2) {
      const prev = rawPath[i - 2]
      const dtPrev = ((a[3] || 0) - (prev[3] || 0)) / 1000
      if (dtPrev > 0 && dtPrev < 30) {
        const nm = distFt(prev[0], prev[1], a[0], a[1]) / 6076.12
        prevKts = nm / (dtPrev / 3600)
      }
    }
    if (i + 1 < rawPath.length) {
      const nxt = rawPath[i + 1]
      const dtNext = ((nxt[3] || 0) - (b[3] || 0)) / 1000
      if (dtNext > 0 && dtNext < 30) {
        const nm = distFt(b[0], b[1], nxt[0], nxt[1]) / 6076.12
        nextKts = nm / (dtNext / 3600)
      }
    }
    let nodeKts = null
    if (prevKts != null && nextKts != null) nodeKts = (prevKts + nextKts) / 2
    else if (prevKts != null) nodeKts = prevKts
    else if (nextKts != null) nodeKts = nextKts
    if (nodeKts == null) {
      recordGap(dtMs, 'no_node_speed')
      pushReal(b)
      continue
    }
    if (nodeKts < 30 || nodeKts > 400) {
      recordGap(dtMs, 'implausible_neighbor_speed')
      pushReal(b)
      continue
    }
    const gapDistNm = distFt(a[0], a[1], b[0], b[1]) / 6076.12
    const impliedKts = gapDistNm / (dtMs / 3_600_000)
    if (impliedKts < nodeKts * (1 - SORTIE_BRIDGE_TOLERANCE)
        || impliedKts > nodeKts * (1 + SORTIE_BRIDGE_TOLERANCE)) {
      recordGap(dtMs, 'speed_mismatch')
      pushReal(b)
      continue
    }
    // Bridge. Insert nSegments−1 synthesized fixes.
    const nSegments = Math.max(2, Math.ceil((dtMs / 1000) / SORTIE_BRIDGE_TARGET_S))
    for (let k = 1; k < nSegments; k++) {
      const t = k / nSegments
      const lat = a[0] + (b[0] - a[0]) * t
      const lon = a[1] + (b[1] - a[1]) * t
      let alt = null
      if (a[2] != null && b[2] != null) alt = (a[2] + (b[2] - a[2]) * t) - altOffset
      const ts = Math.round((a[3] || 0) + dtMs * t)
      out.push([lat, lon, alt, ts, 'repaired'])
      bridged++
    }
    const gapSec = dtMs / 1000
    if (gapSec > maxGap) maxGap = gapSec
    totalGap += gapSec
    pushReal(b)
  }
  return {
    path: out,
    bridgedCount: bridged,
    bridgedMaxGapS: Math.round(maxGap),
    bridgedTotalGapS: Math.round(totalGap),
    gaps,
  }
}

// ── Max-pop segment within the sortie path ───────────────────────
function findSortieMaxPopSegment(sortiePath, popAt, sortieFieldElevFt) {
  if (!Array.isArray(sortiePath) || sortiePath.length < 3 || !popAt) return null
  let sortieBest = null
  for (let i = 0; i < sortiePath.length; i++) {
    // EVALUATION RULE — the max-pop window must contain ONLY real
    // points. Repaired (synthesized) points are rendering aids and
    // are not safe to score. Window starts must be on a real point;
    // we skip any window that contains a repaired point.
    if (sortiePath[i][4] !== 'real') continue
    let j = i
    while (j < sortiePath.length && (sortiePath[j][3] - sortiePath[i][3]) < SORTIE_MAX_POP_WINDOW_MS) j++
    const sortieEndIdx = j - 1
    if (sortieEndIdx - i < 2) continue
    let allReal = true
    for (let k = i; k <= sortieEndIdx; k++) {
      if (sortiePath[k][4] !== 'real') { allReal = false; break }
    }
    if (!allReal) continue
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

// ── Purpose classifier from geometry (S-3) ───────────────────────
function classifySortiePurpose({ cycles, maxExcursionNm, landedAirport, baseAirport, patternRadiusNm = 2 }) {
  if (cycles >= 2 && maxExcursionNm < patternRadiusNm + 1) return 'pattern'
  if (cycles === 1 && maxExcursionNm < SORTIE_PURPOSE_XC_NM && landedAirport && landedAirport === baseAirport) return 'local'
  if (maxExcursionNm >= SORTIE_PURPOSE_XC_NM) return 'cross_country'
  if (landedAirport && baseAirport && landedAirport !== baseAirport) return 'cross_country'
  if (landedAirport && !baseAirport) return 'transient'
  return 'unknown'
}

// ── Plugin ────────────────────────────────────────────────────────
export function sortiesApiPlugin({ db, ENRICH_AP, POPGRID }) {
  // Per-tail base lookup, cached. Query `tracks` for the latest
  // non-null base_airport per tail. Bulk-batched per request.
  async function fetchTailBases(tails) {
    const out = new Map()
    if (!db || !db.useDb || !tails.length) return out
    try {
      const r = await db.queryDb(
        `SELECT call,
           (array_agg(base_airport ORDER BY date DESC) FILTER (WHERE base_airport IS NOT NULL))[1] AS base
         FROM tracks WHERE call = ANY($1) GROUP BY call`,
        [tails],
      )
      for (const row of r.rows) if (row.base) out.set(row.call.toUpperCase(), row.base)
    } catch { /* swallow — base just becomes null */ }
    return out
  }

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
          // ?day=YYYY-MM-DD overrides ?hours / ?days
          const sortieDayParam = (u.searchParams.get('day') || '').trim() || null
          const sortieDaysParam = u.searchParams.get('days') ? Math.max(1, Math.min(30, Number(u.searchParams.get('days')))) : null
          const sortieHours = sortieDayParam || sortieDaysParam
            ? Math.min(48, (sortieDaysParam || 1) * 24)
            : Math.max(0.5, Math.min(48, Number(u.searchParams.get('hours')) || 12))
          const sortieTailFilter = (u.searchParams.get('tail') || '').trim().toUpperCase() || null
          const sortieSchoolFilter = (u.searchParams.get('school') || '').trim().toLowerCase() || null
          const sortieAp = ENRICH_AP.find(a => a.code === sortieAirport)
          if (!sortieAp) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: `unknown airport ${sortieAirport}` }))
          }
          const sortieGroundCeil = sortieAp.elev + SORTIE_GROUND_AGL_FT
          const sortieFieldElev = sortieAp.elev
          const sortiePatternRadius = sortieAp.pattern_radius_nm || 2

          // Window cutoffs — day-mode is [00:00 day, +24h], hours-mode is rolling.
          let sortieCutoffStartMs, sortieCutoffEndMs
          if (sortieDayParam) {
            const [y, m, d] = sortieDayParam.split('-').map(Number)
            sortieCutoffStartMs = Date.UTC(y, m - 1, d)
            sortieCutoffEndMs = sortieCutoffStartMs + 24 * 3600 * 1000
          } else if (sortieDaysParam) {
            sortieCutoffEndMs = Date.now()
            sortieCutoffStartMs = sortieCutoffEndMs - sortieDaysParam * 24 * 3600 * 1000
          } else {
            sortieCutoffEndMs = Date.now()
            sortieCutoffStartMs = sortieCutoffEndMs - sortieHours * 3600 * 1000
          }

          // Load source — historical via loadLiveFromDbByDateRange
          // when ?day= or ?days= is set; live rolling window
          // otherwise. Both routes hit live_tracks (which has per-UTC-
          // day rows + retention going back as far as the DB keeps
          // them). Deep-historical (months+) over the `tracks` table
          // is the next iteration when the test page asks for it.
          let sortieLive
          let sortieSource
          if (db && db.useDb) {
            if (sortieDayParam || sortieDaysParam) {
              const fromDate = new Date(sortieCutoffStartMs).toISOString().slice(0, 10)
              const toDate   = new Date(sortieCutoffEndMs - 1).toISOString().slice(0, 10)
              sortieLive = await db.loadLiveFromDbByDateRange(fromDate, toDate)
              sortieSource = `historical:live_tracks ${fromDate}..${toDate}`
            } else {
              sortieLive = await db.loadLiveFromDb(sortieHours)
              sortieSource = 'live'
            }
          } else {
            try {
              const fs2 = await import('fs/promises')
              const path = await import('path')
              const buf = await fs2.default.readFile(path.default.resolve('public/tracks_live.json'), 'utf8')
              sortieLive = JSON.parse(buf)
              sortieSource = 'file:tracks_live.json'
            } catch { sortieLive = { tracks: [] }; sortieSource = 'empty' }
          }
          const sortieTracks = sortieLive.tracks || []

          // Schools index for operator resolution.
          const schoolsIdx = loadSchoolsIndex()
          // purposeML — lazy-loaded once per process. When unavailable,
          // sortie_purpose falls through to the geometry classifier.
          const purposeMLClassifyFn = await getPurposeMLClassify()
          // acsML — lazy-loaded once per process. Identifies ACS tasks
          // demonstrated + 61.57 currency events from REAL-ONLY points.
          const acsMLIdentifyFn = await getAcsMLIdentify()

          // Pre-pass to collect tails so we can batch the base lookup.
          const tailsSeen = new Set()
          for (const t of sortieTracks) {
            const tl = (t.call || '').trim().toUpperCase()
            if (tl && !tl.startsWith('~')) tailsSeen.add(tl)
          }
          const tailBaseMap = await fetchTailBases([...tailsSeen])

          const sortieResults = []
          for (const sortieTrack of sortieTracks) {
            const sortieTail = (sortieTrack.call || '').trim().toUpperCase()
            if (!sortieTail || sortieTail.startsWith('~')) continue
            if (sortieTailFilter && sortieTail !== sortieTailFilter) continue
            const sortieAllPts = (sortieTrack.points || []).slice().sort((a, b) => (a[3] || 0) - (b[3] || 0))
            if (sortieAllPts.length < 3) continue
            // Gliders AND tow planes turn around faster than typical
            // powered aircraft — both get the 2 min threshold. Without
            // it, two consecutive glider sorties (or two consecutive
            // tow climbs by the same tug) merge into a bogus "double
            // tow."
            const sortieIsGlider = isEnginelessType(sortieTrack.type || '')
            const sortieIsTowPlane = isTowPlaneType(sortieTrack.type || '')
            const sortieShortTurn = sortieIsGlider || sortieIsTowPlane
            const sortieGroundMsForType = sortieShortTurn ? SORTIE_GROUND_MS_SHORT_TURN : SORTIE_GROUND_MS
            const sortieList = detectSortiesInTrack(sortieAllPts, sortieGroundCeil, sortieGroundMsForType)
            for (const s of sortieList) {
              const sortieStartPt = sortieAllPts[s.s]
              const sortieEndPt = sortieAllPts[s.e]
              if (!sortieStartPt || !sortieEndPt) continue
              if ((sortieEndPt[3] || 0) < sortieCutoffStartMs) continue
              if ((sortieStartPt[3] || 0) >= sortieCutoffEndMs) continue
              const sortieLandingDistNm = distNmAp(sortieEndPt[0], sortieEndPt[1], sortieAp.lat, sortieAp.lon)
              if (sortieLandingDistNm > SORTIE_AIRPORT_NEAR_NM) continue

              // Raw path slice.
              const rawPath = []
              for (let k = s.s; k <= s.e; k++) {
                const p = sortieAllPts[k]
                if (p[0] == null || p[1] == null || p[2] == null || p[3] == null) continue
                rawPath.push([p[0], p[1], p[2], p[3]])
              }
              if (rawPath.length < 3) continue

              // Operator / base / school filter.
              const schoolEntry = schoolsIdx.tailToSchool.get(sortieTail) || null
              const sortieOperator = schoolEntry ? schoolEntry.slug : null
              const sortieOperatorName = schoolEntry ? schoolEntry.name : null
              if (sortieSchoolFilter && sortieOperator !== sortieSchoolFilter) continue
              const sortieBase = tailBaseMap.get(sortieTail) || (schoolEntry ? schoolEntry.airport : null) || null

              // Path quality passes: alt offset + bridge.
              const altCal = computeSortieAltOffset(rawPath, sortieAp)
              const bridged = bridgeSortiePath(rawPath, altCal.offset_ft)
              const sortiePath = bridged.path
              if (sortiePath.length < 3) continue

              // Throttle estimate — per-point, real-only. Repaired
              // points get null per the evaluation rule. For each real
              // point, we compute gs (kts) + vs (fpm) from the nearest
              // prior real point within 60 s, then ask the throttle
              // model for an estimate. `throttle_at_takeoff` is the
              // model's reading at the first airborne real fix; the
              // operator's calibration is "should be ~1.0 at takeoff
              // for healthy table entries — values << 0.9 mean the
              // table's vs_max is over-reported for this airframe."
              const sortiePerf = perfForType(sortieTrack.type || '')
              const sortiePathThrottle = new Array(sortiePath.length).fill(null)
              let throttleAtTakeoff = null
              if (sortiePerf && sortiePerf.vs_max_fpm > 0) {
                for (let k = 0; k < sortiePath.length; k++) {
                  const cur = sortiePath[k]
                  if (cur[4] !== 'real') continue
                  // Find prior real point within 60 s.
                  let priorIdx = -1
                  for (let m = k - 1; m >= 0; m--) {
                    if (sortiePath[m][4] !== 'real') continue
                    const dt = (cur[3] - sortiePath[m][3]) / 1000
                    if (dt > 0 && dt <= 60) priorIdx = m
                    break
                  }
                  if (priorIdx < 0) continue
                  const prev = sortiePath[priorIdx]
                  const dtS = (cur[3] - prev[3]) / 1000
                  if (!(dtS > 0)) continue
                  const nm = distFt(prev[0], prev[1], cur[0], cur[1]) / 6076.12
                  const gsKts = (nm / dtS) * 3600
                  let vsFpm = null
                  if (prev[2] != null && cur[2] != null) vsFpm = ((cur[2] - prev[2]) / dtS) * 60
                  const est = estimateThrottle(gsKts, vsFpm, cur[2], sortiePerf)
                  if (est) {
                    sortiePathThrottle[k] = est.throttle
                    if (throttleAtTakeoff == null && cur[2] != null && cur[2] > sortieGroundCeil) {
                      throttleAtTakeoff = est.throttle
                    }
                  }
                }
              }

              // Metrics over the FINAL path (post-amendment).
              let pathLenNm = 0, maxExcNm = 0
              const apCenterLat = sortieAp.lat, apCenterLon = sortieAp.lon
              for (let k = 0; k < sortiePath.length; k++) {
                const p = sortiePath[k]
                const d = distNmAp(p[0], p[1], apCenterLat, apCenterLon)
                if (d > maxExcNm) maxExcNm = d
                if (k > 0) {
                  const a = sortiePath[k - 1]
                  pathLenNm += distNmAp(a[0], a[1], p[0], p[1])
                }
              }

              const sortieTakeoffTs = new Date(sortieStartPt[3]).toISOString()
              const sortieLandingTs = new Date(sortieEndPt[3]).toISOString()
              const sortieDurationMin = Math.round((sortieEndPt[3] - sortieStartPt[3]) / 60_000 * 10) / 10
              const sortieId = `${sortieAirport.toLowerCase()}-${sortieTail.toLowerCase()}-${new Date(sortieStartPt[3]).toISOString().slice(0, 16).replace(/[-T:]/g, '')}`

              // EVALUATION RULE — purposeML must run on REAL points
              // only (no repaired/synthesized fixes). Build the
              // canonical purposeML shape from the real subset of the
              // sortie path; fall through to the geometry classifier
              // when purposeML is unavailable OR confidence < 0.7.
              let sortiePurpose = null
              let sortiePurposeSource = null
              let sortiePurposeConfidence = null
              let sortiePurposeReasons = null
              if (purposeMLClassifyFn) {
                const purposeRealPts = []
                for (const p of sortiePath) {
                  if (p[4] !== 'real') continue
                  if (p[0] == null || p[1] == null || p[2] == null || p[3] == null) continue
                  purposeRealPts.push({
                    lat: p[0], lon: p[1], altMslFt: p[2],
                    tsUnix: Math.floor(p[3] / 1000),
                  })
                }
                if (purposeRealPts.length >= 30) {
                  try {
                    const v = purposeMLClassifyFn(purposeRealPts, {
                      typeCode: sortieTrack.type || '',
                      tail: sortieTail,
                      isSchoolFleet: !!sortieOperator,
                    })
                    if (v && v.confidence >= 0.7) {
                      sortiePurpose = v.purpose
                      sortiePurposeSource = 'shape'
                      sortiePurposeConfidence = v.confidence
                      sortiePurposeReasons = v.reasons || []
                    }
                  } catch (err) {
                    console.warn('[sorties] purposeML classify error for', sortieTail, err && err.message)
                  }
                }
              }
              if (!sortiePurpose) {
                sortiePurpose = classifySortiePurpose({
                  cycles: s.cycles,
                  maxExcursionNm: maxExcNm,
                  landedAirport: sortieAirport,
                  baseAirport: sortieBase,
                  patternRadiusNm: sortiePatternRadius,
                })
                sortiePurposeSource = 'geometry'
              }

              // ── acsML — identify ACS tasks demonstrated + emit
              // 61.57 currency events from REAL-only points. Same
              // points array used for purposeML (we'd already
              // filtered to quality==='real' above; reuse it).
              let sortieAcs = null
              if (acsMLIdentifyFn) {
                // Rebuild the real-points array in case the purposeML
                // block was skipped (fn null path).
                const acsRealPts = []
                for (const p of sortiePath) {
                  if (p[4] !== 'real') continue
                  if (p[0] == null || p[1] == null || p[2] == null || p[3] == null) continue
                  acsRealPts.push({
                    lat: p[0], lon: p[1], altMslFt: p[2],
                    tsUnix: Math.floor(p[3] / 1000),
                  })
                }
                if (acsRealPts.length >= 30) {
                  try {
                    const a = acsMLIdentifyFn(acsRealPts, {
                      typeCode: sortieTrack.type || '',
                      tail: sortieTail,
                    })
                    if (a) {
                      sortieAcs = {
                        tasks_demonstrated: a.tasks_demonstrated || [],
                        scores: a.scores || [],
                        currency_events: a.currency_events || [],
                        phase_summary: a.phase_summary || {},
                        notes: a.notes || [],
                      }
                    }
                  } catch (err) {
                    console.warn('[sorties] acsML identify error for', sortieTail, err && err.message)
                  }
                }
              }

              const sortieRow = {
                sortie_id: sortieId,
                sortie_tail: sortieTail,
                sortie_type: sortieTrack.type || null,
                sortie_is_glider: sortieIsGlider,
                sortie_is_tow_plane: sortieIsTowPlane,
                sortie_ground_threshold_min: sortieGroundMsForType / 60_000,
                sortie_operator: sortieOperator,
                sortie_operator_name: sortieOperatorName,
                sortie_base: sortieBase,
                sortie_purpose: sortiePurpose,
                sortie_purpose_source: sortiePurposeSource,
                sortie_purpose_confidence: sortiePurposeConfidence,
                sortie_purpose_reasons: sortiePurposeReasons,
                sortie_takeoff_ts: sortieTakeoffTs,
                sortie_takeoff_day: sortieTakeoffTs.slice(0, 10),
                sortie_landing_ts: sortieLandingTs,
                sortie_landed_at_airport: sortieAirport,
                sortie_landing_dist_nm: Math.round(sortieLandingDistNm * 10) / 10,
                sortie_duration_min: sortieDurationMin,
                sortie_path_length_nm: Math.round(pathLenNm * 100) / 100,
                sortie_max_excursion_nm: Math.round(maxExcNm * 100) / 100,
                sortie_cycles: s.cycles,
                sortie_is_open: !!s.open,
                sortie_path_point_count: sortiePath.length,
                sortie_path: sortiePath,
                sortie_path_throttle: sortiePathThrottle,
                // Per ACS Areas of Operation (Private Pilot ACS) +
                // FAR 61.57 currency. Computed from REAL-only points.
                // Null when acsML is unavailable or the sortie has <
                // 30 real points. See acsML/README.md.
                sortie_acs: sortieAcs,
                sortie_performance: sortiePerf && sortiePerf.vs_max_fpm > 0 ? {
                  perf_source: sortiePerf.source,
                  vy_kts: sortiePerf.vy_kts,
                  vs_max_fpm: sortiePerf.vs_max_fpm,
                  cruise_kts: sortiePerf.cruise_kts,
                  max_kts: sortiePerf.max_kts,
                  hp: sortiePerf.hp,
                  cruise_throttle: sortiePerf.cruise_throttle,
                  throttle_at_takeoff: throttleAtTakeoff,
                } : { perf_source: 'engineless', throttle_at_takeoff: null },
                sortie_path_amendment: {
                  alt_offset_ft: altCal.offset_ft,
                  alt_offset_source: altCal.source,
                  alt_offset_cohort: altCal.cohort,
                  bridged_count: bridged.bridgedCount,
                  bridged_max_gap_s: bridged.bridgedMaxGapS,
                  bridged_total_gap_s: bridged.bridgedTotalGapS,
                  unbridged_gap_count: bridged.gaps.length,
                  unbridged_max_gap_s: bridged.gaps.reduce((m, g) => Math.max(m, g.gap_seconds), 0),
                },
                // Coverage breaks the bridger refused — the polyline
                // must NOT be drawn through these or it becomes a
                // misleading straight line. `before_index` is the
                // index of the first observed point AFTER the gap;
                // break the polyline immediately before it.
                sortie_path_gaps: bridged.gaps,
                sortie_max_pop_segment: null,
              }

              const sortieMaxPop = findSortieMaxPopSegment(sortiePath, POPGRID?.popAt, sortieFieldElev)
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
            sortie_day: sortieDayParam,
            sortie_days: sortieDaysParam,
            sortie_school: sortieSchoolFilter,
            sortie_source: sortieSource,
            sortie_purpose_classifier: purposeMLClassifyFn ? 'purposeML (real-points only, confidence ≥ 0.7) → geometry fallback' : 'geometry only (purposeML unavailable)',
            sortie_acs_classifier: acsMLIdentifyFn ? 'acsML (real-points only, ≥ 30 pts) — Private Pilot ACS Areas of Operation + FAR 61.57 currency. See acsML/README.md and kickoff_sorties_test.md.' : 'unavailable',
            sortie_count: sortieResults.length,
            sortie_invariant: 'sortie_max_pop_segment.sortie_max_pop_points === sortie_path.slice(sortie_max_pop_index_start, sortie_max_pop_index_end + 1). Every point in the slice has quality="real".',
            sortie_path_format: '[lat, lon, alt_msl_corrected_ft, ts_ms, quality] — quality ∈ {"real", "repaired"}. sortie_path_gaps lists "broken" coverage breaks; render those as hint lines, not solid path. sortie_path_throttle[i] is a parallel array of 0..1 throttle estimates aligned with sortie_path[i]; null entries mean either repaired/engineless or no prior real fix within 60 s.',
            sortie_throttle_model: 'climb_fraction + level_flight_fraction. climb_fraction = max(0, vs_fpm / vs_max_fpm); level_flight_fraction = (gs_kts / cruise_kts)^3 × cruise_throttle. Table-anchored (aircraftPerf.js) with sea-level vs_max + cruise derated ~3 %/1000 ft for non-turbocharged engines. Indicator-grade — wind, density altitude (without OAT), and turbo critical alts not modelled. See sortie_performance.throttle_at_takeoff as the per-sortie sanity check: ~1.0 means the table matches the airframe; << 0.9 means vs_max is over-reported in the table.',
            sortie_evaluation_rules: {
              // Load-bearing operator contract 2026-06-02: the path
              // carries three categories of data with different
              // rendering and evaluation rules. Clients MUST respect
              // these — making them explicit on every payload so a
              // new consumer can't accidentally evaluate against
              // synthesized data.
              real:     'quality="real" points — observed ADS-B fixes with alt amended by sortie_path_amendment.alt_offset_ft. SAFE for any metric / evaluation / classification.',
              repaired: 'quality="repaired" points — synthesized to patch a coverage gap < 5 min where motion is consistent. SAFE to render as solid path; NOT safe for any evaluation (max_pop / purposeML / pop_impact / dBA peak / etc.).',
              broken:   'sortie_path_gaps[] — coverage gaps the bridger refused (> 5 min, no node speed, implausible neighbor speed, or speed mismatch). DO NOT render as a solid line; use a hint line / dashed style between the bracketing real fixes. NEVER use these to compute anything.',
              guarantees: {
                sortie_max_pop_segment: 'computed from real-only windows (no repaired point ever lands inside the window); literal-slice invariant preserved',
                sortie_purpose:         'computed from real-only points when sortie_purpose_source="shape"; geometry classifier falls through when no shape verdict ≥ 0.7 confidence',
                sortie_path_throttle:   'non-null entries only at indices where sortie_path[i].quality === "real" AND a prior real fix exists within 60 s. Repaired/synthesized points always carry null. Engineless types (gliders, balloons) return all-null arrays and sortie_performance.perf_source="engineless".',
                sortie_acs:             'computed from REAL-only points (purposeML uses the same filter). Null when acsML lib missing OR the sortie has < 30 real points after the quality filter. tasks_demonstrated lists every ACS code that fired; currency_events lists per-takeoff/per-landing 61.57(a)/(b) events tagged day vs night by airport lat/lon. scores covers V.A/V.B/V.C/V.D performance-standard verdicts. Mean throttle from sortie_path_throttle drives the VII.B/VII.C/IX.A/IX.B selectors — see kickoff_sorties_test.md round-4 notes.',
              },
            },
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
