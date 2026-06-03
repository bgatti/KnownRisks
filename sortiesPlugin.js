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
import { impactSegments, pointImpact } from './src/popGrid.js'
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

// ── phaseML — labels each fix with a flight phase (on_ground, taxiing,
// pattern, practice_area, departing, inbound, en_route, nearby,
// landed_full_stop). The `landed_full_stop` phase is load-bearing for
// sortie boundary detection: oracle fires it when there's ≥ 30 s
// ground time AND (dwell ≥ 5 min OR end-of-track), with no new
// takeoff within 15 min — i.e. "the crew is done with this flight, log
// entry written." We use it as a hard sortie boundary that overrides
// the ground-threshold merge rules, so a powered aircraft that taxied
// in, shut down, and waited 7 min before another flight gets split
// even if the type-based threshold says merge.
let _phaseMLClassify = null
let _phaseMLAttempted = false
async function getPhaseMLClassify() {
  if (_phaseMLAttempted) return _phaseMLClassify
  _phaseMLAttempted = true
  try {
    const mod = await import('./phaseML/index.js')
    if (mod && typeof mod.classifyTrack === 'function') {
      _phaseMLClassify = mod.classifyTrack
    }
  } catch (err) {
    console.warn('[sorties] phaseML unavailable, no sortie_phases field:', err && err.message)
  }
  return _phaseMLClassify
}

// Compress phaseML per-fix labels into contiguous {phase, ts_start,
// ts_end} segments for compact wire shape. Adjacent same-phase fixes
// merge into one entry.
function phaseLabelsToSegments(labels, canonicalPts) {
  if (!Array.isArray(labels) || !Array.isArray(canonicalPts)) return []
  const segs = []
  let cur = null
  for (let i = 0; i < labels.length && i < canonicalPts.length; i++) {
    const lab = labels[i]
    const ph = lab && lab.phase
    if (!ph) continue
    const tsMs = canonicalPts[i].tsUnix * 1000
    // sortieCue (no_new_takeoff / track_ended / crew_swap_hour_marker)
    // is carried on landed_full_stop labels by phaseML's post-hoc
    // overlay. Preserve it so downstream consumers can see WHY a
    // boundary fired without re-running the oracle.
    const cue = lab && lab.sortieCue ? lab.sortieCue : null
    if (!cur || cur.phase !== ph || cur.cue !== cue) {
      if (cur) cur.ts_end_ms = tsMs
      cur = { phase: ph, ts_start_ms: tsMs, ts_end_ms: tsMs, cue }
      segs.push(cur)
    } else {
      cur.ts_end_ms = tsMs
    }
  }
  return segs
}

const SORTIE_GROUND_MS = 5 * 60_000
// Gliders turn around faster than typical powered aircraft. 2-3 min
// is normal at busy glider ops (KBDU on a thermal day). With the
// 5-min powered threshold, two adjacent glider sorties get merged
// into one bogus "double flight." Operator brief 2026-06-02.
const SORTIE_GROUND_MS_SHORT_TURN = 2 * 60_000
// Tow planes — each climb tows a (potentially different) glider, so
// every land+rehook cycle is a new sortie. Threshold is low enough
// to split any actual stop on the runway / taxiway (typical re-hook
// is 30-60 s) but tolerant of a brief touch-and-go-style ground
// blip from a single ADS-B fix dipping below the ceiling. Operator
// brief 2026-06-03: "3 passes over the runway calculated at 3 kts.
// that is a stop, a connect, and a new sortie."
const SORTIE_GROUND_MS_TOW_PLANE = 20_000
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

// Find nearest entry in the ENRICH_AP catalog within `maxNm`. Returns
// the airport object (with .code, .lat, .lon, .elev) or null. Used to
// resolve sortie_dep_airport / sortie_landed_at_airport from the
// path's first/last fix — Ask S-14 + Ask S-13.
function nearestEnrichApWithin(lat, lon, enrichAp, maxNm) {
  let best = null, bestD = Infinity
  for (const ap of (enrichAp || [])) {
    const d = distNmAp(lat, lon, ap.lat, ap.lon)
    if (d < bestD) { bestD = d; best = ap }
  }
  return (best && bestD <= maxNm) ? best : null
}

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
// Returns a list of sortie sessions. Each one carries the effective
// ground threshold used to bracket it AND a short string explaining
// why ("type_default" / "auto_short_cycle_pattern") so the wire row
// can surface it for the operator. The "auto" detector fires when a
// track contains ≥ 3 airborne sessions whose median inter-session
// ground gap is < 5 min — classic tow-plane or pattern-rich training
// behaviour. In that case we tighten to the tow-plane threshold so
// every land + (re-hook | re-board | shutdown-check) becomes its
// own sortie, even when the type code is null and the tail isn't in
// the PA25/PA18/PIAT/PC6 regex. Operator brief 2026-06-03 —
// "we should have the tow planes well identified."
function detectSortiesInTrack(sortieAllPts, sortieGroundCeil, sortieGroundMs = SORTIE_GROUND_MS, hardBoundaries = []) {
  const sortieList = []
  if (!Array.isArray(sortieAllPts) || sortieAllPts.length < 2) return sortieList
  const sortieSessions = []
  let sortieInAir = false
  let sortieSessionStart = -1
  let sortieSessionPeakAlt = 0
  for (let i = 0; i < sortieAllPts.length; i++) {
    const p = sortieAllPts[i]
    if (p[2] == null || p[3] == null) continue
    const isAir = p[2] > sortieGroundCeil
    if (!sortieInAir && isAir) {
      sortieInAir = true
      sortieSessionStart = i
      sortieSessionPeakAlt = p[2]
    } else if (sortieInAir && isAir) {
      if (p[2] > sortieSessionPeakAlt) sortieSessionPeakAlt = p[2]
    } else if (sortieInAir && !isAir) {
      sortieInAir = false
      sortieSessions.push({ s: sortieSessionStart, e: i, open: false, peakAlt: sortieSessionPeakAlt })
      sortieSessionStart = -1
      sortieSessionPeakAlt = 0
    }
  }
  if (sortieInAir && sortieSessionStart >= 0) {
    sortieSessions.push({ s: sortieSessionStart, e: sortieAllPts.length - 1, open: true, peakAlt: sortieSessionPeakAlt })
  }
  if (!sortieSessions.length) return sortieList

  // Pattern-aware threshold override. Only widens (never tightens
  // beyond) the requested default — so a glider/tow-typed caller that
  // already asked for SORTIE_GROUND_MS_TOW_PLANE / SORTIE_GROUND_MS_
  // SHORT_TURN keeps that. The override only fires for tracks that
  // asked for the long 5-min default AND display a tow-like shape:
  //
  //   • ≥ 3 airborne sessions
  //   • median session DURATION < 5 min (climb-only profile, not a
  //     pattern T&G or training session)
  //   • median session PEAK ALT ≥ groundCeil + 1500 ft (tow release
  //     altitude is typically 2000-3500 ft AGL; pattern T&Gs peak at
  //     ~ 800-1200 ft AGL — this is the load-bearing discriminator
  //     since pattern T&Gs can also have short session durations)
  //   • median inter-session ground gap < 3 min (continuous re-hook
  //     cadence, not a re-brief / re-board)
  //
  // Earlier rounds over-fired on trainers (C172/RV10) doing pattern
  // work — their sessions are short too, but stay LOW. Adding the
  // peak-altitude condition eliminates that false positive without
  // losing tow-plane detection on type-null tracks like N143J.
  const SORTIE_AUTO_TOW_PEAK_AGL_FT = 1500
  let effectiveGroundMs = sortieGroundMs
  let thresholdSource = sortieGroundMs === SORTIE_GROUND_MS ? 'type_default'
    : sortieGroundMs === SORTIE_GROUND_MS_TOW_PLANE ? 'type_tow_plane'
    : sortieGroundMs === SORTIE_GROUND_MS_SHORT_TURN ? 'type_glider' : 'caller_supplied'
  if (sortieGroundMs > SORTIE_GROUND_MS_TOW_PLANE && sortieSessions.length >= 3) {
    const sortieGaps = []
    const sortieDurs = []
    const sortiePeaks = []
    for (let i = 0; i < sortieSessions.length; i++) {
      const dMs = (sortieAllPts[sortieSessions[i].e][3] || 0)
                - (sortieAllPts[sortieSessions[i].s][3] || 0)
      sortieDurs.push(dMs)
      sortiePeaks.push(sortieSessions[i].peakAlt || 0)
      if (i > 0) {
        const gapMs = (sortieAllPts[sortieSessions[i].s][3] || 0)
                    - (sortieAllPts[sortieSessions[i - 1].e][3] || 0)
        sortieGaps.push(gapMs)
      }
    }
    sortieGaps.sort((a, b) => a - b)
    sortieDurs.sort((a, b) => a - b)
    sortiePeaks.sort((a, b) => a - b)
    const sortieMedianGapMs = sortieGaps[Math.floor(sortieGaps.length / 2)]
    const sortieMedianDurMs = sortieDurs[Math.floor(sortieDurs.length / 2)]
    const sortieMedianPeakAlt = sortiePeaks[Math.floor(sortiePeaks.length / 2)]
    const sortieFieldElev = sortieGroundCeil - SORTIE_GROUND_AGL_FT
    if (sortieMedianGapMs < 3 * 60_000
        && sortieMedianDurMs < 5 * 60_000
        && sortieMedianPeakAlt >= sortieFieldElev + SORTIE_AUTO_TOW_PEAK_AGL_FT) {
      effectiveGroundMs = SORTIE_GROUND_MS_TOW_PLANE
      thresholdSource = 'auto_short_cycle_pattern'
    }
  }

  // Helper: returns the cue of the first hardBoundary segment whose
  // time range overlaps the [a, b] gap, or null if none. Each entry in
  // hardBoundaries[] is { ts_start_ms, ts_end_ms, cue } from phaseML's
  // landed_full_stop labelling. When a cue is returned, the merge MUST
  // split — the crew is logged as ended; the next airborne session is
  // a new sortie regardless of the type-based ground threshold. The
  // cue identifies WHY phaseML decided this is a boundary
  // (no_new_takeoff / crew_swap_hour_marker / track_ended).
  const cueForGap = (a, b) => {
    for (const hb of hardBoundaries) {
      if (hb.ts_end_ms >= a && hb.ts_start_ms <= b) return hb.cue || 'unknown'
    }
    return null
  }
  let sortieCur = { ...sortieSessions[0], cycles: 1, ended_by: null }
  for (let i = 1; i < sortieSessions.length; i++) {
    const next = sortieSessions[i]
    const gapStart = sortieAllPts[sortieCur.e][3] || 0
    const gapEnd = sortieAllPts[next.s][3] || 0
    const sortieGroundGapMs = gapEnd - gapStart
    const cue = cueForGap(gapStart, gapEnd)
    if (sortieGroundGapMs < effectiveGroundMs && !cue) {
      sortieCur.e = next.e
      sortieCur.cycles += 1
      if (next.open) sortieCur.open = true
    } else {
      sortieCur.ended_by = cue ? `phaseml_landed_full_stop:${cue}` : 'ground_threshold'
      sortieList.push(sortieCur)
      sortieCur = { ...next, cycles: 1, ended_by: null }
    }
  }
  // Last sortie ends at the track edge — flag it so callers can render
  // an "open" hint differently from a clean shutdown.
  sortieCur.ended_by = sortieCur.open ? 'track_edge' : 'track_end'
  sortieList.push(sortieCur)
  // Stamp the effective threshold + source on every sortie in this
  // track. Callers read these to populate sortie_ground_threshold_min
  // and sortie_ground_threshold_source on the wire row.
  for (const s of sortieList) {
    s.effective_ground_ms = effectiveGroundMs
    s.threshold_source = thresholdSource
  }
  return sortieList
}

// Landing count from the altitude track. Operator brief 2026-06-03:
// "maybe sorties could count landings by looking at the altitude
// track. it's pretty obvious: try a technique." Hysteresis on AGL:
//
//   AGL < LOW_AGL_FT  → state "low" (effectively on the runway)
//   AGL > HIGH_AGL_FT → state "high" (climbed back out)
//
// Each high → low → high cycle is a touch-and-go; ending the sortie
// in the "low" state is a full-stop. The two thresholds straddle a
// dead-band so single noisy fixes can't toggle state.
//
// REAL points only — repaired points are interpolated and would smear
// the dip a landing produces. Returns null on engineless / unknown
// elev tracks where the AGL reference isn't trustworthy.
const SORTIE_LANDING_LOW_AGL_FT = 300
const SORTIE_LANDING_HIGH_AGL_FT = 500
function countSortieLandings(sortiePath, fieldElevFt) {
  if (!Array.isArray(sortiePath) || sortiePath.length < 3) return null
  if (!Number.isFinite(fieldElevFt)) return null
  let touchAndGo = 0
  let fullStop = 0
  let state = null  // null until first real fix
  let lastLowTs = null
  let firstLowTs = null
  for (const p of sortiePath) {
    if (p[4] !== 'real') continue
    if (p[2] == null) continue
    const agl = p[2] - fieldElevFt
    if (state == null) {
      state = agl < SORTIE_LANDING_LOW_AGL_FT ? 'low' : 'high'
      if (state === 'low') { lastLowTs = p[3]; firstLowTs = p[3] }
      continue
    }
    if (state === 'high' && agl < SORTIE_LANDING_LOW_AGL_FT) {
      state = 'low'
      firstLowTs = p[3]
      lastLowTs = p[3]
    } else if (state === 'low' && agl > SORTIE_LANDING_HIGH_AGL_FT) {
      touchAndGo += 1
      state = 'high'
      firstLowTs = null
    } else if (state === 'low') {
      lastLowTs = p[3]
    }
  }
  if (state === 'low') fullStop = 1
  return {
    total: touchAndGo + fullStop,
    touch_and_go: touchAndGo,
    full_stop: fullStop,
    last_low_ts: lastLowTs ? new Date(lastLowTs).toISOString() : null,
  }
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
// Module-scope per-tail base cache. The base airport for a tail is
// stable over hours, so we share the lookup across all sortie
// requests. Misses (tails we didn't get a row for) are also cached
// so we don't repeatedly query the DB for the same orphan tails.
const TAIL_BASE_CACHE = new Map()     // tail → { base: string|null, ts: number }
const TAIL_BASE_TTL_MS = 60 * 60_000  // 1 h — bases rarely change

export function sortiesApiPlugin({ db, ENRICH_AP, POPGRID }) {
  // Per-tail base lookup. Hits the module-scope cache first, queries
  // `tracks` ONLY for tails we don't have a fresh entry for, and
  // bounds the DB call so a stuck pg-pool can't take the whole sortie
  // endpoint down with it. The `out` map is built from the cache +
  // any new rows; cache misses get inserted even when null so we don't
  // re-query orphan tails on every request.
  async function fetchTailBases(tails) {
    const out = new Map()
    const now = Date.now()
    const need = []
    for (const t of tails) {
      const c = TAIL_BASE_CACHE.get(t)
      if (c && now - c.ts < TAIL_BASE_TTL_MS) {
        if (c.base) out.set(t, c.base)
      } else {
        need.push(t)
      }
    }
    if (!need.length || !db || !db.useDb) return out
    // Hard cap on the DB hop so a saturated pool can't gate the whole
    // sortie response. When the timeout fires the response still
    // serves — bases for these tails just fall through to the school
    // index's airport (or null), and we DO NOT poison the cache so
    // the next request will retry.
    const ROW_TIMEOUT_MS = 1500
    try {
      const query = db.queryDb(
        `SELECT call,
           (array_agg(base_airport ORDER BY date DESC) FILTER (WHERE base_airport IS NOT NULL))[1] AS base
         FROM tracks WHERE call = ANY($1) GROUP BY call`,
        [need],
      )
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('row_timeout')), ROW_TIMEOUT_MS))
      const r = await Promise.race([query, timeout])
      const seen = new Set()
      for (const row of r.rows) {
        const tail = String(row.call || '').toUpperCase()
        const base = row.base || null
        seen.add(tail)
        TAIL_BASE_CACHE.set(tail, { base, ts: now })
        if (base) out.set(tail, base)
      }
      // Tails the DB returned nothing for: cache the negative result
      // so we don't re-query them next request either.
      for (const t of need) {
        if (!seen.has(t)) TAIL_BASE_CACHE.set(t, { base: null, ts: now })
      }
    } catch (err) {
      // DB unhappy or timed out — degrade quietly. Do NOT cache.
      console.warn('[sorties] fetchTailBases degraded:', err && err.message)
    }
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
          //
          // Bounded wait: when pg-pool is saturated by other endpoints
          // a cold-cache hit can stall 30-50 s. Cap at 4 s and return
          // an empty payload with sortie_source="db_timeout" so the
          // client can render a transient banner instead of the request
          // hanging or failing outright. (Subsequent requests usually
          // succeed once loadLiveFromDb's own 30 s cache warms.)
          const LOAD_TIMEOUT_MS = 4000
          const timeoutErr = () => new Promise((_, rej) => setTimeout(() => rej(new Error('load_timeout')), LOAD_TIMEOUT_MS))
          let sortieLive
          let sortieSource
          if (db && db.useDb) {
            if (sortieDayParam || sortieDaysParam) {
              const fromDate = new Date(sortieCutoffStartMs).toISOString().slice(0, 10)
              const toDate   = new Date(sortieCutoffEndMs - 1).toISOString().slice(0, 10)
              try {
                sortieLive = await Promise.race([db.loadLiveFromDbByDateRange(fromDate, toDate), timeoutErr()])
                sortieSource = `historical:live_tracks ${fromDate}..${toDate}`
              } catch (err) {
                console.warn('[sorties] historical load degraded:', err && err.message)
                sortieLive = { tracks: [] }
                sortieSource = `db_timeout:historical ${fromDate}..${toDate}`
              }
            } else {
              try {
                sortieLive = await Promise.race([db.loadLiveFromDb(sortieHours), timeoutErr()])
                sortieSource = 'live'
              } catch (err) {
                console.warn('[sorties] live load degraded:', err && err.message)
                sortieLive = { tracks: [] }
                sortieSource = `db_timeout:live ${sortieHours}h`
              }
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
          // phaseML — lazy-loaded once per process. Labels each fix
          // with a flight phase; we use landed_full_stop as a hard
          // sortie boundary signal (overrides ground-threshold merge)
          // and expose the segment list per sortie as sortie_phases.
          const phaseMLClassifyFn = await getPhaseMLClassify()

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
            // Tow planes get the tightest threshold — every climb is a
            // new sortie because each tow may pull a different glider.
            // Gliders get the 2-min short-turn threshold. Default
            // powered aircraft keep 5 min so a single T&G/full-stop-
            // taxi-back doesn't fragment one flight into several.
            const sortieGroundMsForType = sortieIsTowPlane ? SORTIE_GROUND_MS_TOW_PLANE
              : sortieIsGlider ? SORTIE_GROUND_MS_SHORT_TURN
              : SORTIE_GROUND_MS

            // phaseML pre-pass — labels each fix; we extract the
            // landed_full_stop segments to use as hard sortie
            // boundaries (a real shutdown breaks any merge, even when
            // the type-based threshold says merge). Falls through to
            // an empty list when phaseML is unavailable; downstream
            // behaviour is identical to pre-phaseML.
            let sortieTrackPhases = []
            let sortieHardBoundaries = []
            if (phaseMLClassifyFn) {
              const phaseCanonical = []
              for (const p of sortieAllPts) {
                if (p[0] == null || p[1] == null || p[2] == null || p[3] == null) continue
                phaseCanonical.push({ lat: p[0], lon: p[1], altMslFt: p[2], tsUnix: Math.floor(p[3] / 1000) })
              }
              if (phaseCanonical.length >= 5) {
                try {
                  const labels = phaseMLClassifyFn(phaseCanonical)
                  if (Array.isArray(labels) && labels.length === phaseCanonical.length) {
                    sortieTrackPhases = phaseLabelsToSegments(labels, phaseCanonical)
                    sortieHardBoundaries = sortieTrackPhases.filter(seg => seg.phase === 'landed_full_stop')
                  }
                } catch (err) {
                  console.warn('[sorties] phaseML classify error for', sortieTail, err && err.message)
                }
              }
            }
            const sortieList = detectSortiesInTrack(sortieAllPts, sortieGroundCeil, sortieGroundMsForType, sortieHardBoundaries)
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
              // Departure / arrival airport resolution — done on the raw
              // path's first / last fix (before alt amendment, which
              // doesn't move lat/lon anyway). Each looks up the nearest
              // known airport within SORTIE_AIRPORT_NEAR_NM. dep_ap is
              // load-bearing for sortie_dep_airport (Ask S-14) and for
              // the sortie_base implied-fallback (also S-14). arr_ap is
              // null when the aircraft is still in flight at window
              // edge — answers Ask S-13's "landed-at-airport but still
              // 2000 ft AGL" bug.
              const sortieDepAp = nearestEnrichApWithin(rawPath[0][0], rawPath[0][1], ENRICH_AP, SORTIE_AIRPORT_NEAR_NM)
              const sortieArrAp = !s.open
                ? nearestEnrichApWithin(rawPath[rawPath.length - 1][0], rawPath[rawPath.length - 1][1], ENRICH_AP, SORTIE_AIRPORT_NEAR_NM)
                : null
              const sortieDepAirport = sortieDepAp ? sortieDepAp.code : null
              const sortieLandedAtAirport = sortieArrAp ? sortieArrAp.code : null
              // Base resolution chain (S-14):
              //   1. DB per-tail history (most-recent-non-null base_airport)
              //   2. School index home airport
              //   3. Implied — when dep == arr at the SAME airport for a
              //      closed sortie, the aircraft is operating from there
              // sortie_base_source carries the provenance so consumers
              // know how confident they should be.
              let sortieBase = tailBaseMap.get(sortieTail) || null
              let sortieBaseSource = sortieBase ? 'tracks_db' : null
              if (!sortieBase && schoolEntry) {
                sortieBase = schoolEntry.airport || null
                if (sortieBase) sortieBaseSource = 'schools_index'
              }
              if (!sortieBase && sortieDepAp && sortieArrAp && sortieDepAp.code === sortieArrAp.code) {
                sortieBase = sortieDepAp.code
                sortieBaseSource = 'implied'
              }

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
              // S-13 fix: measure max excursion from the path's FIRST
              // fix (takeoff point), not from the queried airport
              // centre. The previous airport-centre version produced
              // sortie_max_excursion_nm > sortie_path_length_nm, which
              // is geometrically impossible — a path can't reach a
              // point further from its start than the path is long.
              // First-fix anchoring makes the two metrics commensurate
              // and matches what the operator intuited.
              let pathLenNm = 0, maxExcNm = 0
              const sortieStartLat = sortiePath[0][0]
              const sortieStartLon = sortiePath[0][1]
              for (let k = 0; k < sortiePath.length; k++) {
                const p = sortiePath[k]
                const d = distNmAp(p[0], p[1], sortieStartLat, sortieStartLon)
                if (d > maxExcNm) maxExcNm = d
                if (k > 0) {
                  const a = sortiePath[k - 1]
                  pathLenNm += distNmAp(a[0], a[1], p[0], p[1])
                }
              }

              // Per-fix noise impact — operator brief 2026-06-03:
              // "sortie flight paths need to include noise impact
              // based on the existing noise model." Uses pointImpact
              // from popGrid.js, the same kernel impactSegments() and
              // findSortieMaxPopSegment() rely on. Output is
              // people/km² × (REF_AGL / AGL)² — louder beneath more
              // people, attenuating with altitude. Scale is consistent
              // across sorties, so clients can autoscale by
              // percentile.
              //
              // Repaired points get null per the
              // sortie_evaluation_rules.repaired contract — bridged
              // lat/lon/alt are interpolated and not safe to evaluate.
              // When POPGRID is unavailable, all entries are null.
              const sortiePathPopImpact = new Array(sortiePath.length).fill(null)
              const sortiePopAt = POPGRID && POPGRID.popAt
              if (sortiePopAt) {
                for (let k = 0; k < sortiePath.length; k++) {
                  const p = sortiePath[k]
                  if (p[4] !== 'real') continue
                  if (p[0] == null || p[1] == null) continue
                  const v = pointImpact(p[0], p[1], p[2] || 0, sortiePopAt)
                  sortiePathPopImpact[k] = Number.isFinite(v) ? Math.round(v * 100) / 100 : null
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
              let sortieAcsAnnotations = null
              if (acsMLIdentifyFn) {
                // Rebuild the real-points array in case the purposeML
                // block was skipped (fn null path). acsRealToPathIdx[i]
                // remembers which sortie_path index acsRealPts[i] came
                // from — used below to remap acsML's per-detection
                // startIdx/endIdx (which index acsRealPts) back to
                // sortie_path indices for the sortie_annotations[]
                // halo-render shape.
                const acsRealPts = []
                const acsRealToPathIdx = []
                for (let k = 0; k < sortiePath.length; k++) {
                  const p = sortiePath[k]
                  if (p[4] !== 'real') continue
                  if (p[0] == null || p[1] == null || p[2] == null || p[3] == null) continue
                  acsRealPts.push({
                    lat: p[0], lon: p[1], altMslFt: p[2],
                    tsUnix: Math.floor(p[3] / 1000),
                  })
                  acsRealToPathIdx.push(k)
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
                      // Build sortie_annotations[] per Ask S-9 shape from
                      // the new task_segments[] array acsML now emits.
                      // Indices in task_segments reference acsRealPts;
                      // remap to sortie_path indices via
                      // acsRealToPathIdx. Verdict is "not_evaluated" for
                      // every auto-detected annotation per S-9c —
                      // automated detection should never grade pilot
                      // performance.
                      const segs = a.task_segments || []
                      sortieAcsAnnotations = []
                      for (const seg of segs) {
                        if (!Number.isFinite(seg.startIdx) || !Number.isFinite(seg.endIdx)) continue
                        const pStart = acsRealToPathIdx[Math.max(0, Math.min(seg.startIdx, acsRealToPathIdx.length - 1))]
                        const pEnd = acsRealToPathIdx[Math.max(0, Math.min(seg.endIdx, acsRealToPathIdx.length - 1))]
                        if (pStart == null || pEnd == null) continue
                        sortieAcsAnnotations.push({
                          kind: 'acs',
                          acs_code: seg.code,
                          acs_title: seg.name,
                          point_index_start: pStart,
                          point_index_end: pEnd,
                          ts_start: new Date(seg.startTs * 1000).toISOString(),
                          ts_end: new Date(seg.endTs * 1000).toISOString(),
                          verdict: 'not_evaluated',
                          source: 'auto',
                          notes: seg.explanation || null,
                          confidence: seg.confidence,
                          evidence_type: seg.type,
                        })
                      }
                    }
                  } catch (err) {
                    console.warn('[sorties] acsML identify error for', sortieTail, err && err.message)
                  }
                }
              }

              // Slice the track's phase segments to this sortie's
              // time window. Each entry: { phase, ts_start, ts_end }.
              // Clipped to the sortie's bounds so a phase segment
              // straddling a boundary doesn't bleed into the next
              // sortie.
              const sortieStartMs = sortieStartPt[3] || 0
              const sortieEndMs = sortieEndPt[3] || 0
              const sortiePhases = sortieTrackPhases.length
                ? sortieTrackPhases
                    .filter(seg => seg.ts_end_ms >= sortieStartMs && seg.ts_start_ms <= sortieEndMs)
                    .map(seg => ({
                      phase: seg.phase,
                      ts_start: new Date(Math.max(seg.ts_start_ms, sortieStartMs)).toISOString(),
                      ts_end: new Date(Math.min(seg.ts_end_ms, sortieEndMs)).toISOString(),
                    }))
                : null

              const sortieRow = {
                sortie_id: sortieId,
                sortie_tail: sortieTail,
                sortie_type: sortieTrack.type || null,
                sortie_is_glider: sortieIsGlider,
                sortie_is_tow_plane: sortieIsTowPlane,
                sortie_ground_threshold_min: (s.effective_ground_ms || sortieGroundMsForType) / 60_000,
                sortie_ground_threshold_source: s.threshold_source || null,
                sortie_boundary_source: s.ended_by || null,
                sortie_phases: sortiePhases,
                sortie_operator: sortieOperator,
                sortie_operator_name: sortieOperatorName,
                sortie_base: sortieBase,
                sortie_base_source: sortieBaseSource,
                sortie_dep_airport: sortieDepAirport,
                sortie_purpose: sortiePurpose,
                sortie_purpose_source: sortiePurposeSource,
                sortie_purpose_confidence: sortiePurposeConfidence,
                sortie_purpose_reasons: sortiePurposeReasons,
                sortie_takeoff_ts: sortieTakeoffTs,
                sortie_takeoff_day: sortieTakeoffTs.slice(0, 10),
                sortie_landing_ts: sortieLandingTs,
                // S-13 fix: only stamp landed_at_airport when the
                // aircraft is no longer airborne. Open sorties (still
                // in flight at window edge) get null so a 2000 ft AGL
                // fix doesn't get labelled as "landed at KBDU".
                sortie_landed_at_airport: sortieLandedAtAirport,
                sortie_landing_dist_nm: Math.round(sortieLandingDistNm * 10) / 10,
                sortie_duration_min: sortieDurationMin,
                sortie_path_length_nm: Math.round(pathLenNm * 100) / 100,
                sortie_max_excursion_nm: Math.round(maxExcNm * 100) / 100,
                sortie_cycles: s.cycles,
                // Landing count derived from the altitude track: each
                // dip below field+300 ft AGL followed by climbout
                // above field+500 ft is a touch_and_go; ending the
                // sortie below the low threshold is a full_stop. See
                // countSortieLandings() for the hysteresis logic.
                sortie_landings: countSortieLandings(sortiePath, sortieFieldElev),
                sortie_is_open: !!s.open,
                sortie_path_point_count: sortiePath.length,
                sortie_path: sortiePath,
                sortie_path_throttle: sortiePathThrottle,
                sortie_path_pop_impact: sortiePathPopImpact,
                // Per ACS Areas of Operation (Private Pilot ACS) +
                // FAR 61.57 currency. Computed from REAL-only points.
                // Null when acsML is unavailable or the sortie has <
                // 30 real points. See acsML/README.md.
                sortie_acs: sortieAcs,
                // Per-segment ACS annotations with sortie_path-indexed
                // brackets — see Ask S-9 in kickoff_sorties_test.md.
                // Each entry's point_index_start / point_index_end
                // resolve through sortie_path so the halo-renderer can
                // bracket the segment without index gymnastics.
                sortie_annotations: sortieAcsAnnotations,
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

          // Glider ↔ tow pairing — operator brief 2026-06-03: "maybe
          // we have gliders correlated to tow, but also tow correlated
          // to gliders (sortie can have related sortie)." Per-sortie
          // sortie_related_sorties[] entries are emitted on BOTH the
          // tow plane's row AND the glider's row so either drill-down
          // resolves to the partner. A pair fires when:
          //   - the two sorties' [takeoff_ts, landing_ts] windows
          //     overlap by ≥ 30 s
          //   - sampling at the tow plane's real fixes during the
          //     overlap, the glider's nearest-time real fix is within
          //     900 ft laterally AND 300 ft vertically for ≥ 50 % of
          //     the samples (mirrors adsb.js pairTowWithGliders'
          //     0.1 nm / 300 ft thresholds but evaluated across the
          //     whole overlap, not just a snapshot).
          // The "tow plane" side accepts both type-flagged (PA25 etc.)
          // and auto-detected (auto_short_cycle_pattern) tracks so
          // tows without a known type still pair.
          const isTowSide = (s) => s.sortie_is_tow_plane
            || s.sortie_ground_threshold_source === 'auto_short_cycle_pattern'
          const isGliderSide = (s) => s.sortie_is_glider
          const PAIR_LAT_FT = 900     // ≈ 0.15 nm — slightly looser than live (0.1) because sortie paths are time-merged
          const PAIR_ALT_FT = 300
          const PAIR_MIN_OVERLAP_MS = 30_000
          const PAIR_MIN_SAMPLES = 3
          const PAIR_MIN_IN_RANGE_FRAC = 0.5
          // Build time-sorted real-only sub-paths once per sortie, keyed
          // by sortie_id, so we can binary-search closest-time matches.
          const realPathByIdx = new Map()
          const realPathFor = (row) => {
            if (realPathByIdx.has(row.sortie_id)) return realPathByIdx.get(row.sortie_id)
            const arr = (row.sortie_path || []).filter(p => p[4] === 'real')
            realPathByIdx.set(row.sortie_id, arr)
            return arr
          }
          const closestByTime = (path, ts) => {
            if (!path.length) return null
            let lo = 0, hi = path.length - 1
            while (lo < hi) {
              const mid = (lo + hi) >> 1
              if (path[mid][3] < ts) lo = mid + 1
              else hi = mid
            }
            if (lo > 0 && Math.abs(path[lo - 1][3] - ts) < Math.abs(path[lo][3] - ts)) lo -= 1
            return path[lo]
          }
          const tows = sortieResults.filter(isTowSide)
          const gliders = sortieResults.filter(isGliderSide)
          for (const tow of tows) {
            const tT = [Date.parse(tow.sortie_takeoff_ts), Date.parse(tow.sortie_landing_ts)]
            const towReal = realPathFor(tow)
            if (towReal.length < PAIR_MIN_SAMPLES) continue
            for (const glider of gliders) {
              if (glider.sortie_tail === tow.sortie_tail) continue
              const tG = [Date.parse(glider.sortie_takeoff_ts), Date.parse(glider.sortie_landing_ts)]
              const overlapStart = Math.max(tT[0], tG[0])
              const overlapEnd = Math.min(tT[1], tG[1])
              if (overlapEnd - overlapStart < PAIR_MIN_OVERLAP_MS) continue
              const gliderReal = realPathFor(glider)
              if (gliderReal.length < PAIR_MIN_SAMPLES) continue
              let samples = 0, inRange = 0, sumLatFt = 0, sumAltFt = 0
              for (const tp of towReal) {
                if (tp[3] < overlapStart || tp[3] > overlapEnd) continue
                const gp = closestByTime(gliderReal, tp[3])
                if (!gp) continue
                if (Math.abs(gp[3] - tp[3]) > 10_000) continue   // > 10 s slop, skip
                samples++
                const latFt = distFt(tp[0], tp[1], gp[0], gp[1])
                const altFt = Math.abs((tp[2] || 0) - (gp[2] || 0))
                sumLatFt += latFt
                sumAltFt += altFt
                if (latFt < PAIR_LAT_FT && altFt < PAIR_ALT_FT) inRange++
              }
              if (samples < PAIR_MIN_SAMPLES) continue
              if (inRange / samples < PAIR_MIN_IN_RANGE_FRAC) continue
              const overlapSec = Math.round((overlapEnd - overlapStart) / 1000)
              const meanLatFt = Math.round(sumLatFt / samples)
              const meanAltFt = Math.round(sumAltFt / samples)
              const inRangeFrac = Math.round(inRange / samples * 100) / 100
              if (!Array.isArray(tow.sortie_related_sorties)) tow.sortie_related_sorties = []
              tow.sortie_related_sorties.push({
                sortie_id: glider.sortie_id,
                tail: glider.sortie_tail,
                type: glider.sortie_type,
                role: 'towed_glider',
                overlap_seconds: overlapSec,
                sample_count: samples,
                in_range_count: inRange,
                in_range_fraction: inRangeFrac,
                mean_lateral_ft: meanLatFt,
                mean_vertical_ft: meanAltFt,
              })
              if (!Array.isArray(glider.sortie_related_sorties)) glider.sortie_related_sorties = []
              glider.sortie_related_sorties.push({
                sortie_id: tow.sortie_id,
                tail: tow.sortie_tail,
                type: tow.sortie_type,
                role: 'tow_plane',
                overlap_seconds: overlapSec,
                sample_count: samples,
                in_range_count: inRange,
                in_range_fraction: inRangeFrac,
                mean_lateral_ft: meanLatFt,
                mean_vertical_ft: meanAltFt,
              })
            }
          }

          // ACS maneuver index — operator brief 2026-06-03: "I need a
          // way to see all identified maneuvers of ACS / so I need to
          // be able to request a sample of flights that covers the
          // maneuvers." Map of ACS code → array of sortie objects
          // demonstrating it, sorted by best-evidence confidence
          // descending so the first entry is the highest-confidence
          // sample. Each entry carries the sortie_id, tail, type, the
          // task's instance count, and the peak evidence confidence
          // for that code on that sortie — enough for a drill-down
          // picker without re-walking the whole response.
          const sortieAcsIndex = {}
          for (const row of sortieResults) {
            const tasks = row.sortie_acs && Array.isArray(row.sortie_acs.tasks_demonstrated)
              ? row.sortie_acs.tasks_demonstrated : []
            const seen = new Set()
            for (const t of tasks) {
              if (!t || !t.code) continue
              if (seen.has(t.code)) continue
              seen.add(t.code)
              const peakConf = (t.evidence || []).reduce((m, e) => Math.max(m, e?.confidence || 0), 0)
              if (!sortieAcsIndex[t.code]) sortieAcsIndex[t.code] = {
                code: t.code, name: t.name || null, sample_count: 0, samples: [],
              }
              sortieAcsIndex[t.code].sample_count++
              sortieAcsIndex[t.code].samples.push({
                sortie_id: row.sortie_id,
                tail: row.sortie_tail,
                type: row.sortie_type,
                purpose: row.sortie_purpose,
                takeoff_ts: row.sortie_takeoff_ts,
                landing_ts: row.sortie_landing_ts,
                duration_min: row.sortie_duration_min,
                instances: t.instances,
                peak_confidence: peakConf,
              })
            }
            // Denormalized code list for fast row-level filtering on
            // the test page — saves walking tasks_demonstrated to
            // ask "does this sortie include IX.A?".
            row.sortie_acs_codes = [...seen].sort()
          }
          for (const key of Object.keys(sortieAcsIndex)) {
            sortieAcsIndex[key].samples.sort((a, b) => b.peak_confidence - a.peak_confidence)
          }

          res.end(JSON.stringify({
            sortie_airport: sortieAirport,
            sortie_window_hours: sortieHours,
            sortie_day: sortieDayParam,
            sortie_days: sortieDaysParam,
            sortie_school: sortieSchoolFilter,
            sortie_source: sortieSource,
            sortie_purpose_classifier: purposeMLClassifyFn ? 'purposeML (real-points only, confidence ≥ 0.7) → geometry fallback' : 'geometry only (purposeML unavailable)',
            sortie_acs_classifier: acsMLIdentifyFn ? 'acsML (real-points only, ≥ 30 pts) — Private Pilot ACS Areas of Operation + FAR 61.57 currency. See acsML/README.md and kickoff_sorties_test.md.' : 'unavailable',
            sortie_phase_classifier: 'phaseML.classifyTrack — labels every fix; landed_full_stop is used as a hard sortie boundary (overrides ground-threshold merge). Per-sortie segments echoed as sortie_phases. sortieCue (no_new_takeoff / crew_swap_hour_marker / track_ended) is carried on landed_full_stop segments per phaseML\'s post-hoc overlay.',
            // ACS code → array of {sortie_id, tail, type, peak_confidence, ...}
            // sorted by peak confidence descending. Lets operators pick a
            // representative sortie per maneuver code in one lookup
            // instead of walking tasks_demonstrated across every row.
            // 2026-06-03 operator brief: "I need to be able to request a
            // sample of flights that covers the maneuvers."
            sortie_acs_index: sortieAcsIndex,
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
                sortie_path_pop_impact: 'people/km² × (REF_AGL / AGL)² evaluated at each fix (popGrid.js pointImpact kernel — same one impactSegments and findSortieMaxPopSegment use). Non-null only at indices where sortie_path[i].quality === "real". Repaired points carry null per the evaluation rule. Scale is consistent across sorties so clients can autoscale by percentile. When POPGRID is unavailable on the server, the array is all-null.',
                sortie_acs:             'computed from REAL-only points (purposeML uses the same filter). Null when acsML lib missing OR the sortie has < 30 real points after the quality filter. tasks_demonstrated lists every ACS code that fired; currency_events lists per-takeoff/per-landing 61.57(a)/(b) events tagged day vs night by airport lat/lon. scores covers V.A/V.B/V.C/V.D performance-standard verdicts. Mean throttle from sortie_path_throttle drives the VII.B/VII.C/IX.A/IX.B selectors — see kickoff_sorties_test.md round-4 notes.',
                sortie_phases:          'phaseML segments clipped to the sortie\'s [takeoff_ts, landing_ts] window. Phase ∈ {on_ground, taxiing, pattern, practice_area, departing, inbound, en_route, nearby, landed_full_stop}. landed_full_stop fires only when a ground run is ≥ 30 s AND (dwell ≥ 5 min OR end-of-track) AND no takeoff occurred within 15 min — this is the load-bearing "crew over, flight logged" signal that breaks sorties even when the type-based ground threshold would have merged. Null when phaseML lib missing OR the track has < 5 real points.',
                sortie_annotations:     'per-segment ACS task annotations derived from acsML\'s raw detection list (post-preempt). Indices reference sortie_path; ts_start/ts_end are derived from the REAL fix at those indices. source="auto" + verdict="not_evaluated" by construction — automated detection brackets a segment, human-grade verdicts come from a separate write path (Ask S-9c). Null when acsML lib missing OR the sortie had < 30 real points (same gate as sortie_acs).',
                sortie_boundary_source: 'how this sortie was bounded from the next: "phaseml_landed_full_stop" (hard signal — preferred), "ground_threshold" (type-based merge fired), "track_end" (last sortie of the day, clean end), "track_edge" (last sortie of the day, still airborne).',
                sortie_related_sorties: 'cross-sortie glider ↔ tow pairings. A pair fires when [takeoff_ts, landing_ts] windows overlap ≥ 30 s AND ≥ 50 % of the tow plane\'s real fixes during the overlap have a nearest-time glider fix within 900 ft lateral + 300 ft vertical. Entries are bidirectional — the tow row carries role="towed_glider" pointing at the glider sortie, the glider row carries role="tow_plane" pointing at the tow. mean_lateral_ft and mean_vertical_ft summarise the formation. Tow-side acceptance includes both type-flagged (PA25 etc.) AND auto-detected (auto_short_cycle_pattern) tracks so unknown-type tow planes still pair.',
                sortie_landings:        'altitude-derived landing count via AGL hysteresis (low gate 300 ft, high gate 500 ft) walking REAL points only. touch_and_go = each high → low → high cycle; full_stop = sortie ended in the low state. total = touch_and_go + full_stop. Reads directly off the altitude track so it works on any sortie regardless of sortie_cycles (which counts airborne-session merges and can differ when ADS-B holds altitude through a brief dip).',
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
