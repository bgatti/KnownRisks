import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { loadPopGrid, impactSegments, pointImpact, POP_KERNEL } from './src/popGrid.js'
import { distFt, classifyPoint, isEnginelessType } from './src/geo.js'
import { NOISE_ZONES } from './src/noiseZones.js'
import { classifyOneTrack, phaseMLApiPlugin } from './phaseML/index.js'
import { synthesizeInProgressCycle } from './flightCycles.js'
import {
  computeFlightAltOffset,
  regionalOffsetSeries,
  smoothedOffsetFor,
  applyOffsetToPoints,
  VERIFIED_ALT_CAL_RADIUS_NM,
} from './src/altCorrection.js'

// Load .env.local into process.env BEFORE importing db.js (which reads
// DATABASE_URL at module load). Lets local dev point at Railway's Postgres
// just by writing the connection string into noise/web/.env.local.
// Only loads variables not already set so an explicit
// `DATABASE_URL=... npx vite` still wins.
{
  const envPath = path.resolve(process.cwd(), '.env.local')
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i)
      if (!m) continue
      const [, k, v] = m
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, '')
    }
    console.log('[env] loaded .env.local')
  }
}
const db = await import('./db.js')
const adsb = await import('./adsb.js')

// ── Shared aircraft + airport reference data ──
// ICAO type code → human-readable description. Module-scope so both the
// flight-ops classifier (descOf) and the /api/excursions/boot enrichment use
// the same table.
const TYPE_DESC = {
  C152: 'Cessna 152', C172: 'Cessna Skyhawk 172', C72R: 'Cessna 172R Skyhawk',
  C182: 'Cessna Skylane 182', C206: 'Cessna Stationair 206', C210: 'Cessna Centurion 210',
  P28A: 'Piper Cherokee/Warrior PA-28', P28B: 'Piper Cherokee 180', PA28: 'Piper Cherokee PA-28',
  P28R: 'Piper Arrow PA-28R', PA46: 'Piper Malibu/Mirage', PA44: 'Piper Seminole',
  PA25: 'Piper Pawnee (tow plane)', PA18: 'Piper Super Cub (tow plane)',
  HUSK: 'Aviat Husky (tow plane)',
  DV20: 'Diamond Katana DV20', DA20: 'Diamond Katana DA20', DA40: 'Diamond Diamond Star',
  DA42: 'Diamond Twin Star',
  SR20: 'Cirrus SR20', SR22: 'Cirrus SR22', S22T: 'Cirrus SR22T',
  M20P: 'Mooney M20P', M20J: 'Mooney M20J', M20K: 'Mooney M20K',
  BE33: 'Beechcraft Bonanza 33', BE35: 'Beechcraft Bonanza V35', BE36: 'Beechcraft Bonanza A36',
  BE55: 'Beechcraft Baron 55', BE58: 'Beechcraft Baron 58', BE76: 'Beechcraft Duchess',
  BE9L: 'Beechcraft King Air', BE95: 'Beechcraft Travel Air', BE40: 'Beechjet 400',
  C25A: 'Cessna Citation CJ2', C25B: 'Cessna Citation CJ3', C25C: 'Cessna Citation CJ4',
  C501: 'Cessna Citation I/SP', C525: 'Cessna CitationJet', C551: 'Cessna Citation II/SP',
  C560: 'Cessna Citation V', C56X: 'Cessna Citation Excel', C680: 'Cessna Citation Sovereign',
  C68A: 'Cessna Citation Latitude', C750: 'Cessna Citation X',
  CL30: 'Bombardier Challenger 300', CL35: 'Bombardier Challenger 350',
  CL60: 'Bombardier Challenger 600',
  GALX: 'Gulfstream G200', G200: 'Gulfstream G200', H25B: 'Hawker 800',
  LJ40: 'Learjet 40', LJ60: 'Learjet 60',
  E55P: 'Embraer Phenom 300', E50P: 'Embraer Phenom 100', SF50: 'Cirrus Vision Jet',
  TBM7: 'Daher TBM 700', TBM8: 'Daher TBM 850', TBM9: 'Daher TBM 900',
  PC12: 'Pilatus PC-12', PC24: 'Pilatus PC-24', DHC6: 'De Havilland Twin Otter',
  R22: 'Robinson R22', R44: 'Robinson R44', R66: 'Robinson R66',
  AS50: 'Airbus AS350 Écureuil', AS55: 'Airbus AS355 Écureuil 2',
  AS65: 'Airbus AS365 Dauphin', AS21: 'Schleicher ASK 21 (glider)',
  EC20: 'Airbus EC120 Colibri', EC30: 'Airbus EC130', EC35: 'Airbus EC135', EC45: 'Airbus EC145',
  B06: 'Bell 206 JetRanger', B407: 'Bell 407', B429: 'Bell 429',
  H500: 'Hughes/MD 500', S76: 'Sikorsky S-76', S92: 'Sikorsky S-92',
  BD7T: 'Bonanza V35 Turbo', BDOG: 'Beagle Bulldog', VL3: 'JMB VL-3',
  LGEZ: 'Rutan Long-EZ', LONG: 'Rutan Long-EZ', LANCAIR: 'Lancair',
  RV6: "Van's RV-6", RV7: "Van's RV-7", RV8: "Van's RV-8", RV10: "Van's RV-10",
  RV12: "Van's RV-12", RV14: "Van's RV-14",
  GLID: 'Glider', VENT: 'Schempp-Hirth Ventus', NIMB: 'Schempp-Hirth Nimbus',
  DISC: 'Schempp-Hirth Discus', JS1J: 'Jonker JS1', ASTR: 'Astir glider',
  DG10: 'DG-100 (glider)', DG15: 'DG-150 (glider)', DG80: 'DG-800 (glider)',
  DG1T: 'DG-1000T (glider)',
  B738: 'Boeing 737-800', B739: 'Boeing 737-900', B38M: 'Boeing 737 MAX 8',
  B39M: 'Boeing 737 MAX 9', B78X: 'Boeing 787-10',
  A319: 'Airbus A319', A320: 'Airbus A320', A321: 'Airbus A321', A20N: 'Airbus A320neo',
  A21N: 'Airbus A321neo',
  CRJ2: 'Bombardier CRJ-200', CRJ7: 'Bombardier CRJ-700', CRJ9: 'Bombardier CRJ-900',
  E170: 'Embraer E-170', E75L: 'Embraer E-175 (long wing)', E190: 'Embraer E-190',
  E195: 'Embraer E-195',
  MD83: 'McDonnell Douglas MD-83', MD88: 'McDonnell Douglas MD-88',
  H60: 'Sikorsky UH-60 Black Hawk', GYRO: 'Gyroplane',
  C30J: 'Lockheed Martin C-130J Super Hercules', C130: 'Lockheed C-130 Hercules',
}
function expandType(type) {
  if (!type) return null
  return TYPE_DESC[String(type).toUpperCase()] || type
}

// Purpose classifier: special-use → school → type-code heuristic → GA default.
// Mirrors the flight-ops endpoint's classifier; module-scope so the leaderboard,
// recent-landings, boot, and missions all classify consistently.
function purposeOf(type, tail, isSchoolFleet, specialUse) {
  if (specialUse) {
    const m = {
      medivac: 'medevac', medivac_possible: 'medevac', firefighting: 'firefighting',
      law_enforcement: 'law_enforcement', military: 'military', government: 'government',
      patrol: 'patrol', science: 'science', survey: 'survey', search_rescue: 'search_rescue',
      helicopter_ops: 'helicopter_ops',
    }
    if (m[specialUse]) return m[specialUse]
  }
  if (isSchoolFleet) return 'training'
  if (!type) return 'unknown'
  const T = String(type).toUpperCase()
  if (/PA25|PA18/.test(T)) return 'tow_plane'
  if (/GLID|VENT|AS2|DG\d|NIMB|DISC|SGS/.test(T)) return 'glider'
  if (/R22|R44|R66|AS50|EC\d|B06|B407|H500|S76/.test(T)) return 'helicopter'
  if (/B73|B38|B78|A3[12]|A2[01]|CRJ|E7[05]|E19|MD[89]/.test(T)) return 'airline'
  if (/C25|C5[0-6]|C6[89]|C750|CL[36]|LJ\d|GL[AX]|H25|E55P|E50P|SF50/.test(T)) return 'biz_jet'
  if (/PC12|TBM|DHC6/.test(T)) return 'turboprop'
  if (/RV[78]|LGEZ|VL3|LONG|LANCAIR/.test(T)) return 'experimental'
  if (/PA44|DA42|BE58|BE55|BE76/.test(T)) return 'ga_twin'
  return 'ga_single'
}

// Special-use registry (medivac/firefighting/military/science/etc.) loaded at
// module scope so resolvePurpose can use it as the authoritative override —
// e.g. NEON's Twin Otters and Scientific Aviation's Mooneys flagged as 'science'
// even when the historical tracks.purpose says ga_single/unknown.
let SPECIAL_USE_MAP = new Map()
try {
  const sud = JSON.parse(fs.readFileSync('public/special_use_aircraft.json', 'utf8'))
  for (const ac of sud.aircraft || []) if (ac.tail && ac.use) SPECIAL_USE_MAP.set(ac.tail.toUpperCase(), ac.use)
} catch { /* optional */ }

// Resolve a tail's purpose:
//   1. Special-use registry (curated overrides) — wins over everything.
//   2. PA25/PA18 type → always tow_plane (the airframe IS a tow plane even when
//      it's in a glider-school fleet; the pilot may be training, but the
//      aircraft's purpose is tow).
//   3. Stored (curated) purpose on the tracks row when meaningful.
//   4. Type-based classifier fallback so gliders / GA aren't "unknown".
function resolvePurpose(stored, type, tail) {
  const su = tail ? SPECIAL_USE_MAP.get(String(tail).toUpperCase()) : null
  if (su) return purposeOf(type, tail, false, su)
  const T = String(type || '').toUpperCase()
  // Type-unambiguous airframes always win over school-fleet membership:
  //   PA25/PA18 = Pawnee / Super Cub → tow planes (even at glider schools).
  //   PIAT/PC6  = Pilatus Porter      → tow plane (SSB's tow).
  //   GLID/AS2x/DG*/VENT/NIMB/DISC/SGS/ASTR/JS1J = gliders → glider purpose
  //   even when in a school's fleet (the airframe IS a glider; the student
  //   pilot's training context doesn't change that).
  if (/^(PA25|PA18|PIAT|PC6)$/.test(T)) return 'tow_plane'
  if (/^(GLID|VENT|NIMB|DISC|SGS|ASTR|JS1J|JS\d|LS\d|PIK|ASW|SZD)/.test(T) || /^AS\d/.test(T) || /^DG\d/.test(T)) return 'glider'
  if (stored && stored !== 'unknown') return stored
  return purposeOf(type, tail, false, null)
}

// Aircraft icon URL — placeholder-now, upgradable-later. Resolution order:
//   1. per-tail override   (public/aircraft_icons.json → { "byTail": { "N123": url } })
//   2. per-type override   (… → { "byType": { "C172": url } })  (a bare map also works)
//   3. reserved convention /aircraft-icons/<TYPE>.png  (file may not exist yet;
//      the UI should fall back to the type label on load error)
// To upgrade later: drop real URLs into public/aircraft_icons.json, or repoint
// the convention at a CDN here — no consumer change needed.
let AIRCRAFT_ICONS = { byType: {}, byTail: {} }
try {
  const j = JSON.parse(fs.readFileSync('public/aircraft_icons.json', 'utf8'))
  AIRCRAFT_ICONS = { byType: j.byType || (j.byTail ? {} : j) || {}, byTail: j.byTail || {} }
} catch { /* optional registry */ }
function aircraftIconUrl(type, tail) {
  const T = (type || '').toUpperCase()
  const N = (tail || '').toUpperCase()
  if (N && AIRCRAFT_ICONS.byTail[N]) return AIRCRAFT_ICONS.byTail[N]
  if (T && AIRCRAFT_ICONS.byType[T]) return AIRCRAFT_ICONS.byType[T]
  return T ? `/aircraft-icons/${T}` : null
}

// Resolve a real aircraft PHOTO URL for a type code via Wikipedia page images
// (same source as NoiseReport.jsx), keyed by the expanded type name. Cached;
// negative results cached briefly so we don't hammer the API.
const PHOTO_CACHE = new Map() // TYPE -> { ts, url|null }
const PHOTO_TTL = 7 * 24 * 3600 * 1000
const PHOTO_NEG_TTL = 6 * 3600 * 1000
async function resolveAircraftPhoto(type) {
  const key = (type || '').toUpperCase()
  if (!key) return null
  const c = PHOTO_CACHE.get(key)
  if (c && Date.now() - c.ts < (c.url ? PHOTO_TTL : PHOTO_NEG_TTL)) return c.url
  let url = null
  try {
    const q = `${expandType(key) || key} aircraft`
    const api = 'https://en.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages' +
      '&piprop=thumbnail&pithumbsize=200&generator=search&gsrlimit=1&gsrsearch=' + encodeURIComponent(q)
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), 3500)
    const r = await fetch(api, { signal: ctrl.signal, headers: { 'User-Agent': 'FlightSafe-Noise/1.0 (aircraft icon resolver)' } })
    clearTimeout(to)
    if (r.ok) {
      const d = await r.json()
      const pages = d?.query?.pages
      const first = pages ? Object.values(pages)[0] : null
      url = first?.thumbnail?.source || null
    }
  } catch { /* network/timeout → negative cache */ }
  PHOTO_CACHE.set(key, { ts: Date.now(), url })
  return url
}

// Last-resort placeholder (plane glyph + type label) when no photo resolves.
function placeholderIconSvg(type) {
  const t = String(type || '?').toUpperCase().slice(0, 5)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="#0f172a"/>
  <path d="M32 7 L35.5 29 L55 33 L35.5 37 L33.5 53 L32 44 L30.5 53 L28.5 37 L9 33 L28.5 29 Z" fill="#38bdf8" fill-opacity="0.9"/>
  <text x="32" y="60" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" font-weight="600" fill="#e2e8f0">${t}</text>
</svg>`
}

// Serves /aircraft-icons/<name> as a real image — an uploaded file from
// public/aircraft-icons/ if present, else a generated SVG placeholder.
// Registered as a middleware so it intercepts before the SPA HTML catch-all
// (which was returning index.html for these paths).
function aircraftIconsPlugin() {
  return {
    name: 'aircraft-icons',
    configureServer(server) {
      server.middlewares.use('/aircraft-icons', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const name = decodeURIComponent((req.url || '').split('?')[0].replace(/^\/+/, ''))
          if (!name || name.includes('/') || name.includes('..')) return next()
          const dir = path.resolve('public/aircraft-icons')
          const stem = name.replace(/\.(svg|png|jpg|jpeg)$/i, '')
          res.setHeader('Access-Control-Allow-Origin', '*')
          // 1. A real uploaded file wins (per-type image drop-in).
          for (const c of [name, `${stem}.png`, `${stem}.jpg`, `${stem}.svg`]) {
            const fp = path.join(dir, c)
            if (fp.startsWith(dir) && fs.existsSync(fp)) {
              const ext = c.split('.').pop().toLowerCase()
              res.setHeader('Content-Type', ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : 'image/jpeg')
              res.setHeader('Cache-Control', 'public, max-age=86400')
              return res.end(fs.readFileSync(fp))
            }
          }
          // 2. A real aircraft photo for the type (Wikipedia, cached) → redirect.
          const photo = await resolveAircraftPhoto(stem)
          if (photo) {
            res.statusCode = 302
            res.setHeader('Location', photo)
            res.setHeader('Cache-Control', 'public, max-age=86400')
            return res.end()
          }
          // 3. Last resort: generated placeholder (rare — obscure/unmatched type).
          res.setHeader('Content-Type', 'image/svg+xml')
          res.setHeader('Cache-Control', 'public, max-age=3600')
          return res.end(placeholderIconSvg(stem))
        } catch { return next() }
      })
      console.log('[aircraft-icons] registered /aircraft-icons/<TYPE> (file → photo redirect → placeholder)')
    },
  }
}

// Letter grade from an impact_score (population impact_index × purpose weight).
// Lower impact = better grade. Thresholds are tunable.
function impactGrade(score) {
  if (score == null) return null
  if (score < 0.3) return 'A'
  if (score < 0.6) return 'B'
  if (score < 1.2) return 'C'
  if (score < 2.0) return 'D'
  return 'F'
}

// Build classified bands from a slice of points. When `popAt` is provided,
// each point is a 4-tuple [lat, lon, alt, impact] where impact is the
// per-point population-noise intensity (same kernel family as impact_index;
// pre-purpose). Each band also carries an aggregate `impact` (sum over its
// points) and `impact_share` (fraction of the track total) so kiosks that
// don't autoscale per-point can still color whole bands relatively. Points
// stay backwards-compatible: legacy clients reading p[0..2] keep working.
// `typeCode`: optional aircraft ICAO type. Engineless types (gliders,
// balloons) are VNAP-exempt — their bands are always emitted with klass=null.
function bandsFromPoints(pts, popAt, typeCode) {
  const out = []
  let cur = null
  let trackTotal = 0
  const engineless = isEnginelessType(typeCode)
  for (const p of pts) {
    const klass = classifyPoint(p[0], p[1], p[2], NOISE_ZONES, { engineless })
    let imp = null
    if (popAt) {
      imp = Math.round(pointImpact(p[0], p[1], p[2], popAt))
      trackTotal += imp
    }
    const pt = imp != null ? [p[0], p[1], p[2], imp] : [p[0], p[1], p[2]]
    // Capture the source-point timestamp (4th elt of the INPUT tuple,
    // which is ms-since-epoch from the live store) on each band so
    // per-band complaint attribution can find a time window. The
    // output `points` only carry impact in slot 3, so this can't be
    // recovered downstream.
    const ts = typeof p[3] === 'number' ? p[3] : null
    if (cur && cur.klass === klass) {
      cur.points.push(pt)
      if (imp != null) cur.impact += imp
      if (ts != null) { if (cur.start_ms == null) cur.start_ms = ts; cur.end_ms = ts }
    } else {
      if (cur) out.push(cur)
      cur = { klass, points: [pt] }
      if (imp != null) cur.impact = imp
      if (ts != null) { cur.start_ms = ts; cur.end_ms = ts }
    }
  }
  if (cur) out.push(cur)
  if (popAt && trackTotal > 0) {
    for (const b of out) b.impact_share = Math.round((b.impact / trackTotal) * 1000) / 1000
  }
  return out
}

// Classify a track's flight phase from its raw points ([lat, lon, alt, ...]).
// `overflight`  — never came near pattern altitude (always above field+300 ft)
// `departure`   — started low at the field, left climbing
// `arrival`     — descended into the field and stayed low at the end
// `pattern`     — both low at start and end (typical pattern work; or 2+
//                  descent cycles which also indicates pattern flying)
// Returns the same shape as /api/excursions/segments — `{ phase, descents,
// hasDescents }` — so /api/excursions/boot can carry it through verbatim
// and the kiosk's local altitude-trend heuristic becomes a fallback only.
function classifyTrackPhase(points) {
  if (!points || points.length === 0) return { phase: 'overflight', descents: 0, hasDescents: false }
  const fieldElev = 5288 // KBDU default; good enough for the firstLow/lastLow check
  const descThreshold = fieldElev + 300 // 5588 MSL
  let descents = 0, wasHigh = false
  for (const p of points) {
    if (p[2] > descThreshold) wasHigh = true
    else if (wasHigh) { descents++; wasHigh = false }
  }
  const firstLow = points[0][2] != null && points[0][2] < descThreshold
  const lastLow = points[points.length - 1][2] != null && points[points.length - 1][2] < descThreshold
  let phase = 'overflight'
  if (firstLow && lastLow && descents >= 2) phase = 'pattern'
  else if (firstLow && !lastLow) phase = 'departure'
  else if (!firstLow && lastLow) phase = 'arrival'
  else if (firstLow && lastLow) phase = 'pattern'
  return { phase, descents, hasDescents: descents > 0 }
}

// Population grid for the leaderboard's pop-impact explainer (computed live, so
// it works before the backfill column is populated). Optional.
let POPGRID = null
try { POPGRID = loadPopGrid('public/population_density.json') } catch { POPGRID = null }
const POP_SCALE = 1000 // pop_impact-per-ft that maps to impact_index = 1 (keep in sync with leaderboard)
const LEADERBOARD_FLIGHT_EXP = 1.5 // super-linear frequency emphasis
const LEADERBOARD_ZONE_K = 12      // zone-proxy impact scaling (pre-population fallback)
const missionsCache = new Map()    // key `${days}|${scope}|${airport}` → { ts, body } (5-min TTL)

// Compute a track's [startMs, endMs] from its bands' point timestamps.
// Falls back to the track date (a full UTC day) for sparse historical
// tracks whose points have no per-point timestamp. Returns null when
// there's no usable signal at all.
function trackTimeWindow(t) {
  let lo = null, hi = null
  for (const b of (t?.bands || [])) {
    for (const p of (b?.points || [])) {
      const ts = Array.isArray(p) ? p[3] : (p && p.ts)
      const n = typeof ts === 'number' ? ts : (typeof ts === 'string' ? Date.parse(ts) : NaN)
      if (Number.isFinite(n)) {
        if (lo == null || n < lo) lo = n
        if (hi == null || n > hi) hi = n
      }
    }
  }
  if (lo != null && hi != null) return [lo, hi]
  if (t?.date) {
    const day = Date.parse(t.date + 'T00:00:00Z')
    if (Number.isFinite(day)) return [day, day + 24 * 3600 * 1000]
  }
  return null
}

// Shared complaint loader with 30 s memoization. The kiosk polls multiple
// enriched endpoints; without this each call would re-query Postgres.
// Exposed as a module-scope helper so /api/excursions/boot and
// /api/adsb/current-flights both reuse the same cache window.
const COMPLAINT_CACHE_TTL_MS = 30 * 1000
let complaintCache = { ts: 0, list: [] }
async function loadComplaintsCached() {
  const now = Date.now()
  if (now - complaintCache.ts < COMPLAINT_CACHE_TTL_MS) return complaintCache.list
  let list = []
  if (db.useDb) {
    try { list = await db.getComplaints(null) } catch { list = [] }
  } else {
    try {
      const fs = await import('fs/promises')
      const path = await import('path')
      const buf = await fs.default.readFile(path.default.resolve('data/complaints.json'), 'utf8')
      list = JSON.parse(buf).complaints || []
    } catch { list = [] }
  }
  complaintCache = { ts: now, list }
  return list
}

// Build the leaderboard from the LIVE store (live_tracks), which is the current
// per-day capture — the historical `tracks` table lags real time. Flights are
// real takeoff→landing cycles (touch-and-goes merged), base/purpose come from
// the call→tracks classification, and impact uses the population grid. Returns
// the response object, or null if the live store has no data for the window.
async function buildLiveLeaderboard({ days, limit, by, homeBaseRaw }) {
  const FT_PER_NM = 6076
  const today = new Date()
  const toDate = today.toISOString().slice(0, 10)
  const fromD = new Date(today); fromD.setUTCDate(fromD.getUTCDate() - (days - 1))
  const fromDate = fromD.toISOString().slice(0, 10)
  const range = await db.loadLiveFromDbByDateRange(fromDate, toDate)
  const tracks = range.tracks || []
  if (!tracks.length) return null

  // Merge each aircraft's points across days; sum the per-day stored lengths.
  const byHex = new Map()
  for (const t of tracks) {
    const hex = t.hex || t.call
    if (!hex) continue
    let g = byHex.get(hex)
    if (!g) { g = { hex, call: t.call || hex, type: t.type || '', points: [], lt: 0, lr: 0, lo: 0, ly: 0 }; byHex.set(hex, g) }
    if (Array.isArray(t.points)) for (const p of t.points) g.points.push(p)
    g.lt += t.len_total_ft || 0; g.lr += t.len_red_ft || 0; g.lo += t.len_orange_ft || 0; g.ly += t.len_yellow_ft || 0
  }

  const zoneConfig = await adsb.loadZones()
  const gapMs = 10 * 60000 // touch-and-go / taxi-back merge threshold
  const perTail = []
  for (const g of byHex.values()) {
    g.points.sort((a, b) => (a[3] || 0) - (b[3] || 0))
    const cycles = adsb.extractTowCycles(g.hex, g.call, g.points, zoneConfig)
      .filter(f => f.takeoff_ts && f.landing_ts)
      .sort((a, b) => new Date(a.takeoff_ts) - new Date(b.takeoff_ts))
    let flights = 0, lastLand = null
    for (const f of cycles) {
      if (lastLand && (new Date(f.takeoff_ts) - new Date(lastLand)) < gapMs) { lastLand = f.landing_ts; continue }
      flights++; lastLand = f.landing_ts
    }
    if (flights === 0) continue
    const popImpact = POPGRID ? impactSegments(g.points, POPGRID.popAt, distFt).total : null
    perTail.push({ tail: g.call, type: g.type, flights, lt: g.lt, lr: g.lr, lo: g.lo, ly: g.ly, popImpact })
  }
  if (!perTail.length) return null

  // call → base / purpose / school (latest non-null) from the tracks classification.
  const tails = perTail.map(t => t.tail).filter(Boolean)
  const info = new Map()
  if (tails.length) {
    const r = await db.queryDb(
      `SELECT call,
        (array_agg(base_airport ORDER BY date DESC) FILTER (WHERE base_airport IS NOT NULL))[1] AS base,
        (array_agg(purpose ORDER BY date DESC) FILTER (WHERE purpose IS NOT NULL))[1] AS purpose,
        (array_agg(school ORDER BY date DESC) FILTER (WHERE school IS NOT NULL))[1] AS school
       FROM tracks WHERE call = ANY($1) GROUP BY call`, [tails])
    for (const row of r.rows) info.set(row.call, row)
  }

  const bases = homeBaseRaw ? homeBaseRaw.split(',').map(b => b.trim().toUpperCase()).filter(Boolean) : null
  const groups = new Map()
  for (const t of perTail) {
    const i = info.get(t.tail)
    const base = i?.base || null
    if (bases && !(base && bases.includes(base.toUpperCase()))) continue
    const key = by === 'base' ? base : by === 'school' ? (i?.school || null) : t.tail
    if (key == null) continue
    let g = groups.get(key)
    if (!g) { g = { name: key, flights: 0, lt: 0, lr: 0, lo: 0, ly: 0, popImpact: 0, popKnown: false, type: t.type, school: i?.school || null, base, purpose: resolvePurpose(i?.purpose, t.type, t.tail) }; groups.set(key, g) }
    g.flights += t.flights; g.lt += t.lt; g.lr += t.lr; g.lo += t.lo; g.ly += t.ly
    if (t.popImpact != null) { g.popImpact += t.popImpact; g.popKnown = true }
  }
  if (!groups.size) return null

  const scored = [...groups.values()].map(g => {
    const exc_ft = g.lr + g.lo + g.ly
    const excursion_rate = g.lt > 0 ? exc_ft / g.lt : 0
    let impact_index, impact_basis
    if (g.popKnown && g.lt > 0) { impact_index = (g.popImpact / g.lt) / POP_SCALE; impact_basis = 'population' }
    else { impact_index = LEADERBOARD_ZONE_K * (g.lt > 0 ? (3 * g.lr + 2 * g.lo + g.ly) / g.lt : 0); impact_basis = 'zone_proxy' }
    const cleanliness = 1 - Math.min(1, excursion_rate)
    const score = Math.pow(g.flights, LEADERBOARD_FLIGHT_EXP) * cleanliness * (1 / (1 + impact_index))
    return {
      name: g.name, type: g.type, school: g.school, base: g.base, purpose: g.purpose,
      flights: g.flights,
      total_nm: Math.round(g.lt / FT_PER_NM * 10) / 10,
      clean_nm: Math.round((g.lt - exc_ft) / FT_PER_NM * 10) / 10,
      excursion_nm: Math.round(exc_ft / FT_PER_NM * 10) / 10,
      excursion_rate: Math.round(excursion_rate * 1000) / 10,
      pop_impact: g.popKnown ? Math.round(g.popImpact) : null,
      impact_basis, impact_index: Math.round(impact_index * 1000) / 1000,
      score: Math.round(score * 100) / 100,
    }
  })
  scored.sort((a, b) => b.score - a.score || b.flights - a.flights)
  const top = scored.slice(0, limit)
  const maxScore = top.length ? top[0].score : 0
  const entries = top.map((e, i) => ({
    rank: i + 1, ...e,
    icon_url: by === 'tail' ? aircraftIconUrl(e.type, e.name) : null,
    score_pct: maxScore > 0 ? Math.round(e.score / maxScore * 1000) / 10 : 0,
  }))
  return {
    generated_at: new Date().toISOString(),
    window: { days, from: fromDate, to: toDate },
    by, airport: homeBaseRaw || null, home_base: homeBaseRaw || null, origin: null,
    source: 'live_tracks', days_loaded: range.days_loaded ?? null,
    scoring: {
      formula: 'flights^1.5 × (1 − excursion_rate) × 1/(1 + impact_index)',
      flights_exponent: LEADERBOARD_FLIGHT_EXP,
      impact_basis: entries.length ? entries[0].impact_basis : null,
      sort: 'score desc, flights desc',
    },
    entries,
  }
}
// Airports near the field (code/lat/lon/field-elevation ft) for origin/dest
// inference and on-ground detection in boot enrichment.
const ENRICH_AP = [
  { code: 'KBDU', lat: 40.0394, lon: -105.2258, elev: 5288 },
  { code: 'KBJC', lat: 39.9088, lon: -105.1172, elev: 5673 },
  { code: 'KEIK', lat: 40.0098, lon: -105.0488, elev: 5130 },
  { code: 'KLMO', lat: 40.1636, lon: -105.1636, elev: 5055 },
  { code: 'KAPA', lat: 39.5701, lon: -104.8493, elev: 5885 },
  { code: 'KGXY', lat: 40.4348, lon: -104.6331, elev: 4697 },
  { code: 'KFNL', lat: 40.4518, lon: -105.0166, elev: 5016 },
  { code: 'KDEN', lat: 39.8617, lon: -104.6731, elev: 5434 },
]
function distNmAp(la1, lo1, la2, lo2) {
  const dLat = (la1 - la2) * 60
  const dLon = (lo1 - lo2) * 60 * Math.cos(((la1 + la2) / 2) * Math.PI / 180)
  return Math.hypot(dLat, dLon)
}
function nearestAp(lat, lon) {
  let best = null, bestD = Infinity
  for (const ap of ENRICH_AP) {
    const d = distNmAp(lat, lon, ap.lat, ap.lon)
    if (d < bestD) { bestD = d; best = ap }
  }
  return { ...best, dist: bestD }
}

// JSON file-backed ledger store. Each instance owns one file (e.g.
// data/reports.json) and serializes concurrent mutations through a single
// promise chain, so two POSTs that arrive simultaneously can't clobber each
// other's read-modify-write. Atomic writes via unique .tmp + rename.
function makeLedger(filename) {
  let chain = Promise.resolve()
  const load = async (fs, path) => {
    try {
      const buf = await fs.readFile(path.resolve(filename), 'utf8')
      return JSON.parse(buf)
    } catch {
      return null
    }
  }
  const write = async (fs, path, data) => {
    const p = path.resolve(filename)
    const dir = path.dirname(p)
    try { await fs.mkdir(dir, { recursive: true }) } catch {}
    const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2))
    // OneDrive (and AV scanners) can hold transient locks on the destination
    // during sync, making rename fail EPERM/EBUSY. Retry a few times with
    // backoff before giving up; lock is usually released within ~200ms.
    const delays = [25, 50, 100, 200, 400]
    let lastErr = null
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        await fs.rename(tmp, p)
        return
      } catch (e) {
        lastErr = e
        if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') break
        if (attempt === delays.length) break
        await new Promise((r) => setTimeout(r, delays[attempt]))
      }
    }
    try { await fs.unlink(tmp) } catch {}
    throw lastErr
  }
  const mutate = async (fs, path, fn) => {
    const task = async () => {
      const cur = (await load(fs, path)) || { items: [] }
      const next = (await fn(cur)) || cur
      await write(fs, path, next)
      return next
    }
    const queued = chain.then(task, task)
    chain = queued.catch(() => {})
    return queued
  }
  return { load, mutate, write }
}

// HMAC-signed notice token. Embedded in the landing URL from /api/send-notice
// and verified by /api/pilot-response so operator-forwarded pilot replies
// can be tied back to the exact notice that was sent. Secret comes from
// NOISE_NOTICE_SECRET env var; dev fallback is a fixed string so tokens stay
// valid across restarts without extra config.
const NOTICE_SECRET = process.env.NOISE_NOTICE_SECRET || 'dev-notice-secret-change-me'
const signNoticeId = (tail, atMs) => {
  const payload = `${tail}|${atMs}`
  const sig = crypto.createHmac('sha256', NOTICE_SECRET).update(payload).digest('base64url').slice(0, 16)
  return `${Buffer.from(payload).toString('base64url')}.${sig}`
}
const verifyNoticeId = (token) => {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null
  const [payloadB64, sig] = token.split('.')
  let payload
  try { payload = Buffer.from(payloadB64, 'base64url').toString('utf8') } catch { return null }
  const expected = crypto.createHmac('sha256', NOTICE_SECRET).update(payload).digest('base64url').slice(0, 16)
  if (sig !== expected) return null
  const [tail, atMsStr] = payload.split('|')
  const atMs = Number(atMsStr)
  if (!tail || !Number.isFinite(atMs)) return null
  return { tail, atMs }
}

const readJsonBody = async (req) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

// Dev-time middleware for POST /api/send-notice.
// If RESEND_API_KEY is set, forwards to Resend; otherwise dry-run (logs only).
// Configure the FROM address via NOISE_NOTICE_FROM (must be a verified Resend
// sender, e.g. "KBDU FBO <noise@your-verified-domain.com>").
const notificationsLedger = makeLedger('data/notifications.json')

function sendNoticePlugin() {
  return {
    name: 'send-notice',
    configureServer(server) {
      server.middlewares.use('/api/send-notice', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const payload = await readJsonBody(req)
          const { to, subject, body, tail, school, nid } = payload
          if (!to || !subject || !body) {
            res.statusCode = 400
            res.end(JSON.stringify({ ok: false, error: 'missing fields' }))
            return
          }
          const apiKey = process.env.RESEND_API_KEY
          const from = process.env.NOISE_NOTICE_FROM || 'KBDU FBO <onboarding@resend.dev>'
          const logLine = `[send-notice] ${new Date().toISOString()} ${tail} → ${to} (${school})`
          const recordNotification = async (via, ok) => {
            if (!ok || !tail) return
            const notifRecord = {
              kind: 'operator',
              tail,
              via,
              contact: to,
              school: school || null,
              noticeId: nid || null,
              at: new Date().toISOString(),
            }
            if (db.useDb) {
              await db.addNotification(notifRecord)
            } else {
              await notificationsLedger.mutate(fs, path, (cur) => {
                const items = Array.isArray(cur.items) ? cur.items : []
                items.push(notifRecord)
                return { items }
              })
            }
          }
          if (!apiKey) {
            console.log(logLine, '— DRY RUN (no RESEND_API_KEY)')
            await recordNotification('dry-run', true).catch((e) =>
              console.error('[send-notice] ledger write failed', e),
            )
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, dryRun: true }))
            return
          }
          const resp = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ from, to: [to], subject, text: body }),
          })
          const data = await resp.json().catch(() => ({}))
          console.log(logLine, resp.ok ? '— SENT' : `— FAILED ${resp.status}`, data)
          await recordNotification('email', resp.ok).catch((e) =>
            console.error('[send-notice] ledger write failed', e),
          )
          res.statusCode = resp.ok ? 200 : 502
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: resp.ok, dryRun: false, resend: data }))
        } catch (err) {
          console.error('[send-notice] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, error: String(err) }))
        }
      })
    },
  }
}

// GET /api/excursions?tail=N12JA[&from=YYYY-MM-DD][&to=YYYY-MM-DD]
// Returns JSON list of classified excursions for an aircraft within a date
// window, along with a deep link back to the map page pre-selecting the tail.
function excursionsApiPlugin() {
  let zonesCache = null
  // mtime-based cache for the big tracks file. Re-read only when the file
  // on disk changes; avoids re-parsing 200 MB on every API hit.
  const fileCache = { tracks: null, schools: null, live: null }

  // ── Caches for /api/excursions/boot ───────────────────────────────
  //
  // The handler runs three slow SQL queries (historical-tracks, per-tail
  // active aggregation, per-tail enrichment join) plus a live_tracks
  // multi-day pull. The region-wide case (no `airport=` filter) returned
  // 500s averaging 59 s / max 98 s in production with 3-of-3 failure
  // rate. SQL has no narrowing predicate beyond date + (worst_class
  // NOT NULL), so the planner scans the whole 24 h window and sorts by
  // a CASE expression over thousands of rows with multi-KB `bands`
  // JSONB. With 8 s kiosk polling and 60 s response time, the pg pool
  // (max=8) saturates; new requests wait until statement_timeout (25 s)
  // fires and the handler returns 500.
  //
  // The "boot" semantic — clients call once at startup — tolerates a
  // generous TTL. 45 s is long enough that repeated probes within a
  // kiosk session are free; short enough that the next session sees
  // fresh data.
  //
  // Request coalescing: concurrent callers for the same key wait on
  // the leader's Promise rather than each running their own query
  // against an already-saturated pool. This eliminates the
  // pool-exhaustion 500 cascade in the multi-workstation case.
  const BOOT_RESPONSE_TTL_MS = 45_000
  const bootResponseCache = new Map() // key -> { body, fetchedAt }
  const bootInFlight = new Map() // key -> Promise<{ body }>

  const TRACKS_DIR = 'C:\\tmp\\noise_data'
  const TRACK_YEARS = ['2023', '2024', '2025', '2026']
  const FILE_PATHS = {
    schools: 'public/flight_schools_fleets.json',
    live: 'public/tracks_live.json',
  }
  const buildIndex = (data) => {
    const byTail = new Map()
    for (const t of data.tracks || []) {
      const k = (t.call || '').trim()
      if (!k) continue
      let arr = byTail.get(k)
      if (!arr) { arr = []; byTail.set(k, arr) }
      arr.push(t)
    }
    data._byTail = byTail
    return data
  }
  // `opts` is forwarded to db.loadTracksFromDb when key === 'tracks':
  //   { fromDate?, toDate?, hardCap? }
  // Without it the DB loader defaults to "last 90 days, max 50000 rows"
  // — large windows must opt in explicitly to avoid OOM-ing the heap.
  const loadCached = async (fs, path, key, opts = {}) => {
    if (db.useDb) {
      if (key === 'tracks') return db.loadTracksFromDb(opts)
      if (key === 'live') return db.loadLiveFromDb()
      if (key === 'schools') return db.loadSchoolsFromDb()
    }
    // Per-year track files — merge them, cache based on combined mtime.
    if (key === 'tracks') {
      try {
        let latestMtime = 0
        for (const y of TRACK_YEARS) {
          try {
            const st = await fs.stat(TRACKS_DIR + '\\tracks_' + y + '.json')
            if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs
          } catch {}
        }
        const cached = fileCache[key]
        if (cached && cached.mtimeMs === latestMtime) return cached.data
        const allTracks = []
        for (const y of TRACK_YEARS) {
          try {
            const buf = await fs.readFile(TRACKS_DIR + '\\tracks_' + y + '.json', 'utf8')
            const d = JSON.parse(buf)
            if (d.tracks) allTracks.push(...d.tracks)
          } catch {}
        }
        const data = buildIndex({ tracks: allTracks })
        fileCache[key] = { mtimeMs: latestMtime, data }
        return data
      } catch (e) {
        return buildIndex({ tracks: [] })
      }
    }
    const p = path.resolve(FILE_PATHS[key])
    try {
      const stat = await fs.stat(p)
      const cached = fileCache[key]
      if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data
      const buf = await fs.readFile(p, 'utf8')
      const data = JSON.parse(buf)
      if (key === 'live') buildIndex(data)
      fileCache[key] = { mtimeMs: stat.mtimeMs, data }
      return data
    } catch (e) {
      if (key === 'schools') return { schools: [] }
      if (key === 'live') return { tracks: [], _byTail: new Map(), updated_at: null }
      throw e
    }
  }
  return {
    name: 'excursions-api',
    configureServer(server) {
      console.log('[excursions-api] registering endpoints...')
      // /api/excursions/flight-ops — intent model with intermediaries.
      // Registered first within excursionsApiPlugin so it matches before
      // the /api/excursions catch-all.
      server.middlewares.use('/api/excursions/flight-ops', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        const u = new URL(req.originalUrl || req.url, `http://${req.headers.host || 'localhost'}`)
        const baseParam = (u.searchParams.get('base') || '').toUpperCase()
        const radiusNm = Number(u.searchParams.get('radius')) || (baseParam ? 15 : 999)
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const liveData = await loadCached(fs, path, 'live')
          const schoolsData = await loadCached(fs, path, 'schools')
          // Build school + per-aircraft description lookups from the
          // schools file (each aircraft has tail + descriptive type, e.g.
          // "Cessna 172P (1981)").
          const schoolMap = new Map()
          const schoolAcDesc = new Map()
          for (const s of schoolsData.schools || []) {
            for (const ac of s.aircraft || []) {
              schoolMap.set(ac.tail, s.name)
              if (ac.type) schoolAcDesc.set(ac.tail, ac.type)
            }
          }
          // Special-use registry — overrides type-code purpose for known
          // medivac, firefighting, law enforcement, military, etc. tails.
          const specialUseMap = new Map()
          try {
            const buf = await fs.readFile(path.resolve('public/special_use_aircraft.json'), 'utf8')
            const sud = JSON.parse(buf)
            for (const ac of sud.aircraft || []) {
              specialUseMap.set(ac.tail, {
                use: ac.use,                        // medivac, firefighting, …
                description: ac.description,        // human-readable role
                aircraft_desc: ac.aircraft_desc,    // e.g. "PILATUS PC-12"
                owner: ac.owner,
              })
            }
          } catch (e) { /* file optional — categorisation falls back to type-only */ }
          const AP = [
            { code: 'KBDU', lat: 40.0394, lon: -105.2258, elev: 5288, tpa: 6300 },
            { code: 'KBJC', lat: 39.9088, lon: -105.1172, elev: 5673, tpa: 6700 },
            { code: 'KEIK', lat: 40.0098, lon: -105.0488, elev: 5130, tpa: 6100 },
            { code: 'KLMO', lat: 40.1636, lon: -105.1636, elev: 5055, tpa: 6100 },
            { code: 'KAPA', lat: 39.5701, lon: -104.8493, elev: 5885, tpa: 6900 },
            { code: 'KGXY', lat: 40.4348, lon: -104.6331, elev: 4697, tpa: 5700 },
          ]
          // Runway headings for pattern leg detection
          const RUNWAYS = {
            KBDU: [{ hdg: 80, name: '08' }, { hdg: 260, name: '26' }],
            KBJC: [{ hdg: 119, name: '12' }, { hdg: 299, name: '30' }],
            KEIK: [{ hdg: 152, name: '15' }, { hdg: 332, name: '33' }],
            KLMO: [{ hdg: 113, name: '11' }, { hdg: 293, name: '29' }],
            KAPA: [{ hdg: 174, name: '17' }, { hdg: 354, name: '35' }],
          }
          const distNm = (lat1, lon1, lat2, lon2) => {
            const dLat = (lat1 - lat2) * 60
            const dLon = (lon1 - lon2) * 60 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180)
            return Math.hypot(dLat, dLon)
          }
          // When ?base=KBDU is set, ALL distances/intent are relative to that
          // airport. Without it, each aircraft uses its nearest airport.
          const fixedBase = baseParam ? AP.find(a => a.code === baseParam) : null
          const nearAp = (lat, lon) => {
            if (fixedBase) return { ...fixedBase, dist: distNm(lat, lon, fixedBase.lat, fixedBase.lon) }
            let best = AP[0], bestD = Infinity
            for (const ap of AP) {
              const d = distNm(lat, lon, ap.lat, ap.lon)
              if (d < bestD) { bestD = d; best = ap }
            }
            return { ...best, dist: bestD }
          }
          const normAngle = (a) => ((a % 360) + 540) % 360 - 180 // ±180
          // Purpose: combined classification using:
          //   1. Special-use registry (medivac, firefighting, military, …)
          //   2. School fleet membership → 'training'
          //   3. Type-code heuristic (tow_plane, glider, airline, biz_jet, …)
          //   4. Default 'ga_single' / 'ga_twin'
          // (`purposeOf` lives at module scope — shared with the leaderboard etc.)
          // ICAO type code → human-readable description lives at module scope
          // (shared TYPE_DESC); descOf falls back to it below.
          const descOf = (type, tail) => {
            if (specialUseMap.get(tail)?.aircraft_desc) return specialUseMap.get(tail).aircraft_desc
            if (schoolAcDesc.get(tail)) return schoolAcDesc.get(tail)
            if (!type) return ''
            return TYPE_DESC[type.toUpperCase()] || type
          }

          const aircraft = []
          for (const t of liveData.tracks || []) {
            const pts = t.points || []
            if (pts.length < 5) continue
            const tail = t.call || t.reg || t.hex || '?'
            const type = t.type || ''
            const school = schoolMap.get(tail) || null
            const specialUseRec = specialUseMap.get(tail)
            const purpose = purposeOf(type, tail, !!school, specialUseRec?.use)
            const description = descOf(type, tail)
            const lastPt = pts[pts.length - 1]
            const ap = nearAp(lastPt[0], lastPt[1])

            // ─── 3-min window (last 90 pts at 2s, or whatever we have) ───
            const WINDOW = 90
            const recent = pts.slice(-WINDOW)
            const first = recent[0], last = recent[recent.length - 1]
            const hasTs = first.length > 3 && last.length > 3
            const dtMin = hasTs ? (last[3] - first[3]) / 60000 : (recent.length * 2) / 60
            const flightTimeMin = hasTs ? (last[3] - pts[0][3]) / 60000 : (pts.length * 2) / 60

            // Distance to nearest airport at start and end of window
            const distStart = distNm(first[0], first[1], ap.lat, ap.lon)
            const distEnd = distNm(last[0], last[1], ap.lat, ap.lon)

            // Groundspeed estimate (kt) from last few points
            const gs = recent.length >= 3
              ? distNm(recent[recent.length-3][0], recent[recent.length-3][1], last[0], last[1]) * 60 / ((hasTs ? (last[3] - recent[recent.length-3][3]) / 60000 : 6/60) || 1)
              : 0

            // ─── Intermediary 1: closure_pct ───
            const closureRate = dtMin > 0 ? (distStart - distEnd) / dtMin : 0 // nm/min, positive = closing
            const closure_pct = gs > 10 ? (closureRate * 60) / gs * 100 : 0

            // ─── Intermediary 2: angular_accumulation ───
            let totalTurn = 0
            for (let i = 1; i < recent.length; i++) {
              // Compute heading between consecutive points
              const dLon = (recent[i][1] - recent[i-1][1]) * Math.cos(((recent[i][0] + recent[i-1][0]) / 2) * Math.PI / 180)
              const dLat = recent[i][0] - recent[i-1][0]
              if (Math.abs(dLon) < 1e-7 && Math.abs(dLat) < 1e-7) continue
              const hdg = Math.atan2(dLon, dLat) * 180 / Math.PI
              if (i >= 2) {
                const dLon2 = (recent[i-1][1] - recent[i-2][1]) * Math.cos(((recent[i-1][0] + recent[i-2][0]) / 2) * Math.PI / 180)
                const dLat2 = recent[i-1][0] - recent[i-2][0]
                if (Math.abs(dLon2) > 1e-7 || Math.abs(dLat2) > 1e-7) {
                  const prevHdg = Math.atan2(dLon2, dLat2) * 180 / Math.PI
                  totalTurn += Math.abs(normAngle(hdg - prevHdg))
                }
              }
            }
            const trackDistNm = dtMin > 0 ? gs * dtMin / 60 : 0.1
            const angular_accumulation = trackDistNm > 0.01 ? totalTurn / trackDistNm : 0

            // ─── Intermediary 3: climb_energy (fpm averaged over window) ───
            const climb_energy = dtMin > 0 ? (last[2] - first[2]) / dtMin : 0

            // ─── Intermediary 4: vertical_stability ───
            const meanAlt = recent.reduce((s, p) => s + p[2], 0) / recent.length
            const altVar = recent.reduce((s, p) => s + (p[2] - meanAlt) ** 2, 0) / recent.length
            const vertical_stability = Math.sqrt(altVar)

            // ─── Intermediary 5: at_pattern_altitude ───
            const at_pattern_altitude = Math.abs(last[2] - ap.tpa) < 200

            // ─── Intermediary 6: orbit_radius_nm ───
            const turnRateDegMin = dtMin > 0 ? totalTurn / dtMin : 0
            const orbit_radius_nm = turnRateDegMin > 10 ? (gs / 60) / (turnRateDegMin * Math.PI / 180) : 99

            // ─── Intermediary 7: directness ───
            const displacement = distNm(first[0], first[1], last[0], last[1])
            let pathLen = 0
            for (let i = 1; i < recent.length; i++) pathLen += distNm(recent[i-1][0], recent[i-1][1], recent[i][0], recent[i][1])
            const directness = pathLen > 0.01 ? displacement / pathLen : 1

            // ─── Intermediary 8: heading_to_runway ───
            const lastHdg = recent.length >= 2
              ? Math.atan2(
                  (last[1] - recent[recent.length-2][1]) * Math.cos(last[0] * Math.PI / 180),
                  last[0] - recent[recent.length-2][0]
                ) * 180 / Math.PI
              : 0
            const rwys = RUNWAYS[ap.code] || []
            let bestRwyAlign = 180, bestRwy = null
            for (const rwy of rwys) {
              const align = Math.abs(normAngle(lastHdg - rwy.hdg))
              if (align < bestRwyAlign) { bestRwyAlign = align; bestRwy = rwy.name }
            }
            const heading_to_runway = bestRwyAlign

            // ─── Intent classification ───
            const agl = last[2] - ap.elev
            let intent, leg = null, confidence = 0.5

            if (purpose === 'tow_plane' && angular_accumulation > 200) {
              intent = 'towing'; confidence = 0.9
            } else if (purpose === 'glider' && distEnd > 3) {
              intent = 'soaring'; confidence = 0.8
            } else if (purpose === 'glider') {
              intent = 'local_soaring'; confidence = 0.7
            } else if (distEnd < 3 && angular_accumulation > 150 && at_pattern_altitude) {
              intent = 'pattern'; confidence = 0.85
            } else if (distEnd < 3 && angular_accumulation > 100) {
              intent = 'pattern'; confidence = 0.7
            } else if (closure_pct > 60 && distEnd < 12 && climb_energy < 0) {
              intent = 'inbound'; confidence = 0.8
            } else if (closure_pct > 40 && distEnd < 15) {
              intent = 'inbound'; confidence = 0.6
            } else if (closure_pct < -60 && distEnd < 5) {
              intent = 'outbound'; confidence = 0.8
            } else if (closure_pct < -30 && distEnd < 8 && climb_energy > 200) {
              intent = 'outbound'; confidence = 0.7
            } else if (distEnd > 5 && directness < 0.4 && vertical_stability > 100) {
              intent = 'practicing'; confidence = 0.75
            } else if (distEnd > 5 && closure_pct > 20) {
              intent = 'returning'; confidence = 0.6
            } else if (distEnd > 5 && closure_pct < -20) {
              intent = 'to_practice'; confidence = 0.6
            } else if (purpose === 'airline') {
              intent = climb_energy > 100 ? 'outbound' : 'inbound'; confidence = 0.6
            } else {
              intent = 'transit'; confidence = 0.4
            }

            // ─── Pattern leg (when intent = pattern) ───
            if (intent === 'pattern' && rwys.length) {
              // Find which runway direction is closest to our heading
              let rwyHdg = rwys[0].hdg
              for (const rwy of rwys) {
                if (Math.abs(normAngle(lastHdg - rwy.hdg)) < Math.abs(normAngle(lastHdg - rwyHdg))) {
                  rwyHdg = rwy.hdg
                }
              }
              const relHdg = normAngle(lastHdg - rwyHdg)
              if (agl < 50) leg = 'on_runway'
              else if (agl < 200 && Math.abs(relHdg) < 30 && closureRate > 0) leg = 'short_final'
              else if (Math.abs(relHdg) < 30 && climb_energy < -200) leg = 'final'
              else if (Math.abs(normAngle(relHdg - 90)) < 40 && climb_energy < -100) leg = 'base'
              else if (Math.abs(relHdg - 180) < 40 || Math.abs(relHdg + 180) < 40) leg = 'downwind'
              else if (Math.abs(normAngle(relHdg - 90)) < 40 && climb_energy > 100) leg = 'crosswind'
              else if (Math.abs(relHdg) < 30 && climb_energy > 100) leg = 'upwind'
              else if (closureRate > 0 && distEnd > 1.5) leg = 'entering'
              else leg = 'maneuvering'
            }

            aircraft.push({
              tail, type, description, purpose, school,
              special_use: specialUseRec ? {
                role: specialUseRec.description,
                owner: specialUseRec.owner,
              } : null,
              intent, leg, confidence: +confidence.toFixed(2),
              airport: ap.code, dist_nm: +distEnd.toFixed(1),
              alt: last[2], agl: Math.round(agl),
              groundspeed: Math.round(gs),
              flight_time_min: Math.round(flightTimeMin),
              intermediaries: {
                closure_pct: Math.round(closure_pct),
                angular_accumulation: Math.round(angular_accumulation),
                climb_energy: Math.round(climb_energy),
                vertical_stability: Math.round(vertical_stability),
                at_pattern_altitude,
                orbit_radius_nm: +orbit_radius_nm.toFixed(1),
                directness: +directness.toFixed(2),
                heading_to_runway: Math.round(heading_to_runway),
              },
            })
          }

          // Filter by radius when base is specified
          const filtered = baseParam
            ? aircraft.filter(ac => ac.dist_nm <= radiusNm)
            : aircraft

          // Group by intent
          const groups = {}
          for (const ac of filtered) {
            if (!groups[ac.intent]) groups[ac.intent] = []
            groups[ac.intent].push(ac)
          }
          const summary = Object.entries(groups)
            .sort((a, b) => b[1].length - a[1].length)
            .map(([intent, list]) => ({ intent, count: list.length }))

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({
            timestamp: new Date().toISOString(),
            base: fixedBase ? { code: fixedBase.code, lat: fixedBase.lat, lon: fixedBase.lon, elev: fixedBase.elev, radius_nm: radiusNm } : null,
            total: filtered.length,
            summary,
            aircraft: filtered,
          }, null, 2))
        } catch (e) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(e) }))
        }
      })

      // Registered BEFORE /api/excursions because connect prefix-matches and
      // would otherwise route /api/excursions/segments into the wrong handler.
      server.middlewares.use('/api/excursions/segments', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const tail = (u.searchParams.get('tail') || '').trim()
          const hours = Number(u.searchParams.get('hours')) || 24
          const limit = Number(u.searchParams.get('limit')) || 200
          const latParam = u.searchParams.get('lat')
          const lonParam = u.searchParams.get('lon')
          // Accept radius_mi (statute miles) or radius_nm (nautical miles).
          // Default is 4 statute miles, matching the legacy hardcoded value.
          const radiusMi = u.searchParams.get('radius_mi')
            ? Number(u.searchParams.get('radius_mi'))
            : (u.searchParams.get('radius_nm') ? Number(u.searchParams.get('radius_nm')) * 1.15078 : 4)
          const center = (latParam != null && lonParam != null && latParam !== '' && lonParam !== '')
            ? { lat: Number(latParam), lon: Number(lonParam) }
            : null
          if (!zonesCache) {
            const mod = await import('./src/noiseZones.js')
            zonesCache = mod.NOISE_ZONES
          }
          // Compute window first so the DB query only fetches that slice.
          // Explicit `from`/`to` (ISO 8601 or epoch ms) take precedence over
          // the lookback `hours` param. Either bound can be omitted —
          // e.g. ?from=2026-05-07T20:15:00Z&to=2026-05-07T20:30:00Z
          const nowMs = Date.now()
          const fromParam = u.searchParams.get('from')
          const toParam = u.searchParams.get('to')
          const parseTs = (s) => {
            if (!s) return null
            // Accept epoch-ms strings ("1714324800000") and ISO 8601.
            const asNum = Number(s)
            if (Number.isFinite(asNum) && asNum > 1_000_000_000_000) return asNum
            const t = Date.parse(s)
            return Number.isFinite(t) ? t : null
          }
          let fromMs, toMs
          if (fromParam || toParam) {
            fromMs = fromParam ? parseTs(fromParam) : (nowMs - hours * 3600 * 1000)
            toMs = toParam ? parseTs(toParam) : nowMs
            if (fromMs == null || toMs == null) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'invalid from/to — use ISO 8601 (e.g. 2026-05-07T20:15:00Z) or epoch-ms' }))
              return
            }
            if (fromMs >= toMs) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'from must be before to' }))
              return
            }
          } else {
            fromMs = nowMs - hours * 3600 * 1000
            toMs = nowMs
          }
          const fromDate = new Date(fromMs).toISOString().slice(0, 10)
          const toDate = new Date(toMs).toISOString().slice(0, 10)
          // When a precise from/to is given AND the window dips before today,
          // fan out across the live_tracks rows for each day in range. The
          // default loadCached('live') only returns the most-recent (today's)
          // snapshot, so historical windows would return zero live tracks.
          const todayUtc = new Date().toISOString().slice(0, 10)
          const needsHistoricalLive = (fromParam || toParam) && db.useDb && fromDate < todayUtc
          const [tracksData, liveData] = await Promise.all([
            loadCached(fs, path, 'tracks', { fromDate, toDate }),
            needsHistoricalLive
              ? db.loadLiveFromDbByDateRange(fromDate, toDate)
              : loadCached(fs, path, 'live'),
          ])
          // Geo helpers — duplicated from the /api/excursions handler to keep
          // this route self-contained. Any change to classification thresholds
          // must be mirrored in both places.
          const FT_PER_DEG_LAT = 364560
          const RADIUS_FT = radiusMi * 5280
          const pointInPolygon = (lat, lon, poly) => {
            let inside = false
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
              const [yi, xi] = poly[i]
              const [yj, xj] = poly[j]
              if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) {
                inside = !inside
              }
            }
            return inside
          }
          const distPointToSegFt = (lat, lon, aLat, aLon, bLat, bLon) => {
            const latRef = (aLat + bLat + lat) / 3
            const cos = Math.cos((latRef * Math.PI) / 180)
            const px = (lon - aLon) * FT_PER_DEG_LAT * cos
            const py = (lat - aLat) * FT_PER_DEG_LAT
            const dx = (bLon - aLon) * FT_PER_DEG_LAT * cos
            const dy = (bLat - aLat) * FT_PER_DEG_LAT
            const len2 = dx * dx + dy * dy
            if (len2 === 0) return Math.hypot(px, py)
            let t = (px * dx + py * dy) / len2
            t = Math.max(0, Math.min(1, t))
            return Math.hypot(px - t * dx, py - t * dy)
          }
          const signedDistance = (lat, lon) => {
            let minAbs = Infinity
            let insideAny = false
            let nearestZone = null
            for (const z of zonesCache) {
              const poly = z.polygon
              if (pointInPolygon(lat, lon, poly)) insideAny = true
              let minEdge = Infinity
              for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                const d = distPointToSegFt(lat, lon, poly[i][0], poly[i][1], poly[j][0], poly[j][1])
                if (d < minEdge) minEdge = d
              }
              if (minEdge < minAbs) { minAbs = minEdge; nearestZone = z.name }
            }
            return { d: insideAny ? -minAbs : minAbs, zone: nearestZone }
          }
          const ALT_THRESHOLD_FT = 7500
          const classifyAlt = (alt) => {
            if (alt == null) return null
            const below = ALT_THRESHOLD_FT - alt
            if (below > 500) return 'red'
            if (below > 250) return 'orange'
            if (below > -250) return 'yellow'
            return null
          }
          const classifyZone = (d) => {
            if (d < -500) return 'red'
            if (d < -250) return 'orange'
            if (d < 250) return 'yellow'
            return null
          }
          const SEV = { yellow: 1, orange: 2, red: 3 }
          const classifyPoint = (lat, lon, alt) => {
            const { d, zone } = signedDistance(lat, lon)
            const z = classifyZone(d)
            const a = classifyAlt(alt)
            if (!z || !a) return { klass: null, zone: null }
            return { klass: SEV[z] <= SEV[a] ? z : a, zone }
          }
          const withinRadius = (lat, lon) => {
            if (!center) return true
            const latRef = (lat + center.lat) / 2
            const cos = Math.cos((latRef * Math.PI) / 180)
            const dx = (lon - center.lon) * FT_PER_DEG_LAT * cos
            const dy = (lat - center.lat) * FT_PER_DEG_LAT
            return dx * dx + dy * dy <= RADIUS_FT * RADIUS_FT
          }
          // When tail is provided, use the O(1) index. When omitted, scan
          // all tracks in the time window — capped by `limit` to avoid
          // returning the entire dataset.
          let candidates, liveCandidates
          if (tail) {
            candidates = tracksData._byTail.get(tail) || []
            liveCandidates = liveData._byTail.get(tail) || []
          } else {
            candidates = tracksData.tracks || []
            liveCandidates = (liveData.tracks || [])
          }
          const matches = candidates.filter((t) => {
            const m = (t.src || '').match(/(\d{4}-\d{2}-\d{2})/)
            if (!m) return false
            const d = m[1]
            return d >= fromDate && d <= toDate
          })
          for (const lt of liveCandidates) matches.push(lt)
          // Cap to prevent OOM on wide queries.
          if (matches.length > limit) matches.length = limit
          const tracksOut = []
          // Only filter points by timestamp when from/to was explicit AND
          // the track carries per-point timestamps (4th element). Historical
          // tracks are 3-element with no timestamps — for those we trust
          // the date-level filter applied above.
          const filterPointsByTime = !!(fromParam || toParam)

          // ── Per-track alt-correction pre-pass ────────────────────────
          // Each track gets its own self-calibrated offset (lowest-25% or
          // runway-anchor cohort vs the base-airport elevation), the
          // regional smoother averages across nearby landings at the same
          // airport, and the smoothed offset is subtracted from every
          // point before classification. Without this, segment points
          // carry raw barometric altitude → AGL math goes negative on
          // any flight whose transponder over-reads by a few hundred
          // feet. See `noise/web/ADJUSTED_ALT.md`.
          const pickAirportForTrack = (t) => {
            if (t.base_airport) {
              const ap = ENRICH_AP.find(a => a.code === t.base_airport)
              if (ap) return ap
            }
            // Fall back to the nearest airport whose first or last fix
            // lies within VERIFIED_ALT_CAL_RADIUS_NM. This catches live
            // tracks that don't carry the base_airport column.
            if (!t.points?.length) return null
            const first = t.points[0]
            const last = t.points[t.points.length - 1]
            let best = null, bestD = VERIFIED_ALT_CAL_RADIUS_NM
            for (const ap of ENRICH_AP) {
              const dF = first[0] != null && first[1] != null
                ? distNmAp(first[0], first[1], ap.lat, ap.lon) : Infinity
              const dL = last[0] != null && last[1] != null
                ? distNmAp(last[0], last[1], ap.lat, ap.lon) : Infinity
              const d = Math.min(dF, dL)
              if (d < bestD) { bestD = d; best = ap }
            }
            return best
          }
          const midMsOfTrack = (t) => {
            if (!t.points?.length) return null
            const first = t.points[0]?.[3]
            const last = t.points[t.points.length - 1]?.[3]
            if (typeof first !== 'number' || typeof last !== 'number') return null
            return (first + last) / 2
          }
          const selfCalibrated = []
          const apByTrack = new WeakMap()
          for (const t of matches) {
            if (!t.points?.length) continue
            const ap = pickAirportForTrack(t)
            if (!ap) continue
            apByTrack.set(t, ap)
            const mid = midMsOfTrack(t)
            if (mid == null) continue
            const { offset_ft, calibration_fixes } = computeFlightAltOffset(t.points, ap)
            if (!calibration_fixes) continue
            selfCalibrated.push({
              airport: ap.code, midMs: mid,
              offsetFt: offset_ft, calibrationFixes: calibration_fixes,
            })
          }
          const altSeries = regionalOffsetSeries(selfCalibrated)
          const offsetByTrack = new WeakMap()
          for (const t of matches) {
            const ap = apByTrack.get(t)
            if (!ap) continue
            const mid = midMsOfTrack(t)
            if (mid == null) continue
            const sm = smoothedOffsetFor(ap.code, mid, altSeries)
            if (sm) offsetByTrack.set(t, sm.offset_ft)
          }

          for (const t of matches) {
            const m = (t.src || '').match(/(\d{4}-\d{2}-\d{2})/)
            const date = m ? m[1] : (t.src === 'live' ? toDate : null)
            const isLive = t.src === 'live'
            // Build the point list to walk. When a precise window was
            // requested and the track has per-point timestamps, drop points
            // outside it; otherwise use all points.
            const walkRaw = (filterPointsByTime && t.points.length && typeof t.points[0][3] === 'number')
              ? t.points.filter((p) => p[3] >= fromMs && p[3] <= toMs)
              : t.points
            if (walkRaw.length === 0) continue
            // Apply the regional-smoothed offset to every point before
            // classification — zone tests use p[2] (alt MSL), and every
            // point that ends up in segments[*].points[] must already
            // carry the corrected altitude.
            const trackOffset = offsetByTrack.get(t) || 0
            const walk = applyOffsetToPoints(walkRaw, trackOffset)
            // Engineless aircraft (gliders, balloons) are VNAP-exempt — emit
            // their segments as a single clean band so they never appear in
            // the excursion feed even when low over a noise zone.
            const trackEngineless = isEnginelessType(t.type)
            const segments = []
            let cur = null
            for (let i = 0; i < walk.length; i++) {
              const p = walk[i]
              const { klass, zone } = trackEngineless
                ? { klass: null, zone: null }
                : classifyPoint(p[0], p[1], p[2])
              if (cur && cur.klass === klass && cur.zone === zone) {
                cur.points.push(p)
              } else {
                if (cur) {
                  // Bridge: duplicate the transition point into the closing
                  // segment so rendered polylines share an endpoint and have
                  // no visual gap at the class/zone change.
                  cur.points.push(p)
                  segments.push(cur)
                }
                cur = { klass, zone, points: [p] }
              }
            }
            if (cur) segments.push(cur)
            // Derive per-segment timestamps from the 4th element of each
            // point (epoch-ms, written by the live collector). Historical
            // tracks from tracks_yearly.json are 3-element → timestamps
            // are null and callers fall back to the track's date field.
            const stampSegment = (s) => {
              let first = null, last = null
              for (const p of s.points) {
                if (typeof p[3] === 'number') {
                  if (first == null) first = p[3]
                  last = p[3]
                }
              }
              s.startedAt = first != null ? new Date(first).toISOString() : null
              s.endedAt = last != null ? new Date(last).toISOString() : null
              return s
            }
            for (const s of segments) stampSegment(s)
            const filtered = center
              ? segments.filter((s) => s.points.some((p) => withinRadius(p[0], p[1])))
              : segments
            if (filtered.length) {
              // Shared classifier — see classifyTrackPhase() at module scope.
              // /api/excursions/boot calls the same helper so the kiosk sees
              // identical phase values from either source.
              const { phase, descents, hasDescents } = classifyTrackPhase(walk)
              tracksOut.push({
                tail: t.call || t.reg || tail || '?',
                type: t.type || '',
                src: t.src, date, live: isLive,
                phase, descents, hasDescents,
                // base_airport: most-recent observed base from tracks.base_airport.
                // Null on live-only tracks (the live_tracks JSONB doesn't carry it);
                // we backfill from historical candidates of the same tail below.
                base_airport: t.base_airport || null,
                // alt_offset_ft: regional-smoothed per-track ADS-B
                // altitude correction (subtracted from raw alt before
                // classification). 0 when no calibration was available.
                alt_offset_ft: trackOffset,
                segments: filtered,
              })
            }
          }
          // Backfill base_airport: the live_tracks JSONB doesn't carry the
          // column, and a 24-hour window often returns only live rows. Fall
          // back to the most-recent observed base from the historical tracks
          // table — same pattern /api/adsb/current-flights uses.
          if (db.useDb) {
            const tailsNeedingBase = [...new Set(
              tracksOut.filter(r => !r.base_airport && r.tail && r.tail !== '?').map(r => r.tail)
            )]
            if (tailsNeedingBase.length) {
              try {
                const r = await db.queryDb(
                  `SELECT call,
                     (array_agg(base_airport ORDER BY date DESC) FILTER (WHERE base_airport IS NOT NULL))[1] AS base
                   FROM tracks WHERE call = ANY($1) GROUP BY call`,
                  [tailsNeedingBase]
                )
                const baseByTail = new Map()
                for (const row of r.rows) if (row.base) baseByTail.set(row.call, row.base)
                for (const t of tracksOut) {
                  if (!t.base_airport && baseByTail.has(t.tail)) t.base_airport = baseByTail.get(t.tail)
                }
              } catch (err) {
                console.error('[excursions-segments-api] base_airport backfill failed', err.message)
              }
            }
          }
          const payload = {
            query: tail || 'all',
            window: {
              from: new Date(fromMs).toISOString(),
              to: new Date(toMs).toISOString(),
              from_date: fromDate,
              to_date: toDate,
              hours: (toMs - fromMs) / 3600_000,
              limit,
              point_filter: filterPointsByTime ? 'sub-day-precision' : 'date-only',
            },
            // matched = tracks that produced at least one in-window segment
            // and were returned. candidates_considered = pre-filter pool size.
            matched: tracksOut.length,
            candidates_considered: matches.length,
            center: center ? { lat: center.lat, lon: center.lon, radius_mi: radiusMi, radius_ft: RADIUS_FT } : null,
            live: {
              updated_at: liveData.updated_at || null,
              tracks: liveCandidates.length,
              days_loaded: liveData.days_loaded || 1,
              source: needsHistoricalLive ? 'live_tracks-multi-day' : 'live_tracks-today',
            },
            tracks: tracksOut,
          }
          // Surface the available history range so callers can detect when
          // their window pre-dates what's persisted.
          if (db.useDb) {
            try {
              const horizon = await db.getLiveDataHorizon()
              payload.data_horizon = horizon
            } catch {}
          }
          // When querying a specific tail, add aircraft metadata.
          if (tail) {
            const allCandidates = [...liveCandidates, ...candidates]
            const pickField = (k) => {
              for (const t of allCandidates) if (t[k]) return t[k]
              return ''
            }
            payload.tail = tail
            payload.call = pickField('call') || tail
            payload.type = pickField('type')
            payload.desc = pickField('desc')
            payload.ownOp = pickField('ownOp')
          }
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify(payload))
        } catch (err) {
          console.error('[excursions-segments-api] error', err)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
      // GET /api/excursions/boot — Returns tracks with pre-computed bands
      // and per-tail active summaries from Postgres. Optionally joins
      // reports and notifications.
      server.middlewares.use('/api/excursions/boot', async (req, res, next) => {
        console.log('[excursions-boot] hit:', req.method, req.url)
        if (req.method !== 'GET') return next()
        // Coalesce-leader bookkeeping in outer scope so the catch can
        // safely settle (or no-op for waiters / early returns).
        let leaderResolve = null
        let leaderReject = null
        let leaderCacheKey = null
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const hours = Number(u.searchParams.get('hours')) || 1
          // `airport` filter — when set, the response narrows to tracks
          // attributed to (or flying through) the named field. Without it
          // the endpoint is region-wide (every Front Range airport mixed),
          // which is what the kiosk reported as buggy: painting KBDU
          // tracks on the KBJC map. Semantic when set: historical tracks
          // are filtered in SQL on `base_airport = $airport`; live tracks
          // are filtered post-enrichment on `t.base === airport ||
          // t.origin === airport || t.dest === airport` (covers transit).
          const airport = (u.searchParams.get('airport') || '').trim().toUpperCase() || null
          // Region-wide (no `airport=`) is the heaviest path: the SQL has
          // no narrowing predicate beyond date, and the response includes
          // every Front Range airport's tracks. The kiosk reported 3-of-3
          // 500 / 59 s avg / 98 s max on hours=24&limit=150 unfiltered.
          // Cap unfiltered limit at 75 to keep the worst-case payload and
          // sort cost bounded — clients that want full detail must pass
          // `airport=`. The `limit` query param still wins up to its hard
          // ceiling (500 with airport, 75 without).
          const rawLimit = Number(u.searchParams.get('limit')) || 100
          const limit = airport ? Math.min(500, rawLimit) : Math.min(75, rawLimit)
          const includeSet = new Set(
            (u.searchParams.get('include') || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          )
          if (airport && !ENRICH_AP.find(a => a.code === airport)) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Access-Control-Allow-Origin', '*')
            return res.end(JSON.stringify({ error: `unknown airport ${airport}` }))
          }

          // ── Response cache ──
          // /boot is the kiosk's bootstrap call — probed once at startup
          // and again on session reconnects. Cache the JSON body keyed on
          // (airport, hours, limit, include) for BOOT_RESPONSE_TTL_MS
          // (45 s). A warm cache eliminates the multi-second SQL +
          // per-tail enrichment path entirely. The cached value is the
          // already-serialized JSON string so we avoid re-stringifying.
          const includeKey = [...includeSet].sort().join(',')
          const cacheKey = `${airport || ''}|${hours}|${limit}|${includeKey}`
          const cachedBoot = bootResponseCache.get(cacheKey)
          if (cachedBoot && Date.now() - cachedBoot.fetchedAt < BOOT_RESPONSE_TTL_MS) {
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.setHeader('X-Cache', 'HIT')
            return res.end(cachedBoot.body)
          }

          // ── In-flight request coalescing ──
          // Without this, when the kiosk fleet polls the endpoint while a
          // MISS is computing, each request grabs a pool slot and runs
          // the full SQL independently. With pool max=8 and ~60 s queries,
          // the pool saturates and downstream requests time out with
          // statement_timeout → 500. Coalescing lets every waiter on the
          // same key share one computation.
          const inflight = bootInFlight.get(cacheKey)
          if (inflight) {
            // Waiter path. If the leader rejects, the outer catch emits
            // a clean 500 for this caller too.
            const { body } = await inflight
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.setHeader('X-Cache', 'COALESCED')
            return res.end(body)
          }
          // Leader path: create the in-flight promise so coalesced callers
          // arriving below can await it. Track the key + resolvers in
          // outer scope so the success / error tails know to settle.
          leaderCacheKey = cacheKey
          const inflightPromise = new Promise((resolve, reject) => {
            leaderResolve = resolve
            leaderReject = reject
          })
          // Silence unhandled-rejection noise if no waiter ever attaches.
          inflightPromise.catch(() => {})
          bootInFlight.set(cacheKey, inflightPromise)

          const SEV = { yellow: 1, orange: 2, red: 3, purple: 4 }
          const nowMs = Date.now()
          const fromDate = new Date(nowMs - hours * 3600 * 1000).toISOString().slice(0, 10)
          const toDate = new Date(nowMs).toISOString().slice(0, 10)

          // Load complaints once per request (30 s memoized). Used twice:
          //   (a) per-track `complaints[]` — tail+window match for the
          //       kiosk's "halo the matching flight track" overlay
          //   (b) top-level `complaints` — every complaint in the request
          //       window, geocoded or not. The kiosk filters this to lat/lon
          //       for map pins and re-uses it to render notes alongside flights.
          const fsMod = await import('./flightScore.js')
          const complaintsRaw = await loadComplaintsCached()
          const complaintsForWindow = fsMod.recentComplaintsForKiosk(
            complaintsRaw, Math.min(24 * 60, hours * 60),
          )

          // Historical tracks are indexed by date only, so sub-day windows
          // can't be filtered at the point level — live data covers that range.
          // Skip the historical query entirely when hours < 24.
          let tracksRes = { rows: [] }
          if (hours >= 24) {
            const tracksSql = `
              SELECT call, type, desc_text AS desc, own_op AS "ownOp", src,
                     date, base_airport AS base, worst_class AS worst, school,
                     seg_total, seg_red, seg_orange, seg_yellow, seg_purple,
                     len_total_ft, len_red_ft, len_orange_ft, len_yellow_ft, len_purple_ft,
                     bands
              FROM tracks
              WHERE date >= $1 AND date <= $2
                AND worst_class IS NOT NULL
                AND bands IS NOT NULL
                ${airport ? 'AND base_airport = $4' : ''}
              ORDER BY
                CASE WHEN seg_purple > 0 THEN 0
                     WHEN worst_class = 'red' THEN 1
                     WHEN worst_class = 'orange' THEN 2
                     ELSE 3 END,
                rand_key
              LIMIT $3
            `
            const tracksParams = airport
              ? [fromDate, toDate, limit, airport]
              : [fromDate, toDate, limit]
            tracksRes = await db.queryDb(tracksSql, tracksParams)
          }

          // ── Per-tail active summary ──
          const activeSql = `
            SELECT call AS tail, type,
                   MAX(worst_class) AS worst,
                   SUM(seg_yellow)::int AS yellow,
                   SUM(seg_orange)::int AS orange,
                   SUM(seg_red)::int AS red,
                   SUM(seg_purple)::int AS purple,
                   SUM(seg_red + seg_orange + seg_yellow + seg_purple)::int AS points_hit,
                   MAX(date) AS last_date,
                   school, base_airport AS airport
            FROM tracks
            WHERE date >= $1 AND date <= $2
              AND worst_class IS NOT NULL
              ${airport ? 'AND base_airport = $3' : ''}
            GROUP BY call, type, school, base_airport
            ORDER BY
              CASE MAX(worst_class)
                WHEN 'purple' THEN 4 WHEN 'red' THEN 3
                WHEN 'orange' THEN 2 WHEN 'yellow' THEN 1
                ELSE 0 END DESC,
              SUM(seg_red) DESC
          `
          const activeParams = airport
            ? [fromDate, toDate, airport]
            : [fromDate, toDate]
          const activeRes = await db.queryDb(activeSql, activeParams)
          // Engineless aircraft (gliders, balloons) are VNAP-exempt. Even
          // if they have non-null worst_class in the historical tracks
          // table (the backfill ran before this rule existed), they
          // never appear in the active list.
          const active = activeRes.rows.filter(r => !isEnginelessType(r.type)).map(r => ({
            tail: r.tail, type: r.type || 'Unknown',
            school: r.school || null, airport: r.airport || null,
            worst: r.worst,
            counts: { yellow: r.yellow, orange: r.orange, red: r.red, purple: r.purple },
            pointsHit: r.points_hit,
            lastDate: r.last_date,
          }))

          // ── Live tracks (pre-classified by capture-worker) ──
          let liveCount = 0, liveUpdatedAt = null
          const liveTracks = []
          // Window cutoff in epoch-ms for trimming live track points.
          // Live track points are 4-tuples [lat, lon, alt, ts_ms], so we can
          // filter at sub-second resolution. Any `hours` value works here.
          const windowFromMs = nowMs - hours * 3600 * 1000
          try {
            // Fetch live_tracks across the FULL requested window, not just
            // CURRENT_DATE. The capture worker keys rows by UTC day; near
            // midnight a `hours=24` request needs both yesterday's and
            // today's rows to cover the actual 24-hour window. Without
            // this, the response shrinks to ~minutes right after the
            // UTC rollover. (The per-point timestamp trim below clips
            // anything outside windowFromMs.)
            const liveRange = await db.loadLiveFromDbByDateRange(fromDate, toDate)
            const rawLive = liveRange.tracks || []
            if (rawLive.length) {
              liveCount = rawLive.length
              liveUpdatedAt = liveRange.updated_at || null
              for (const t of rawLive) {
                if (!t.bands || t.bands.length === 0) continue
                // Engineless aircraft (gliders, balloons) are VNAP-exempt —
                // the capture worker may have written historical bands with
                // non-null klass values before this rule existed; flatten
                // any such bands to klass=null at read time so they never
                // surface as excursions.
                const engineless = isEnginelessType(t.type)
                // Trim each band's points to the time window when possible.
                // Bands whose last point is older than the cutoff are dropped;
                // bands spanning the cutoff get their leading points sliced.
                const trimmedBands = []
                for (const b of t.bands) {
                  const pts = b.points || []
                  if (!pts.length) continue
                  const hasTs = pts[pts.length - 1].length > 3
                  const sanitised = engineless && b.klass ? { ...b, klass: null } : b
                  if (!hasTs) { trimmedBands.push(sanitised); continue }
                  // Find the first point >= windowFromMs
                  let startIdx = pts.length
                  for (let i = 0; i < pts.length; i++) {
                    if (pts[i][3] >= windowFromMs) { startIdx = i; break }
                  }
                  if (startIdx >= pts.length) continue // whole band is too old
                  // Keep the last point before the window as a bridge for continuity
                  const slice = startIdx > 0 ? pts.slice(startIdx - 1) : pts.slice(startIdx)
                  if (slice.length >= 2) trimmedBands.push({ ...sanitised, points: slice })
                }
                if (!trimmedBands.length) continue
                // Server-classified flight phase for the kiosk — same
                // classifier as /api/excursions/segments. Replaces the
                // client-side altitude-trend heuristic which trailed on
                // stale fixes and mis-classified thermalling gliders.
                const phaseAll = trimmedBands.flatMap((b) => b.points || [])
                const { phase, descents, hasDescents } = classifyTrackPhase(phaseAll)
                liveTracks.push({
                  call: t.call || t.reg || '?',
                  type: t.type || '',
                  src: 'live',
                  date: toDate,
                  base: null,
                  // VNAP-exempt aircraft: zero out the cached worst/seg/len
                  // counters too, so consumers reading those fields directly
                  // see consistent state with the (now-null-klass) bands.
                  worst: engineless ? null : (t.worst || null),
                  school: null,
                  seg_total: t.seg_total || 0,
                  seg_red: engineless ? 0 : (t.seg_red || 0),
                  seg_orange: engineless ? 0 : (t.seg_orange || 0),
                  seg_yellow: engineless ? 0 : (t.seg_yellow || 0),
                  len_total_ft: t.len_total_ft || 0,
                  len_red_ft: engineless ? 0 : (t.len_red_ft || 0),
                  len_orange_ft: engineless ? 0 : (t.len_orange_ft || 0),
                  len_yellow_ft: engineless ? 0 : (t.len_yellow_ft || 0),
                  bands: trimmedBands,
                  phase, descents, hasDescents,
                  vnap_exempt: engineless || undefined,
                  live: true,
                })
              }
            }
          } catch (e) { console.error('[excursions-boot] live error:', e.message) }

          // ── Enrich live tracks for the kiosk Impact / Welcome slides ──
          // base/purpose/school/desc from the per-tail backfill classification
          // (tracks table, latest row per call); origin/dest/landed/on_ground_min
          // from the flight's own band geometry. A visitor with no history keeps
          // base=null (⇒ not KBDU-based) and still gets an expanded type from
          // the shared TYPE_DESC map.
          try {
            const liveTails = [...new Set(liveTracks.map((t) => t.call).filter((c) => c && c !== '?'))]
            const tailInfo = new Map()
            if (liveTails.length) {
              // Pick the latest NON-NULL value for each field independently —
              // purpose/base/desc are sparse, so the most-recent row may lack
              // a value other rows have.
              const infoRes = await db.queryDb(
                `SELECT call,
                   (array_agg(base_airport ORDER BY date DESC) FILTER (WHERE base_airport IS NOT NULL))[1] AS base,
                   (array_agg(purpose      ORDER BY date DESC) FILTER (WHERE purpose      IS NOT NULL))[1] AS purpose,
                   (array_agg(school       ORDER BY date DESC) FILTER (WHERE school       IS NOT NULL))[1] AS school,
                   (array_agg(desc_text    ORDER BY date DESC) FILTER (WHERE desc_text    IS NOT NULL))[1] AS descr
                 FROM tracks WHERE call = ANY($1) GROUP BY call`,
                [liveTails],
              )
              for (const r of infoRes.rows) tailInfo.set(r.call, r)
            }
            const GROUND_AGL = 200 // ft above field elevation still counts as "on ground"
            const NEAR_NM = 2.5    // a track end this close to a field = a landing there
            for (const t of liveTracks) {
              const info = tailInfo.get(t.call)
              t.base = info?.base || null
              t.purpose = resolvePurpose(info?.purpose, t.type, t.call)
              t.school = info?.school || t.school || null
              t.desc = info?.descr || expandType(t.type) // expanded aircraft type
              t.origin = null; t.dest = null; t.landed = false; t.on_ground_min = null
              const pts = (t.bands || []).flatMap((b) => b.points || [])
              if (pts.length >= 2) {
                const p0 = pts[0], pN = pts[pts.length - 1]
                const o = nearestAp(p0[0], p0[1]); if (o.dist <= 3) t.origin = o.code
                const d = nearestAp(pN[0], pN[1])
                if (d.dist <= NEAR_NM) {
                  t.dest = d.code
                  const groundCeil = d.elev + GROUND_AGL
                  if (pN[2] != null && pN[2] <= groundCeil) {
                    // Walk back over consecutive trailing on-ground points near the field
                    let i = pts.length - 1
                    while (i > 0) {
                      const p = pts[i - 1]
                      if (p[2] != null && p[2] <= groundCeil && nearestAp(p[0], p[1]).dist <= NEAR_NM) i--
                      else break
                    }
                    const start = pts[i]
                    const hasTs = pN.length > 3 && start.length > 3
                    t.on_ground_min = hasTs ? Math.max(0, (pN[3] - start[3]) / 60000) : null
                    t.landed = t.on_ground_min != null ? t.on_ground_min >= 5 : true
                  }
                }
              }
            }
          } catch (e) { console.error('[excursions-boot] enrich error:', e.message) }

          // Apply `airport=` to live tracks. Historical tracks are already
          // SQL-filtered upstream. A live track is in-scope when it's based
          // at the airport OR its origin / dest (from nearestAp on the
          // track's first/last fix, threshold 2.5 nm) matches — captures
          // transit traffic that flew through the field this window.
          let liveTracksFiltered = liveTracks
          if (airport) {
            liveTracksFiltered = liveTracks.filter(t =>
              t.base === airport || t.origin === airport || t.dest === airport,
            )
          }

          // ── Merge live tracks into per-tail active aggregation ──
          // The active SQL above only scans the historical `tracks` table,
          // which doesn't include today's in-progress flights. Without this
          // merge, /boot returns 0 active for hours<24 even when /active sees
          // live violations. Counts come from the trimmed bands so they
          // reflect points still in the requested window.
          const liveByTail = new Map()
          for (const lt of liveTracksFiltered) {
            const tail = lt.call
            if (!tail || tail === '?') continue
            let trackWorst = null
            const trackCounts = { yellow: 0, orange: 0, red: 0, purple: 0 }
            let trackPointsHit = 0
            for (const b of lt.bands || []) {
              if (!b.klass || !(b.klass in trackCounts)) continue // clean band
              const n = b.points?.length || 0
              trackCounts[b.klass] += n
              trackPointsHit += n
              if (!trackWorst || SEV[b.klass] > SEV[trackWorst]) trackWorst = b.klass
            }
            if (!trackWorst) continue // no in-window violations on this track
            let rec = liveByTail.get(tail)
            if (!rec) {
              rec = {
                tail, type: lt.type || 'Unknown',
                school: null, airport: null,
                worst: trackWorst,
                counts: { ...trackCounts },
                pointsHit: trackPointsHit,
                lastDate: lt.date,
                live: true,
              }
              liveByTail.set(tail, rec)
            } else {
              for (const k of ['yellow', 'orange', 'red', 'purple']) rec.counts[k] += trackCounts[k]
              rec.pointsHit += trackPointsHit
              if (SEV[trackWorst] > SEV[rec.worst]) rec.worst = trackWorst
            }
          }
          // Merge by tail: bump counts on existing historical row, otherwise append
          for (const [tail, rec] of liveByTail) {
            const existing = active.find(a => a.tail === tail)
            if (existing) {
              for (const k of ['yellow', 'orange', 'red', 'purple']) {
                existing.counts[k] = (existing.counts[k] || 0) + rec.counts[k]
              }
              existing.pointsHit = (existing.pointsHit || 0) + rec.pointsHit
              if (SEV[rec.worst] > SEV[existing.worst]) existing.worst = rec.worst
              existing.live = true
            } else {
              active.push(rec)
            }
          }
          // Re-sort: severity desc, then points hit desc
          active.sort((a, b) => SEV[b.worst] - SEV[a.worst] || (b.pointsHit || 0) - (a.pointsHit || 0))

          // ── Opt-in joins: reports, notifications ──
          if (includeSet.has('reports')) {
            const complaints = await db.getComplaints(null)
            const byTail = new Map()
            for (const c of complaints || []) {
              const ts = Date.parse(c.createdAt || '')
              if (!Number.isFinite(ts) || ts < windowFromMs || ts > nowMs) continue
              const k = (c.tail || '').toUpperCase()
              if (!k) continue
              let rec = byTail.get(k)
              if (!rec) { rec = { count: 0, scoreMax: null, scoreSum: 0, scoreN: 0 }; byTail.set(k, rec) }
              rec.count++
              if (typeof c.score === 'number') { rec.scoreSum += c.score; rec.scoreN++; if (rec.scoreMax == null || c.score > rec.scoreMax) rec.scoreMax = c.score }
            }
            for (const entry of active) {
              const rec = byTail.get(entry.tail.toUpperCase())
              entry.reportCount = rec ? rec.count : 0
              entry.reportScoreMax = rec?.scoreMax ?? null
              entry.reportScoreAvg = rec && rec.scoreN > 0 ? rec.scoreSum / rec.scoreN : null
            }
          }
          if (includeSet.has('notifications')) {
            const items = await db.getNotifications(null, null)
            const STATUS_RANK = { none: 0, acknowledged: 1, reviewed: 2, completed: 3 }
            const actionToStatus = (action) => {
              if (action === 'acknowledge') return 'acknowledged'
              if (action === 'reviewed_flight' || action === 'reviewed_abatement') return 'reviewed'
              if (action === 'completed_training') return 'completed'
              return 'none'
            }
            const byTail = new Map()
            for (const it of items || []) {
              const ts = Date.parse(it.at || '')
              if (!Number.isFinite(ts) || ts < windowFromMs || ts > nowMs) continue
              const k = (it.tail || '').toUpperCase()
              if (!k) continue
              let rec = byTail.get(k)
              if (!rec) { rec = { operator: null, pilot: null, responses: [] }; byTail.set(k, rec) }
              if (it.kind === 'operator') { if (!rec.operator || ts > Date.parse(rec.operator.at)) rec.operator = it }
              else if (it.kind === 'pilot') { if (!rec.pilot || ts > Date.parse(rec.pilot.at)) rec.pilot = it }
              else if (it.kind === 'pilot-response') rec.responses.push(it)
            }
            for (const entry of active) {
              const rec = byTail.get(entry.tail.toUpperCase())
              if (!rec) {
                entry.operatorNotified = null; entry.pilotNotified = null
                entry.pilotAction = { status: 'none', at: null, steps: { acknowledged: false, flight_reviewed: false, abatement_reviewed: false, completed_training: false } }
                continue
              }
              entry.operatorNotified = rec.operator ? { at: rec.operator.at, via: rec.operator.via || null, contact: rec.operator.contact || null } : null
              entry.pilotNotified = rec.pilot ? { at: rec.pilot.at, via: rec.pilot.via || null, channel: rec.pilot.channel || null } : null
              const steps = { acknowledged: false, flight_reviewed: false, abatement_reviewed: false, completed_training: false }
              let bestStatus = 'none', bestAt = null
              for (const r of rec.responses) {
                if (r.action === 'acknowledge') steps.acknowledged = true
                else if (r.action === 'reviewed_flight') steps.flight_reviewed = true
                else if (r.action === 'reviewed_abatement') steps.abatement_reviewed = true
                else if (r.action === 'completed_training') steps.completed_training = true
                const s = actionToStatus(r.action)
                if (STATUS_RANK[s] >= STATUS_RANK[bestStatus]) { bestStatus = s; bestAt = r.at }
              }
              entry.pilotAction = { status: bestStatus, at: bestAt, steps }
            }
          }

          const responseBody = JSON.stringify({
            generated_at: new Date(nowMs).toISOString(),
            window: {
              hours, from: fromDate, to: toDate, limit,
              from_ms: windowFromMs, to_ms: nowMs,
              airport,
              note: hours < 24
                ? 'Sub-day window: live track points trimmed to last N hours; historical tracks skipped (date-level only).'
                : 'Historical tracks pulled by date; live track points trimmed to window.',
            },
            include: [...includeSet],
            render: {
              format: 'bands',
              colors: { red: '#dc2626', orange: '#f97316', yellow: '#facc15', purple: '#a855f7' },
              clean_color: '#1a7070',
              weight: 1.5,
              opacity: 0.7,
              blend: 'multiply',
              note: 'Each track.bands[] is an array of {klass, points} runs. Render each run as a Polyline colored by klass (null = clean_color). Points are [lat, lon, alt_ft]. Adjacent runs share their boundary point for continuity. Each band may also carry `complaints[]`, `complaint_dba_max`, `complaint_worst_klass`, `complaint_count` — paint a halo on those bands using complaint_dba_max for intensity and complaint_worst_klass for colour. The track-level `complaints[]` is the union; each complaint has `band_indices[]` so a kiosk can render either way.',
            },
            active,
            tracks: [
              ...tracksRes.rows.map((r) => {
                // Mirror the phase enrichment we do for liveTracks above so
                // historical (hours>=24) tracks carry the same field. Bands
                // come straight from the DB; flatten their points and
                // classify the whole track.
                const pts = (r.bands || []).flatMap((b) => b.points || [])
                const ph = classifyTrackPhase(pts)
                // VNAP-exempt: flatten any non-null klass bands on engineless
                // aircraft (the backfill predates this rule). Also zero
                // the cached worst/seg counters so consumers reading them
                // directly see consistent state with the bands.
                const engineless = isEnginelessType(r.type)
                const bands = engineless
                  ? (r.bands || []).map(b => b.klass ? { ...b, klass: null } : b)
                  : r.bands
                const exemptedCounters = engineless ? {
                  worst: null, seg_red: 0, seg_orange: 0, seg_yellow: 0, seg_purple: 0,
                  len_red_ft: 0, len_orange_ft: 0, len_yellow_ft: 0, len_purple_ft: 0,
                } : null
                // Per-track complaints — tail+window match. Historical
                // tracks are date-granular, so we widen the window to the
                // whole UTC day when no per-point timestamp is available.
                const win = trackTimeWindow(r)
                const trackComplaints = win
                  ? fsMod.matchComplaintsForKiosk(complaintsRaw, r.call, win[0], win[1])
                  : []
                // Per-band attribution → each band gains its own
                // complaints[] + complaint_dba_max + complaint_worst_klass,
                // and each top-level complaint gains band_indices[].
                // Use a tight 60 s pad here (≪ the 10-min flight-level pad)
                // so glow lights only the segments actually within earshot
                // of when the complainant pressed record.
                fsMod.attachComplaintsToBands(bands, trackComplaints, { pad: 60 * 1000 })
                // Bridge within-band coverage gaps so the kiosk's edge-
                // length filter doesn't drop flight-path polylines. Run
                // AFTER complaints attachment so synth points don't
                // produce phantom matches. Synth points carry tuple[4]=1.
                const synthCount = bridgeBandsInPlace(bands)
                return {
                  ...r, ...(exemptedCounters || {}), bands,
                  phase: ph.phase, descents: ph.descents, hasDescents: ph.hasDescents,
                  vnap_exempt: engineless || undefined,
                  complaints: trackComplaints,
                  points_synth_count: synthCount,
                }
              }),
              ...liveTracksFiltered.map(lt => {
                const win = trackTimeWindow(lt)
                const trackComplaints = win
                  ? fsMod.matchComplaintsForKiosk(complaintsRaw, lt.call, win[0], win[1])
                  : []
                fsMod.attachComplaintsToBands(lt.bands, trackComplaints, { pad: 60 * 1000 })
                const synthCount = bridgeBandsInPlace(lt.bands)
                return { ...lt, complaints: trackComplaints, points_synth_count: synthCount }
              }),
            ],
            live: { updated_at: liveUpdatedAt, tracks: liveCount, filtered_to: airport || null },
            // Top-level complaint feed for the kiosk's map-pin layer.
            // Items contain geocoded entries (lat/lon set) and tail-only
            // entries — kiosk filters to the subset it needs.
            complaints: {
              window_minutes: Math.min(24 * 60, hours * 60),
              count: complaintsForWindow.length,
              geocoded_count: complaintsForWindow.filter(c => c.lat != null && c.lon != null).length,
              items: complaintsForWindow,
            },
          })
          // Cache the serialized body and release coalesced waiters before
          // writing the response. Failures are NOT cached — the next caller
          // retries.
          bootResponseCache.set(cacheKey, { body: responseBody, fetchedAt: Date.now() })
          if (leaderResolve) {
            bootInFlight.delete(leaderCacheKey)
            leaderResolve({ body: responseBody })
          }
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('X-Cache', 'MISS')
          res.end(responseBody)
        } catch (err) {
          console.error('[excursions-boot] error', err)
          // Release any waiting coalesced callers with the same error so
          // they emit their own 500 (or retry on the next poll). Only the
          // leader has resolvers; waiters and early returns leave these
          // null, in which case there's nothing to settle.
          if (leaderReject) {
            try {
              bootInFlight.delete(leaderCacheKey)
              leaderReject(err)
            } catch {}
          }
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          // CORS must be set on the error path too — otherwise a DB-timeout
          // 500 (e.g. Query read timeout under load) reaches the browser as
          // a CORS error, masking the real cause.
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // GET /api/excursions/active[&hours=48][&include=reports,notifications]
      // Returns all tails with at least one classified point within the
      // window, grouped per-tail (worst class, counts, last date, school/type
      // lookup from flight_schools_fleets.json). Registered BEFORE /api/excursions
      // so connect's prefix matcher routes it correctly.
      //
      // include= opt-in joins. The base call stays cheap — the expensive
      // per-tail lookups only run when explicitly asked for:
      //   include=reports         → reportCount (+ reportScoreMax/Avg) from
      //                             the complaints store, filtered to window
      //   include=notifications   → operatorNotified / pilotNotified /
      //                             pilotAction from the notifications ledger
      server.middlewares.use('/api/excursions/active', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const hours = Number(u.searchParams.get('hours')) || 48
          const includeSet = new Set(
            (u.searchParams.get('include') || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          )
          if (!zonesCache) {
            const mod = await import('./src/noiseZones.js')
            zonesCache = mod.NOISE_ZONES
          }
          const _activeNow = Date.now()
          const _activeFrom = new Date(_activeNow - hours * 3600 * 1000).toISOString().slice(0, 10)
          const _activeTo = new Date(_activeNow).toISOString().slice(0, 10)
          const [tracksData, liveData, schoolsData] = await Promise.all([
            loadCached(fs, path, 'tracks', { fromDate: _activeFrom, toDate: _activeTo }),
            loadCached(fs, path, 'live'),
            loadCached(fs, path, 'schools'),
          ])
          // Tail → school/type lookup (schools file is authoritative).
          const tailInfo = new Map()
          for (const s of schoolsData.schools || []) {
            for (const ac of s.aircraft || []) {
              if (ac.tail) {
                tailInfo.set(ac.tail, {
                  type: ac.type || 'Unknown',
                  school: s.name,
                  airport: s.airport,
                })
              }
            }
          }
          // Live tracks carry their own type; fill in tails not in schools.
          for (const lt of liveData.tracks || []) {
            const tail = (lt.call || '').trim()
            if (!tail || tailInfo.has(tail)) continue
            tailInfo.set(tail, { type: lt.type || 'Unknown', school: null, airport: null })
          }
          // Classification helpers (inlined to match the /segments handler).
          const FT_PER_DEG_LAT = 364560
          const pointInPolygon = (lat, lon, poly) => {
            let inside = false
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
              const [yi, xi] = poly[i]
              const [yj, xj] = poly[j]
              if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) {
                inside = !inside
              }
            }
            return inside
          }
          const distPointToSegFt = (lat, lon, aLat, aLon, bLat, bLon) => {
            const latRef = (aLat + bLat + lat) / 3
            const cos = Math.cos((latRef * Math.PI) / 180)
            const px = (lon - aLon) * FT_PER_DEG_LAT * cos
            const py = (lat - aLat) * FT_PER_DEG_LAT
            const dx = (bLon - aLon) * FT_PER_DEG_LAT * cos
            const dy = (bLat - aLat) * FT_PER_DEG_LAT
            const len2 = dx * dx + dy * dy
            if (len2 === 0) return Math.hypot(px, py)
            let t = (px * dx + py * dy) / len2
            t = Math.max(0, Math.min(1, t))
            return Math.hypot(px - t * dx, py - t * dy)
          }
          const signedDistance = (lat, lon) => {
            let minAbs = Infinity
            let insideAny = false
            for (const z of zonesCache) {
              const poly = z.polygon
              if (pointInPolygon(lat, lon, poly)) insideAny = true
              let minEdge = Infinity
              for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                const d = distPointToSegFt(lat, lon, poly[i][0], poly[i][1], poly[j][0], poly[j][1])
                if (d < minEdge) minEdge = d
              }
              if (minEdge < minAbs) minAbs = minEdge
            }
            return insideAny ? -minAbs : minAbs
          }
          const ALT_THRESHOLD_FT = 7500
          const classifyAlt = (alt) => {
            if (alt == null) return null
            const below = ALT_THRESHOLD_FT - alt
            if (below > 500) return 'red'
            if (below > 250) return 'orange'
            if (below > -250) return 'yellow'
            return null
          }
          const classifyZone = (d) => {
            if (d < -500) return 'red'
            if (d < -250) return 'orange'
            if (d < 250) return 'yellow'
            return null
          }
          const SEV = { yellow: 1, orange: 2, red: 3 }
          const classifyPoint = (lat, lon, alt) => {
            const z = classifyZone(signedDistance(lat, lon))
            const a = classifyAlt(alt)
            if (!z || !a) return null
            return SEV[z] <= SEV[a] ? z : a
          }
          // Day-granular window
          const nowMs = Date.now()
          const fromDate = new Date(nowMs - hours * 3600 * 1000).toISOString().slice(0, 10)
          const toDate = new Date(nowMs).toISOString().slice(0, 10)
          // Walk every tail that appears in either historical OR live tracks.
          // Live tracks have src='live' (no embedded date) and are always
          // considered in-window.
          // updated_at is written without a timezone suffix but represents UTC;
          // force UTC parsing so "now" isn't shifted by the server's local offset.
          const parseUtc = (s) => {
            if (!s) return nowMs
            const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z'
            const t = Date.parse(iso)
            return Number.isFinite(t) ? t : nowMs
          }
          const liveUpdatedAtMs = parseUtc(liveData.updated_at)
          const allTails = new Set([
            ...tracksData._byTail.keys(),
            ...liveData._byTail.keys(),
          ])
          const active = []
          for (const tail of allTails) {
            let worst = null
            const counts = { yellow: 0, orange: 0, red: 0 }
            let lastDate = ''
            let lastSeenMs = 0
            let pointsHit = 0
            let isLive = false
            const hist = tracksData._byTail.get(tail) || []
            const live = liveData._byTail.get(tail) || []
            for (const t of [...hist, ...live]) {
              const srcIsLive = t.src === 'live'
              let trackTs = 0
              if (!srcIsLive) {
                const m = (t.src || '').match(/(\d{4}-\d{2}-\d{2})/)
                if (!m) continue
                const d = m[1]
                if (d < fromDate || d > toDate) continue
                if (d > lastDate) lastDate = d
                // Day-granular historical tracks — peg to noon of that day.
                trackTs = Date.parse(d + 'T12:00:00Z') || 0
              } else {
                isLive = true
                if (toDate > lastDate) lastDate = toDate
                // Live tracks: use the live file's updated_at as a proxy.
                trackTs = liveUpdatedAtMs
              }
              // Engineless aircraft are VNAP-exempt → no points contribute
              // to this tail's worst-class or counts.
              if (isEnginelessType(t.type)) continue
              let trackHit = false
              let trackMaxPointTs = 0
              for (const p of t.points) {
                const k = classifyPoint(p[0], p[1], p[2])
                if (k) {
                  counts[k]++
                  pointsHit++
                  trackHit = true
                  if (!worst || SEV[k] > SEV[worst]) worst = k
                  // Live collector writes per-point epoch-ms in p[3]. Use it
                  // when present so "last seen" is accurate to the second.
                  if (typeof p[3] === 'number' && p[3] > trackMaxPointTs) {
                    trackMaxPointTs = p[3]
                  }
                }
              }
              if (trackHit) {
                const ts = trackMaxPointTs || trackTs
                if (ts > lastSeenMs) lastSeenMs = ts
              }
            }
            if (worst) {
              const info = tailInfo.get(tail) || {}
              active.push({
                tail,
                type: info.type || 'Unknown',
                school: info.school || null,
                airport: info.airport || null,
                worst,
                counts,
                pointsHit,
                lastDate,
                lastSeenMs,
                live: isLive,
              })
            }
          }
          // Opt-in joins — only resolve what the client asked for. Both
          // stores are small single-file JSON ledgers; we load once and
          // index by tail in-memory.
          const windowFromMs = nowMs - hours * 3600 * 1000
          if (includeSet.has('reports')) {
            let complaintsData = null
            if (db.useDb) {
              const all = await db.getComplaints(null)
              complaintsData = { complaints: all }
            } else {
              try {
                const raw = await fs.readFile(path.resolve('data/complaints.json'), 'utf8')
                complaintsData = JSON.parse(raw)
              } catch {}
            }
            const byTail = new Map()
            for (const c of (complaintsData && complaintsData.complaints) || []) {
              const ts = Date.parse(c.createdAt || '')
              if (!Number.isFinite(ts) || ts < windowFromMs || ts > nowMs) continue
              const k = (c.tail || '').toUpperCase()
              if (!k) continue
              let rec = byTail.get(k)
              if (!rec) { rec = { count: 0, scoreMax: null, scoreSum: 0, scoreN: 0 }; byTail.set(k, rec) }
              rec.count++
              if (typeof c.score === 'number') {
                rec.scoreSum += c.score
                rec.scoreN++
                if (rec.scoreMax == null || c.score > rec.scoreMax) rec.scoreMax = c.score
              }
            }
            for (const entry of active) {
              const rec = byTail.get(entry.tail.toUpperCase())
              entry.reportCount = rec ? rec.count : 0
              entry.reportScoreMax = rec && rec.scoreMax != null ? rec.scoreMax : null
              entry.reportScoreAvg = rec && rec.scoreN > 0 ? rec.scoreSum / rec.scoreN : null
            }
          }
          if (includeSet.has('notifications')) {
            let notifData = null
            if (db.useDb) {
              const all = await db.getNotifications(null, null)
              notifData = { items: all }
            } else {
              try {
                const raw = await fs.readFile(path.resolve('data/notifications.json'), 'utf8')
                notifData = JSON.parse(raw)
              } catch {}
            }
            // Per-tail latest by kind, plus an aggregated pilotAction state
            // machine (completed > reviewed > acknowledged > none). We only
            // consider items whose `at` falls in the window, so stale
            // notifications from before hours= ago don't bleed through.
            const byTail = new Map()
            const STATUS_RANK = { none: 0, acknowledged: 1, reviewed: 2, completed: 3 }
            const actionToStatus = (action) => {
              if (action === 'acknowledge') return 'acknowledged'
              if (action === 'reviewed_flight' || action === 'reviewed_abatement') return 'reviewed'
              if (action === 'completed_training') return 'completed'
              return 'none'
            }
            for (const it of (notifData && notifData.items) || []) {
              const ts = Date.parse(it.at || '')
              if (!Number.isFinite(ts) || ts < windowFromMs || ts > nowMs) continue
              const k = (it.tail || '').toUpperCase()
              if (!k) continue
              let rec = byTail.get(k)
              if (!rec) {
                rec = {
                  operator: null, // latest operator notification
                  pilot: null,    // latest pilot notification
                  responses: [],  // all pilot-response items, any order
                }
                byTail.set(k, rec)
              }
              if (it.kind === 'operator') {
                if (!rec.operator || ts > Date.parse(rec.operator.at)) rec.operator = it
              } else if (it.kind === 'pilot') {
                if (!rec.pilot || ts > Date.parse(rec.pilot.at)) rec.pilot = it
              } else if (it.kind === 'pilot-response') {
                rec.responses.push(it)
              }
            }
            for (const entry of active) {
              const rec = byTail.get(entry.tail.toUpperCase())
              if (!rec) {
                entry.operatorNotified = null
                entry.pilotNotified = null
                entry.pilotAction = { status: 'none', at: null, steps: {
                  acknowledged: false, flight_reviewed: false, abatement_reviewed: false, completed_training: false,
                } }
                continue
              }
              entry.operatorNotified = rec.operator ? {
                at: rec.operator.at,
                via: rec.operator.via || null,
                contact: rec.operator.contact || null,
              } : null
              entry.pilotNotified = rec.pilot ? {
                at: rec.pilot.at,
                via: rec.pilot.via || null,
                channel: rec.pilot.channel || null,
              } : null
              const steps = {
                acknowledged: false,
                flight_reviewed: false,
                abatement_reviewed: false,
                completed_training: false,
              }
              let bestStatus = 'none'
              let bestAt = null
              for (const r of rec.responses) {
                if (r.action === 'acknowledge') steps.acknowledged = true
                else if (r.action === 'reviewed_flight') steps.flight_reviewed = true
                else if (r.action === 'reviewed_abatement') steps.abatement_reviewed = true
                else if (r.action === 'completed_training') steps.completed_training = true
                const s = actionToStatus(r.action)
                if (STATUS_RANK[s] >= STATUS_RANK[bestStatus]) {
                  bestStatus = s
                  bestAt = r.at
                }
              }
              entry.pilotAction = { status: bestStatus, at: bestAt, steps }
            }
          }
          active.sort((a, b) => {
            if (SEV[b.worst] !== SEV[a.worst]) return SEV[b.worst] - SEV[a.worst]
            return (b.lastSeenMs || 0) - (a.lastSeenMs || 0)
          })
          const payload = {
            generated_at: new Date(nowMs).toISOString(),
            window: { hours, from: fromDate, to: toDate },
            include: [...includeSet],
            active,
          }
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify(payload))
        } catch (err) {
          console.error('[excursions-active-api] error', err)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      server.middlewares.use('/api/excursions', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const tail = (u.searchParams.get('tail') || '').trim()
          const from = u.searchParams.get('from')
          const to = u.searchParams.get('to')
          if (!tail) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'missing required parameter: tail' }))
            return
          }
          if (!zonesCache) {
            const mod = await import('./src/noiseZones.js')
            zonesCache = mod.NOISE_ZONES
          }
          const t0 = Date.now()
          // /api/excursions?tail=… optionally takes from/to. Default to a
          // 1-year window to bound the query — querying 4+ years × 143k+
          // tracks crashes the heap.
          const _excTo = to || new Date().toISOString().slice(0, 10)
          const _excFrom = from || new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10)
          const [tracksData, schoolsData] = await Promise.all([
            loadCached(fs, path, 'tracks', { fromDate: _excFrom, toDate: _excTo }),
            loadCached(fs, path, 'schools'),
          ])
          const loadMs = Date.now() - t0
          // Build tail → school lookup
          let schoolInfo = null
          for (const s of schoolsData.schools || []) {
            for (const ac of s.aircraft || []) {
              if (ac.tail === tail) {
                schoolInfo = { school: s.name, airport: s.airport, type: ac.type || '' }
                break
              }
            }
            if (schoolInfo) break
          }
          // Geo helpers — inlined so the plugin is self-contained.
          const FT_PER_DEG_LAT = 364560
          const pointInPolygon = (lat, lon, poly) => {
            let inside = false
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
              const [yi, xi] = poly[i]
              const [yj, xj] = poly[j]
              if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) {
                inside = !inside
              }
            }
            return inside
          }
          const distPointToSegFt = (lat, lon, aLat, aLon, bLat, bLon) => {
            const latRef = (aLat + bLat + lat) / 3
            const cos = Math.cos((latRef * Math.PI) / 180)
            const px = (lon - aLon) * FT_PER_DEG_LAT * cos
            const py = (lat - aLat) * FT_PER_DEG_LAT
            const dx = (bLon - aLon) * FT_PER_DEG_LAT * cos
            const dy = (bLat - aLat) * FT_PER_DEG_LAT
            const len2 = dx * dx + dy * dy
            if (len2 === 0) return Math.hypot(px, py)
            let t = (px * dx + py * dy) / len2
            t = Math.max(0, Math.min(1, t))
            return Math.hypot(px - t * dx, py - t * dy)
          }
          const signedDistance = (lat, lon) => {
            let minAbs = Infinity
            let insideAny = false
            let nearestZone = null
            for (const z of zonesCache) {
              const poly = z.polygon
              if (pointInPolygon(lat, lon, poly)) insideAny = true
              let minEdge = Infinity
              for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                const d = distPointToSegFt(lat, lon, poly[i][0], poly[i][1], poly[j][0], poly[j][1])
                if (d < minEdge) minEdge = d
              }
              if (minEdge < minAbs) { minAbs = minEdge; nearestZone = z.name }
            }
            return { d: insideAny ? -minAbs : minAbs, zone: nearestZone }
          }
          const ALT_THRESHOLD_FT = 7500
          const classifyAlt = (alt) => {
            if (alt == null) return null
            const below = ALT_THRESHOLD_FT - alt
            if (below > 500) return 'red'
            if (below > 250) return 'orange'
            if (below > -250) return 'yellow'
            return null
          }
          const classifyZone = (d) => {
            if (d < -500) return 'red'
            if (d < -250) return 'orange'
            if (d < 250) return 'yellow'
            return null
          }
          const SEV = { yellow: 1, orange: 2, red: 3 }
          const classifyPoint = (lat, lon, alt) => {
            const { d, zone } = signedDistance(lat, lon)
            const z = classifyZone(d)
            const a = classifyAlt(alt)
            if (!z || !a) return { klass: null, zone: null }
            return { klass: SEV[z] <= SEV[a] ? z : a, zone }
          }
          // Look up tracks for this tail via the pre-indexed Map (O(1)),
          // then filter by date window. Search depth is therefore bounded by
          // the number of days that tail was observed — usually < 100.
          const candidates = tracksData._byTail.get(tail) || []
          const matches = candidates.filter((t) => {
            if (!from && !to) return true
            const m = (t.src || '').match(/(\d{4}-\d{2}-\d{2})/)
            if (!m) return false
            const d = m[1]
            if (from && d < from) return false
            if (to && d > to) return false
            return true
          })
          // Walk each track, collect contiguous-violation events
          const excursions = []
          for (const t of matches) {
            const m = (t.src || '').match(/(\d{4}-\d{2}-\d{2})/)
            const date = m ? m[1] : null
            // Engineless aircraft (gliders/balloons) → no excursions emitted.
            if (isEnginelessType(t.type)) continue
            const tags = t.points.map((p) => classifyPoint(p[0], p[1], p[2]))
            let cur = null
            for (let i = 0; i < t.points.length; i++) {
              const tag = tags[i]
              if (tag.klass) {
                if (!cur) cur = {
                  date, worst: tag.klass, zone: tag.zone, points: 1,
                  peakAlt: t.points[i][2],
                }
                else {
                  cur.points++
                  if (SEV[tag.klass] > SEV[cur.worst]) {
                    cur.worst = tag.klass; cur.zone = tag.zone
                    cur.peakAlt = t.points[i][2]
                  }
                }
              } else if (cur) {
                excursions.push(cur); cur = null
              }
            }
            if (cur) excursions.push(cur)
          }
          excursions.sort((a, b) => (a.date || '').localeCompare(b.date || ''))
          // Landing URL — deep link to the NoticePage with tail, timestamp
          // of the worst offense (midnight UTC of that day), and school
          // pre-populated for the compose flow.
          const host = req.headers.host || 'localhost:5174'
          const proto = req.headers['x-forwarded-proto'] || 'http'
          const worstOffense = excursions.length
            ? excursions.reduce((w, o) => (SEV[o.worst] > SEV[w.worst] ? o : w), excursions[0])
            : null
          const atMs = worstOffense
            ? Date.parse(worstOffense.date + 'T12:00:00Z') || Date.now()
            : Date.now()
          const noticeId = signNoticeId(tail, atMs)
          const params = new URLSearchParams()
          params.set('tail', tail)
          params.set('at', String(atMs))
          params.set('nid', noticeId)
          if (schoolInfo?.school) params.set('school', schoolInfo.school)
          const landing = `${proto}://${host}/notice?${params.toString()}`
          const elapsedMs = Date.now() - t0
          const payload = {
            tail,
            type: schoolInfo?.type || '',
            school: schoolInfo?.school || null,
            base: schoolInfo?.airport || null,
            window: { from: from || null, to: to || null },
            tracks_seen: matches.length,
            tracks_in_index: candidates.length,
            total_excursions: excursions.length,
            worst: excursions.length
              ? excursions.reduce((w, o) => (SEV[o.worst] > SEV[w] ? o.worst : w), excursions[0].worst)
              : null,
            excursions,
            landing_url: landing,
            timing_ms: { total: elapsedMs, file_load: loadMs },
          }
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify(payload, null, 2))
        } catch (err) {
          console.error('[excursions-api] error', err)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}

// Server-side live ADS-B collector. Runs inside the dev server (and any
// preview/build-serve invocation): polls adsb.lol (falling back to
// airplanes.live) every POLL_MS, accumulates per-hex tracks in memory, and
// atomically flushes to public/tracks_live.json — the same file the
// /api/excursions/segments endpoint merges with historical data. On UTC day
// rollover the previous day is written to public/tracks_live_YYYY-MM-DD.json
// and in-memory state resets. This replaces the brittle per-tab
// localStorage persistence in App.jsx as the single source of truth for
// "today's" live data, shared across every browser tab hitting the server.
// POST /api/noise-reports
//   body: { mode, submittedAt, reporter, identity, location, score, media, excursion, ... }
//   Persists the full client-side meta blob verbatim to
//   noise/web/data/noise_reports.json, assigns a server-side id and
//   receivedAt, and returns { id, receivedAt }. Concurrent writes are
//   serialized through the shared ledger promise chain.
//
// GET /api/noise-reports[?reporter=...]
//   Read-only dump, optionally filtered by reporter (for a "My Reports"
//   panel). Returns { count, reports }.
function noiseReportsApiPlugin() {
  const ledger = makeLedger('data/noise_reports.json')
  // Allowed audio slots — anything else 400s. Add slots here when new clip
  // types are introduced (e.g. raw60s).
  const AUDIO_SLOTS = new Set(['spliced10s', 'loudest5s'])
  const AUDIO_MAX_BYTES = 1_000_000 // 1 MB cap per clip (defends against WAV/PCM uploads)
  // Match /api/noise-reports/<reportId>/audio/<slot>
  const AUDIO_PATH_RE = /^\/([^/]+)\/audio\/([^/]+)\/?$/
  // Read the whole request body into a Buffer with a hard size cap.
  const readBytesCapped = async (req, max) => {
    const chunks = []
    let total = 0
    for await (const c of req) {
      total += c.length
      if (total > max) throw new Error(`payload too large (>${max} bytes)`)
      chunks.push(c)
    }
    return Buffer.concat(chunks, total)
  }
  return {
    name: 'noise-reports-api',
    configureServer(server) {
      server.middlewares.use('/api/noise-reports', async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'POST') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')

          // ── Audio sub-route dispatch ──
          // Vite's connect prefix-matches /api/noise-reports, so audio URLs
          // arrive here. Strip the prefix and check for an audio path before
          // falling through to the JSON list/create logic.
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const subPath = u.pathname.replace(/^\/api\/noise-reports/, '') || '/'
          const audioMatch = subPath.match(AUDIO_PATH_RE)
          if (audioMatch) {
            const reportId = decodeURIComponent(audioMatch[1])
            const slot = decodeURIComponent(audioMatch[2])
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
            if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }
            if (!AUDIO_SLOTS.has(slot)) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: `invalid slot; allowed: ${[...AUDIO_SLOTS].join(', ')}` }))
              return
            }

            if (req.method === 'POST') {
              const ctype = (req.headers['content-type'] || '').toLowerCase()
              if (!ctype.startsWith('audio/mpeg') && !ctype.startsWith('audio/mp3')) {
                res.statusCode = 415
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'Content-Type must be audio/mpeg' }))
                return
              }
              let buf
              try {
                buf = await readBytesCapped(req, AUDIO_MAX_BYTES)
              } catch (err) {
                res.statusCode = 413
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: String(err.message || err) }))
                return
              }
              if (buf.length === 0) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'empty body' }))
                return
              }
              if (db.useDb) {
                await db.addAudio(reportId, slot, buf, 'audio/mpeg')
              } else {
                const dir = path.resolve('data/audio', reportId)
                await fs.mkdir(dir, { recursive: true })
                await fs.writeFile(path.join(dir, `${slot}.mp3`), buf)
              }
              res.statusCode = 201
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true, reportId, slot, bytes: buf.length }))
              return
            }

            if (req.method === 'GET') {
              let bytes = null, mime = 'audio/mpeg'
              if (db.useDb) {
                const row = await db.getAudio(reportId, slot)
                if (row) { bytes = row.bytes; mime = row.mime || 'audio/mpeg' }
              } else {
                try {
                  bytes = await fs.readFile(path.resolve('data/audio', reportId, `${slot}.mp3`))
                } catch { bytes = null }
              }
              if (!bytes) {
                res.statusCode = 404
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'audio not found' }))
                return
              }
              res.setHeader('Content-Type', mime)
              res.setHeader('Content-Length', bytes.length)
              // Audio clips are immutable per (reportId, slot) — long cache.
              res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
              res.end(bytes)
              return
            }

            res.statusCode = 405
            res.end()
            return
          }

          // ── Original JSON list/create logic ──
          if (req.method === 'GET') {
            const reporter = (u.searchParams.get('reporter') || '').trim()
            let list
            if (db.useDb) {
              list = await db.getNoiseReports(reporter || null)
            } else {
              const data = (await ledger.load(fs, path)) || { reports: [] }
              list = Array.isArray(data.reports) ? data.reports : []
              if (reporter) {
                list = list.filter((r) => {
                  const rep = r.reporter
                  if (!rep) return false
                  if (typeof rep === 'string') return rep === reporter
                  return rep.email === reporter || rep.id === reporter || rep.name === reporter
                })
              }
            }
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(JSON.stringify({ count: list.length, reports: list }))
            return
          }
          let body
          try {
            body = await readJsonBody(req)
          } catch {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'invalid JSON body' }))
            return
          }
          const receivedAt = new Date().toISOString()
          const id = `nr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          const record = { ...body, id, receivedAt }
          if (db.useDb) {
            await db.addNoiseReport(record)
          } else {
            await ledger.mutate(fs, path, (cur) => {
              const reports = Array.isArray(cur.reports) ? cur.reports : []
              reports.push(record)
              return { reports }
            })
          }
          res.statusCode = 201
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ id, receivedAt }))
        } catch (err) {
          console.error('[noise-reports-api] error', err)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}

// POST /api/notifications/pilot-ack
//   body: { tail, noticeId?, via?, channel?: 'operator-forwarded'|'direct', contact?, notes? }
//   Records that the pilot has been notified (typically by the operator
//   forwarding the notice downstream). Writes to data/notifications.json.
//
// POST /api/pilot-response
//   body: { noticeId | tail, action: 'acknowledge'|'reviewed_flight'|
//           'reviewed_abatement'|'completed_training', notes? }
//   Records a pilot response tied back to a specific notice via HMAC-signed
//   noticeId (from the landing URL). Falls back to bare tail if noticeId is
//   absent — useful for manual back-office entries — but a signed noticeId
//   is the canonical path. Writes to data/notifications.json with
//   kind='pilot-response'.
//
// GET /api/notifications[?tail=...&kind=operator|pilot|pilot-response]
//   Read-only dump for debugging and for the /active endpoint to join
//   per-tail notification state.
function pilotApiPlugin() {
  const PILOT_ACTIONS = new Set([
    'acknowledge',
    'reviewed_flight',
    'reviewed_abatement',
    'completed_training',
  ])
  return {
    name: 'pilot-api',
    configureServer(server) {
      server.middlewares.use('/api/notifications/pilot-ack', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const body = await readJsonBody(req).catch(() => null)
          if (!body) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'invalid JSON body' }))
            return
          }
          const tail = ((body.tail || '') + '').trim().toUpperCase()
          if (!tail) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'missing tail' }))
            return
          }
          const record = {
            kind: 'pilot',
            tail,
            via: body.via || 'api',
            channel: body.channel || 'operator-forwarded',
            contact: body.contact || null,
            noticeId: body.noticeId || null,
            notes: body.notes || null,
            at: new Date().toISOString(),
          }
          if (db.useDb) {
            await db.addNotification(record)
          } else {
            await notificationsLedger.mutate(fs, path, (cur) => {
              const items = Array.isArray(cur.items) ? cur.items : []
              items.push(record)
              return { items }
            })
          }
          res.statusCode = 201
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify(record))
        } catch (err) {
          console.error('[pilot-ack] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
      server.middlewares.use('/api/pilot-response', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const body = await readJsonBody(req).catch(() => null)
          if (!body) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'invalid JSON body' }))
            return
          }
          const action = ((body.action || '') + '').trim()
          if (!PILOT_ACTIONS.has(action)) {
            res.statusCode = 400
            res.end(JSON.stringify({
              error: 'invalid action',
              allowed: [...PILOT_ACTIONS],
            }))
            return
          }
          // Prefer signed noticeId; fall back to bare tail. Reject if
          // neither channel yields a usable tail.
          let tail = null
          let noticeId = null
          if (body.noticeId) {
            const verified = verifyNoticeId(body.noticeId)
            if (!verified) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'invalid or expired noticeId' }))
              return
            }
            tail = verified.tail
            noticeId = body.noticeId
          } else if (body.tail) {
            tail = ((body.tail || '') + '').trim().toUpperCase()
          }
          if (!tail) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'missing noticeId or tail' }))
            return
          }
          const record = {
            kind: 'pilot-response',
            tail,
            action,
            noticeId,
            notes: body.notes || null,
            at: new Date().toISOString(),
          }
          if (db.useDb) {
            await db.addNotification(record)
          } else {
            await notificationsLedger.mutate(fs, path, (cur) => {
              const items = Array.isArray(cur.items) ? cur.items : []
              items.push(record)
              return { items }
            })
          }
          res.statusCode = 201
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify(record))
        } catch (err) {
          console.error('[pilot-response] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
      server.middlewares.use('/api/notifications', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const tail = (u.searchParams.get('tail') || '').trim().toUpperCase()
          const kind = (u.searchParams.get('kind') || '').trim()
          let items
          if (db.useDb) {
            items = await db.getNotifications(tail || null, kind || null)
          } else {
            const data = (await notificationsLedger.load(fs, path)) || { items: [] }
            items = Array.isArray(data.items) ? data.items : []
            if (tail) items = items.filter((i) => (i.tail || '').toUpperCase() === tail)
            if (kind) items = items.filter((i) => i.kind === kind)
          }
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ count: items.length, items }))
        } catch (err) {
          console.error('[notifications-api] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}

// Per-airport scale that maps an `impact_index` (small float, same units
// the leaderboard uses) onto the 0–100 integer `pop_impact` the Pilot
// Console wants. Calibration target (FLIGHT_DATA_SERVICE.md Ask #5a):
// 100 = loudest plausible aircraft × densest catchment cell × pattern-leg
// duration.
//
// Retuned 2026-05-31 against an empirical sample of 115 KBDU flights
// (pattern-excluded). Observed impact_index distribution:
//   p50=0.43, p75=0.91, p90=1.59, p95=2.21, p99=2.79, max=17.2
// Scale=40 puts the calibration ceiling at impact_index ≈ 2.5 → 100;
// p95 maps to 88, p90 to 63, p75 to 36. ~5% of flights null (vs 12%
// at the v0 scale=50 / threshold=1.5). The bulk of the distribution
// sits in the 0-95 range with real numbers; only the genuine high-
// impact outliers null.
const IMPACT_SCALE_BY_AIRPORT = {
  KBDU: 40,
  KBJC: 40,
}
const IMPACT_SCALE_DEFAULT = 40

// Null threshold for pop_impact — aligned with the scale so that the
// null fires exactly when the unscaled value would exceed 100. Updated
// whenever IMPACT_SCALE_DEFAULT moves so the two stay in lock-step.
const POP_IMPACT_NULL_THRESHOLD = 100 / IMPACT_SCALE_DEFAULT  // 2.5 at scale=40

const VNAP_KLASS_RANK = { yellow: 1, orange: 2, red: 3, purple: 4 }

// Pattern exclusion envelope — fixes inside this envelope are dropped from
// the population-impact and worst-segment calculations (but NOT from VNAP
// counting or complaint matching). Rationale: the pattern's noise exposure
// over the immediate airport neighborhood is structurally unavoidable —
// every takeoff and landing happens there. Penalizing it inflates
// `pop_impact` for what every flight at this field has to do. If a pattern
// leg also crosses a noise-abatement zone (vnap_count) or triggers a
// complaint, those still count — that's the right signal.
//
// Envelope: within `pattern_radius_nm` of the field AND ≤ pattern_alt_agl_ft.
// 2 nm × 1500 ft AGL covers a standard FAA pattern (~1000 AGL) plus the
// climb-out buffer to ~1500 before the aircraft "leaves the pattern."
const PATTERN_RADIUS_NM_BY_AIRPORT = {
  KBDU: 2,
  KBJC: 3, // bigger field, longer downwinds
}
const PATTERN_RADIUS_NM_DEFAULT = 2
const PATTERN_ALT_AGL_FT_DEFAULT = 1500

// Airport static metadata not derivable from ENRICH_AP. Magnetic
// declination values are positive East (US/Colorado area). Extend this
// map as new airports get configured for /api/airports/:icao.
const AIRPORT_META_STATIC = {
  KBDU: { name: 'Boulder Municipal',          magnetic_variation_e: 6.8, tz: 'America/Denver' },
  KBJC: { name: 'Rocky Mountain Metropolitan', magnetic_variation_e: 6.9, tz: 'America/Denver' },
  KAPA: { name: 'Centennial',                 magnetic_variation_e: 6.7, tz: 'America/Denver' },
  KFNL: { name: 'Northern Colorado Regional', magnetic_variation_e: 6.5, tz: 'America/Denver' },
  KEIK: { name: 'Erie Municipal',             magnetic_variation_e: 6.7, tz: 'America/Denver' },
  KLMO: { name: 'Vance Brand (Longmont)',     magnetic_variation_e: 6.7, tz: 'America/Denver' },
  KGXY: { name: 'Greeley-Weld County',        magnetic_variation_e: 6.4, tz: 'America/Denver' },
}

// In-memory runway cache (24 h TTL). Overpass queries are slow and
// rate-limited; cache aggressively since runways don't move.
const airportRunwayCache = new Map()
const AIRPORT_RUNWAY_TTL_MS = 24 * 3600 * 1000

// Curated runway data (FAA Form 5010 via AirNav) loaded once at startup,
// overrides OSM length/width/surface per ref. OSM still supplies the
// centerline polylines. See noise/web/data/runways.json for the source.
let CURATED_RUNWAYS = null
async function loadCuratedRunways() {
  if (CURATED_RUNWAYS) return CURATED_RUNWAYS
  try {
    const { default: fs } = await import('fs/promises')
    const { default: path } = await import('path')
    const buf = await fs.readFile(path.resolve('data/runways.json'), 'utf8')
    const j = JSON.parse(buf)
    CURATED_RUNWAYS = j.airports || {}
  } catch (e) {
    console.error('[airports] runways.json load failed:', e.message)
    CURATED_RUNWAYS = {}
  }
  return CURATED_RUNWAYS
}

// Strip leading zeros from a runway designation: "08/26" → "8/26",
// "08L/26R" → "8L/26R". Lets curated `ref` match OSM's zero-padded
// or unpadded form without forcing one convention.
function normalizeRunwayRef(ref) {
  if (!ref) return null
  return String(ref)
    .split('/')
    .map(s => s.replace(/^0+(\d)/, '$1'))
    .join('/')
}

// Shared runway fetch for one airport — used by `/api/airports/:icao`
// and `/api/runways` (regional). Returns the final list to emit
// (curated overlay applied, source-tagged), or null when the icao is
// unknown. Cache + OSM fallback logic identical to what the single-
// airport handler used inline.
async function getRunwaysForAirport(icao) {
  const ap = ENRICH_AP.find(a => a.code === icao)
  if (!ap) return null
  const cached = airportRunwayCache.get(icao)
  let osmRunways
  if (cached && Date.now() - cached.fetchedAt < AIRPORT_RUNWAY_TTL_MS) {
    osmRunways = cached.runways
  } else {
    try {
      osmRunways = await fetchOverpassRunways(ap.lat, ap.lon, 3000)
      if (osmRunways.length > 0) {
        airportRunwayCache.set(icao, { runways: osmRunways, fetchedAt: Date.now() })
      }
    } catch (err) {
      console.error('[runways] overpass error for', icao, err.message)
      osmRunways = cached?.runways || []
    }
  }
  const curated = await loadCuratedRunways()
  if (curated[icao] && Array.isArray(curated[icao].runways)) {
    const osmByRef = new Map()
    for (const r of osmRunways) {
      const k = normalizeRunwayRef(r.ref)
      if (!k) continue
      const prev = osmByRef.get(k)
      if (!prev || (r.centerline?.length || 0) > (prev.centerline?.length || 0)) {
        osmByRef.set(k, r)
      }
    }
    return curated[icao].runways.map((c) => {
      const osm = osmByRef.get(normalizeRunwayRef(c.ref))
      return {
        ref: c.ref,
        surface: c.surface || osm?.surface || null,
        length_ft: c.length_ft ?? osm?.length_ft ?? null,
        width_ft: c.width_ft ?? osm?.width_ft ?? null,
        elev_ft: c.elev_ft ?? ap.elev ?? null,
        centerline: osm?.centerline || [],
        source: 'curated',
      }
    })
  }
  return osmRunways.map(r => ({ ...r, elev_ft: ap.elev ?? null, source: 'osm' }))
}

// Fetch `aeroway=runway` ways from OSM Overpass within `radiusM` of the
// field. Same query the kiosk's pilot-console used to run client-side
// (Ask #8 moves it server-side so multiple workstations don't each hit
// Overpass). Returns `[{ ref, surface, length_ft, width_ft, centerline }]`.
async function fetchOverpassRunways(lat, lon, radiusM = 3000) {
  const query = `[out:json][timeout:25];way["aeroway"="runway"](around:${radiusM},${lat},${lon});out geom;`
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`
  // Overpass rejects requests without a User-Agent (406 Not Acceptable),
  // including the default Node fetch UA. Identify the service per
  // Overpass etiquette.
  const res = await fetch(url, { headers: { 'User-Agent': 'flightsafe-noise-api/1.0 (+aviation-monitor)' } })
  if (!res.ok) throw new Error(`overpass ${res.status}`)
  const json = await res.json()
  const runways = []
  for (const el of json.elements || []) {
    if (el.type !== 'way') continue
    const geom = el.geometry || []
    if (geom.length < 2) continue
    const tags = el.tags || {}
    const lengthM = tags.length ? Number(tags.length) : null
    const widthM = tags.width ? Number(tags.width) : null
    // OSM `length` is supposed to be meters but is frequently mis-tagged
    // (a value of "10000" probably means 10,000 ft, not 10,000 m, but
    // we can't tell). Cap at 5,000 m / ~16,400 ft — no civil runway in
    // the catchment exceeds that. Null is honest when the OSM data is
    // unusable; the kiosk's info box can render "— ft" or fall back to
    // a centerline-derived length.
    const lengthFt = Number.isFinite(lengthM) && lengthM > 0 && lengthM <= 5000
      ? Math.round(lengthM * 3.28084) : null
    const widthFt = Number.isFinite(widthM) && widthM > 0 && widthM <= 200
      ? Math.round(widthM * 3.28084) : null
    runways.push({
      ref: tags.ref || null,
      surface: tags.surface || null,
      length_ft: lengthFt,
      width_ft: widthFt,
      centerline: geom.map(g => [g.lat, g.lon]),
    })
  }
  return runways
}

// Canonical slug for a school name. Drops parenthetical abbreviations
// ("Soaring Society of Boulder (SSB)" → "soaring-society-of-boulder"),
// lowercases, replaces non-alphanumeric runs with single hyphens, trims
// edge hyphens. Used by /api/schools and by the `?school=` filter on
// /api/flights/current.
function slugifySchool(name) {
  if (!name) return null
  return String(name)
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function patternEnvelopeFor(airport) {
  return {
    radiusNm: PATTERN_RADIUS_NM_BY_AIRPORT[airport] ?? PATTERN_RADIUS_NM_DEFAULT,
    altAglFt: PATTERN_ALT_AGL_FT_DEFAULT,
  }
}

// Pattern fixes (takeoff + landing + T&G circuits) contribute to pop_impact
// at this weight relative to en-route fixes. 0 = strict exclusion (the
// original behavior); 1 = no exclusion. 0.3 = "pattern noise counts, but
// at ~30% the rate of an en-route overflight." Lets the score reflect
// "this flight did 12 pattern circuits over Boulder" without that
// dominating over a single bad-neighbor overflight elsewhere.
//
// Placeholder for a proper per-airport empirical "average pattern impact"
// calibration — once that lands, this weight folds into the calibration
// constant per-airport.
const PATTERN_WEIGHT = 0.3

// `verified_alt` — per-flight ADS-B barometric altitude correction.
// The math (`findRunwayAnchors`, `computeFlightAltOffset`, the regional
// time smoother) lives in `./src/altCorrection.js` so /api/excursions/segments
// can reuse it. See `noise/web/ADJUSTED_ALT.md` for the prose explainer.

function isInPattern(p, ap, radiusNm, altAglFt) {
  if (!ap || p[0] == null || p[1] == null) return false
  if (distNmAp(p[0], p[1], ap.lat, ap.lon) > radiusNm) return false
  if (p[2] == null) return false
  return (p[2] - ap.elev) <= altAglFt
}

// A fix is in *some* airport's pattern if it sits within that airport's
// pattern envelope. Used for pop_impact pattern-weighting and for
// worst_segment exclusion — a T&G at KLMO over the KLMO pattern is
// unavoidable to KLMO operations, same as a T&G at KBDU over KBDU's
// pattern. Iterates every ENRICH_AP entry; cheap enough (≈ 7 airports
// × distNmAp per point).
function isInAnyPattern(p) {
  if (p[0] == null || p[1] == null || p[2] == null) return false
  for (const ap of ENRICH_AP) {
    const env = patternEnvelopeFor(ap.code)
    if (distNmAp(p[0], p[1], ap.lat, ap.lon) > env.radiusNm) continue
    if ((p[2] - ap.elev) <= env.altAglFt) return true
  }
  return false
}

// Sibling of `impactSegments` (from popGrid.js) that applies a per-segment
// weight so pattern fixes can contribute at a reduced rate rather than
// being excluded entirely. Returns the same { total, lenFt } shape so
// downstream impact_index math is unchanged. Mirrors the exact kernel
// (segment length × pop at midpoint × (REF_AGL/AGL)² attenuation) — a
// per-point implementation would drop the ft multiplier and zero out
// the whole index, which is the regression we just caught.
function impactSegmentsWeighted(pts, popAt, distFn, isPatternFn, patternWeight) {
  const { GROUND_REF_FT, REF_AGL_FT, MIN_AGL_FT } = POP_KERNEL
  let total = 0, lenFt = 0
  if (!pts || pts.length < 2) return { total, lenFt }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const ft = distFn(a[0], a[1], b[0], b[1])
    lenFt += ft
    const midAlt = ((a[2] || 0) + (b[2] || 0)) / 2
    const pop = ft > 0 ? popAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) : 0
    const agl = Math.max(MIN_AGL_FT, midAlt - GROUND_REF_FT)
    const atten = (REF_AGL_FT / agl) ** 2
    let contribution = pop > 0 && ft > 0 ? ft * pop * atten : 0
    if (contribution > 0) {
      const midPt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, midAlt, b[3]]
      if (isPatternFn(midPt)) contribution *= patternWeight
    }
    total += contribution
  }
  return { total, lenFt }
}

// Same value as flightScore.js's internal `DBFS_TO_DBA_CALIBRATION`. Kept
// in sync manually; both convert the dBFS reading the complaint form
// records into an SPL dBA estimate at the receiver. If this drifts,
// per-flight `complaint_dba_max` and per-complaint `dba_estimate` will
// diverge — leave a TODO to either export it from flightScore.js or move
// it to a shared constants module.
const DBFS_TO_DBA_CALIBRATION_LOCAL = 132

// Indicators bundle for a single flight (FLIGHT_DATA_SERVICE.md Ask #2 + #5).
//
//   grpCycles  — array of { tMs, lMs } from the per-airport flight grouping.
//   allPts     — full sorted point list for the tail (already time-sorted).
//   tail/type  — for engineless gating + aircraft-typed classification.
//   airport    — used to filter NOISE_ZONES by ICAO prefix and to pick the
//                pop_impact scaling constant.
//   complaints — raw (un-projected) complaint records, scoped to today.
//
// Returns the flat `indicators` object expected on each /api/flights/current
// row, plus a separate `impact_index` (the small-float upstream value) so
// downstream callers can compose if needed. `worst_segment` is a stub for now
// (sliding-window dBA analysis lands in a follow-up tick).
function computeFlightIndicators(grpCycles, allPts, tail, type, airport, complaints) {
  const out = {
    vnap_count: 0,
    vnap_worst_klass: null,
    pop_impact: 0,
    pop_grade: null,
    complaint_count: 0,
    complaint_dba_max: null,
    complaint_worst_klass: null,
    worst_segment: null,
    impact_index: 0,
  }
  const tMs = grpCycles[0].tMs
  const lMs = grpCycles[grpCycles.length - 1].lMs ?? Date.now()
  const flightPts = allPts.filter(p => p[3] != null && p[3] >= tMs && p[3] <= lMs)
  if (flightPts.length < 2) return out
  const engineless = isEnginelessType(type)
  const ap = ENRICH_AP.find(a => a.code === airport)
  // verified_alt offset for this flight — back out per-flight ADS-B
  // barometric drift by comparing low-over-field fixes to known field
  // elevation. Subtracted from any raw alt before computing AGL.
  const calib = computeFlightAltOffset(flightPts, ap)
  out.alt_offset_ft = calib.offset_ft
  out.alt_offset_calibration_fixes = calib.calibration_fixes
  // Population-impact + worst-segment use a pattern-excluded subset — the
  // pattern's exposure over the airport neighborhood is unavoidable and
  // shouldn't accumulate into a "this pilot was noisy" score. The
  // exclusion is multi-airport: a KBDU-area flight doing T&Gs at KLMO
  // also sits in KLMO's pattern envelope. Without this, neighboring-
  // field pattern legs dominated worst_segment for ~80% of KBDU flights.
  // V and N (VNAP + complaints) keep using flightPts: a pattern leg that
  // punches through a noise-abatement polygon or triggers a complaint
  // is exactly the kind of signal those metrics are supposed to surface.
  const nonPatternPts = flightPts.filter(p => !isInAnyPattern(p))

  // ── V — VNAP zone touches (deduped by zone name, airport-scoped) ─────
  const zonesHit = new Set()
  let worstVnapKlass = null
  for (const p of flightPts) {
    const k = classifyPoint(p[0], p[1], p[2], NOISE_ZONES, { engineless })
    if (!k) continue
    for (const z of NOISE_ZONES) {
      const zAirport = (z.name || '').split(/\s+/, 1)[0]
      if (zAirport && zAirport !== airport) continue
      if (classifyPoint(p[0], p[1], p[2], [z], { engineless })) {
        zonesHit.add(z.name)
        if (!worstVnapKlass || (VNAP_KLASS_RANK[k] || 0) > (VNAP_KLASS_RANK[worstVnapKlass] || 0)) {
          worstVnapKlass = k
        }
        break // one zone per point is enough
      }
    }
  }
  out.vnap_count = zonesHit.size
  out.vnap_worst_klass = worstVnapKlass

  // ── P — pop_impact 0-100 + categorical pop_grade ─────────────────────
  // Pattern fixes (takeoff / landing / T&G circuits) contribute at
  // PATTERN_WEIGHT (0.3) — included so a flight with 12 pattern circuits
  // over Boulder reads higher than one with 1 circuit, but not enough
  // to dominate over a single bad-neighbor overflight elsewhere.
  // worst_segment below stays strictly pattern-excluded so the overlay
  // doesn't always render on the runway approach.
  // Null-when-clamping: any flight whose impact_index would exceed the
  // scale's calibration ceiling returns null rather than a clamped 100.
  if (POPGRID && POPGRID.popAt && flightPts.length >= 2) {
    const { total, lenFt } = impactSegmentsWeighted(
      flightPts, POPGRID.popAt, distFt, isInAnyPattern, PATTERN_WEIGHT,
    )
    const impact_index = lenFt > 0 ? (total / lenFt) / POP_SCALE : 0
    out.impact_index = Math.round(impact_index * 1000) / 1000
    const scale = IMPACT_SCALE_BY_AIRPORT[airport] ?? IMPACT_SCALE_DEFAULT
    if (impact_index > POP_IMPACT_NULL_THRESHOLD) {
      out.pop_impact = null
    } else {
      out.pop_impact = Math.max(0, Math.min(100, Math.round(impact_index * scale)))
    }
    out.pop_grade = impactGrade(impact_index)
  }

  // ── N — complaint correlations (tail + flight window, ±10-min pad) ───
  if (complaints && complaints.length) {
    // Reuse the projected-complaint helper from flightScore.js to get
    // dba_estimate / klass per matched complaint.
    const matched = []
    const T = tail.toUpperCase()
    const pad = 10 * 60 * 1000
    const lo = tMs - pad, hi = lMs + pad
    for (const c of complaints) {
      if ((c.tail || '').toUpperCase() !== T) continue
      const s = c.startedAt ? Date.parse(c.startedAt) : NaN
      const e = c.endedAt ? Date.parse(c.endedAt) : s
      if (!Number.isFinite(s)) continue
      if (e < lo || s > hi) continue
      matched.push(c)
    }
    out.complaint_count = matched.length
    let worstK = null, maxDba = null
    // reported_segments — Ask #11: each entry is a geocoded complaint
    // point (NOT a polyline; complaints belong to the reporter location,
    // not the aircraft path). Kiosk renders triangle markers + popups.
    // Notes truncated to 140 chars (Twitter-ish) to bound wire size on
    // outlier reports; full notes available via
    // /api/flights/:id/complaints if needed.
    const reportedSegments = []
    for (const c of matched) {
      const m = c.notes ? /(-?\d+(?:\.\d+)?)\s*dbfs/i.exec(c.notes) : null
      const dbfs = m ? Number(m[1]) : null
      const dba = Number.isFinite(dbfs) ? Math.round(dbfs + DBFS_TO_DBA_CALIBRATION_LOCAL) : null
      if (dba != null && (maxDba == null || dba > maxDba)) maxDba = dba
      const k = c.klass
      if (k && (!worstK || (VNAP_KLASS_RANK[k] || 0) > (VNAP_KLASS_RANK[worstK] || 0))) worstK = k
      if (c.lat != null && c.lon != null) {
        const notes = (c.notes || '').length > 140 ? c.notes.slice(0, 137) + '...' : (c.notes || null)
        reportedSegments.push({
          lat: c.lat,
          lon: c.lon,
          dba_estimate: dba,
          klass: k || null,
          started_at: c.startedAt || null,
          notes,
        })
      }
    }
    out.complaint_dba_max = maxDba
    out.complaint_worst_klass = worstK
    out.reported_segments = reportedSegments
  } else {
    out.reported_segments = []
  }

  // ── worst_segment — 30 s sliding window over pattern-excluded fixes ──
  out.worst_segment = computeWorstSegment(nonPatternPts, POPGRID?.popAt, airport, engineless, calib.offset_ft)

  // ── incursion_segments — per-zone in-polygon runs (Ask #6) ───────────
  out.incursion_segments = computeIncursionSegments(flightPts, airport, engineless, ap, calib.offset_ft)
  return out
}

// Intersect line segment [p1, p2] with polygon boundary; return the
// point at the FIRST intersection along [p1, p2] as [lat, lon, alt, ts_ms],
// or null when the segment doesn't cross any polygon edge. Used by
// computeIncursionSegments to pin segment endpoints to the actual VNAP
// boundary instead of the nearest in-polygon fix — without this the
// rendered polyline can sit 100+ m inside the zone depending on ADS-B
// sampling rate.
//
// Uses 2D line-line intersection in lat/lon — fine for sub-mile polygon
// edges at this latitude where lat/lon distortion is < 0.5% over the
// edge length. alt and ts are linearly interpolated along the [p1, p2]
// parameter.
function interpolatePolygonEdge(p1, p2, polygon) {
  if (!polygon || polygon.length < 2) return null
  const x1 = p1[1], y1 = p1[0]
  const x2 = p2[1], y2 = p2[0]
  let bestT = null
  for (let i = 0; i < polygon.length - 1; i++) {
    const v1 = polygon[i], v2 = polygon[i + 1]
    const x3 = v1[1], y3 = v1[0]
    const x4 = v2[1], y4 = v2[0]
    const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if (Math.abs(den) < 1e-14) continue // parallel
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
    const s = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den
    if (t < 0 || t > 1 || s < 0 || s > 1) continue
    if (bestT == null || t < bestT) bestT = t
  }
  if (bestT == null) return null
  const lat = p1[0] + bestT * (p2[0] - p1[0])
  const lon = p1[1] + bestT * (p2[1] - p1[1])
  const alt = (p1[2] != null && p2[2] != null)
    ? Math.round(p1[2] + bestT * (p2[2] - p1[2]))
    : (p1[2] ?? p2[2] ?? null)
  const ts = (p1[3] != null && p2[3] != null)
    ? Math.round(p1[3] + bestT * (p2[3] - p1[3]))
    : (p1[3] ?? p2[3] ?? null)
  return [lat, lon, alt, ts]
}

// Per-flight VNAP incursion segments (FLIGHT_DATA_SERVICE.md Ask #6).
// Walks the flight against each airport-scoped NOISE_ZONES polygon and
// emits the contiguous in-polygon runs with klass≥orange. Severity:
//   - `significant`: any red fix in the run
//   - `minor`: only orange fixes (no red)
// `near` (within 500 ft of the polygon edge but not inside) is intentionally
// not emitted in v0 — per the channel exchange, until the kiosk surfaces
// it differently from "no incursions at all" the wire bytes don't earn
// their keep.
//
// Polygon-edge interpolation is also deferred — segment endpoints are the
// first/last in-polygon fixes. ADS-B sampling means the polyline can land
// up to 100+ m inside the zone boundary; if the rendered overlay looks
// chunky enough to matter we add a binary search along the bounding edge
// from prev/next fix in a follow-up.
//
// Runs over the FULL flight track (including pattern fixes) — a pattern
// leg through a noise-abatement polygon is exactly the kind of signal
// this metric is supposed to surface, so the pattern-exclusion that
// pop_impact / worst_segment use does NOT apply here.
function computeIncursionSegments(flightPts, airport, engineless, ap, altOffsetFt = 0) {
  if (!flightPts || flightPts.length < 2) return []
  // Bake the per-flight ADS-B drift correction into the field-elev
  // reference so all AGL math here uses verified altitude.
  const fieldElevFt = ap?.elev != null ? ap.elev + (altOffsetFt || 0) : null
  const airportZones = NOISE_ZONES.filter(z => {
    const za = (z.name || '').split(/\s+/, 1)[0]
    return !za || za === airport
  })
  const segments = []
  for (const zone of airportZones) {
    let runStart = -1
    let runEnd = -1
    let worstKlass = null
    let peakDba = 0
    const runPts = []
    const closeRun = () => {
      if (runStart < 0) return
      // AGL stats + length over the segment's points (Ask #9 info-box).
      // Edge-interpolated endpoints in runPts can lack a usable alt
      // (alt may be the linearly-interpolated value); we still take it.
      let aglSum = 0, aglMin = Infinity, aglMax = -Infinity, aglCount = 0
      let lengthFt = 0
      for (let k = 0; k < runPts.length; k++) {
        const p = runPts[k]
        if (p[2] != null && fieldElevFt != null) {
          const agl = Math.max(0, p[2] - fieldElevFt)
          aglSum += agl
          if (agl < aglMin) aglMin = agl
          if (agl > aglMax) aglMax = agl
          aglCount++
        }
        if (k > 0) {
          const a = runPts[k - 1], b = runPts[k]
          lengthFt += distFt(a[0], a[1], b[0], b[1])
        }
      }
      // VNAP ceiling AGL — global default 7500 MSL (matches noiseZonesApiPlugin
      // DEFAULT_CEILING_FT). Per-zone or per-airport overrides can be added
      // here when we have them; for now every zone uses the same ceiling
      // and we convert to AGL using the TRUE field elevation (ap.elev),
      // not the per-flight verified_alt-corrected fieldElevFt. The ceiling
      // is an inherent zone property; it shouldn't shift per flight's
      // ADS-B calibration.
      const VNAP_CEILING_MSL_DEFAULT = 7500
      const trueFieldElevFt = ap?.elev ?? null
      segments.push({
        zone_name: zone.name,
        severity: worstKlass === 'red' ? 'significant' : 'minor',
        points: runPts.slice(),
        dba_peak: Math.round(peakDba),
        alt_agl_min: aglCount > 0 ? Math.round(aglMin) : null,
        alt_agl_mean: aglCount > 0 ? Math.round(aglSum / aglCount) : null,
        alt_agl_peak: aglCount > 0 ? Math.round(aglMax) : null,
        length_nm: Math.round((lengthFt / 6076.12) * 100) / 100,
        vnap_floor_agl: null,
        vnap_ceiling_agl: trueFieldElevFt != null ? Math.round(VNAP_CEILING_MSL_DEFAULT - trueFieldElevFt) : null,
        start_ts: new Date(flightPts[runStart][3]).toISOString(),
        end_ts: new Date(flightPts[runEnd][3]).toISOString(),
      })
      runStart = -1
      runEnd = -1
      worstKlass = null
      peakDba = 0
      runPts.length = 0
    }
    for (let i = 0; i < flightPts.length; i++) {
      const p = flightPts[i]
      if (p[3] == null) continue
      const k = classifyPoint(p[0], p[1], p[2], [zone], { engineless })
      if (k === 'red' || k === 'orange') {
        // Entering the polygon — interpolate the polygon-edge crossing
        // point from the previous (outside) fix and use that as the
        // segment start, so the rendered polyline pins to the actual
        // VNAP boundary rather than the first in-polygon fix.
        if (runStart < 0) {
          runStart = i
          if (i > 0) {
            const edgePt = interpolatePolygonEdge(flightPts[i - 1], p, zone.polygon)
            if (edgePt) runPts.push(edgePt)
          }
        }
        runEnd = i
        runPts.push([p[0], p[1], p[2], p[3]])
        if (!worstKlass || (VNAP_KLASS_RANK[k] || 0) > (VNAP_KLASS_RANK[worstKlass] || 0)) {
          worstKlass = k
        }
        const d = aglAdjustedDba(p, fieldElevFt, k)
        if (d > peakDba) peakDba = d
      } else if (runStart >= 0) {
        // Exiting the polygon — interpolate the exit edge from the last
        // in-polygon fix to this (outside) fix and append it as the
        // segment endpoint.
        const edgePt = interpolatePolygonEdge(flightPts[runEnd], p, zone.polygon)
        if (edgePt) runPts.push(edgePt)
        closeRun()
      }
    }
    closeRun() // flush a run still open at flight end
  }
  // Sort by start time so the kiosk renders in flight order.
  segments.sort((a, b) => a.start_ts.localeCompare(b.start_ts))
  return segments
}

// Find the 30-second flight window with the highest population-noise impact.
// Used by computeFlightIndicators to populate `worst_segment` on the CURRENT
// feed (FLIGHT_DATA_SERVICE.md Ask #5b). Returns null when the flight has no
// population exposure (every window's peak density is zero — e.g. an open-
// space glider sortie). Per-point dBA uses the same band-klass → dBA proxy
// the kiosk's client-side v0 uses (red 85 / orange 75 / yellow 65 / clean
// 55) — until the noise pipeline exposes a per-fix continuous dBA both
// sides have the same view. impact_score reuses the per-airport scale so
// it reads on the same 0-100 axis as `pop_impact` (Ask #5a).
const WORST_SEGMENT_KLASS_DBA = { yellow: 65, orange: 75, red: 85, purple: 90 }
const WORST_SEGMENT_CLEAN_DBA = 55
const WORST_SEGMENT_WINDOW_MS = 30_000

// AGL-aware klass → dBA proxy. -6 dB per altitude doubling above 1000 ft AGL.
// Pattern altitude is the reference where the klass-bucket proxy is
// calibrated against ground sensors; a higher cruise fix over the same
// block produces less perceived noise. Used by both worst_segment and
// incursion_segments so a single fix can't show up `significant` in one
// metric and `dba: 55` in the other — same calibration, different
// aggregation.
function aglAdjustedDba(p, fieldElevFt, klass) {
  let d = WORST_SEGMENT_KLASS_DBA[klass] ?? WORST_SEGMENT_CLEAN_DBA
  if (fieldElevFt != null && p[2] != null) {
    const agl = Math.max(0, p[2] - fieldElevFt)
    if (agl > 1000) d = Math.max(0, d - 6 * Math.log2(agl / 1000))
  }
  return d
}

// bridgeTrackGaps — fill in synthetic intermediate fixes across coverage
// gaps when the implied groundspeed is consistent with reasonable
// aircraft motion. Used to keep `worst_segment.points` renderable when
// the kiosk's edge-length filter would otherwise drop the polyline
// (a sparse 30 s window can have a single pair of fixes 30+ s apart;
// the renderer treats that as a coverage gap and skips it, so the
// worst-segment overlay becomes orphaned even though the segment is
// physically real).
//
// Synthetic points get a 5th tuple slot = 1 so downstream renderers
// can style them distinctly (dashed line, faded color, etc.). Real
// points stay as 4-tuples (backwards compatible — old consumers ignore
// the extra element).
//
// Acceptance test for a gap (per operator spec):
//   1. Compute implied groundspeed = gap_dist / gap_dt
//   2. If neighbor edges before/after the gap have a usable speed
//      estimate, accept the bridge only when implied is within
//      ±tolerance of the neighbor speed (default ±75%). Catches the
//      "the plane really was going this fast, just lost coverage"
//      case while rejecting "the plane disappeared and reappeared
//      somewhere implausible."
//   3. Falls back to a plausible-range check (30-400 kts covering
//      GA + light jets) when no neighbor speed is available.
//
// Gaps longer than `maxBridgeMs` (default 5 min) are NEVER bridged
// regardless of implied speed — at that scale the aircraft's actual
// path is genuinely unknown.
function bridgeTrackGaps(pts, opts = {}) {
  const {
    gapMs = 30_000,
    maxBridgeMs = 5 * 60_000,
    plausibleKtsMin = 30,
    plausibleKtsMax = 400,
    tolerance = 0.75,
    targetEdgeMs = 15_000,
  } = opts
  if (!Array.isArray(pts) || pts.length < 2) return pts
  const out = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const dtMs = (b[3] || 0) - (a[3] || 0)
    if (dtMs <= gapMs || dtMs > maxBridgeMs) { out.push(b); continue }

    // Groundspeed at A = the speed of the edge immediately before A.
    // Groundspeed at B = the speed of the edge immediately after B.
    // Average the two for the reference speed; if only one side is
    // measurable, use that. If neither is measurable, DO NOT bridge —
    // we won't invent a speed.
    //
    // Neighbor edges longer than 30 s are themselves potentially in a
    // dropout window, so their derived speed is unreliable; reject and
    // fall through to the other side or to no-bridge.
    let prevKts = null, nextKts = null
    if (i >= 2) {
      const prev = pts[i - 2]
      const ndtS = ((a[3] || 0) - (prev[3] || 0)) / 1000
      if (ndtS > 0 && ndtS < 30) {
        const ndnm = distFt(prev[0], prev[1], a[0], a[1]) / 6076.12
        prevKts = ndnm / (ndtS / 3600)
      }
    }
    if (i + 1 < pts.length) {
      const next = pts[i + 1]
      const ndtS = ((next[3] || 0) - (b[3] || 0)) / 1000
      if (ndtS > 0 && ndtS < 30) {
        const ndnm = distFt(b[0], b[1], next[0], next[1]) / 6076.12
        nextKts = ndnm / (ndtS / 3600)
      }
    }
    let nodeKts = null
    if (prevKts != null && nextKts != null) nodeKts = (prevKts + nextKts) / 2
    else if (prevKts != null) nodeKts = prevKts
    else if (nextKts != null) nodeKts = nextKts
    if (nodeKts == null) { out.push(b); continue }
    // Sanity bound — a runaway derived speed (single buggy fix) shouldn't
    // license a bridge. Outside the plausible aircraft envelope, abort.
    if (nodeKts < plausibleKtsMin || nodeKts > plausibleKtsMax) {
      out.push(b); continue
    }

    const gapDistNm = distFt(a[0], a[1], b[0], b[1]) / 6076.12
    const impliedKts = gapDistNm / (dtMs / 3_600_000)
    // The bridge's straight-line implied speed must match the observed
    // node-speed average within ±tolerance. ±75% is generous enough to
    // accept lazy turns + minor course changes through the gap while
    // rejecting "the aircraft teleported" cases.
    if (impliedKts < nodeKts * (1 - tolerance) || impliedKts > nodeKts * (1 + tolerance)) {
      out.push(b); continue
    }

    // Insert enough synthetic points to keep each resulting edge below
    // targetEdgeMs. Linear interpolation on lat/lon/alt/ts.
    const nSegments = Math.max(2, Math.ceil(dtMs / targetEdgeMs))
    for (let k = 1; k < nSegments; k++) {
      const t = k / nSegments
      out.push([
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] != null && b[2] != null ? a[2] + (b[2] - a[2]) * t : (a[2] ?? b[2] ?? null),
        Math.round((a[3] || 0) + dtMs * t),
        1, // synth marker
      ])
    }
    out.push(b)
  }
  return out
}

// Apply bridgeTrackGaps to every band's points[] in place. Skips bands
// without timestamps (their points are 3-tuples — bridge needs the ts
// slot). Attaches `points_synth_count` per band when bridging fired so
// the kiosk can see how many fixes were inferred. Used by the
// /api/excursions/boot path-rendering surface (the operator reports
// the kiosk's > 30 s edge filter creating visible rendering gaps in
// the flight path; the bridge fills them when motion is consistent).
function bridgeBandsInPlace(bands) {
  let total = 0
  if (!Array.isArray(bands)) return 0
  for (const b of bands) {
    if (!b || !Array.isArray(b.points) || b.points.length < 2) continue
    // Need the 4th tuple slot (ts) to compute gap durations.
    const last = b.points[b.points.length - 1]
    if (!Array.isArray(last) || last.length < 4 || last[3] == null) continue
    const bridged = bridgeTrackGaps(b.points)
    if (bridged.length > b.points.length) {
      const synth = bridged.reduce((n, p) => n + (p[4] === 1 ? 1 : 0), 0)
      b.points = bridged
      b.points_synth_count = synth
      total += synth
    }
  }
  return total
}

function computeWorstSegment(flightPts, popAt, airport, engineless, altOffsetFt = 0) {
  if (!flightPts || flightPts.length < 3 || !popAt) return null
  const pts = flightPts.filter(p => p[3] != null)
  if (pts.length < 3) return null
  const scale = IMPACT_SCALE_BY_AIRPORT[airport] ?? IMPACT_SCALE_DEFAULT
  const ap = ENRICH_AP.find(a => a.code === airport)
  // Subtract the per-flight ADS-B drift correction from the field-elev
  // reference so all AGL math here uses verified altitude.
  const fieldElevFt = ap?.elev != null ? ap.elev + (altOffsetFt || 0) : null
  let best = null
  for (let i = 0; i < pts.length; i++) {
    let j = i
    while (j < pts.length && pts[j][3] - pts[i][3] < WORST_SEGMENT_WINDOW_MS) j++
    const endIdx = j - 1
    if (endIdx - i < 2) continue
    const winPts = pts.slice(i, endIdx + 1)
    let peakDba = 0, sumDba = 0, peakPop = 0
    for (const p of winPts) {
      const k = classifyPoint(p[0], p[1], p[2], NOISE_ZONES, { engineless })
      const d = aglAdjustedDba(p, fieldElevFt, k)
      sumDba += d
      if (d > peakDba) peakDba = d
      const popv = popAt(p[0], p[1]) || 0
      if (popv > peakPop) peakPop = popv
    }
    if (peakPop <= 0) continue
    const { total, lenFt } = impactSegments(winPts, popAt, distFt)
    const impact_index = lenFt > 0 ? (total / lenFt) / POP_SCALE : 0
    const rawScore = Math.round(impact_index * scale)
    // Null-when-clamping per kiosk's calibration request: while the
    // window-scoped IMPACT_SCALE is provisional, a rawScore > 100 means
    // we'd clamp; emit null instead. Internal rawScore is kept on the
    // best record so window selection stays correct (the worst window
    // still wins, it just doesn't surface a misleading 100).
    const impact_score = rawScore > 100 ? null : Math.max(0, rawScore)
    if (!best || rawScore > best._rawScore) {
      // Ask #9 info-box stats: AGL min/mean/peak, length_nm, people_exposed.
      // people_exposed is the people-seconds aggregate the kiosk wants
      // ("this segment overflew ~2,400 people for ~30 s") — sum across
      // window fixes of (popAt × dt), where dt is the gap from the prior
      // fix in seconds.
      let aglSum = 0, aglMin = Infinity, aglMax = -Infinity, aglCount = 0
      let lengthFtBest = 0
      let peopleSec = 0
      for (let k = 0; k < winPts.length; k++) {
        const p = winPts[k]
        if (p[2] != null && fieldElevFt != null) {
          const agl = Math.max(0, p[2] - fieldElevFt)
          aglSum += agl
          if (agl < aglMin) aglMin = agl
          if (agl > aglMax) aglMax = agl
          aglCount++
        }
        if (k > 0) {
          const a = winPts[k - 1], b = winPts[k]
          lengthFtBest += distFt(a[0], a[1], b[0], b[1])
          const dt = ((b[3] || 0) - (a[3] || 0)) / 1000
          if (dt > 0) {
            const popv = popAt(b[0], b[1]) || 0
            peopleSec += popv * dt
          }
        }
      }
      best = {
        points: winPts.map(p => [p[0], p[1], p[2], p[3]]),
        dba_mean: Math.round(sumDba / winPts.length),
        dba_peak: Math.round(peakDba),
        pop_density_peak: Math.round(peakPop),
        impact_score,
        alt_agl_min: aglCount > 0 ? Math.round(aglMin) : null,
        alt_agl_mean: aglCount > 0 ? Math.round(aglSum / aglCount) : null,
        alt_agl_peak: aglCount > 0 ? Math.round(aglMax) : null,
        length_nm: Math.round((lengthFtBest / 6076.12) * 100) / 100,
        people_exposed: Math.round(peopleSec),
        _rawScore: rawScore,
        start_ts: new Date(winPts[0][3]).toISOString(),
        end_ts: new Date(winPts[winPts.length - 1][3]).toISOString(),
      }
    }
  }
  if (best) delete best._rawScore
  // INVARIANT: worst_segment.points MUST be a literal subset of the
  // flight-path points the kiosk renders. Do NOT bridge synth points
  // in here — bridging happens on the flight-path data in
  // /api/excursions/boot (bridgeBandsInPlace). The kiosk identifies
  // the worst_segment fixes inside the bridged band points by matching
  // (lat, lon, ts) tuples and highlights them on the rendered polyline.
  // If we bridged here too, the worst_segment would contain synth fixes
  // that may not be byte-identical to the band-side synth fixes, which
  // would break the highlight.
  return best
}

// ── /api/flights/* — Pilot Console "CURRENT" surface ────────────────────────
//
// A "flight" here is NOT a single takeoff-to-landing cycle. It groups
// consecutive cycles for the same tail that share a sortie: touch-and-goes
// and full-stops-with-taxi-back stay inside one flight; only a ground gap
// long enough for a crew swap + fresh preflight + run-up starts a new one.
//
// FLIGHT_GAP_MIN — per-airport ground-gap threshold (minutes) separating
// "same flight" from "new flight." Empirically chosen from a histogram of
// 1,491 consecutive-cycle gaps across 464 tail-days of KBDU-area tracks
// (2026-04-18..24).
//
// Inflections in the trainer-gap distribution (density per minute):
//   3-4 → 4-5 min:    195/min → 26/min   (7.5× drop) — pattern work ends
//   8-10 → 10-15 min: 14/min → 5.8/min   (2.4× drop) — coverage tails off
//   10-15 → 15-30:    5.8/min → 1.9/min  (3× drop)
//   30-60 → 60+:      0.83/min → cluster — clean "next sortie" floor
//
// The 5-30 min range is dominated by ADS-B coverage gaps mid-flight, not
// real ground time. Raising the threshold inside that range catches few
// extra "same-flight" merges (10→30 min only buys +3.8 pp) while reducing
// false-positive new flights during dropouts. Right floor is per-airport:
// KBJC has long taxi times (Class D, bigger field) and benefits from a
// wider window.
//
// COMPANION GUARD (still TODO): even with these wider numbers the proper
// fix for coverage-gap mid-flight fragmentation is a second-pass collapse
// that examines ADS-B coverage and aircraft drift inside the gap.
//   - ADS-B coverage during the gap < 30% of expected, AND
//   - aircraft moved > 2,000 ft between supposed landing and takeoff
//   → treat as a single flight regardless of gap length.
const FLIGHT_GAP_MIN_BY_AIRPORT = {
  KBDU: 20, // small GA — operator-tuned past the empirical 15-min plateau
  KBJC: 30, // Class D, longer taxi/ground-hold times (operator note)
}
const FLIGHT_GAP_MIN_DEFAULT = 20

function flightGapMinFor(airport) {
  const k = (airport || '').toUpperCase()
  return FLIGHT_GAP_MIN_BY_AIRPORT[k] ?? FLIGHT_GAP_MIN_DEFAULT
}

// Back-compat alias for callers that don't yet pass airport context.
// Prefer flightGapMinFor(airport) in new code.
const FLIGHT_GAP_MIN = FLIGHT_GAP_MIN_DEFAULT

// computeFlightId(airport, tail, takeoffMs) — stable per-flight key.
// Format: `<airport>-<tail>-<YYYYMMDDHHMM>` lowercase, UTC. Minute granularity
// matches the kiosk's client-synthesized `land-<TAIL>-<YYYYMMDDHHmm>` bucket
// so queued POSTs can reconcile once the kiosk swaps to server ids.
function computeFlightId(airport, tail, takeoffMs) {
  const d = new Date(takeoffMs)
  if (isNaN(d.getTime())) return null
  const pad = (n) => String(n).padStart(2, '0')
  const ymdhm = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`
  return `${(airport || 'unk').toLowerCase()}-${(tail || 'unk').toLowerCase()}-${ymdhm}`
}

// groupCyclesIntoFlights(cycles, gapMinMs) — cycles must be sorted ascending
// by tMs (takeoff epoch ms). Each cycle: { tMs, lMs, ...rest }. Returns an
// array of groups; each group is an array of the input cycle objects that
// belong to the same flight. A new flight begins when the gap between the
// previous landing (lMs) and the next takeoff (tMs) is >= gapMinMs.
// Group cycles into flights. Two cycles merge into one flight when their
// ground gap is < gapMinMs. The companion guard catches the case where a
// "long" gap is actually an ADS-B coverage dropout mid-flight (validated
// by the crew-replacement-gap analysis worker: 97% of 8-12 min "gaps"
// had < 30% expected coverage AND the aircraft drifted > 2,000 ft between
// supposed landing and takeoff — meaning the plane was still airborne,
// not parked on the ramp). When the guard fires, the cycles merge even
// at gap >= gapMinMs.
//
// `allPts` is the tail's full sorted point array. When omitted, the
// guard is skipped (legacy behavior).
const COVERAGE_GAP_SAMPLE_MS = 5000     // expected ADS-B fix interval
const COVERAGE_GAP_THRESHOLD = 0.30     // < 30% expected coverage = dropout
const COVERAGE_GAP_DRIFT_FT = 2000      // > 2,000 ft drift = still airborne

function groupCyclesIntoFlights(cycles, gapMinMs, allPts = null) {
  if (!cycles || !cycles.length) return []
  const groups = [[cycles[0]]]
  for (let i = 1; i < cycles.length; i++) {
    const prev = cycles[i - 1]
    const cur = cycles[i]
    // An in-progress cycle (null lMs) can't merge forward — no later
    // cycle could exist beyond an open one. Hard-split.
    if (prev.lMs == null) { groups.push([cur]); continue }
    const gap = cur.tMs - prev.lMs
    let merge = gap < gapMinMs

    if (!merge && allPts) {
      // Coverage-gap guard. Count fixes inside the gap window and the
      // physical drift between the last pre-gap and first post-gap fixes.
      const gapStart = prev.lMs
      const gapEnd = cur.tMs
      const expected = Math.max(1, Math.round((gapEnd - gapStart) / COVERAGE_GAP_SAMPLE_MS))
      let inGap = 0
      let prevFix = null, nextFix = null
      for (const p of allPts) {
        if (p[3] == null) continue
        if (p[3] >= gapStart && p[3] <= gapEnd) inGap++
        if (p[3] <= gapStart) prevFix = p
        if (p[3] >= gapEnd && !nextFix) nextFix = p
      }
      const coverage = inGap / expected
      const driftFt = (prevFix && nextFix)
        ? distFt(prevFix[0], prevFix[1], nextFix[0], nextFix[1])
        : 0
      if (coverage < COVERAGE_GAP_THRESHOLD && driftFt > COVERAGE_GAP_DRIFT_FT) {
        merge = true
      }
    }

    if (merge) groups[groups.length - 1].push(cur)
    else groups.push([cur])
  }
  return groups
}

// POST /api/flights/acknowledge
// Body: { flight_id, acknowledged_by, note?, tail? }
//
// One tap acks every issue on the flight: VNAP crossings, population-impact
// moments, and correlated complaints all become "handled" from the Pilot
// Console's perspective. The CURRENT feed drops this flight on next poll.
//
// Idempotency: same flight_id + same acknowledged_by → 200 (no-op).
//              same flight_id + different acknowledged_by → 409 with prior
//              attribution. Unknown flight_id is accepted (the kiosk synth-
//              esizes ids before the server emits them; rejecting would
//              break the queued-POST replay).
function flightsApiPlugin() {
  // Live-tracks loader. UTC-boundary correctness is enforced upstream by
  // db.loadLiveFromDb(hoursBack) — see db.js for the architectural
  // explanation. Pass the requested lookback through so the date range
  // is sized to fit the actual window, not 4 h fallback.
  const loadLive = async (hoursBack = 1) => {
    if (db.useDb) return db.loadLiveFromDb(hoursBack)
    const fs = await import('fs/promises')
    const path = await import('path')
    try {
      const buf = await fs.default.readFile(path.default.resolve('public/tracks_live.json'), 'utf8')
      return JSON.parse(buf)
    } catch { return { tracks: [], updated_at: null } }
  }

  // ── Caches for /api/flights/current ──────────────────────────────
  //
  // The handler runs 5-50 s of work per request: a multi-day live_tracks
  // pull, a per-tail enrichment JOIN that scans `tracks` for ~600 tails,
  // and CPU-bound cycle extraction + indicator computation per flight.
  // Two amplifiers compound it into the 220 s avg the kiosk reported:
  //
  //   (a) the kiosk polls every 8 s, response takes >> 8 s → multiple
  //       in-flight requests per workstation, each running the full
  //       computation independently;
  //   (b) multiple workstations on the same airport all run the same
  //       computation in parallel.
  //
  // Two memoize layers fix that:
  //
  //   TAIL_INFO_TTL_MS: per-tail (base, school, purpose, desc) result,
  //   60 s TTL. The data changes slowly (school assignments, base
  //   airport). On each request, query only tails not already cached.
  //
  //   CURRENT_RESPONSE_TTL_MS: full response JSON keyed on (airport,
  //   landedHours, rangeNm, schoolFilter), 4 s TTL. With 8 s polling,
  //   every other request hits a warm cache; multi-workstation polls
  //   all share one computation.
  //
  // Both caches are in-process Maps; Railway can have multiple containers
  // but per-container amortization is already a 10-50x win.
  const TAIL_INFO_TTL_MS = 60_000
  const tailInfoCache = new Map()   // call -> { row, fetchedAt }
  // Response-cache freshness window. Within this age, cached body is
  // returned as-is (X-Cache: HIT). Within STALE_MS, cached body is
  // returned and a background refresh kicks off (X-Cache: STALE). Past
  // STALE_MS, the request waits for a fresh leader.
  //
  // 30 s fresh / 5 min stale picked for the kiosk's reality:
  // /api/flights/current cold-compute is CPU-bound at 30-50 s on KBDU
  // (200+ tails × cycle extraction + indicators), which exceeds the
  // Railway edge timeout (~30 s) and starves the event loop while it
  // runs. With 30 s fresh, every 8 s kiosk poll inside the same window
  // is a sub-ms HIT (no event-loop pressure). Beyond 30 s, STALE
  // serves the last successful body immediately AND triggers an
  // in-background refresh — so polls never wait on the leader's
  // CPU burst, the next 8 s poll already gets the fresh body if the
  // refresh completed.
  const CURRENT_RESPONSE_TTL_MS = 30_000
  const CURRENT_RESPONSE_STALE_MS = 5 * 60_000
  const currentResponseCache = new Map()  // key -> { body, fetchedAt }
  // Request coalescing — the kiosk reported `airport=KBDU&landed_hours=48`
  // never caching: 3 sequential polls all `X-Cache: MISS`, 30-94 s each,
  // with intermittent 500s. Root cause: cold response time (30-90 s) is
  // > 10× the 8 s poll cadence, so subsequent polls arrive before the
  // first poll's `cache.set` fires. All in-flight requests run their own
  // computation, the pg pool saturates (max=8), `statement_timeout`
  // (25 s) trips on waiters, handler returns 500. Coalescing collapses
  // all concurrent callers for the same key onto one Promise — the
  // leader does the work, waiters await its result (or skip waiting via
  // STALE semantics above).
  const currentInFlight = new Map()  // key -> Promise<body>


  // Cache for /api/schools. The handler used to read + parse
  // public/flight_schools_fleets.json (30 KB), `await import` two node
  // modules, and slug-compute the whole catalog on EVERY request — the
  // kiosk measured 27.83 s avg / 80.77 s p100 (OneDrive-backed I/O +
  // per-call dynamic imports compound badly on Windows dev).
  //
  // flight_schools_fleets.json is static config (a human edits it, not
  // the runtime). Load it once, build a fully-resolved
  // { airport -> [{slug,name,tail_count}, ...] } index, cache in
  // closure scope. An mtime check lets dev edits hot-reload without
  // restarting the server. Path resolution (relative
  // 'public/flight_schools_fleets.json') is unchanged from the
  // previous handler so prod and dev see the same file.
  const SCHOOLS_INDEX_PATH = 'public/flight_schools_fleets.json'
  let schoolsIndexCache = null      // { byAirport: Map, mtimeMs }
  let schoolsIndexLastServed = null // identity ref for X-Cache header
  function buildSchoolsIndex(raw) {
    const fleets = JSON.parse(raw)
    const airportOf = (s) => ((s.airport || '').split(/[\s/]/, 1)[0] || '').trim().toUpperCase()
    const byAirport = new Map()
    for (const s of (fleets.schools || [])) {
      const ap = airportOf(s)
      if (!ap) continue
      const slug = slugifySchool(s.name)
      if (!slug) continue
      const entry = {
        slug,
        name: s.name,
        tail_count: Array.isArray(s.aircraft) ? s.aircraft.length : 0,
      }
      let bucket = byAirport.get(ap)
      if (!bucket) { bucket = []; byAirport.set(ap, bucket) }
      bucket.push(entry)
    }
    // Sort each bucket once at index-build time so request handlers
    // can return the cached array verbatim.
    for (const bucket of byAirport.values()) {
      bucket.sort((a, b) => (b.tail_count - a.tail_count) || a.name.localeCompare(b.name))
    }
    return { byAirport, mtimeMs: 0 }
  }
  function loadSchoolsIndex() {
    let mtimeMs = 0
    try { mtimeMs = fs.statSync(SCHOOLS_INDEX_PATH).mtimeMs } catch { mtimeMs = -1 }
    if (schoolsIndexCache && schoolsIndexCache.mtimeMs === mtimeMs) return schoolsIndexCache
    if (mtimeMs < 0) {
      schoolsIndexCache = { byAirport: new Map(), mtimeMs: -1 }
      return schoolsIndexCache
    }
    try {
      const raw = fs.readFileSync(SCHOOLS_INDEX_PATH, 'utf8')
      schoolsIndexCache = buildSchoolsIndex(raw)
      schoolsIndexCache.mtimeMs = mtimeMs
    } catch (e) {
      console.error('[api/schools] fleet config read failed:', e.message)
      schoolsIndexCache = { byAirport: new Map(), mtimeMs }
    }
    return schoolsIndexCache
  }


  return {
    name: 'flights-api',
    configureServer(server) {
      // Warm the per-airport runway cache in parallel at server start.
      // /api/airports/:icao + /api/runways both call getRunwaysForAirport,
      // which goes to Overpass on a cache miss (25 s timeout in-query, often
      // 5-30 s wall-clock). Without warmup, the first kiosk page load on a
      // cold Railway container stalls 30-90 s — the bug filed in
      // FLIGHT_DATA_SERVICE.md as "catastrophic endpoint latency."
      //
      // Fire-and-forget: don't block plugin registration; just kick off the
      // 7 Overpass calls in parallel so the cache is hot before the first
      // kiosk request lands. allSettled so one slow airport doesn't poison
      // the others.
      ;(async () => {
        const t0 = Date.now()
        const codes = ENRICH_AP.map(a => a.code)
        const results = await Promise.allSettled(codes.map(c => getRunwaysForAirport(c)))
        const ok = results.filter(r => r.status === 'fulfilled' && Array.isArray(r.value)).length
        const slow = Date.now() - t0
        console.log(`[runways-warmup] ${ok}/${codes.length} airports warmed in ${slow} ms`)
      })().catch(err => console.error('[runways-warmup] error', err))

      server.middlewares.use('/api/flights/acknowledge', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')
        try {
          const body = await readJsonBody(req).catch(() => null)
          if (!body) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' })) }
          const flightId = ((body.flight_id || '') + '').trim().toLowerCase()
          const by = ((body.acknowledged_by || '') + '').trim()
          const note = ((body.note || '') + '').trim() || null
          const tail = ((body.tail || '') + '').trim().toUpperCase() || null
          if (!flightId || !by) {
            res.statusCode = 400
            return res.end(JSON.stringify({ ok: false, error: 'flight_id and acknowledged_by required' }))
          }
          // Look for an existing flight-ack on this flight_id.
          let existing = null
          if (db.useDb) {
            const all = await db.getNotifications(null, 'flight-ack')
            existing = (all || []).find((it) => (it.flight_id || '').toLowerCase() === flightId) || null
          } else {
            const { default: fs } = await import('fs/promises')
            const { default: path } = await import('path')
            const cur = (await notificationsLedger.load(fs, path)) || { items: [] }
            existing = (cur.items || []).find((it) => it.kind === 'flight-ack' && (it.flight_id || '').toLowerCase() === flightId) || null
          }
          if (existing) {
            const existingBy = existing.acknowledged_by || null
            if (existingBy && existingBy !== by) {
              res.statusCode = 409
              return res.end(JSON.stringify({
                ok: false,
                reason: 'already_acknowledged',
                by: existingBy,
                at: existing.at || null,
              }))
            }
            res.statusCode = 200
            return res.end(JSON.stringify({
              ok: true,
              acknowledged_at: existing.at || null,
              idempotent: true,
            }))
          }
          const record = {
            kind: 'flight-ack',
            flight_id: flightId,
            tail,
            acknowledged_by: by,
            note,
            at: new Date().toISOString(),
          }
          if (db.useDb) {
            await db.addNotification(record)
          } else {
            const { default: fs } = await import('fs/promises')
            const { default: path } = await import('path')
            await notificationsLedger.mutate(fs, path, (cur) => {
              const items = Array.isArray(cur.items) ? cur.items : []
              items.push(record)
              return { items }
            })
          }
          res.statusCode = 201
          res.end(JSON.stringify({ ok: true, acknowledged_at: record.at, flight_id: flightId }))
        } catch (err) {
          console.error('[flights/acknowledge] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, error: String(err) }))
        }
      })

      // GET /api/flights/current/stream?airport=KBDU[&school=<slug>]
      //
      // SSE push channel for the CURRENT feed (Ask #4). v0 sends full
      // snapshots every 5 s instead of diff events — simpler to render,
      // simpler to debug, and the kiosk's existing snapshot consumer
      // works unchanged. Heartbeat every 15 s so the client can detect
      // a dropped connection. Same query-string surface as the polled
      // endpoint (airport / school / landed_hours / range_nm).
      //
      // Implementation note: self-fetches /api/flights/current internally
      // rather than re-running the whole snapshot pipeline. One snapshot
      // build per connected client per 5 s — fine for a few dispatch
      // desks; if subscriber count grows, fan out a shared snapshot
      // timer to all open connections.
      server.middlewares.use('/api/flights/current/stream', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no') // tell reverse proxies not to buffer
        res.setHeader('Access-Control-Allow-Origin', '*')
        if (typeof res.flushHeaders === 'function') res.flushHeaders()
        // Immediate SSE comment to force the proxy to start the stream
        // — without this, Railway's edge can buffer the first ~kB
        // before any byte reaches the client.
        try { res.write(': sse-open\n\n') } catch {}

        const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
        const innerPath = `/api/flights/current?${u.searchParams.toString()}`
        const port = parseInt(process.env.PORT || '5174', 10)
        console.log('[flights/current/stream] subscriber connected', { innerPath, port })

        const SNAPSHOT_MS = 5000
        const HEARTBEAT_MS = 15000

        let closed = false
        let snapshotTimer = null
        let heartbeatTimer = null
        const cleanup = () => {
          closed = true
          if (snapshotTimer) clearTimeout(snapshotTimer)
          if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
        }
        req.on('close', cleanup)
        req.on('error', cleanup)

        // Railway's edge proxy buffers responses up to ~some-threshold
        // before flushing. SSE events smaller than that get held until
        // the buffer fills or the connection closes. Padding each event
        // with a 4 KB comment forces a flush after every emit.
        const FLUSH_PADDING = ': ' + ' '.repeat(4096) + '\n\n'
        const sendEvent = (obj) => {
          if (closed) return false
          try {
            res.write(`data: ${JSON.stringify(obj)}\n\n`)
            res.write(FLUSH_PADDING)
          } catch { cleanup(); return false }
          return true
        }

        const tick = async () => {
          if (closed) return
          console.log('[flights/current/stream] tick start', innerPath)
          try {
            const resp = await fetch(`http://localhost:${port}${innerPath}`)
            console.log('[flights/current/stream] inner fetch', resp.status)
            if (resp.ok) {
              const snap = await resp.json()
              sendEvent({ type: 'snapshot', ...snap })
              console.log('[flights/current/stream] snapshot sent, flights=', snap.count)
            } else {
              sendEvent({ type: 'error', status: resp.status, message: `inner /current ${resp.status}` })
            }
          } catch (err) {
            console.error('[flights/current/stream] tick error', err.message)
            sendEvent({ type: 'error', message: err.message })
          }
          if (!closed) snapshotTimer = setTimeout(tick, SNAPSHOT_MS)
        }

        heartbeatTimer = setInterval(() => {
          sendEvent({ type: 'heartbeat', ts: Date.now() })
        }, HEARTBEAT_MS)

        // Initial snapshot fires immediately on connect.
        tick()
      })

      // GET /api/flights/:id/complaints
      //
      // Per-flight complaint detail for the kiosk's info-box / popup
      // surface (the "full explanation" goal — Ask #9's deferred sibling
      // endpoint). Returns the projected complaint records matched to a
      // specific flight_id: lat/lon/started_at/klass/dba_estimate/notes/
      // reporter/source_category/distance_miles. Same projection
      // `projectComplaint` (from flightScore.js) used everywhere else.
      //
      // flight_id format `<airport>-<tail>-<YYYYMMDDHHMM>` UTC lowercase.
      // We decode tail + takeoff timestamp from the id and run the
      // same tail+window match the indicators use (±10 min pad, 12-hour
      // forward window to cover any realistic GA flight).
      server.middlewares.use('/api/flights/', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
        // We only handle the /:id/complaints suffix here. Other /api/flights/*
        // routes (acknowledge, acknowledgements, current, current/stream)
        // claim their paths first via their own middleware registrations.
        const m = u.pathname.match(/^\/([^/]+)\/complaints$/)
        if (!m) return next()
        const flightId = decodeURIComponent(m[1]).toLowerCase()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Cache-Control', 'public, max-age=15')
        try {
          // Decode <airport>-<tail>-<YYYYMMDDHHMM>. Tails can contain
          // hyphens (rare but possible on experimental registrations);
          // the timestamp is the last hyphen-delimited token.
          const parts = flightId.split('-')
          if (parts.length < 3) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'invalid flight_id format' }))
          }
          const ymdhm = parts[parts.length - 1]
          const airport = parts[0].toUpperCase()
          const tail = parts.slice(1, -1).join('-').toUpperCase()
          if (!/^\d{12}$/.test(ymdhm)) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'invalid timestamp in flight_id' }))
          }
          const year = Number(ymdhm.slice(0, 4))
          const month = Number(ymdhm.slice(4, 6))
          const day = Number(ymdhm.slice(6, 8))
          const hour = Number(ymdhm.slice(8, 10))
          const minute = Number(ymdhm.slice(10, 12))
          const takeoffMs = Date.UTC(year, month - 1, day, hour, minute)
          const windowEndMs = takeoffMs + 12 * 3600 * 1000 // 12 h forward
          const complaintsRaw = await loadComplaintsCached()
          const fsMod = await import('./flightScore.js')
          const matched = fsMod.matchComplaintsForKiosk(complaintsRaw, tail, takeoffMs, windowEndMs)
          res.end(JSON.stringify({
            flight_id: flightId,
            airport,
            tail,
            takeoff_ts: new Date(takeoffMs).toISOString(),
            window_hours: 12,
            count: matched.length,
            complaints: matched,
          }))
        } catch (err) {
          console.error('[api/flights/:id/complaints] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // GET /api/runways?center=<icao>&radius_nm=<N>
      //
      // Regional runway endpoint (FLIGHT_DATA_SERVICE.md Ask #10). Returns
      // every runway at every airport within `radius_nm` of `center` in
      // one round-trip, with `icao` + `airport_name` attached to each row
      // so the kiosk's regional-context map can group/label. Replaces
      // the client's per-airport parallel-probe fallback (7 HTTP
      // requests at boot, doesn't scale as AIRPORT_META_STATIC grows).
      //
      // center: ICAO code (default KBDU). radius_nm: 1..200, default 50.
      // Iterates ENRICH_AP / AIRPORT_META_STATIC; each in-range airport
      // resolves runways via the same getRunwaysForAirport helper the
      // single-airport endpoint uses, so curated overrides + OSM
      // fallback + cache all apply.
      server.middlewares.use('/api/runways', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Cache-Control', 'public, max-age=86400')
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const center = (u.searchParams.get('center') || 'KBDU').trim().toUpperCase()
          const radiusNm = Math.max(1, Math.min(200, Number(u.searchParams.get('radius_nm')) || 50))
          const centerAp = ENRICH_AP.find(a => a.code === center)
          if (!centerAp) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: `unknown center airport ${center}` }))
          }
          // Resolve all in-range airports in PARALLEL. Sequential await
          // serialized 7 potentially-slow Overpass calls; with the warmup
          // those are usually cache hits, but on a cold container during
          // the warmup window any single slow airport would still serialize
          // the whole response. Promise.all + early distance filter keeps
          // the network fanout tight.
          const inRange = ENRICH_AP.filter(ap =>
            distNmAp(centerAp.lat, centerAp.lon, ap.lat, ap.lon) <= radiusNm,
          )
          const rwyLists = await Promise.all(
            inRange.map(ap => getRunwaysForAirport(ap.code).catch(() => null)),
          )
          const out = []
          for (let i = 0; i < inRange.length; i++) {
            const ap = inRange[i]
            const rwys = rwyLists[i]
            if (!rwys || rwys.length === 0) continue
            const meta = AIRPORT_META_STATIC[ap.code] || {}
            for (const r of rwys) {
              out.push({
                icao: ap.code,
                airport_name: meta.name || null,
                ref: r.ref,
                surface: r.surface,
                length_ft: r.length_ft,
                width_ft: r.width_ft,
                elev_ft: r.elev_ft,
                centerline: r.centerline,
                source: r.source,
              })
            }
          }
          res.end(JSON.stringify({
            center,
            center_lat: centerAp.lat,
            center_lon: centerAp.lon,
            radius_nm: radiusNm,
            count: out.length,
            runways: out,
          }))
        } catch (err) {
          console.error('[api/runways] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // GET /api/airports/:icao
      //
      // Airport metadata for the Pilot Console (FLIGHT_DATA_SERVICE.md Ask #8):
      // name, lat/lon/elev, magnetic_variation_e, and runway centerlines as
      // [lat, lon] polylines. Runways are fetched from OSM Overpass server-
      // side and cached for 24 h — clients shouldn't be hitting a community-
      // hosted third-party origin from every workstation.
      server.middlewares.use('/api/airports/', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Cache-Control', 'public, max-age=86400')
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const icao = u.pathname.replace(/^\//, '').trim().toUpperCase()
          if (!icao) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'icao required' }))
          }
          const ap = ENRICH_AP.find(a => a.code === icao)
          if (!ap) {
            res.statusCode = 404
            return res.end(JSON.stringify({ error: `unknown airport ${icao}` }))
          }
          // Cache lookup; fetch on miss/stale. Overpass failures degrade
          // gracefully to runways: [] — the rest of the metadata still
          // ships so the wind dial and badge copy keep working.
          // Curated overlay + OSM fallback lives in the shared helper
          // so the regional `/api/runways` endpoint gets the same data.
          const runways = await getRunwaysForAirport(icao) || []
          const meta = AIRPORT_META_STATIC[icao] || {}
          res.end(JSON.stringify({
            icao,
            name: meta.name || null,
            lat: ap.lat,
            lon: ap.lon,
            elev_ft: ap.elev,
            magnetic_variation_e: meta.magnetic_variation_e ?? null,
            tz: meta.tz || null,
            runways,
          }))
        } catch (err) {
          console.error('[api/airports] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // GET /api/schools?airport=KBDU
      //
      // Catalog of registered schools at an airport — slug, display name,
      // and per-school tail count. Drives the Pilot Console's dropdown
      // and validates the `?school=<slug>` filter on /api/flights/current
      // (Ask #7). Source of truth is the `school` column in `tracks`,
      // grouped by school name and slugged at read time so the canonical
      // slug shape stays server-controlled.
      server.middlewares.use('/api/schools', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Cache-Control', 'public, max-age=300')
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const airport = (u.searchParams.get('airport') || '').trim().toUpperCase()
          if (!airport) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'airport required' }))
          }
          // Authoritative source for "schools based at this airport" is
          // the static flight_schools_fleets.json config — each school
          // has a single `airport` field naming its registered base.
          // Querying tracks.base_airport (the prior implementation) was
          // wrong: that table records the destination/base for each
          // individual track, so a Rocky Mountain Flight School tail
          // doing a cross-country to KFNL gets `base_airport='KFNL'` on
          // that row, and the school then appears at KFNL with one
          // tail. Aggregated across the whole tracks history, RMS ended
          // up listed at all 7 configured airports.
          //
          // Perf: the previous body `await import`-ed fs/promises and
          // path, then re-read + re-parsed the 30 KB JSON and slug-
          // computed the WHOLE catalog on EVERY request. The kiosk
          // measured 27.83 s avg / 80.77 s p100 — dynamic imports +
          // OneDrive-backed I/O compound badly on Windows dev. The
          // static config now lives in a closure-scope index built
          // once (and invalidated by mtime so dev edits hot-reload).
          // Per-request work is a Map.get plus the final
          // JSON.stringify. Warm hits are < 1 ms; cold path is a
          // single sync stat + readFile + parse. Wire shape unchanged.
          const idx = loadSchoolsIndex()
          const bucket = idx.byAirport.get(airport) || []
          res.setHeader('X-Cache', idx === schoolsIndexLastServed ? 'HIT' : 'MISS')
          schoolsIndexLastServed = idx
          res.end(JSON.stringify({ airport, count: bucket.length, schools: bucket }))
        } catch (err) {
          console.error('[api/schools] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // GET /api/flights/acknowledgements[?airport=KBDU&since=ISO]
      // Read-only dump of flight-ack records — lets the Pilot Console
      // reconcile its localStorage queue against server state on reconnect.
      server.middlewares.use('/api/flights/acknowledgements', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const airport = (u.searchParams.get('airport') || '').trim().toLowerCase()
          const sinceParam = u.searchParams.get('since')
          const sinceMs = sinceParam ? Date.parse(sinceParam) : null
          let items
          if (db.useDb) {
            items = await db.getNotifications(null, 'flight-ack')
          } else {
            const { default: fs } = await import('fs/promises')
            const { default: path } = await import('path')
            const cur = (await notificationsLedger.load(fs, path)) || { items: [] }
            items = (cur.items || []).filter((it) => it.kind === 'flight-ack')
          }
          items = (items || []).filter((it) => {
            if (airport && !(it.flight_id || '').toLowerCase().startsWith(`${airport}-`)) return false
            if (sinceMs && Number.isFinite(sinceMs)) {
              const at = Date.parse(it.at || '')
              if (!Number.isFinite(at) || at < sinceMs) return false
            }
            return true
          })
          res.end(JSON.stringify({ count: items.length, items }))
        } catch (err) {
          console.error('[flights/acknowledgements] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, error: String(err) }))
        }
      })

      // GET /api/flights/current?airport=KBDU[&landed_hours=6][&range_nm=25]
      //
      // Unified Pilot Console CURRENT feed (FLIGHT_DATA_SERVICE.md Ask #1).
      // Membership rule:
      //   - Airborne AND within range_nm of airport (phaseML refinement
      //     deferred to a follow-up; v0 includes all airborne traffic in
      //     range so the kiosk's existing rule is a strict subset).
      //   - OR landed at airport in the last landed_hours AND not yet
      //     acknowledged via /api/flights/acknowledge.
      //
      // A flight = a group of cycles whose ground gaps are all <
      // flightGapMinFor(airport) min — i.e. T&Gs and short taxi-back
      // full-stops collapse into one row, one acknowledge.
      //
      // V/P/N indicators are zero in v0; Ask #2 wires them in next.
      server.middlewares.use('/api/flights/current', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Cache-Control', 'public, max-age=5')
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const airport = (u.searchParams.get('airport') || 'KBDU').trim().toUpperCase()
          const landedHours = Math.max(0.5, Math.min(48, Number(u.searchParams.get('landed_hours')) || 6))
          // range_nm bounds: 5..100 (Ask #12). Front Range practice areas
          // routinely fan to 75 nm toward the foothills + DEN class B
          // periphery; 50 was clipping legitimate home-airport flights.
          const rangeNm = Math.max(5, Math.min(100, Number(u.searchParams.get('range_nm')) || 25))
          const schoolFilter = (u.searchParams.get('school') || '').trim().toLowerCase() || null
          const ap = ENRICH_AP.find((a) => a.code === airport)
          if (!ap) { res.statusCode = 400; return res.end(JSON.stringify({ error: `unknown airport ${airport}` })) }

          // Response cache — composite key over the query params that affect
          // output. With CURRENT_RESPONSE_TTL_MS=8s and kiosk polling every
          // 8s, every other poll hits cache; multi-workstation polls share
          // one computation. The cached body is the final JSON string so
          // we don't pay re-serialization either.
          const cacheKey = `${airport}|${landedHours}|${rangeNm}|${schoolFilter || ''}`
          const cached = currentResponseCache.get(cacheKey)
          const cacheAge = cached ? Date.now() - cached.fetchedAt : Infinity

          // Fresh — return immediately.
          if (cacheAge < CURRENT_RESPONSE_TTL_MS) {
            res.setHeader('X-Cache', 'HIT')
            return res.end(cached.body)
          }

          // Stale — return cached body immediately, kick off a background
          // refresh if one isn't already in flight. This is the dominant
          // path under steady-state kiosk polling: every 8 s poll past
          // the first inside a 5 min window returns instantly (sub-ms);
          // the refresh runs in the background without blocking polls,
          // and the next poll after refresh completes gets the fresher
          // body. The leader's CPU burst no longer starves the event
          // loop relative to user-visible latency.
          if (cacheAge < CURRENT_RESPONSE_STALE_MS && cached) {
            // Within the stale tolerance window: serve the cached body
            // immediately so the kiosk's 8 s poll never blocks on the
            // ~50 s cold-compute path. Background refresh would be the
            // ideal next step (it would keep the cache permanently
            // fresh) but it requires extracting the heavy work into a
            // standalone helper — deferred. Today's deal: kiosk gets
            // an instantaneous response that's at most 5 min old, then
            // the next request after the stale window triggers a fresh
            // cold compute.
            res.setHeader('X-Cache', 'STALE')
            return res.end(cached.body)
          }

          // Coalesce — if a leader is already computing this key, await
          // its Promise. Only reached when there is no cached body to
          // serve stale (very first poll for the key after a restart).
          const existing = currentInFlight.get(cacheKey)
          if (existing) {
            res.setHeader('X-Cache', 'COALESCED')
            try {
              const body = await existing
              return res.end(body)
            } catch (err) {
              // Leader failed — let the next request retry from cold.
              throw err
            }
          }

          // Leader path — define the work as an IIFE, register the
          // Promise in currentInFlight BEFORE awaiting so concurrent
          // callers (kiosk polls + multi-workstation) see the
          // in-flight key and coalesce. The IIFE's `finally` releases
          // the slot regardless of success or failure.
          const work = (async () => { try {
          const nowMs = Date.now()
          const landedCutoffMs = nowMs - landedHours * 3600 * 1000
          const gapMinMs = flightGapMinFor(airport) * 60000
          const groundCeil = ap.elev + 200
          const LANDING_NEAR_NM = 4

          // ── Acks (kind='flight-ack') keyed by flight_id ───────────────
          let ackItems = []
          if (db.useDb) {
            try { ackItems = await db.getNotifications(null, 'flight-ack') } catch {}
          } else {
            try {
              const { default: fs } = await import('fs/promises')
              const { default: path } = await import('path')
              const cur = (await notificationsLedger.load(fs, path)) || { items: [] }
              ackItems = (cur.items || []).filter((it) => it.kind === 'flight-ack')
            } catch {}
          }
          const ackByFlightId = new Map()
          for (const it of (ackItems || [])) {
            const fid = (it.flight_id || '').toLowerCase()
            if (!fid) continue
            const at = Date.parse(it.at || '')
            const existing = ackByFlightId.get(fid)
            if (!existing || (Number.isFinite(at) && at > Date.parse(existing.at || ''))) {
              ackByFlightId.set(fid, it)
            }
          }

          // ── Complaints (cached) for per-flight N indicator ────────────
          let complaintsRaw = []
          try { complaintsRaw = await loadComplaintsCached() } catch { complaintsRaw = [] }

          // ── Tracks + zones ────────────────────────────────────────────
          // Pass landedHours through so the date range is sized for the
          // actual window (covers UTC-midnight crossings cleanly).
          const live = await loadLive(landedHours)
          const tracks = live.tracks || []
          const baseZones = await adsb.loadZones()
          const zoneConfig = { ...baseZones, field_elevation_ft: ap.elev }

          // ── Per-tail descriptor / school / base lookup ────────────────
          // Same shape /api/adsb/current-flights and /api/noise/recent-landings
          // use. Without this the row renders the bare ICAO type code
          // ("C172" instead of "CESSNA 172") because the kiosk falls back
          // to `type` when `desc` is null (client-flagged regression).
          //
          // Memoized at 60 s per tail (tailInfoCache, module-scope). On
          // each request, only tails missing from the cache (or stale)
          // hit Postgres. Steady-state kiosk polling means the per-tail
          // SQL touches ~0 rows; first poll after process start does the
          // full ~600-row scan once. This drops the dominant slow path
          // in the 220 s avg the kiosk reported.
          const allTails = [...new Set(tracks.map((t) => (t.call || '').trim()).filter(Boolean))]
          const info = new Map()
          const tailsToFetch = []
          const tailNowMs = Date.now()
          for (const tail of allTails) {
            const c = tailInfoCache.get(tail)
            if (c && tailNowMs - c.fetchedAt < TAIL_INFO_TTL_MS) {
              if (c.row) info.set(tail, c.row)
            } else {
              tailsToFetch.push(tail)
            }
          }
          if (tailsToFetch.length) {
            try {
              const r = await db.queryDb(
                `SELECT call,
                   (array_agg(base_airport ORDER BY date DESC) FILTER (WHERE base_airport IS NOT NULL))[1] AS base,
                   (array_agg(purpose      ORDER BY date DESC) FILTER (WHERE purpose      IS NOT NULL))[1] AS purpose,
                   (array_agg(school       ORDER BY date DESC) FILTER (WHERE school       IS NOT NULL))[1] AS school,
                   (array_agg(desc_text    ORDER BY date DESC) FILTER (WHERE desc_text    IS NOT NULL))[1] AS descr
                 FROM tracks WHERE call = ANY($1) GROUP BY call`,
                [tailsToFetch],
              )
              const rowByCall = new Map()
              for (const row of r.rows) rowByCall.set(row.call, row)
              // Populate the cache for ALL fetched tails (including those
              // with no matching row) so the next request doesn't re-query
              // unknown tails. Cache hit with row=null is a valid "no
              // data" answer.
              for (const tail of tailsToFetch) {
                const row = rowByCall.get(tail) || null
                tailInfoCache.set(tail, { row, fetchedAt: tailNowMs })
                if (row) info.set(tail, row)
              }
            } catch {
              // On failure don't poison the cache — tails not in it stay
              // missing so the next request retries. Existing cached
              // entries remain valid.
            }
          }

          const flights = []
          for (const t of tracks) {
            const tail = (t.call || '').trim()
            if (!tail || tail.startsWith('~')) continue
            const pts = (t.points || []).slice().sort((a, b) => (a[3] || 0) - (b[3] || 0))
            if (pts.length < 2) continue

            // Project extractTowCycles output to { tMs, lMs }. lMs is null
            // for in-progress (airborne) cycles.
            const rawCycles = adsb.extractTowCycles(t.hex, tail, pts, zoneConfig) || []
            const cycles = []
            for (const c of rawCycles) {
              const tMs = Date.parse(c.takeoff_ts || '')
              if (!Number.isFinite(tMs)) continue
              const lMs = c.landing_ts ? Date.parse(c.landing_ts) : null
              cycles.push({ tMs, lMs: Number.isFinite(lMs) ? lMs : null })
            }
            // Fallback for airborne flights with no complete cycle yet — the
            // exact case `/api/adsb/current-flights` handles by walking back
            // from the latest fix. Without this fallback, airborne practice-
            // area / training flights silently drop out of CURRENT until
            // they land (kiosk bug report 2026-06-01). See flightCycles.js
            // for the pure helper + its regression net.
            if (!cycles.length) {
              const synth = synthesizeInProgressCycle(pts, groundCeil, nowMs)
              if (synth) cycles.push(synth)
            }
            if (!cycles.length) continue
            cycles.sort((a, b) => a.tMs - b.tMs)

            // Group cycles into flights using the per-airport gap. A null
            // lMs (still airborne) ends its group — no later cycle can
            // merge into an open one. Companion guard fires when a gap
            // looks like an ADS-B coverage dropout, not real ground time
            // (passed `pts` as the third arg).
            const groups = groupCyclesIntoFlights(cycles, gapMinMs, pts)

            // Most recent track fix — drives airborne/landed decision and
            // the row's position marker.
            const last = pts[pts.length - 1]
            const lastSeenS = Math.max(0, Math.round((nowMs - (last[3] || nowMs)) / 1000))

            for (let gi = 0; gi < groups.length; gi++) {
              const grp = groups[gi]
              const takeoffMs = grp[0].tMs
              const lastCy = grp[grp.length - 1]
              const landingMs = lastCy.lMs
              const isLastGroup = gi === groups.length - 1

              // Airborne iff this is the latest group AND its last cycle
              // is still open OR the most recent fix is above ground ceiling.
              const isAirborne = isLastGroup && (
                landingMs == null
                || (last[2] != null && last[2] > groundCeil)
              )

              // Pick reference fix: last fix when airborne, otherwise the
              // first fix at/after landing.
              let refPt = last
              if (!isAirborne && landingMs != null) {
                refPt = pts.find((p) => p[3] != null && p[3] >= landingMs) || last
              }
              const dist = distNmAp(refPt[0], refPt[1], ap.lat, ap.lon)
              const landingDist = (!isAirborne && refPt)
                ? distNmAp(refPt[0], refPt[1], ap.lat, ap.lon)
                : Infinity

              // track_deg from last two fixes (same math as /live).
              let trackDeg = null
              if (pts.length >= 2) {
                const a = pts[pts.length - 2], b = last
                const dtSec = ((b[3] || 0) - (a[3] || 0)) / 1000
                if (dtSec > 0) {
                  const cos = Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180)
                  const dx = (b[1] - a[1]) * 364560 * cos
                  const dy = (b[0] - a[0]) * 364560
                  trackDeg = Math.round((Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360)
                }
              }

              const flightId = computeFlightId(airport, tail, takeoffMs)
              const ack = ackByFlightId.get(flightId)
              const acknowledged = !!ack

              // Phase resolution:
              //   airborne → phaseML label (pattern / inbound / departing /
              //              en_route / practice_area / nearby) — same engine
              //              /api/adsb/current-flights uses, sliced to the
              //              last PHASE_WINDOW_S of fixes.
              //   landed + acked → 'landed'
              //   landed + not acked → 'ack_pending'
              let phase
              if (isAirborne) {
                let mlPhase = 'nearby'
                try {
                  const PHASE_WINDOW_S = 180
                  const windowStartMs = (last[3] || nowMs) - PHASE_WINDOW_S * 1000
                  const phasePts = []
                  for (const p of pts) {
                    if (p[3] == null || p[3] < windowStartMs) continue
                    phasePts.push({
                      lat: p[0], lon: p[1],
                      altMslFt: p[2], tsUnix: p[3] / 1000,
                    })
                  }
                  if (phasePts.length >= 2) {
                    const { phases } = classifyOneTrack(phasePts, {
                      typeCode: t.type || '',
                      intentWindowS: PHASE_WINDOW_S,
                      priorByAirport: { [airport]: 2.0 },
                    })
                    if (phases && phases.length) mlPhase = phases[phases.length - 1].phase
                  }
                } catch (e) {
                  console.error('[flights/current] phaseML error for', tail, e.message)
                }
                phase = mlPhase
              } else if (acknowledged) phase = 'landed'
              else phase = 'ack_pending'

              // Membership.
              const inAirborneSet = isAirborne && dist <= rangeNm
              const inLandedSet = !isAirborne
                && landingMs != null
                && landingMs >= landedCutoffMs
                && landingDist <= LANDING_NEAR_NM
                && !acknowledged
              if (!inAirborneSet && !inLandedSet) continue

              const sinceMs = isAirborne
                ? (nowMs - takeoffMs)
                : (nowMs - (landingMs || nowMs))

              // Compute V/P/N indicators inline (Ask #2 + #5a). worst_segment
              // is still null pending the sliding-window analysis (Ask #5b).
              const indFull = computeFlightIndicators(
                grp, pts, tail, t.type, airport, complaintsRaw,
              )
              const { worst_segment, incursion_segments, reported_segments, impact_index, ...indicators } = indFull

              const inf = info.get(tail) || {}
              // Ask #7 — filter to flights registered to this school. The
              // unknown-slug case still emits the response shape; the
              // flights[] array is just empty, matching the kiosk's
              // "not a 404, legitimate empty state" semantics.
              if (schoolFilter) {
                const flightSlug = slugifySchool(inf.school)
                if (!flightSlug || flightSlug !== schoolFilter) continue
              }
              flights.push({
                id: flightId,
                tail,
                type: t.type || null,
                desc: inf.descr || expandType(t.type),
                base: inf.base || null,
                school: inf.school || null,
                school_slug: slugifySchool(inf.school),
                icon_url: aircraftIconUrl(t.type, tail),
                phase,
                is_airborne: isAirborne,
                landed_at: landingMs ? new Date(landingMs).toISOString() : null,
                takeoff_ts: new Date(takeoffMs).toISOString(),
                acknowledged,
                acknowledged_by: ack?.acknowledged_by || null,
                acknowledged_at: ack?.at || null,
                since_ms: Math.max(0, sinceMs),
                cycles_in_flight: grp.length,
                indicators,
                worst_segment,
                incursion_segments,
                reported_segments,
                impact_index,
                lat: refPt?.[0] ?? null,
                lon: refPt?.[1] ?? null,
                alt_ft: refPt?.[2] ?? null,
                track_deg: trackDeg,
                last_seen_s: lastSeenS,
                dist_nm: Math.round(dist * 10) / 10,
              })
            }
          }

          // ── verified_alt post-pass: regional time-smoothed offset ────
          // Each flight's own touchdown calibration (self-offset) feeds a
          // per-airport time series. We then re-derive each flight's
          // final offset as the smoothed average of the 2 landings before
          // and 2 after its midtime (outliers > max(50, stddev) dropped).
          // This catches baro drift across a long flight, rescues
          // flights that never approached the runway, and reduces single-
          // transponder noise. The delta gets folded back into alt_agl_*
          // on worst_segment and incursion_segments so noise items
          // report the smoothed-corrected AGL.
          // `regionalOffsetSeries` drops calibrationFixes==0; we also drop
          // offsetFt==0 here to preserve the pre-refactor semantics (a
          // flight whose cohort produced a 0-ft offset wasn't seeded into
          // the series).
          const midMsOf = (f) => {
            const takeoffMs = Date.parse(f.takeoff_ts || '')
            const landMs = f.landed_at ? Date.parse(f.landed_at) : takeoffMs
            return Number.isFinite(takeoffMs) && Number.isFinite(landMs)
              ? (takeoffMs + landMs) / 2 : nowMs
          }
          const selfCalibrated = []
          for (const f of flights) {
            const off = f.indicators?.alt_offset_ft
            const cohort = f.indicators?.alt_offset_calibration_fixes || 0
            if (!cohort || off === 0) continue
            selfCalibrated.push({
              airport, midMs: midMsOf(f),
              offsetFt: off, calibrationFixes: cohort,
            })
          }
          const seriesByAirport = regionalOffsetSeries(selfCalibrated)
          for (const f of flights) {
            const smoothed = smoothedOffsetFor(airport, midMsOf(f), seriesByAirport)
            if (!smoothed) continue
            const oldOff = f.indicators.alt_offset_ft || 0
            const delta = smoothed.offset_ft - oldOff
            f.indicators.alt_offset_ft = smoothed.offset_ft
            f.indicators.alt_offset_smoothing_landings = smoothed.n_landings
            if (delta !== 0) {
              const shift = (v) => v != null ? Math.round(v - delta) : null
              if (f.worst_segment) {
                f.worst_segment.alt_agl_min = shift(f.worst_segment.alt_agl_min)
                f.worst_segment.alt_agl_mean = shift(f.worst_segment.alt_agl_mean)
                f.worst_segment.alt_agl_peak = shift(f.worst_segment.alt_agl_peak)
              }
              for (const s of f.incursion_segments || []) {
                s.alt_agl_min = shift(s.alt_agl_min)
                s.alt_agl_mean = shift(s.alt_agl_mean)
                s.alt_agl_peak = shift(s.alt_agl_peak)
              }
            }
          }

          // Airborne first, then most-recent landing first.
          flights.sort((a, b) => {
            if (a.is_airborne !== b.is_airborne) return a.is_airborne ? -1 : 1
            return (b.landed_at || '').localeCompare(a.landed_at || '')
          })

          const responseBody = JSON.stringify({
            airport,
            generated_at: new Date(nowMs).toISOString(),
            flight_gap_min: flightGapMinFor(airport),
            landed_hours: landedHours,
            range_nm: rangeNm,
            school_filter: schoolFilter,
            count: flights.length,
            indicators_note: 'V/P/N indicators wired (Ask #2 + #5a). worst_segment wired (Ask #5b) with AGL-aware dBA proxy. incursion_segments wired (Ask #6) with polygon-edge interpolation, significant/minor severity tiers, and AGL-aware dBA proxy. pop_impact retuned 2026-05-31: scale=40, null threshold=2.5 (was 50/1.5). p95 of observed impact_index now maps to 88; null cohort drops from ~12% to ~5%. worst_segment.impact_score still nulls when window-scoped raw exceeds 100 (intrinsic to 30 s concentration). pop_impact and worst_segment EXCLUDE the strict airport pattern envelope (within pattern_radius_nm and ≤ 1500 ft AGL). VNAP, complaint, and incursion_segments indicators use the full track. Ask #7 ?school=<slug> filter active when set. phase labels from phaseML classifier (pattern/inbound/departing/en_route/practice_area/nearby) for airborne; landed or ack_pending for landed. Flight grouping has a companion coverage-gap guard: cycles >= FLIGHT_GAP_MIN apart but <30% expected ADS-B coverage AND >2,000 ft aircraft drift merge anyway.',
            pop_impact_scale: 'pop_impact is a 0-100 integer per Ask #5a; impact_index is the legacy small-float for back-compat with the wall kiosk.',
            flights,
          })
          currentResponseCache.set(cacheKey, { body: responseBody, fetchedAt: Date.now() })
          return responseBody
          } finally { currentInFlight.delete(cacheKey) } })()
          currentInFlight.set(cacheKey, work)
          res.setHeader('X-Cache', 'MISS')
          res.end(await work)
        } catch (err) {
          console.error('[flights/current] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}

// Permitted `source_category` values on a complaint. Default `aviation`
// preserves the historical shape; the other values let the kiosk's
// reporting form surface non-aviation sources so the operator can compute
// aviation-vs-other ratios. Adding a value here is the only place — kept
// closed so we don't get free-text drift in downstream rollups.
const COMPLAINT_SOURCE_CATEGORIES = new Set([
  'aviation',
  'road',
  'construction',
  'rail',
  'industrial',
  'other',
])

// GET  /api/complaints[?tail=...&source=...]  → list all or filter
// POST /api/complaints                          → lodge a complaint
// Storage: noise/web/data/complaints.json (outside public/, not served).
// Multiple complaints per (tail, startedAt) are allowed — different
// reporters can each file their own. Concurrent POSTs are serialized via
// a promise chain so one file write can't clobber another's read-modify-write.
function complaintsApiPlugin() {
  const FILE = 'data/complaints.json'
  let writeChain = Promise.resolve()
  const loadAll = async (fs, path) => {
    try {
      const buf = await fs.readFile(path.resolve(FILE), 'utf8')
      const data = JSON.parse(buf)
      return { complaints: Array.isArray(data.complaints) ? data.complaints : [] }
    } catch {
      return { complaints: [] }
    }
  }
  const saveAll = async (fs, path, data) => {
    const p = path.resolve(FILE)
    const dir = path.dirname(p)
    try { await fs.mkdir(dir, { recursive: true }) } catch {}
    const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2))
    try {
      await fs.rename(tmp, p)
    } catch (e) {
      try { await fs.unlink(tmp) } catch {}
      throw e
    }
  }
  const readBody = async (req) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8')
    return raw ? JSON.parse(raw) : {}
  }
  return {
    name: 'complaints-api',
    configureServer(server) {
      server.middlewares.use('/api/complaints', async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'POST') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          if (req.method === 'GET') {
            const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
            const tail = (u.searchParams.get('tail') || '').trim().toUpperCase()
            const source = (u.searchParams.get('source') || '').trim().toLowerCase()
            let list
            if (db.useDb) {
              list = await db.getComplaints(tail || null)
            } else {
              const data = await loadAll(fs, path)
              list = tail
                ? data.complaints.filter((c) => (c.tail || '').toUpperCase() === tail)
                : data.complaints
            }
            if (source) {
              // Default to 'aviation' for records written before source_category
              // existed — preserves historical filtering semantics.
              list = list.filter((c) => (c.source_category || 'aviation') === source)
            }
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(JSON.stringify({ count: list.length, complaints: list }))
            return
          }
          let body
          try {
            body = await readBody(req)
          } catch {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'invalid JSON body' }))
            return
          }
          const tail = ((body.tail || '') + '').trim().toUpperCase()
          const startedAt = ((body.startedAt || '') + '').trim()
          const klass = ((body.klass || '') + '').trim()
          const sourceCategory = (((body.source_category || body.sourceCategory) || 'aviation') + '').trim().toLowerCase()
          if (!COMPLAINT_SOURCE_CATEGORIES.has(sourceCategory)) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
              error: `invalid source_category; allowed: ${[...COMPLAINT_SOURCE_CATEGORIES].join(', ')}`,
            }))
            return
          }
          // tail is only required for aviation reports. Non-aviation
          // (road / construction / rail / industrial / other) can omit
          // tail entirely — the report is about an environmental source
          // the reporter hears, not a specific aircraft.
          if (sourceCategory === 'aviation' && !tail) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'tail required for aviation source_category' }))
            return
          }
          if (!startedAt || !klass) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'missing required fields: startedAt, klass' }))
            return
          }
          const record = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: new Date().toISOString(),
            source_category: sourceCategory,
            tail: tail || null,
            startedAt,
            endedAt: body.endedAt || null,
            klass,
            zone: body.zone || null,
            reporter: body.reporter || null,
            notes: body.notes || null,
            type: body.type || null,
            lat: typeof body.lat === 'number' ? body.lat : null,
            lon: typeof body.lon === 'number' ? body.lon : null,
            location: body.location || null,
            precision: body.precision || null,
            mediaKind: body.mediaKind || null,
            score: typeof body.score === 'number' ? body.score : null,
            distanceMiles: typeof body.distanceMiles === 'number' ? body.distanceMiles : null,
          }
          if (db.useDb) {
            // Workaround for the complaints.tail NOT NULL column — non-
            // aviation reports satisfy it with '' while raw JSONB preserves
            // the true null shape on the wire. Schema migration to NULL
            // tail is a follow-up.
            await db.queryDb(
              'INSERT INTO complaints (id, tail, started_at, ended_at, klass, zone, notes, type, score, raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
              [
                record.id, record.tail || '', record.startedAt, record.endedAt,
                record.klass, record.zone, record.notes, record.type,
                record.score, JSON.stringify(record),
              ],
            )
          } else {
            const task = async () => {
              const data = await loadAll(fs, path)
              data.complaints.push(record)
              await saveAll(fs, path, data)
            }
            const queued = writeChain.then(task, task)
            writeChain = queued.catch(() => {})
            await queued
          }
          res.statusCode = 201
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify(record))
        } catch (err) {
          console.error('[complaints-api] error', err)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}

function liveCapturePlugin() {
  // Front Range corridor center — covers KBDU, KLMO, KEIK, KBJC, KAPA, KGXY
  // with a 36 nm radius from the geographic mean of all 6 airports.
  const CENTER = [40.0211, -105.0063]
  const RADIUS_NM = 36
  const POLL_MS = 5_000
  const ALT_MAX_FT = 10_000
  const LIVE_FILE = 'public/tracks_live.json'
  const archivePathFor = (day) => `public/tracks_live_${day}.json`
  const FEEDS = [
    (lat, lon, nm) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
    (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}`,
  ]
  const todayUTC = () => new Date().toISOString().slice(0, 10)
  const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, '')
  let state = null // { day, startedAt, byHex: Map<hex, {hex,call,type,reg,points}> }
  let timer = null
  let fs = null
  let path = null
  let stopping = false
  let pollInFlight = false // serialize polls — prevents concurrent fetch/flush
  const initState = () => ({ day: todayUTC(), startedAt: nowIso(), byHex: new Map() })
  const serializeTracks = (byHex) => Array.from(byHex.values()).map((t) => ({
    hex: t.hex, call: t.call, type: t.type, reg: t.reg, src: 'live', points: t.points,
  }))
  const writeAtomic = async (p, obj) => {
    // Unique temp name so even if two writes ever race, they don't clobber
    // each other's .tmp source and cause ENOENT on rename. On Windows,
    // fs.rename replaces the destination if it exists (since Node 14).
    // OneDrive/AV scanners hold transient locks on public/*.json during
    // sync — retry rename a few times on EPERM/EBUSY/EACCES before giving
    // up; lock is usually released within ~200ms.
    const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(obj))
    const delays = [25, 50, 100, 200, 400]
    let lastErr = null
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        await fs.rename(tmp, p)
        return
      } catch (e) {
        lastErr = e
        if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') break
        if (attempt === delays.length) break
        await new Promise((r) => setTimeout(r, delays[attempt]))
      }
    }
    try { await fs.unlink(tmp) } catch {}
    throw lastErr
  }
  const flush = async () => {
    if (!state) return
    await writeAtomic(path.resolve(LIVE_FILE), {
      center: CENTER,
      radius_nm: RADIUS_NM,
      alt_max_ft: ALT_MAX_FT,
      started_at: state.startedAt,
      updated_at: nowIso(),
      tracks: serializeTracks(state.byHex),
    })
  }
  const archive = async (day, startedAt, byHex) => {
    const p = path.resolve(archivePathFor(day))
    await writeAtomic(p, {
      center: CENTER,
      radius_nm: RADIUS_NM,
      alt_max_ft: ALT_MAX_FT,
      started_at: startedAt,
      updated_at: nowIso(),
      tracks: serializeTracks(byHex),
    })
  }
  const loadExisting = async () => {
    // On startup, rehydrate today's session from disk if present; otherwise
    // archive whatever stale file we find under its own day and start fresh.
    try {
      const p = path.resolve(LIVE_FILE)
      const buf = await fs.readFile(p, 'utf8')
      const data = JSON.parse(buf)
      const fileDay = (data.updated_at || '').slice(0, 10)
      if (fileDay === todayUTC()) {
        const byHex = new Map()
        for (const t of data.tracks || []) {
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
        state = { day: todayUTC(), startedAt: data.started_at || nowIso(), byHex }
        console.log(`[live-capture] resumed ${state.byHex.size} tracks for ${state.day}`)
        return
      }
      if (fileDay) {
        const archPath = path.resolve(archivePathFor(fileDay))
        try {
          await fs.access(archPath)
        } catch {
          await fs.writeFile(archPath, buf)
          console.log(`[live-capture] archived stale ${LIVE_FILE} as tracks_live_${fileDay}.json`)
        }
      }
    } catch {
      // no file yet — fresh start
    }
    state = initState()
  }
  const rotateIfNeeded = async () => {
    if (!state || state.day === todayUTC()) return
    try {
      await archive(state.day, state.startedAt, state.byHex)
      console.log(`[live-capture] rotated ${state.day} → tracks_live_${state.day}.json`)
    } catch (e) {
      console.error('[live-capture] rotate failed', e)
    }
    state = initState()
  }
  const poll = async () => {
    if (stopping) return
    if (pollInFlight) return // previous poll still running; skip this tick
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
      // Prefer registration as call so tail-based queries line up with
      // how tracks_yearly.json keys aircraft (call === registration for GA).
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
        // 4th element is epoch-ms timestamp. Historical tracks from
        // tracks_yearly.json are 3-element; segment builder handles both.
        t.points.push([ac.lat, ac.lon, alt, Date.now()])
      }
    }
    try { await flush() } catch (e) { console.error('[live-capture] flush failed', e) }
    } finally {
      pollInFlight = false
    }
  }
  return {
    name: 'live-capture',
    async configureServer(server) {
      // Idempotent — vite re-invokes configureServer on config reloads, and
      // leaking setInterval handles across reloads was one path to OOM.
      if (timer) { clearInterval(timer); timer = null }
      stopping = false
      const fsMod = await import('fs/promises')
      const pathMod = await import('path')
      fs = fsMod.default
      path = pathMod.default
      await loadExisting()
      poll().catch((e) => console.error('[live-capture] poll failed', e))
      timer = setInterval(
        () => poll().catch((e) => console.error('[live-capture] poll failed', e)),
        POLL_MS,
      )
      const stop = () => {
        stopping = true
        if (timer) { clearInterval(timer); timer = null }
      }
      server.httpServer?.on('close', stop)
      console.log(`[live-capture] started, polling every ${POLL_MS / 1000}s`)
    },
    closeBundle() {
      stopping = true
      if (timer) { clearInterval(timer); timer = null }
    },
  }
}

// Paginated API: GET /api/tracks?page=0&size=2000
// Returns { tracks, page, size, total, pages } so the client can fetch
// in chunks and show a progress bar. Queries Postgres with LIMIT/OFFSET.
// Also serves /tracks_yearly.json as a legacy fallback (redirects to
// the paginated API page 0 for backwards compat).
function dbTracksPlugin() {
  let countCache = { n: 0, at: 0 }
  const COUNT_TTL = 60_000
  return {
    name: 'db-tracks',
    configureServer(server) {
      console.log('[db-tracks] plugin registered — /api/tracks (paginated) + /tracks_yearly.json')

      // Paginated endpoint — client fetches chunks from Postgres directly.
      // Defaults reduced so the Node heap can't be blown by a single page:
      // each `tracks.points` JSONB can be hundreds of KB, so 2 000 rows
      // can serialize into multi-GB. 200 rows / 1 000 cap is plenty for
      // progressive loading on the client.
      server.middlewares.use('/api/tracks', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const page = Math.max(0, parseInt(u.searchParams.get('page') || '0'))
          const size = Math.min(1000, Math.max(50, parseInt(u.searchParams.get('size') || '200')))
          const offset = page * size

          // Get total count (cached)
          const now = Date.now()
          if (!countCache.n || now - countCache.at > COUNT_TTL) {
            const cr = await db.queryDb('SELECT count(*) FROM tracks')
            countCache = { n: parseInt(cr.rows[0].count), at: now }
          }
          const total = countCache.n
          const pages = Math.ceil(total / size)

          console.log(`[db-tracks] /api/tracks page=${page} size=${size} offset=${offset} total=${total}`)

          // Query just this page from Postgres
          const r = await db.queryDb(
            'SELECT call, hex, type, desc_text, own_op, src, points FROM tracks ORDER BY id LIMIT $1 OFFSET $2',
            [size, offset]
          )
          // Derive year, t0, years_back from src (e.g. "globe/2023-03-15/hex")
          // These fields are expected by the client for filtering and time-of-day.
          const currentYear = new Date().getFullYear()
          const tracks = r.rows.map(row => {
            const m = (row.src || '').match(/(\d{4})-(\d{2})-(\d{2})/)
            const year = m ? m[1] : null
            const t0 = m ? Math.floor(Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`) / 1000) : null
            const yearsBack = year ? currentYear - parseInt(year) : null
            return {
              call: row.call, hex: row.hex, type: row.type, desc: row.desc_text,
              ownOp: row.own_op, src: row.src, points: row.points,
              year, t0, years_back: yearsBack,
            }
          })

          const payload = JSON.stringify({ tracks, page, size, total, pages })
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(payload)
        } catch (e) {
          console.error('[db-tracks] /api/tracks error', e)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(e), tracks: [] }))
        }
      })

      // Legacy /tracks_yearly.json — redirect to page 0 so old clients
      // get something, but real loading uses the paginated API above.
      server.middlewares.use('/tracks_yearly.json', async (_req, res) => {
        console.log('[db-tracks] /tracks_yearly.json requested — returning empty (use /api/tracks)')
        res.setHeader('Content-Type', 'application/json')
        res.end('{"tracks":[],"_use_api":true}')
      })
    },
  }
}

// Pre-aggregated noise stats and filtered tracks from Postgres.
// Replaces the 60MB bulk download + client-side classification with
// lightweight server-side queries against pre-computed columns.
function noiseApiPlugin() {
  if (!db.useDb) return null // only on Railway

  // ── Caches for /api/noise/recent-landings ───────────────────────────────
  //
  // The kiosk team measured 84 s avg / 101 s p100 on this endpoint with one
  // 500 in 3 samples (probable cause: pg pool exhaustion under concurrent
  // polling, then statement_timeout firing → catch returns 500). The slow
  // paths mirror /api/flights/current and /api/adsb/current-flights:
  //
  //   1. The per-tail GROUP BY scan over `tracks` (`call = ANY($1)`) — same
  //      SQL all three endpoints run. `tracks.call` is unindexed, so each
  //      request triggers a seq scan over millions of rows. The JS-level
  //      mitigation here hides it for warm hits; see
  //      migrations/20260531_tracks_call_idx.sql for the matching index
  //      that drops cold-start latency from minutes to under a second.
  //   2. extractTowCycles + impactSegments + bandsFromPoints walk every
  //      track point per request. Even after the tail-info join is cached,
  //      a 12 h window still has hundreds of tracks to process.
  //   3. Multi-workstation kiosk polling. With the 8 s poll interval and
  //      a 60 s cold response, every workstation runs the full pipeline
  //      independently → pool saturation → cascading 500s.
  //
  // Two-layer cache + request coalescing (same shape as the boot-endpoint
  // and current-flights fixes already landed):
  //
  //   RECENT_LANDINGS_RESPONSE_TTL_MS: full response JSON keyed on
  //   (airport, minutes), 10 s TTL. A new landing typically takes ≥ 60 s
  //   to register (descent → confirmed on-ground requires ≥ 30 s of fixes
  //   below ground ceiling), so a 10 s stale window is invisible to
  //   operators. Picked slightly over the kiosk's 8 s poll cadence so the
  //   second poll in a pair is a HIT.
  //
  //   RECENT_LANDINGS_TAIL_INFO_TTL_MS: per-tail (base, school, purpose,
  //   desc) row, 60 s TTL. School/base/purpose change at most once per day.
  //   Each request queries Postgres only for tails missing from the cache;
  //   steady-state polling drives the per-tail SQL to ~0 rows.
  //
  // recentLandingsInFlight coalesces concurrent MISS computations on the
  // same key so the multi-workstation case shares one pipeline run; this
  // is the most likely fix for the 1-of-3 sample returning 500 / 58 bytes
  // (concurrent miss → pool exhaustion → statement_timeout → 500).
  const RECENT_LANDINGS_RESPONSE_TTL_MS = 10_000
  const recentLandingsResponseCache = new Map() // key -> { body, fetchedAt }
  const recentLandingsInFlight = new Map()      // key -> Promise<{ body }>
  const RECENT_LANDINGS_TAIL_INFO_TTL_MS = 60_000
  const recentLandingsTailInfoCache = new Map() // call -> { row, fetchedAt }

  return {
    name: 'noise-api',
    configureServer(server) {
      console.log('[noise-api] registered /api/noise/stats, /api/noise/tracks, /api/noise/years')

      // GET /api/noise/years — distinct years for filter pills
      server.middlewares.use('/api/noise/years', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const r = await db.queryDb('SELECT DISTINCT year FROM tracks WHERE year IS NOT NULL ORDER BY year')
          const years = r.rows.map(row => row.year)
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ years }))
        } catch (e) {
          console.error('[noise-api] /years error', e)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e) }))
        }
      })

      // GET /api/noise/leaderboard?days=90&limit=20&by=tail|base|school
      //                            [&airport=KBDU][&origin=local|transient]
      //
      // Public leaderboard API. Ranks entities by a Good-Neighbor composite
      // score over the last N days that rewards flying OFTEN while staying clean
      // and low-impact over the (populated) noise-abatement zones:
      //
      //   score = flights × (1 − excursion_rate) × 1/(1 + K·impact_per_nm)
      //     flights        — frequency reward (more flights ranks higher)
      //     excursion_rate — excursion miles / total miles (least excursions)
      //     impact_per_nm  — severity-weighted excursion miles (red×3, orange×2,
      //                      yellow×1) per mile flown = impact over populated
      //                      areas per path length (the VNAP zones are the
      //                      protected residential areas)
      //
      // Filters (all optional, combinable):
      //   airport  — restrict to aircraft whose HOME base (tracks.base_airport)
      //              is this airport, e.g. ?airport=KBDU. Comma-separates for
      //              multiple. Aliases: homeBase, base. This is the "based here"
      //              filter — the backfill records each aircraft's home field.
      //   origin   — local | transient. Per-flight geometric classification
      //              (within vs beyond the local radius). Distinct from airport:
      //              a based aircraft can fly transient, a visitor can fly local.
      //
      // Response shape:
      //   { generated_at, window: {days, from, to}, by, airport, home_base,
      //     origin, scoring, entries: [{ rank, name, flights, total_nm, clean_nm,
      //       excursion_nm, weighted_exc_nm, clean_pct, red_pct, orange_pct,
      //       yellow_pct, excursion_rate, pop_impact, impact_basis, impact_index,
      //       score, score_pct }] }
      // impact_basis is 'population' once the pop_impact backfill has run, else
      // 'zone_proxy' (severity-weighted abatement-zone excursion per mile).
      let popColEnsured = false
      server.middlewares.use('/api/noise/leaderboard', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          // Ensure the pop_impact column exists so SUM(pop_impact) is safe even
          // before the backfill recompute has run (it reads NULL → zone_proxy).
          if (!popColEnsured) {
            await db.queryDb('ALTER TABLE tracks ADD COLUMN IF NOT EXISTS pop_impact REAL').catch(() => {})
            popColEnsured = true
          }
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const days = Math.min(3650, Math.max(1, parseInt(u.searchParams.get('days') || '90')))
          const limit = Math.min(100, Math.max(1, parseInt(u.searchParams.get('limit') || '20')))
          const by = u.searchParams.get('by') || 'tail' // tail | base | school

          const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
          const FT_PER_NM = 6076

          // Build optional filters. $1 is always the date cutoff; extra filter
          // params are appended after it, the LIMIT param goes last.
          const params = [cutoff]
          const extra = []
          // `base` is an alias for `homeBase`: on every other noise endpoint
          // (buildFilters) `base` already filters tracks.base_airport (the home
          // field), so the leaderboard now matches. There is no operating-
          // airport dimension in the backfill to filter on.
          // `airport` is the preferred name; `homeBase`/`base` kept as aliases.
          const homeBaseRaw = u.searchParams.get('airport') || u.searchParams.get('homeBase') || u.searchParams.get('base')

          // Primary source: the LIVE store (current daily captures). The
          // historical `tracks` SQL below is the fallback for windows the live
          // store doesn't cover. ?source=tracks forces the historical path.
          if (u.searchParams.get('source') !== 'tracks') {
            const live = await buildLiveLeaderboard({ days, limit, by, homeBaseRaw }).catch((e) => {
              console.error('[noise-api] /leaderboard live agg failed:', e.message); return null
            })
            if (live && live.entries.length) {
              res.setHeader('Content-Type', 'application/json')
              res.setHeader('Access-Control-Allow-Origin', '*')
              res.setHeader('Cache-Control', 'public, max-age=300')
              return res.end(JSON.stringify(live))
            }
          }

          if (homeBaseRaw) {
            const bases = homeBaseRaw.split(',').map(b => b.trim()).filter(Boolean)
            if (bases.length === 1) { params.push(bases[0]); extra.push(`base_airport = $${params.length}`) }
            else if (bases.length > 1) { params.push(bases); extra.push(`base_airport = ANY($${params.length})`) }
          }
          const originRaw = u.searchParams.get('origin')
          const origin = (originRaw === 'local' || originRaw === 'transient') ? originRaw : null
          if (origin) { params.push(origin); extra.push(`origin = $${params.length}`) }
          const extraSql = extra.length ? ' AND ' + extra.join(' AND ') : ''
          // Fetch a wide candidate set so the JS composite score (below) isn't
          // pre-truncated by the SQL pre-sort; we slice to `limit` after scoring.
          const candidateLimit = Math.max(limit, 500)
          params.push(candidateLimit)
          const limP = `$${params.length}`

          let sql
          if (by === 'base') {
            sql = `
              SELECT base_airport AS name,
                     count(*)::int AS flights,
                     round((SUM(len_total_ft) / ${FT_PER_NM})::numeric, 1) AS total_nm,
                     round((SUM(len_total_ft - len_red_ft - len_orange_ft - len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS clean_nm,
                     round((SUM(len_red_ft + len_orange_ft + len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS excursion_nm,
                     round((SUM(len_red_ft) / ${FT_PER_NM})::numeric, 1) AS red_nm,
                     round((SUM(len_orange_ft) / ${FT_PER_NM})::numeric, 1) AS orange_nm,
                     round((SUM(len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS yellow_nm,
                     round((SUM(3 * len_red_ft + 2 * len_orange_ft + len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS weighted_exc_nm,
                     SUM(pop_impact) AS pop_impact_sum,
                     SUM(len_total_ft) AS len_total_ft_sum
              FROM tracks
              WHERE date >= $1 AND len_total_ft > 0 AND base_airport IS NOT NULL${extraSql}
              GROUP BY base_airport
              HAVING SUM(len_total_ft) > 0
              ORDER BY SUM(len_total_ft - len_red_ft - len_orange_ft - len_yellow_ft) DESC
              LIMIT ${limP}
            `
          } else if (by === 'school') {
            sql = `
              SELECT school AS name,
                     count(*)::int AS flights,
                     round((SUM(len_total_ft) / ${FT_PER_NM})::numeric, 1) AS total_nm,
                     round((SUM(len_total_ft - len_red_ft - len_orange_ft - len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS clean_nm,
                     round((SUM(len_red_ft + len_orange_ft + len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS excursion_nm,
                     round((SUM(len_red_ft) / ${FT_PER_NM})::numeric, 1) AS red_nm,
                     round((SUM(len_orange_ft) / ${FT_PER_NM})::numeric, 1) AS orange_nm,
                     round((SUM(len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS yellow_nm,
                     round((SUM(3 * len_red_ft + 2 * len_orange_ft + len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS weighted_exc_nm,
                     SUM(pop_impact) AS pop_impact_sum,
                     SUM(len_total_ft) AS len_total_ft_sum
              FROM tracks
              WHERE date >= $1 AND len_total_ft > 0 AND school IS NOT NULL${extraSql}
              GROUP BY school
              HAVING SUM(len_total_ft) > 0
              ORDER BY SUM(len_total_ft - len_red_ft - len_orange_ft - len_yellow_ft) DESC
              LIMIT ${limP}
            `
          } else {
            // by tail (default)
            sql = `
              SELECT call AS name, MAX(type) AS type, MAX(school) AS school,
                     MAX(base_airport) AS base, MAX(purpose) AS purpose,
                     count(*)::int AS flights,
                     round((SUM(len_total_ft) / ${FT_PER_NM})::numeric, 1) AS total_nm,
                     round((SUM(len_total_ft - len_red_ft - len_orange_ft - len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS clean_nm,
                     round((SUM(len_red_ft + len_orange_ft + len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS excursion_nm,
                     round((SUM(len_red_ft) / ${FT_PER_NM})::numeric, 1) AS red_nm,
                     round((SUM(len_orange_ft) / ${FT_PER_NM})::numeric, 1) AS orange_nm,
                     round((SUM(len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS yellow_nm,
                     round((SUM(3 * len_red_ft + 2 * len_orange_ft + len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS weighted_exc_nm,
                     SUM(pop_impact) AS pop_impact_sum,
                     SUM(len_total_ft) AS len_total_ft_sum
              FROM tracks
              WHERE date >= $1 AND len_total_ft > 0${extraSql}
              GROUP BY call
              HAVING SUM(len_total_ft) > 0
              ORDER BY SUM(len_total_ft - len_red_ft - len_orange_ft - len_yellow_ft) DESC
              LIMIT ${limP}
            `
          }

          const r = await db.queryDb(sql, params)

          // ── Good-Neighbor composite score ──
          // Rank biases toward aircraft that fly OFTEN while staying clean and
          // low-impact over the (populated) abatement zones:
          //   score = flights × cleanliness × impactFactor
          //     flights      — frequency reward (linear: more flights ranks higher)
          //     cleanliness  — 1 − excursion_rate (fraction of path length clean)
          //     impactFactor — 1 / (1 + K · impact_per_nm), where impact_per_nm is
          //                    severity-weighted excursion miles (red×3, orange×2,
          //                    yellow×1) per mile flown — "impact over populated
          //                    areas per path length".
          // impact_index feeds impactFactor = 1/(1+impact_index). Two bases:
          //   population — real people-weighted noise per ft (pop_impact column),
          //                normalized by POP_SCALE. Used once backfill populates it.
          //   zone_proxy — severity-weighted excursion nm per nm flown × ZONE_K.
          //                Fallback before pop_impact is computed.
          const POP_SCALE = 1000 // pop_impact-per-ft that maps to impact_index = 1
          const ZONE_K = 12
          const scored = r.rows.map(row => {
            const total = Number(row.total_nm) || 0
            const exc = Number(row.excursion_nm) || 0
            const wexc = Number(row.weighted_exc_nm) || 0
            const lenFt = Number(row.len_total_ft_sum) || 0
            const popImpact = row.pop_impact_sum == null ? null : Number(row.pop_impact_sum)
            const excursion_rate = total > 0 ? exc / total : 0
            let impact_index, impact_basis
            if (popImpact != null && lenFt > 0) {
              impact_index = (popImpact / lenFt) / POP_SCALE
              impact_basis = 'population'
            } else {
              impact_index = ZONE_K * (total > 0 ? wexc / total : 0)
              impact_basis = 'zone_proxy'
            }
            const cleanliness = 1 - Math.min(1, excursion_rate)
            const impactFactor = 1 / (1 + impact_index)
            const score = (Number(row.flights) || 0) * cleanliness * impactFactor
            return {
              ...row,
              clean_pct: total > 0 ? Math.round(row.clean_nm / total * 1000) / 10 : 0,
              red_pct: total > 0 ? Math.round(row.red_nm / total * 1000) / 10 : 0,
              orange_pct: total > 0 ? Math.round(row.orange_nm / total * 1000) / 10 : 0,
              yellow_pct: total > 0 ? Math.round(row.yellow_nm / total * 1000) / 10 : 0,
              excursion_rate: Math.round(excursion_rate * 1000) / 10, // %
              pop_impact: popImpact == null ? null : Math.round(popImpact),
              impact_basis,
              impact_index: Math.round(impact_index * 1000) / 1000,
              score: Math.round(score * 100) / 100,
            }
          })
          // Sort by composite score (desc), then flights as a tiebreak.
          scored.sort((a, b) => b.score - a.score || b.flights - a.flights)
          const top = scored.slice(0, limit)
          // Normalize to a 0–100 leaderboard score relative to the top entry.
          const maxScore = top.length ? top[0].score : 0
          const entries = top.map((e, i) => ({
            rank: i + 1,
            ...e,
            icon_url: by === 'tail' ? aircraftIconUrl(e.type, e.name) : null,
            score_pct: maxScore > 0 ? Math.round(e.score / maxScore * 1000) / 10 : 0,
          }))

          const now = new Date()
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Cache-Control', 'public, max-age=300') // 5 min cache
          res.end(JSON.stringify({
            generated_at: now.toISOString(),
            window: { days, from: cutoff, to: now.toISOString().slice(0, 10) },
            by,
            airport: homeBaseRaw || null,
            home_base: homeBaseRaw || null, // alias, back-compat
            origin: origin || null,
            scoring: {
              formula: 'flights × (1 − excursion_rate) × 1/(1 + impact_index)',
              impact_index: 'population basis: people-weighted noise per ft / POP_SCALE; ' +
                'else zone_proxy: ZONE_K × severity-weighted excursion nm (red×3, orange×2, yellow×1) per nm',
              impact_basis: entries.length ? entries[0].impact_basis : null,
              sort: 'score desc, flights desc',
            },
            entries,
          }))
        } catch (e) {
          console.error('[noise-api] /leaderboard error', e)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(e) }))
        }
      })

      // GET /api/noise/impact-explain?tail=N3547L[&days=30][&limit=12]
      // Per-flight, per-SEGMENT population-noise impact for one tail, computed
      // live from the population grid + stored geometry (works before the
      // pop_impact backfill). Drives the single-tail explainer map: each
      // segment's `contribution` = length_ft × people/km² × (REF_AGL/AGL)².
      server.middlewares.use('/api/noise/impact-explain', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const tail = (u.searchParams.get('tail') || '').trim().toUpperCase()
          const days = Math.min(365, Math.max(1, parseInt(u.searchParams.get('days') || '30')))
          const limit = Math.min(50, Math.max(1, parseInt(u.searchParams.get('limit') || '12')))
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          if (!tail) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'tail required' })) }
          if (!POPGRID) { res.statusCode = 503; return res.end(JSON.stringify({ error: 'population grid unavailable' })) }
          const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
          const q = await db.queryDb(
            `SELECT id, date, type, base_airport AS base, points
             FROM tracks WHERE call = $1 AND date >= $2 AND points IS NOT NULL
             ORDER BY date DESC LIMIT $3`,
            [tail, cutoff, limit],
          )
          let sumImpact = 0, sumLen = 0, maxContribution = 0
          const flights = q.rows.map((row) => {
            const pts = (row.points || []).map((p) => [p[0], p[1], p[2]])
            const { total, lenFt, segments } = impactSegments(pts, POPGRID.popAt, distFt)
            sumImpact += total; sumLen += lenFt
            for (const s of segments) if (s.contribution > maxContribution) maxContribution = s.contribution
            return {
              id: row.id, date: row.date, type: row.type, type_desc: expandType(row.type), base: row.base,
              points: pts,
              contributions: segments.map((s) => s.contribution),
              segments,
              len_ft: Math.round(lenFt),
              pop_impact: Math.round(total),
              impact_index: lenFt > 0 ? Math.round((total / lenFt) / POP_SCALE * 1000) / 1000 : 0,
            }
          })
          res.setHeader('Cache-Control', 'public, max-age=120')
          res.end(JSON.stringify({
            tail, days, window: { from: cutoff, to: new Date().toISOString().slice(0, 10) },
            pop_scale: POP_SCALE, kernel: POP_KERNEL,
            totals: {
              flights: flights.length,
              len_ft: Math.round(sumLen),
              pop_impact: Math.round(sumImpact),
              impact_index: sumLen > 0 ? Math.round((sumImpact / sumLen) / POP_SCALE * 1000) / 1000 : 0,
              max_contribution: maxContribution,
            },
            flights,
          }))
        } catch (e) {
          console.error('[noise-api] /impact-explain error', e)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(e) }))
        }
      })

      // GET /api/noise/recent-landings?airport=KBDU&minutes=30
      // Recent full-stop landings at `airport`, each with its population-noise
      // impact computed from the SAME kernel as the leaderboard / impact-explain
      // (no separate Lmax model), plus classified bands[] and authoritative
      // visitor-gating values (airborne_min, origin_dist_nm). impact_score is
      // an alias of impact_index — purpose-aware weighting (training ×2, slide
      // cadence) is a caller concern; this API returns the physical measurement.
      server.middlewares.use('/api/noise/recent-landings', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        // Settle-helper for the in-flight coalescing layer; set in the
        // MISS path and called from both the happy path and the catch so
        // failures don't poison coalesced waiters.
        let settleInflight = null
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const airport = (u.searchParams.get('airport') || 'KBDU').trim().toUpperCase()
          const minutes = Math.min(720, Math.max(1, parseInt(u.searchParams.get('minutes') || '30')))
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Cache-Control', 'public, max-age=20')
          const ap = ENRICH_AP.find((a) => a.code === airport)
          if (!ap) { res.statusCode = 400; return res.end(JSON.stringify({ error: `unknown airport ${airport}` })) }
          if (!POPGRID) { res.statusCode = 503; return res.end(JSON.stringify({ error: 'population grid unavailable' })) }

          // ── Response cache check ──
          // Composite key over the params that affect output. With
          // RECENT_LANDINGS_RESPONSE_TTL_MS=10s and 8 s kiosk polling, the
          // second poll in any pair is a HIT and replies in sub-ms time.
          // Cached body is the final JSON string (no re-serialization).
          const cacheKey = `${airport}|${minutes}`
          const cached = recentLandingsResponseCache.get(cacheKey)
          if (cached && Date.now() - cached.fetchedAt < RECENT_LANDINGS_RESPONSE_TTL_MS) {
            res.setHeader('X-Cache', 'HIT')
            return res.end(cached.body)
          }

          // ── In-flight request coalescing ──
          // Without this, when multiple workstations poll while a MISS is
          // computing, each request grabs a pg pool slot and runs the full
          // pipeline independently. Under sustained load (the kiosk team's
          // measured 84 s avg), the pool saturates and downstream requests
          // time out → catch returns 500. Coalescing lets every waiter on
          // the same key share one computation; this is the most likely
          // explanation for the 1-of-3 sample returning 500 / 58 bytes.
          const inflight = recentLandingsInFlight.get(cacheKey)
          if (inflight) {
            const { body } = await inflight
            res.setHeader('X-Cache', 'COALESCED')
            return res.end(body)
          }
          let resolveInflight, rejectInflight
          const inflightPromise = new Promise((resolve, reject) => {
            resolveInflight = resolve
            rejectInflight = reject
          })
          recentLandingsInFlight.set(cacheKey, inflightPromise)
          // Always clear the in-flight entry once we resolve/reject so a
          // failed run doesn't poison subsequent callers.
          settleInflight = (ok, value) => {
            recentLandingsInFlight.delete(cacheKey)
            if (ok) resolveInflight(value); else rejectInflight(value)
          }

          const today = new Date().toISOString().slice(0, 10)
          const range = await db.loadLiveFromDbByDateRange(today, today)
          const tracks = range.tracks || []

          // Complaints — same shared loader the boot endpoint uses, so the
          // kiosk's recent-impact map can glow per-band/segment without
          // having to cross-reference /api/complaints from the client.
          const fsMod = await import('./flightScore.js')
          const complaintsRaw = await loadComplaintsCached()

          // call → base/purpose/school/desc from the historical classification.
          //
          // Memoized at 60 s per tail (recentLandingsTailInfoCache, plugin
          // scope). On each request we query Postgres only for tails missing
          // from the cache; steady-state kiosk polling drives this query to
          // ~0 rows. Cold start pays the full GROUP BY scan once. Until the
          // matching migration's tracks(call) index lands in production, that
          // scan IS the dominant slow path — this cache makes it a one-time
          // cost per process.
          const allTails = [...new Set(tracks.map((t) => (t.call || '').trim()).filter(Boolean))]
          const info = new Map()
          const tailsToFetch = []
          const tailNowMs = Date.now()
          for (const tail of allTails) {
            const c = recentLandingsTailInfoCache.get(tail)
            if (c && tailNowMs - c.fetchedAt < RECENT_LANDINGS_TAIL_INFO_TTL_MS) {
              if (c.row) info.set(tail, c.row)
            } else {
              tailsToFetch.push(tail)
            }
          }
          if (tailsToFetch.length) {
            try {
              const r = await db.queryDb(
                `SELECT call,
                   (array_agg(base_airport ORDER BY date DESC) FILTER (WHERE base_airport IS NOT NULL))[1] AS base,
                   (array_agg(purpose      ORDER BY date DESC) FILTER (WHERE purpose      IS NOT NULL))[1] AS purpose,
                   (array_agg(school       ORDER BY date DESC) FILTER (WHERE school       IS NOT NULL))[1] AS school,
                   (array_agg(desc_text    ORDER BY date DESC) FILTER (WHERE desc_text    IS NOT NULL))[1] AS descr
                 FROM tracks WHERE call = ANY($1) GROUP BY call`, [tailsToFetch])
              const rowByCall = new Map()
              for (const row of r.rows) rowByCall.set(row.call, row)
              // Cache ALL fetched tails (including tails with no matching
              // row) so the next request doesn't re-query unknowns.
              for (const tail of tailsToFetch) {
                const row = rowByCall.get(tail) || null
                recentLandingsTailInfoCache.set(tail, { row, fetchedAt: tailNowMs })
                if (row) info.set(tail, row)
              }
            } catch {
              // On DB failure don't poison the cache. Unfetched tails stay
              // missing so the next request retries; existing cached
              // entries remain valid.
            }
          }

          const nowMs = Date.now()
          // Detect cycles the same way /missions does (extractTowCycles), so a
          // recent landing is found even when ADS-B drops out before touchdown
          // (common at small GA fields like KBDU — the old on-ground dwell
          // check returned 0 for those). Override field_elevation_ft so cycle
          // detection works for non-KBDU airports too.
          const baseZones = await adsb.loadZones()
          const zoneConfig = { ...baseZones, field_elevation_ft: ap.elev }
          const minutesMs = minutes * 60000
          const LANDING_NEAR_NM = 4 // last fix can be a few nm out when ADS-B drops near ground
          const TNG_GAP_MS = 5 * 60000 // consecutive cycles closer than this = touch-and-go, same flight
          const SESSION_GAP_MS = 30 * 60000 // a gap > 30 min in the track ends a "session" (next fix starts a new flight)
          const MIN_AIRBORNE_MIN = 3 // anything shorter is sensor noise (spurious blip), not a real flight
          const out = []
          for (const t of tracks) {
            // Skip ADSBExchange anonymized tails (~hex) — these are PIA/TIS-B
            // relays that often shadow real aircraft and produce phantom cycles.
            if ((t.call || '').trim().startsWith('~')) continue
            const pts = (t.points || []).slice().sort((a, b) => (a[3] || 0) - (b[3] || 0))
            if (pts.length < 5) continue
            // 1. Extract cycles, keeping only those whose final fix is at THIS
            //    airport (extractTowCycles with KBDU's threshold also detects
            //    cycles at neighboring fields like KEIK/KLMO — filter those out
            //    by landing location, not just time).
            const LANDING_CONFIRM_MS = 30 * 1000 // need ≥30 s of on-ground fixes after landing_ts to call it "landed"
            const groundCeil = ap.elev + 200     // a fix at/below this is "on the ground" near the field
            const atAirport = []
            for (const f of adsb.extractTowCycles(t.hex, t.call, pts, zoneConfig)) {
              if (!f.takeoff_ts || !f.landing_ts) continue
              let tMs = Date.parse(f.takeoff_ts), lMs = Date.parse(f.landing_ts)
              if (!Number.isFinite(tMs) || !Number.isFinite(lMs)) continue
              if ((nowMs - lMs) > minutesMs) continue
              // Endpoint of this cycle (last fix at or before landing_ts).
              let endPt = null
              for (const p of pts) { if (p[3] != null && p[3] <= lMs) endPt = p; else if (p[3] > lMs) break }
              if (!endPt) continue
              if (distNmAp(endPt[0], endPt[1], ap.lat, ap.lon) > LANDING_NEAR_NM) continue
              // Reject "phantom landings": the phase detector treats a single
              // below-threshold fix on short final as on_ground (e.g. N75FF at
              // 5325 ft / 83 kts / -758 fpm gave a 0-second on_ground phase
              // and was reported as landed while still flying). Require either
              // ≥LANDING_CONFIRM_MS of fixes at/below the field ground ceiling
              // OR ≥2 such fixes spanning some duration. If neither holds, the
              // aircraft is still on short final — skip until next poll.
              const groundFixes = pts.filter(p => p[3] != null && p[3] >= lMs - 5000 && p[2] != null && p[2] <= groundCeil)
              const groundSpan = groundFixes.length >= 2 ? (groundFixes[groundFixes.length - 1][3] - groundFixes[0][3]) : 0
              if (groundSpan < LANDING_CONFIRM_MS) continue
              // Trim cycle to its last contiguous session — phase detection
              // can't see a landing across an ADS-B blackout, so a morning
              // flight + 14-hour gap + evening flight reads as one ~15-hour
              // "cycle". Walk the cycle's points; if any consecutive pair is
              // more than SESSION_GAP_MS apart, the real takeoff is after the
              // last such gap.
              const inCy = pts.filter(p => p[3] != null && p[3] >= tMs && p[3] <= lMs)
              for (let i = inCy.length - 1; i > 0; i--) {
                if ((inCy[i][3] - inCy[i - 1][3]) > SESSION_GAP_MS) { tMs = inCy[i][3]; break }
              }
              atAirport.push({ takeoff_ts: new Date(tMs).toISOString(), landing_ts: f.landing_ts, tMs, lMs })
            }
            // 2. Sort by takeoff and merge T&Gs at THIS field: consecutive cycles
            //    whose ground gap is < TNG_GAP_MS collapse into one flight. (A
            //    busy tow session collapsing into one row is expected — pilots
            //    don't shut down between tows.)
            atAirport.sort((a, b) => a.tMs - b.tMs)
            const merged = []
            for (const f of atAirport) {
              const prev = merged[merged.length - 1]
              if (prev && (f.tMs - prev.lMs) < TNG_GAP_MS) { prev.landing_ts = f.landing_ts; prev.lMs = f.lMs }
              else merged.push({ ...f })
            }
            // 3. Fallback for sparse tracks: extractTowCycles needs enough points
            //    to detect phases — sparse day-tracks (just a few fixes) yield 0
            //    cycles even when the aircraft clearly ended at the airport.
            //    Walk backward from the last fix to find the START of the
            //    most-recent contiguous session (gap > SESSION_GAP_MS ends it).
            //    Using first-airborne-of-day produced impossible 15-hour
            //    "flights" for aircraft that flew morning AND afternoon with
            //    a tracking blackout between.
            if (merged.length === 0) {
              const last = pts[pts.length - 1]
              const tdAlt = ap.elev + 1500
              // Same phantom-landing guard as the main path: require ≥30 s of
              // tail fixes at/below the field ground ceiling, so an aircraft
              // on short final isn't reported as landed. (groundCeil declared
              // above near LANDING_CONFIRM_MS, reused here.)
              const tailFixes = last && last[3] != null
                ? pts.filter(p => p[3] != null && (last[3] - p[3]) <= 60_000 && p[2] != null && p[2] <= groundCeil)
                : []
              const tailSpan = tailFixes.length >= 2 ? (tailFixes[tailFixes.length - 1][3] - tailFixes[0][3]) : 0
              if (last && last[3] != null && (nowMs - last[3]) <= minutesMs
                  && last[2] != null && last[2] <= tdAlt
                  && distNmAp(last[0], last[1], ap.lat, ap.lon) <= LANDING_NEAR_NM
                  && tailSpan >= LANDING_CONFIRM_MS) {
                // Walk backward: find the start of the last contiguous session.
                let sessionStart = pts.length - 1
                for (let i = pts.length - 1; i > 0; i--) {
                  const gap = (pts[i][3] || 0) - (pts[i - 1][3] || 0)
                  if (gap > SESSION_GAP_MS) { sessionStart = i; break }
                  sessionStart = i - 1
                }
                // Within that session, find the first airborne fix (the takeoff).
                let firstAir = null
                for (let i = sessionStart; i < pts.length; i++) {
                  const p = pts[i]
                  if (p[2] != null && p[2] > groundCeil) { firstAir = p; break }
                }
                const tMs = (firstAir?.[3]) || pts[sessionStart][3] || last[3]
                const lMs = last[3]
                merged.push({ takeoff_ts: new Date(tMs).toISOString(), landing_ts: new Date(lMs).toISOString(), tMs, lMs })
              }
            }
            for (const cy of merged) {
              const tMs = cy.tMs, lMs = cy.lMs
              // Drop sub-MIN_AIRBORNE_MIN "flights" — these come from sensor
              // blips and corrupt the impact ranking with grade=F entries that
              // never really flew.
              if ((lMs - tMs) < MIN_AIRBORNE_MIN * 60000) continue
              const cyclePts = pts.filter(p => p[3] >= tMs && p[3] <= lMs)
              if (cyclePts.length < 3) continue

              const p0 = cyclePts[0]
              const o = nearestAp(p0[0], p0[1])
              const tail = (t.call || '').trim()
              const inf = info.get(tail) || {}
              const purpose = resolvePurpose(inf.purpose, t.type, tail)
              const { total, lenFt } = impactSegments(cyclePts, POPGRID.popAt, distFt)
              const impact_index = lenFt > 0 ? (total / lenFt) / POP_SCALE : 0
              // impact_score is now an alias of impact_index — no purpose
              // multiplier here. Behaviour over people is a physical measurement;
              // purpose-aware weighting (training ×2, slide cadence, etc.) is a
              // caller concern (badges, sort order, slide rotation).
              const impact_score = Math.round(impact_index * 1000) / 1000
              const bands = bandsFromPoints(cyclePts, POPGRID.popAt, t.type)
              // Per-landing complaints — tail+cycle-window match. Then
              // attach to bands with the same tight 60-s pad the boot
              // endpoint uses, so the recent-impact map can paint
              // per-segment glow without a client-side cross-reference.
              const landingComplaints = fsMod.matchComplaintsForKiosk(complaintsRaw, tail, tMs, lMs)
              fsMod.attachComplaintsToBands(bands, landingComplaints, { pad: 60 * 1000 })
              // Departure detection — find the first POST-landing fix that's
              // both airborne (alt > field+200 ft) AND > 0.5 nm from the
              // field. A brief taxi-back or hold-short ADS-B blip stays
              // close to the runway so the 0.5 nm guard rejects it. The
              // first such fix is when the aircraft really left — that's
              // `departed_at`. If we never see one, the aircraft is either
              // still on the ground or has dropped out of ADS-B coverage.
              const DEPART_MIN_NM = 0.5
              const COVERAGE_FRESH_MS = 5 * 60_000 // last fix within 5 min → coverage is live
              let departedMs = null
              for (const p of pts) {
                if (p[3] == null || p[3] <= lMs) continue
                if (p[2] == null || p[2] <= groundCeil) continue
                if (distNmAp(p[0], p[1], ap.lat, ap.lon) < DEPART_MIN_NM) continue
                departedMs = p[3]
                break
              }
              // "still_on_ground" only when we have RECENT coverage of the
              // tail; otherwise we can't tell if the aircraft is on the
              // ground or just out of ADS-B reach. (last point in the full
              // track within COVERAGE_FRESH_MS of now → coverage is live.)
              const lastFix = pts[pts.length - 1]
              const coverageFresh = lastFix && lastFix[3] != null && (nowMs - lastFix[3]) <= COVERAGE_FRESH_MS
              const stillOnGround = departedMs == null && coverageFresh
              // on_ground_min — actual dwell (departed - landed), OR
              // wall-clock since landing when truly on the ground, OR
              // null when we have no idea (coverage gap, no departure seen).
              let onGroundMin = null
              if (departedMs != null) {
                onGroundMin = Math.round(Math.max(0, (departedMs - lMs) / 60000) * 10) / 10
              } else if (stillOnGround) {
                onGroundMin = Math.round(Math.max(0, (nowMs - lMs) / 60000) * 10) / 10
              }
              // The user-visible "landed full stop" decision: we still emit
              // the cycle (the kiosk wants to see overflights / brief
              // touches in the impact list), but mark it honestly. An
              // aircraft that departed in < 60 s is a transit touch, not a
              // landed-full-stop. The boot endpoint's phase classifier
              // independently classifies these as 'overflight'.
              const fullStop = onGroundMin == null ? null : onGroundMin >= 1.0
              out.push({
                tail, type: t.type || null, desc: inf.descr || expandType(t.type),
                icon_url: aircraftIconUrl(t.type, tail),
                base: inf.base || null, purpose, school: inf.school || null,
                origin: o.dist <= 3 ? o.code : null, dest: airport,
                origin_dist_nm: Math.round(distNmAp(p0[0], p0[1], ap.lat, ap.lon) * 10) / 10,
                landed: true,
                landed_at: new Date(lMs).toISOString(),
                departed_at: departedMs != null ? new Date(departedMs).toISOString() : null,
                still_on_ground: !!stillOnGround,
                on_ground_min: onGroundMin,
                full_stop: fullStop,
                airborne_min: Math.round(Math.max(0, (lMs - tMs) / 60000) * 10) / 10,
                impact_index: Math.round(impact_index * 1000) / 1000,
                impact_score, impact_grade: impactGrade(impact_score),
                pop_impact: Math.round(total),
                bands,
                complaints: landingComplaints,
              })
            }
          }
          out.sort((a, b) => (b.landed_at || '').localeCompare(a.landed_at || ''))
          // Top-level complaint feed — every complaint within `minutes`,
          // independent of which landing it matches. Kiosk filters to
          // lat/lon-populated entries for map pins (mirrors the boot
          // endpoint's shape so a single client renderer handles both).
          const complaintsForWindow = fsMod.recentComplaintsForKiosk(complaintsRaw, minutes)
          const responseBody = JSON.stringify({
            generated_at: new Date(nowMs).toISOString(),
            airport, minutes, pop_scale: POP_SCALE,
            scoring: {
              impact_index: 'population-noise per ft / POP_SCALE (same kernel as leaderboard & impact-explain)',
              impact_score: 'alias of impact_index (no purpose multiplier — purpose-aware ranking is a caller concern)',
              impact_grade: 'A<0.3 B<0.6 C<1.2 D<2.0 F',
            },
            departure_tracking: {
              departed_at: 'ISO ts of the first post-landing fix that is airborne AND > 0.5 nm from the field. null when no departure detected.',
              still_on_ground: 'true iff departed_at is null AND last fix on this tail is within 5 min of now (coverage live).',
              on_ground_min: 'Actual ground dwell. (departed_at - landed_at) when departed; (now - landed_at) when still_on_ground; null when coverage gapped.',
              full_stop: 'true when on_ground_min >= 1.0 min. false = transit touch / overflight. null when undetermined.',
            },
            count: out.length,
            landings: out,
            complaints: {
              window_minutes: minutes,
              count: complaintsForWindow.length,
              geocoded_count: complaintsForWindow.filter(c => c.lat != null && c.lon != null).length,
              items: complaintsForWindow,
            },
          })
          // Persist into the response cache and unblock any coalesced
          // waiters BEFORE writing to res, so a slow socket flush doesn't
          // hold subsequent callers on the same key.
          recentLandingsResponseCache.set(cacheKey, { body: responseBody, fetchedAt: Date.now() })
          if (settleInflight) settleInflight(true, { body: responseBody })
          res.setHeader('X-Cache', 'MISS')
          res.end(responseBody)
        } catch (e) {
          console.error('[noise-api] /recent-landings error', e)
          // Release any coalesced callers with the error so they don't
          // hang. Failures are NOT cached — the next request retries.
          try { if (settleInflight) settleInflight(false, e) } catch {}
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(e) }))
        }
      })

      // GET /api/noise/missions[?days=N]
      // Completed flights from live capture, categorized by purpose.
      //
      // A "flight" is a takeoff→landing cycle (a track with both a takeoff
      // and a landing). Touch-and-goes and taxi-backs do NOT count as
      // separate flights: consecutive cycles whose on-ground gap is shorter
      // than MISSION_GROUND_GAP_MIN are merged into one flight. Purpose is
      // looked up per tail from the historical `tracks` classification.
      //
      // `days` (default 1 = today) widens the window to the last N UTC days.
      // Each day has one current row in live_tracks; points for the same
      // aircraft are concatenated across days before cycle extraction so a
      // flight that crosses midnight is not double-counted.
      const MISSION_GROUND_GAP_MIN = 10
      server.middlewares.use('/api/noise/missions', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const daysRaw = parseInt(u.searchParams.get('days') || '1', 10)
          const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 1825) : 1
          // Scope: ?airport / ?operatedAt → "operated" (origin|dest|base == airport,
          // i.e. the field's own activity incl. visitors). ?homeBase / ?base →
          // "based" (home-field only). none → "all" (whole corridor).
          const opRaw = (u.searchParams.get('airport') || u.searchParams.get('operatedAt') || '').trim().toUpperCase()
          const baseRaw = (u.searchParams.get('homeBase') || u.searchParams.get('base') || '').trim().toUpperCase()
          const scopeAirport = opRaw || baseRaw || null
          const scope = opRaw ? 'operated' : baseRaw ? 'based' : 'all'
          // Source: 'combined' (default) merges live_tracks (recent, real flight
          // cycles) with the historic `tracks` table (older, surfaces rare
          // categories like firefighting/science that live's 38-day window misses).
          // 'live' = live_tracks only (old default). 'historic' = tracks only.
          const sourceParam = (u.searchParams.get('source') || 'combined').toLowerCase()
          const wantLive = sourceParam !== 'historic'
          const wantHist = sourceParam !== 'live'

          const fmtDay = (d) => d.toISOString().slice(0, 10)
          const today = new Date()
          const toDate = fmtDay(today)
          const fromD = new Date(today)
          fromD.setUTCDate(fromD.getUTCDate() - (days - 1))
          const fromDate = fmtDay(fromD)

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Cache-Control', 'public, max-age=300')

          // 5-min result cache — cycle extraction over the window is heavy.
          const ckey = `${days}|${scope}|${scopeAirport || ''}|${sourceParam}`
          const cc = missionsCache.get(ckey)
          if (cc && Date.now() - cc.ts < 300000) return res.end(cc.body)

          const respond = (obj) => { const b = JSON.stringify(obj); missionsCache.set(ckey, { ts: Date.now(), body: b }); res.end(b) }

          // ── LIVE: gather tracks + build byHex (cycle-based flight counts later)
          let range = null
          const byHex = new Map()
          if (wantLive) {
            range = await db.loadLiveFromDbByDateRange(fromDate, toDate)
            for (const t of (range.tracks || [])) {
              const hex = t.hex || t.call
              if (!hex || !Array.isArray(t.points) || !t.points.length) continue
              if (!byHex.has(hex)) byHex.set(hex, { hex, call: t.call || hex, reg: t.reg || '', type: t.type || '', points: [] })
              const g = byHex.get(hex)
              for (const p of t.points) g.points.push(p)
            }
          }

          // ── HISTORIC: aggregate per-tail flight counts from the tracks table
          //    (surfaces rare categories — firefighting, science, search_rescue —
          //    that the ~38-day live store misses). Scope on historic is base-only
          //    (no per-flight geometry in the aggregate), so an "operated" scope
          //    falls back to base_airport=airport for the historic slice.
          let histRows = []
          if (wantHist) {
            const where = ['date >= $1', 'date <= $2', 'seg_total > 0']
            const params = [fromDate, toDate]
            if (scope !== 'all') {
              params.push(scopeAirport)
              where.push(`base_airport = $${params.length}`)
            }
            const r = await db.queryDb(
              `SELECT call, MAX(type) AS type, MAX(school) AS school, MAX(base_airport) AS base,
                 MAX(purpose) AS purpose, count(*)::int AS flights
               FROM tracks WHERE ${where.join(' AND ')}
               GROUP BY call`, params)
            histRows = r.rows || []
          }

          // ── One info lookup for LIVE tails (historic rows carry their own
          //    classification columns — use them directly).
          const info = new Map()
          const liveCalls = [...new Set([...byHex.values()].map((g) => g.call).filter(Boolean))]
          if (liveCalls.length) {
            const r = await db.queryDb(
              `SELECT call,
                 (array_agg(base_airport ORDER BY date DESC) FILTER (WHERE base_airport IS NOT NULL))[1] AS base,
                 (array_agg(purpose      ORDER BY date DESC) FILTER (WHERE purpose      IS NOT NULL))[1] AS purpose,
                 (array_agg(school       ORDER BY date DESC) FILTER (WHERE school       IS NOT NULL))[1] AS school
               FROM tracks WHERE call = ANY($1) GROUP BY call`, [liveCalls])
            for (const row of r.rows) info.set(row.call, row)
          }

          // ── LIVE: scope filter + cycle extraction → per-aircraft flight count
          const perTail = new Map() // tail -> { tail, type, school, base, storedPurpose, live, hist }
          let liveTotal = 0
          if (wantLive && byHex.size) {
            const zoneConfig = await adsb.loadZones()
            const gapMs = MISSION_GROUND_GAP_MIN * 60_000
            const candidates = []
            for (const g of byHex.values()) {
              g.points.sort((a, b) => (a[3] || 0) - (b[3] || 0))
              const base = info.get(g.call)?.base || null
              if (scope === 'all') { candidates.push(g); continue }
              if (scope === 'based') { if (base === scopeAirport) candidates.push(g); continue }
              const first = g.points[0], last = g.points[g.points.length - 1]
              const o = nearestAp(first[0], first[1]), d = nearestAp(last[0], last[1])
              const originCode = o.dist <= 3 ? o.code : null
              const destCode = d.dist <= 3 ? d.code : null
              if (originCode === scopeAirport || destCode === scopeAirport || base === scopeAirport) candidates.push(g)
            }
            for (const g of candidates) {
              const cycles = adsb.extractTowCycles(g.hex, g.call, g.points, zoneConfig)
                .filter(f => f.takeoff_ts && f.landing_ts)
                .sort((a, b) => new Date(a.takeoff_ts) - new Date(b.takeoff_ts))
              const merged = []
              for (const f of cycles) {
                const prev = merged[merged.length - 1]
                if (prev && (new Date(f.takeoff_ts) - new Date(prev.landing_ts)) < gapMs) prev.landing_ts = f.landing_ts
                else merged.push({ takeoff_ts: f.takeoff_ts, landing_ts: f.landing_ts })
              }
              if (!merged.length) continue
              const inf = info.get(g.call) || {}
              const tail = g.call || g.reg || g.hex
              const p = perTail.get(tail) || { tail, type: g.type || inf.type || '', school: inf.school || null, base: inf.base || null, storedPurpose: inf.purpose || null, live: 0, hist: 0 }
              p.live += merged.length
              liveTotal += merged.length
              perTail.set(tail, p)
            }
          }

          // ── HISTORIC: merge per-tail counts into perTail
          let histTotal = 0
          for (const row of histRows) {
            const tail = row.call
            if (!tail) continue
            let p = perTail.get(tail)
            if (!p) {
              p = { tail, type: row.type || '', school: row.school || null, base: row.base || null, storedPurpose: row.purpose || null, live: 0, hist: 0 }
              perTail.set(tail, p)
            } else {
              if (!p.type && row.type) p.type = row.type
              if (!p.school && row.school) p.school = row.school
              if (!p.base && row.base) p.base = row.base
              if (!p.storedPurpose && row.purpose) p.storedPurpose = row.purpose
            }
            p.hist += row.flights
            histTotal += row.flights
          }

          // ── CATEGORIZE by purpose; each aircraft shows live + hist breakdown
          const categories = {}
          for (const p of perTail.values()) {
            const purpose = resolvePurpose(p.storedPurpose, p.type, p.tail)
            if (!categories[purpose]) categories[purpose] = { count: 0, aircraft: [] }
            const flights = p.live + p.hist
            categories[purpose].count += flights
            categories[purpose].aircraft.push({
              tail: p.tail, type: p.type, school: p.school, base: p.base,
              flights, live: p.live, hist: p.hist,
            })
          }
          const sorted = Object.entries(categories).filter(([, v]) => v.count > 0).sort((a, b) => b[1].count - a[1].count)
          const result = {}
          for (const [k, v] of sorted) { v.aircraft.sort((a, b) => b.flights - a.flights); result[k] = v }

          // ── Editorial rollup for the kiosk: five buckets, overlapping on
          // purpose (school-tow gliders count in BOTH training and glider).
          //   training = direct school flights + 2× school-tow (the gliders
          //              schools tow up are training events too).
          //   glider   = 2× ALL tow_plane (each tow ≈ one glider release, but
          //              ADS-B-equipped tow planes are visible while many
          //              pure gliders aren't — the ×2 corrects the gap) +
          //              observed pure-glider flights.
          //   med_fire_rescue = medevac + firefighting + search_rescue +
          //                     helicopter_ops (based med helo + CAP SAR fold in).
          //   research = science + patrol (CAP).
          //   other    = everything else (ga_single, ga_twin, biz_jet,
          //              helicopter, turboprop, experimental, unknown, …).
          // The five sums do NOT equal `total` — they're an overlapping VIEW.
          const cnt = (k) => result[k]?.count || 0
          const towAcft = result.tow_plane?.aircraft || []
          const schoolTow = towAcft.filter(a => a.school).reduce((s, a) => s + a.flights, 0)
          const ROLLUP_OWNED = new Set(['training', 'tow_plane', 'glider', 'medevac', 'medivac', 'medivac_possible', 'firefighting', 'search_rescue', 'helicopter_ops', 'science', 'patrol'])
          const otherCount = Object.entries(result).reduce((s, [k, v]) => s + (ROLLUP_OWNED.has(k) ? 0 : v.count), 0)
          const rollup = {
            training: { count: cnt('training') + 2 * schoolTow,
              includes: `direct school flights (${cnt('training')}) + 2× school-tow (${schoolTow}) — gliders trained at schools` },
            glider: { count: 2 * cnt('tow_plane') + cnt('glider'),
              includes: `2× tow_plane (${cnt('tow_plane')}) + observed pure-glider (${cnt('glider')}) — ×2 corrects for non-ADS-B gliders` },
            med_fire_rescue: { count: cnt('medevac') + cnt('medivac') + cnt('medivac_possible') + cnt('firefighting') + cnt('search_rescue') + cnt('helicopter_ops') + cnt('patrol'),
              includes: `medevac (${cnt('medevac')}) + firefighting (${cnt('firefighting')}) + search_rescue (${cnt('search_rescue')}) + helicopter_ops (${cnt('helicopter_ops')}) + patrol/CAP (${cnt('patrol')})` },
            research: { count: cnt('science'),
              includes: `science (${cnt('science')}) — NEON / Scientific Aviation` },
            other: { count: otherCount,
              includes: 'ga_single + ga_twin + biz_jet + helicopter + turboprop + experimental + unknown + everything not in the four above' },
            note: 'Overlapping editorial view (school-tow gliders count in BOTH training and glider). Sum ≠ total.',
          }

          respond({
            date: toDate, days, from: fromDate, to: toDate,
            airport: scopeAirport, scope, source: sourceParam,
            updated_at: range?.updated_at || new Date().toISOString(),
            days_loaded: range?.days_loaded ?? null,
            sources: {
              live: { flights: liveTotal, days_loaded: range?.days_loaded ?? null, note: 'cycle-based, operated/based/all scope via geometry' },
              historic: { flights: histTotal, from: fromDate, to: toDate, note: 'tracks-table per-row; non-all scope filters by base_airport only' },
            },
            total: liveTotal + histTotal, categories: result, rollup,
          })
        } catch (e) {
          console.error('[noise-api] /missions error', e)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(e) }))
        }
      })

      // Shared: parse URL filter params into SQL WHERE + params array.
      // Supports year, base (comma-multi), school, purpose, tod_start/tod_end.
      function buildFilters(u, baseConds = ['seg_total > 0']) {
        const conds = [...baseConds]
        const params = []
        const year = u.searchParams.get('year') || null
        const base = u.searchParams.get('base') || null
        const school = u.searchParams.get('school') || null
        const purpose = u.searchParams.get('purpose') || null
        const todStart = u.searchParams.get('tod_start')
        const todEnd = u.searchParams.get('tod_end')
        if (year) { params.push(year); conds.push(`year = $${params.length}`) }
        if (base) {
          const bases = base.split(',').map(b => b.trim()).filter(Boolean)
          if (bases.length === 1) { params.push(bases[0]); conds.push(`base_airport = $${params.length}`) }
          else { params.push(bases); conds.push(`base_airport = ANY($${params.length})`) }
        }
        if (school) { params.push(school); conds.push(`school = $${params.length}`) }
        if (purpose) { params.push(purpose); conds.push(`purpose = $${params.length}`) }
        if (todStart != null && todEnd != null) {
          const s = parseInt(todStart), e = parseInt(todEnd)
          if (s <= e) {
            params.push(s, e); conds.push(`start_hour >= $${params.length - 1} AND start_hour < $${params.length}`)
          } else {
            params.push(s, e); conds.push(`(start_hour >= $${params.length - 1} OR start_hour < $${params.length})`)
          }
        }
        return { where: conds.join(' AND '), params }
      }

      // GET /api/noise/stats?year=X&base=X&school=X&tod_start=8&tod_end=17
      server.middlewares.use('/api/noise/stats', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const { where, params } = buildFilters(u)

          // Per-tail rankings
          const tailSql = `
            SELECT call AS tail, type, desc_text AS desc, school, base_airport AS base, purpose,
                   SUM(seg_total)::int AS total, SUM(seg_red)::int AS red,
                   SUM(seg_orange)::int AS orange, SUM(seg_yellow)::int AS yellow,
                   SUM(seg_purple)::int AS purple,
                   SUM(len_total_ft)::real AS total_ft, SUM(len_red_ft)::real AS red_ft,
                   SUM(len_orange_ft)::real AS orange_ft, SUM(len_yellow_ft)::real AS yellow_ft,
                   SUM(len_purple_ft)::real AS purple_ft,
                   MAX(CASE worst_class WHEN 'purple' THEN 4 WHEN 'red' THEN 3 WHEN 'orange' THEN 2 WHEN 'yellow' THEN 1 ELSE 0 END) AS worst_rank,
                   COUNT(*)::int AS track_count
            FROM tracks
            WHERE ${where}
            GROUP BY call, type, desc_text, school, base_airport, purpose
            HAVING SUM(seg_total) > 0
            ORDER BY SUM(seg_red)::float / NULLIF(SUM(seg_total), 0) DESC
            LIMIT 200
          `
          const tailRes = await db.queryDb(tailSql, params)
          const worstMap = { 4: 'purple', 3: 'red', 2: 'orange', 1: 'yellow' }
          const perTail = tailRes.rows.map(r => ({
            ...r, worst: worstMap[r.worst_rank] || null,
          }))

          // Cube: year × base × origin → { total, red }
          const cubeSql = `
            SELECT year, base_airport AS base, origin,
                   SUM(seg_total)::int AS total, SUM(seg_red)::int AS red
            FROM tracks WHERE seg_total > 0
            GROUP BY year, base_airport, origin
          `
          const cubeRes = await db.queryDb(cubeSql)
          const cube = {}
          for (const r of cubeRes.rows) {
            if (!cube[r.year]) cube[r.year] = {}
            if (!cube[r.year][r.base]) cube[r.year][r.base] = {}
            cube[r.year][r.base][r.origin] = { total: r.total, red: r.red }
          }

          // Per-date excursion stats (for the bar chart)
          // Uses % of total flight length in each zone, aggregated per date
          const byDateSql = `
            SELECT date,
                   count(*)::int AS flights,
                   SUM(len_total_ft)::real AS total_ft,
                   SUM(len_yellow_ft)::real AS yellow_ft,
                   SUM(len_orange_ft)::real AS orange_ft,
                   SUM(len_red_ft)::real AS red_ft,
                   SUM(len_purple_ft)::real AS purple_ft
            FROM tracks
            WHERE ${where} AND date IS NOT NULL
            GROUP BY date ORDER BY date
          `
          const byDateRes = await db.queryDb(byDateSql, params)
          const byDate = byDateRes.rows.map(r => ({
            date: r.date,
            flights: r.flights,
            totalFt: r.total_ft,
            yellowFt: r.yellow_ft,
            orangeFt: r.orange_ft,
            redFt: r.red_ft,
            purpleFt: r.purple_ft,
            yellowPct: r.total_ft > 0 ? r.yellow_ft / r.total_ft * 100 : 0,
            orangePct: r.total_ft > 0 ? r.orange_ft / r.total_ft * 100 : 0,
            redPct: r.total_ft > 0 ? r.red_ft / r.total_ft * 100 : 0,
            purplePct: r.total_ft > 0 ? r.purple_ft / r.total_ft * 100 : 0,
          }))

          // Available filters
          const yearsRes = await db.queryDb('SELECT DISTINCT year FROM tracks WHERE year IS NOT NULL ORDER BY year')
          const basesRes = await db.queryDb('SELECT DISTINCT base_airport FROM tracks WHERE base_airport IS NOT NULL ORDER BY base_airport')
          const schoolsRes = await db.queryDb('SELECT DISTINCT school FROM tracks WHERE school IS NOT NULL ORDER BY school')
          const purposesRes = await db.queryDb('SELECT DISTINCT purpose FROM tracks WHERE purpose IS NOT NULL ORDER BY purpose')

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({
            perTail,
            cube,
            byDate,
            years: yearsRes.rows.map(r => r.year),
            bases: basesRes.rows.map(r => r.base_airport),
            schools: schoolsRes.rows.map(r => r.school),
            purposes: purposesRes.rows.map(r => r.purpose),
          }))
        } catch (e) {
          console.error('[noise-api] /stats error', e)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e) }))
        }
      })

      // GET /api/noise/tracks?year=X&base=X&school=X&violations_only=1&tng_only=1&limit=500&offset=0
      // Returns pre-banded tracks for map rendering. Each track includes
      // bands (colored polyline segments) — the client just renders them.
      // Payload: ~200-500KB for 500 tracks vs 60MB for all.
      server.middlewares.use('/api/noise/tracks', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const violationsOnly = u.searchParams.get('violations_only') === '1'
          const tngOnly = u.searchParams.get('tng_only') === '1'
          const limit = Math.min(2000, Math.max(1, parseInt(u.searchParams.get('limit') || '500')))
          const offset = Math.max(0, parseInt(u.searchParams.get('offset') || '0'))

          const { where: baseWhere, params } = buildFilters(u, ['bands IS NOT NULL'])
          const extraConds = []
          if (tngOnly) extraConds.push('seg_purple > 0')
          else if (violationsOnly) extraConds.push('worst_class IS NOT NULL')
          const where = extraConds.length ? `${baseWhere} AND ${extraConds.join(' AND ')}` : baseWhere

          // Count total matching
          const countRes = await db.queryDb(`SELECT count(*)::int AS n FROM tracks WHERE ${where}`, params)
          const total = countRes.rows[0].n

          // Prioritize purple (rare) and red tracks, then fill with random.
          // This ensures quiet-hour T&G violations always appear on the map.
          const pIdx = params.length
          params.push(limit, offset)
          const sql = `
            SELECT call, type, desc_text AS desc, own_op AS "ownOp", src,
                   year, date, base_airport AS base, worst_class AS worst,
                   seg_total, seg_red, seg_orange, seg_yellow,
                   len_total_ft, len_red_ft, len_orange_ft, len_yellow_ft,
                   school, purpose, bands
            FROM tracks
            WHERE ${where}
            ORDER BY
              ${violationsOnly ? `CASE WHEN seg_purple > 0 THEN 0
                   WHEN worst_class = 'red' THEN 1
                   WHEN worst_class = 'orange' THEN 2
                   ELSE 3 END,` : ''}
              rand_key
            LIMIT $${pIdx + 1} OFFSET $${pIdx + 2}
          `
          const r = await db.queryDb(sql, params)

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({
            tracks: r.rows,
            total,
            limit,
            offset,
            pages: Math.ceil(total / limit),
          }))
        } catch (e) {
          console.error('[noise-api] /tracks error', e)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e), tracks: [] }))
        }
      })
    },
  }
}

function externalDataPlugin() {
  const DATA_DIR = 'C:\\tmp\\noise_data'
  return {
    name: 'external-data',
    configureServer(server) {
      let fsModule = null
      server.middlewares.use(async (req, res, next) => {
        const m = req.url.match(/^\/(tracks_\d{4}\.json)$/)
        if (!m) return next()
        if (!fsModule) fsModule = (await import('fs')).default
        const filePath = DATA_DIR + '\\' + m[1]
        try {
          const stat = fsModule.statSync(filePath)
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Content-Length', stat.size)
          fsModule.createReadStream(filePath).pipe(res)
        } catch (e) {
          res.statusCode = 404
          res.end('{"tracks":[]}')
        }
      })
    },
  }
}

// GET /api/live/positions — lightweight current positions for all live aircraft.
// Returns just the last point per track with computed heading. 5s cache via loadLive.
function livePositionsPlugin() {
  const loadLive = async (fs, path) => {
    if (db.useDb) return db.loadLiveFromDb()
    try {
      const buf = await fs.readFile(path.resolve('public/tracks_live.json'), 'utf8')
      return JSON.parse(buf)
    } catch { return { tracks: [], updated_at: null } }
  }
  const bearing = (lat1, lon1, lat2, lon2) => {
    const toRad = (d) => d * Math.PI / 180
    const toDeg = (r) => r * 180 / Math.PI
    const dLon = toRad(lon2 - lon1)
    const y = Math.sin(dLon) * Math.cos(toRad(lat2))
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
              Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon)
    return (toDeg(Math.atan2(y, x)) + 360) % 360
  }
  return {
    name: 'live-positions',
    configureServer(server) {
      server.middlewares.use('/api/live/positions', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const live = await loadLive(fs, path)
          const positions = []
          for (const t of live.tracks || []) {
            if (!t.points?.length) continue
            const last = t.points[t.points.length - 1]
            let hdg = null
            if (t.points.length >= 2) {
              const prev = t.points[t.points.length - 2]
              hdg = Math.round(bearing(prev[0], prev[1], last[0], last[1]))
            }
            positions.push({
              tail: t.call || t.hex,
              hex: t.hex,
              type: t.type || '',
              lat: last[0],
              lon: last[1],
              alt: last[2] || null,
              track: hdg,
              updated: last[3] || null,
            })
          }
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ at: live.updated_at, count: positions.length, positions }))
        } catch (err) {
          console.error('[live-positions] error', err)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}

// ── ADS-B API ──────────────────────────────────────────────────────────
// Endpoints: /api/adsb/live, /api/adsb/track/:icao, /api/adsb/flights,
// /api/adsb/flights/:id/track, /api/adsb/stats, /api/adsb/active-tow,
// /api/adsb/config/fleet, /api/adsb/config/zones, WS /api/adsb/stream
function adsbApiPlugin() {
  // Cache extracted flights so we don't re-process on every request
  let flightsCache = { ts: 0, flights: [], byId: new Map() }
  const FLIGHTS_TTL = 10_000

  const loadLive = async () => {
    if (db.useDb) return db.loadLiveFromDb()
    const fs = await import('fs/promises')
    const path = await import('path')
    try {
      const buf = await fs.default.readFile(path.default.resolve('public/tracks_live.json'), 'utf8')
      return JSON.parse(buf)
    } catch { return { tracks: [], updated_at: null } }
  }

  // ── /api/adsb/current-flights memoization ─────────────────────────────
  // The kiosk team measured 72 s avg / 193 s p100 on this endpoint. The
  // dominant slow paths are:
  //
  //   1. loadLive() — full live-tracks JSON or db.loadLiveFromDb() read
  //      and JSONB deserialization of ~600 active tracks.
  //   2. Per-tail metadata SQL — a GROUP BY scan over the `tracks` table
  //      that runs every request, even though base_airport/school/desc
  //      change at most once per day.
  //   3. classifyOneTrack() per aircraft — the phaseML/intent pipeline
  //      executed for every track that passes the range filter.
  //
  // Mirroring the two-layer cache pattern from /api/flights/current
  // (flightsApiPlugin) handles all three for the warm-cache case:
  //
  //   CURRENT_FLIGHTS_TAIL_INFO_TTL_MS: per-tail (base, school, purpose,
  //   desc) row, 60 s TTL. Each request queries only tails missing from
  //   the cache. Steady-state kiosk polling hits zero rows.
  //
  //   CURRENT_FLIGHTS_RESPONSE_TTL_MS: full response JSON keyed on
  //   (airport, rangeNm, includeVisitors), 6 s TTL. The kiosk team's
  //   real-world polling cadence is ~5–8 s; 6 s ensures the second poll
  //   in any pair sees a warm cache, and multi-workstation polls share
  //   one computation. Picked under the 8 s response cache used by
  //   /api/flights/current to keep the phase data slightly fresher
  //   since current-flights surfaces in-progress maneuvers.
  //
  // Both caches are in-process Maps; Railway can run multiple containers
  // but per-container amortization is the meaningful win here. The
  // X-Cache header (HIT/MISS) is set on every response for observability.
  const CURRENT_FLIGHTS_TAIL_INFO_TTL_MS = 60_000
  const currentFlightsTailInfoCache = new Map()  // call -> { row, fetchedAt }
  const CURRENT_FLIGHTS_RESPONSE_TTL_MS = 6_000
  const currentFlightsResponseCache = new Map()  // key -> { body, fetchedAt }

  const buildFlights = async (zoneConfig, fleet, filterTail, filterFrom, filterTo) => {
    const now = Date.now()
    if (now - flightsCache.ts < FLIGHTS_TTL && !filterTail && !filterFrom) {
      return flightsCache
    }

    const live = await loadLive()
    const allFlights = []
    const byId = new Map()

    for (const t of live.tracks || []) {
      const hex = t.hex || ''
      const tail = t.call || hex
      const fleetEntry = fleet[hex]

      // Only process fleet aircraft, or filter by tail
      if (filterTail && tail !== filterTail && hex !== filterTail) continue
      if (!filterTail && !fleetEntry) continue

      if (!t.points?.length) continue
      const cycles = adsb.extractTowCycles(hex, tail, t.points, zoneConfig)
      for (const f of cycles) {
        if (fleetEntry) {
          f.operator = fleetEntry.operator
          f.role = fleetEntry.role
        }
        // Date filtering
        if (filterFrom && f.date && f.date < filterFrom) continue
        if (filterTo && f.date && f.date > filterTo) continue
        allFlights.push(f)
        byId.set(f.id, { flight: f, points: t.points })
      }
    }

    const cache = { ts: now, flights: allFlights, byId }
    if (!filterTail && !filterFrom) flightsCache = cache
    return cache
  }

  // WebSocket clients for /api/adsb/stream
  const wsClients = new Set()
  let wsBroadcastTimer = null

  return {
    name: 'adsb-api',
    async configureServer(server) {
      // ── GET /api/adsb/live ──────────────────────────────────────────
      server.middlewares.use('/api/adsb/live', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const icaoFilter = u.searchParams.get('icao')
          const filterSet = icaoFilter ? new Set(icaoFilter.split(',').map(s => s.trim().toLowerCase())) : null

          const fleet = await adsb.loadFleet()
          const live = await loadLive()
          const aircraft = []

          for (const t of live.tracks || []) {
            const hex = (t.hex || '').toLowerCase()
            if (filterSet && !filterSet.has(hex)) continue

            if (!t.points?.length) continue
            const last = t.points[t.points.length - 1]
            const fleetEntry = fleet[hex]

            // Compute groundspeed from last two points
            let gs = null, track_deg = null, vs = null
            if (t.points.length >= 2) {
              const prev = t.points[t.points.length - 2]
              const dtSec = ((last[3] || 0) - (prev[3] || 0)) / 1000
              if (dtSec > 0) {
                const cos = Math.cos(((prev[0] + last[0]) / 2) * Math.PI / 180)
                const dx = (last[1] - prev[1]) * 364560 * cos
                const dy = (last[0] - prev[0]) * 364560
                const dFt = Math.hypot(dx, dy)
                gs = Math.round((dFt / 6076.12) / (dtSec / 3600))
                track_deg = Math.round((Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360)
                if (prev[2] != null && last[2] != null) {
                  vs = Math.round((last[2] - prev[2]) / (dtSec / 60))
                }
              }
            }

            const lastSeenS = last[3] ? Math.round((Date.now() - last[3]) / 1000) : null

            aircraft.push({
              icao: hex,
              tail: fleetEntry?.tail || t.call || hex,
              lat: last[0],
              lon: last[1],
              alt_ft: last[2] || null,
              gs_kts: gs,
              track_deg,
              vs_fpm: vs,
              squawk: null, // not in our data yet
              last_seen_s: lastSeenS,
            })
          }

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ aircraft }))
        } catch (err) {
          console.error('[adsb/live] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // ── GET /api/adsb/current-flights?airport=KBDU&range_nm=10 ─────
      // Aircraft BASED at `airport` that are currently flying in the area.
      // "Based at" combines three signals (an aircraft qualifies if ANY
      // match): tracks-DB base_airport classification, flight-school
      // fleet registry (data/flight_schools_fleets.json — school's airport
      // field), and fleet.json (the local tow-plane registry). Pass
      // `?include=visitors` to drop the based-at filter entirely. "Flying"
      // = last fix above field+200 ft AGL within `range_nm` of the field.
      // For each, return how long they've been airborne (from the first
      // airborne fix in the current contiguous session — same session-gap
      // logic as /api/noise/recent-landings) and a placeholder `phase`
      // from the rule-based oracle. The phase field is a placeholder
      // pending the ML classifier in src/PHASE_ML_KICKOFF.md.
      server.middlewares.use('/api/adsb/current-flights', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const airport = (u.searchParams.get('airport') || 'KBDU').trim().toUpperCase()
          const rangeNm = Math.max(0.5, Math.min(50, Number(u.searchParams.get('range_nm')) || 10))
          const includeVisitors = (u.searchParams.get('include') || '').toLowerCase().includes('visitors')
          const ap = ENRICH_AP.find((a) => a.code === airport)
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Cache-Control', 'public, max-age=5')
          if (!ap) { res.statusCode = 400; return res.end(JSON.stringify({ error: `unknown airport ${airport}` })) }

          // Response cache — composite key over the query params that affect
          // output. The kiosk team measured 72 s avg on a cold call; with
          // CURRENT_FLIGHTS_RESPONSE_TTL_MS=6s, the second poll in any
          // ~5–8 s polling pair is a HIT and replies in sub-millisecond
          // time. Cached body is the final JSON string so we don't pay
          // re-serialization either. Errors are NOT cached.
          const cacheKey = `${airport}|${rangeNm}|${includeVisitors ? 1 : 0}`
          const cached = currentFlightsResponseCache.get(cacheKey)
          if (cached && Date.now() - cached.fetchedAt < CURRENT_FLIGHTS_RESPONSE_TTL_MS) {
            res.setHeader('X-Cache', 'HIT')
            return res.end(cached.body)
          }

          const live = await loadLive()
          const tracks = live.tracks || []
          const nowMs = Date.now()
          const SESSION_GAP_MS = 30 * 60000
          const STALE_MAX_S = 180 // skip aircraft whose last fix is > 3 min old
          const groundCeil = ap.elev + 200

          // Complaints (30 s memoized) for per-flight halo + top-level pins.
          // Same loader the /api/excursions/boot endpoint uses, so a kiosk
          // polling both surfaces shares one DB hit per window.
          const fsMod = await import('./flightScore.js')
          const complaintsRaw = await loadComplaintsCached()

          // Per-tail base lookup (same shape as other endpoints).
          //
          // Memoized at 60 s per tail (currentFlightsTailInfoCache, plugin
          // scope). On each request we query Postgres only for tails missing
          // from the cache; steady-state kiosk polling means the per-tail
          // SQL touches ~0 rows. base_airport / school / desc_text change at
          // most once per day, so a 60 s TTL is more than safe. Cold start
          // pays the full GROUP BY scan once. This is the dominant slow
          // path the kiosk team reported.
          const tails = [...new Set(tracks.map((t) => (t.call || '').trim()).filter(Boolean))]
          const info = new Map()
          const tailsToFetch = []
          const tailNowMs = Date.now()
          for (const tail of tails) {
            const c = currentFlightsTailInfoCache.get(tail)
            if (c && tailNowMs - c.fetchedAt < CURRENT_FLIGHTS_TAIL_INFO_TTL_MS) {
              if (c.row) info.set(tail, c.row)
            } else {
              tailsToFetch.push(tail)
            }
          }
          if (tailsToFetch.length) {
            try {
              const r = await db.queryDb(
                `SELECT call,
                   (array_agg(base_airport ORDER BY date DESC) FILTER (WHERE base_airport IS NOT NULL))[1] AS base,
                   (array_agg(purpose      ORDER BY date DESC) FILTER (WHERE purpose      IS NOT NULL))[1] AS purpose,
                   (array_agg(school       ORDER BY date DESC) FILTER (WHERE school       IS NOT NULL))[1] AS school,
                   (array_agg(desc_text    ORDER BY date DESC) FILTER (WHERE desc_text    IS NOT NULL))[1] AS descr
                 FROM tracks WHERE call = ANY($1) GROUP BY call`, [tailsToFetch])
              const rowByCall = new Map()
              for (const row of r.rows) rowByCall.set(row.call, row)
              // Cache ALL fetched tails (including tails with no matching
              // row) so the next request doesn't re-query unknowns.
              for (const tail of tailsToFetch) {
                const row = rowByCall.get(tail) || null
                currentFlightsTailInfoCache.set(tail, { row, fetchedAt: tailNowMs })
                if (row) info.set(tail, row)
              }
            } catch {
              // On DB failure don't poison the cache. Unfetched tails stay
              // missing so the next request retries; existing cached
              // entries remain valid.
            }
          }

          // Build tail→airport map from flight_schools_fleets.json. Many
          // school aircraft (e.g. N75FF / N53FF) don't have base_airport
          // set in the tracks DB but ARE listed in a school's aircraft[].
          // Cached per process; the file is static config.
          if (!global.__SCHOOL_TAIL_AIRPORT) {
            try {
              const { default: fs } = await import('fs/promises')
              const raw = await fs.readFile('public/flight_schools_fleets.json', 'utf8')
              const sf = JSON.parse(raw)
              const m = new Map()
              for (const s of sf.schools || []) {
                const sAp = (s.airport || '').split(/\s+/)[0].trim().toUpperCase() // "KBJC area" → "KBJC"
                if (!sAp) continue
                for (const ac of s.aircraft || []) {
                  const t = (ac.tail || '').trim().toUpperCase()
                  if (t && !m.has(t)) m.set(t, { airport: sAp, school: s.name || null })
                }
              }
              global.__SCHOOL_TAIL_AIRPORT = m
            } catch { global.__SCHOOL_TAIL_AIRPORT = new Map() }
          }
          const schoolMap = global.__SCHOOL_TAIL_AIRPORT
          const fleet = await adsb.loadFleet() // hex → { tail, operator, role } — currently only KBDU tow planes

          // Phase classifier — phaseML/oracle.js + maneuvers.js (the JS
          // port of noise/phase-ml/). Stateless, pure, sub-ms per track.
          // Returns { phase, current_maneuvers[], intent } per aircraft;
          // see noise/web/phaseML/README.md for the full contract. The
          // multi-airport intent posterior is computed against a prior
          // biased to the requested airport so kiosk-local context is
          // preserved (other airports still scored, just down-weighted).
          const PHASE_WINDOW_S = 180 // 3-min trailing slice for intent
          const RECENT_MANEUVER_S = 60 // surface maneuvers whose end is within this
          const priorByAirport = { [airport]: 2.0 } // soft kiosk bias

          const flights = []
          for (const t of tracks) {
            if ((t.call || '').startsWith('~')) continue
            const pts = t.points || []
            if (pts.length < 2) continue
            const last = pts[pts.length - 1]
            if (!last || last[3] == null) continue
            const ageS = (nowMs - last[3]) / 1000
            if (ageS > STALE_MAX_S) continue
            // Currently airborne — last fix above field ground ceiling.
            if (last[2] == null || last[2] <= groundCeil) continue
            // Within range of the airport.
            const dist = distNmAp(last[0], last[1], ap.lat, ap.lon)
            if (dist > rangeNm) continue
            const tail = (t.call || '').trim()
            const tailU = tail.toUpperCase()
            const inf = info.get(tail) || {}
            // Three-signal "based at" check (any one qualifies).
            const dbBase = (inf.base || '').toUpperCase() === airport
            const schoolEntry = schoolMap.get(tailU)
            const schoolBase = schoolEntry && schoolEntry.airport === airport
            const fleetEntry = fleet[(t.hex || '').toLowerCase()]
            const fleetBase = !!fleetEntry && airport === 'KBDU' // fleet.json is all KBDU operators today
            const isBased = dbBase || schoolBase || fleetBase
            if (!isBased && !includeVisitors) continue
            const basedReason = dbBase ? 'db_base'
              : schoolBase ? `school:${schoolEntry.school || 'unknown'}`
              : fleetBase ? `fleet:${fleetEntry.operator || 'unknown'}`
              : 'visitor'

            // flying_minutes = time since the start of the current contiguous
            // session's first airborne fix. Walk backward from `last` until
            // we cross either a > SESSION_GAP_MS gap or a below-ground fix.
            let takeoffMs = last[3]
            for (let i = pts.length - 1; i > 0; i--) {
              const cur = pts[i], prev = pts[i - 1]
              const gap = (cur[3] || 0) - (prev[3] || 0)
              if (gap > SESSION_GAP_MS) break
              // If the prior fix was below ground ceiling, the current
              // session began here (takeoff).
              if (prev[2] != null && prev[2] <= groundCeil) { takeoffMs = cur[3]; break }
              takeoffMs = prev[3] || takeoffMs
            }
            const flyingMin = Math.max(0, (nowMs - takeoffMs) / 60000)

            // Derive gs / track / vs from last two points (same math as /live).
            let gs = 0, trackDeg = 0, vs = 0
            const prev = pts[pts.length - 2]
            const dtSec = ((last[3] || 0) - (prev[3] || 0)) / 1000
            if (dtSec > 0) {
              const cos = Math.cos(((prev[0] + last[0]) / 2) * Math.PI / 180)
              const dx = (last[1] - prev[1]) * 364560 * cos
              const dy = (last[0] - prev[0]) * 364560
              const dFt = Math.hypot(dx, dy)
              gs = Math.round((dFt / 6076.12) / (dtSec / 3600))
              trackDeg = Math.round((Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360)
              if (prev[2] != null && last[2] != null) vs = Math.round((last[2] - prev[2]) / (dtSec / 60))
            }
            const altAgl = (last[2] || ap.elev) - ap.elev

            // Run the phaseML classifier on this aircraft's last
            // PHASE_WINDOW_S worth of fixes. Use only the current-session
            // points (computed above as `takeoffMs..last`) so a long
            // taxi/blackout from earlier in the day doesn't drag the
            // classifier into stale state.
            let phase = 'nearby', currentManeuvers = [], intentTop = null
            try {
              const windowStartMs = Math.max(takeoffMs, last[3] - PHASE_WINDOW_S * 1000)
              const phasePts = []
              for (const p of pts) {
                if (p[3] == null || p[3] < windowStartMs) continue
                phasePts.push({ lat: p[0], lon: p[1], altMslFt: p[2], tsUnix: p[3] / 1000 })
              }
              if (phasePts.length >= 2) {
                const { phases, maneuvers, intent } = classifyOneTrack(phasePts, {
                  typeCode: t.type || '',
                  intentWindowS: PHASE_WINDOW_S,
                  priorByAirport,
                })
                if (phases && phases.length) phase = phases[phases.length - 1].phase
                const endTs = phasePts[phasePts.length - 1].tsUnix
                currentManeuvers = (maneuvers || [])
                  .filter(m => m.endTsUnix != null && (endTs - m.endTsUnix) <= RECENT_MANEUVER_S)
                  .map(m => ({
                    type: m.type, confidence: m.confidence,
                    decisionCue: m.evidence?.decisionCue || null,
                    startTs: m.startTsUnix != null ? new Date(m.startTsUnix * 1000).toISOString() : null,
                    endTs: m.endTsUnix != null ? new Date(m.endTsUnix * 1000).toISOString() : null,
                  }))
                if (intent?.top) {
                  intentTop = {
                    airport: intent.top.airport,
                    probability: intent.top.probability ?? null,
                    runway: intent.top.runway || null,
                    confidence_gap: intent.confidenceGap ?? null,
                    explanation: intent.top.explanation || null,
                  }
                }
              }
            } catch (e) {
              console.error('[current-flights] phaseML error for', tail, e.message)
            }

            // Per-flight complaints — match by tail across the current
            // airborne session, with the same ±10 min pad as everywhere else.
            const flightComplaints = fsMod.matchComplaintsForKiosk(
              complaintsRaw, tail, takeoffMs, last[3] || nowMs,
            )

            flights.push({
              icao: t.hex,
              tail,
              type: t.type || null,
              desc: inf.descr || expandType(t.type),
              base: inf.base || (schoolBase ? airport : null) || (fleetBase ? airport : null),
              based_reason: basedReason,
              purpose: resolvePurpose(inf.purpose, t.type, tail),
              school: inf.school || schoolEntry?.school || null,
              lat: last[0], lon: last[1],
              alt_ft: last[2], alt_agl: Math.round(altAgl),
              gs_kts: gs, track_deg: trackDeg, vs_fpm: vs,
              dist_nm: Math.round(dist * 10) / 10,
              last_seen_s: Math.round(ageS),
              flying_minutes: Math.round(flyingMin * 10) / 10,
              takeoff_ts: new Date(takeoffMs).toISOString(),
              phase,
              phase_source: 'phaseML',
              current_maneuvers: currentManeuvers,
              intent: intentTop,
              complaints: flightComplaints,
            })
          }
          flights.sort((a, b) => (a.dist_nm - b.dist_nm))
          // Top-level complaint feed — recent complaints (last 60 min, matching
          // the live-flight focus), independent of tail-match. Kiosk filters
          // to lat/lon-populated entries for map pins; the per-flight
          // `complaints[]` array above already covers the halo case.
          const complaintsForWindow = fsMod.recentComplaintsForKiosk(complaintsRaw, 60)
          const responseBody = JSON.stringify({
            generated_at: new Date(nowMs).toISOString(),
            airport, range_nm: rangeNm,
            count: flights.length,
            phase_labels: [
              'on_ground', 'taxiing', 'pattern', 'landed_full_stop',
              'practice_area', 'departing', 'inbound', 'en_route', 'nearby',
            ],
            phase_source: 'phaseML',
            phase_note: 'phase comes from noise/web/phaseML (JS port of noise/phase-ml). Each flight also carries `current_maneuvers` (PTS detections whose end is within the last 60 s) and `intent` (Bayesian multi-airport posterior over candidate destinations). Hit /api/phase-ml/health or /classify directly to drive the same engine without going through current-flights.',
            flights,
            complaints: {
              window_minutes: 60,
              count: complaintsForWindow.length,
              geocoded_count: complaintsForWindow.filter(c => c.lat != null && c.lon != null).length,
              items: complaintsForWindow,
            },
          })
          currentFlightsResponseCache.set(cacheKey, { body: responseBody, fetchedAt: Date.now() })
          res.setHeader('X-Cache', 'MISS')
          res.end(responseBody)
        } catch (err) {
          console.error('[adsb/current-flights] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // ── GET /api/adsb/track ────────────────────────────────────────
      // Two URL shapes (both supported, both return phase data):
      //   GET /api/adsb/track?icao=<hex>&minutes=<1..60>
      //     → preferred. Returns raw `[lat, lon, alt, ts_ms]` tuples (the
      //       same format the live store uses internally), so callers can
      //       feed them directly into phase-ml without re-parsing dates.
      //   GET /api/adsb/track/<icao>?since=<iso8601>
      //     → legacy. Returns `[{ts, lat, lon, alt, gs, vs}]` objects.
      //
      // The bare-path registration (`/api/adsb/track`) catches BOTH because
      // connect's `use()` matches the prefix with `/`, `?`, or end-of-path.
      server.middlewares.use('/api/adsb/track', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          // connect strips the prefix from req.url; pathname is either '/'
          // (bare query call) or '/<icao>' (legacy path call).
          const icaoFromQuery = (u.searchParams.get('icao') || '').trim().toLowerCase()
          const icaoFromPath = u.pathname.replace(/^\//, '').trim().toLowerCase()
          const icao = icaoFromQuery || icaoFromPath
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          if (!icao) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'icao required: pass ?icao=<hex> or /api/adsb/track/<hex>' }))
          }

          // Window selection: ?minutes= (preferred, 1..60) > ?since= > 4h default.
          const minutesParam = u.searchParams.get('minutes')
          let sinceMs
          if (minutesParam != null && minutesParam !== '') {
            const minutes = Math.max(1, Math.min(60, Number(minutesParam) || 30))
            sinceMs = Date.now() - minutes * 60_000
          } else {
            const sinceParam = u.searchParams.get('since')
            sinceMs = sinceParam ? new Date(sinceParam).getTime() : Date.now() - 4 * 3600 * 1000
          }

          const fleet = await adsb.loadFleet()
          const zoneConfig = await adsb.loadZones()
          const live = await loadLive()

          let track = null
          for (const t of live.tracks || []) {
            if ((t.hex || '').toLowerCase() === icao) {
              track = t
              break
            }
          }

          if (!track) {
            res.statusCode = 404
            return res.end(JSON.stringify({ error: 'icao not found in today\'s live tracks' }))
          }

          // Filter points by sinceMs (points lacking a timestamp are kept —
          // they're historical fallback entries with no per-point time).
          const filtered = (track.points || []).filter(p => !p[3] || p[3] >= sinceMs)

          const phases = adsb.detectPhases(filtered, zoneConfig)
          const tail = fleet[icao]?.tail || track.call || icao
          // Use the raw tuple shape only when the caller used the new
          // ?icao= form — keeps existing path-based callers byte-stable.
          const useTuples = icaoFromQuery !== ''

          res.end(JSON.stringify({
            icao, tail,
            window: {
              minutes: minutesParam ? Math.max(1, Math.min(60, Number(minutesParam) || 30)) : null,
              since: new Date(sinceMs).toISOString(),
              point_count: filtered.length,
            },
            // Each tuple: [lat, lon, alt_ft, ts_ms]. ts_ms may be null on
            // legacy historical fallback fixes that lacked a timestamp.
            points: useTuples
              ? filtered.map(p => [p[0], p[1], p[2], p[3] ?? null])
              : filtered.map(p => ({
                  ts: p[3] ? new Date(p[3]).toISOString() : null,
                  lat: p[0], lon: p[1], alt: p[2],
                  gs: null, vs: null,
                })),
            phases: phases.map(p => ({
              type: p.type,
              start_ts: p.start_ts ? new Date(p.start_ts).toISOString() : null,
              end_ts: p.end_ts ? new Date(p.end_ts).toISOString() : null,
              alt_start: p.alt_start,
              alt_end: p.alt_end,
            })),
          }))
        } catch (err) {
          console.error('[adsb/track] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // ── GET /api/adsb/flights/:id/track (must register BEFORE /api/adsb/flights)
      server.middlewares.use('/api/adsb/flights/', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
        const pathParts = u.pathname.replace(/^\//, '').split('/')

        // /api/adsb/flights/:id/track → pathParts = [":id", "track"]
        if (pathParts.length === 2 && pathParts[1] === 'track') {
          try {
            const flightId = pathParts[0]
            const fleet = await adsb.loadFleet()
            const zoneConfig = await adsb.loadZones()
            const { byId } = await buildFlights(zoneConfig, fleet)

            const entry = byId.get(flightId)
            if (!entry) {
              res.statusCode = 404
              res.end(JSON.stringify({ error: 'flight not found' }))
              return
            }

            const { flight, points } = entry
            const startIdx = flight._startIdx || 0
            const endIdx = flight._endIdx || points.length - 1
            const slice = points.slice(startIdx, endIdx + 1)

            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(JSON.stringify({
              id: flight.id,
              icao: flight.icao,
              tail: flight.tail,
              points: slice.map(p => ({
                ts: p[3] ? new Date(p[3]).toISOString() : null,
                lat: p[0], lon: p[1], alt: p[2],
              })),
            }))
          } catch (err) {
            console.error('[adsb/flights/track] error', err)
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(err) }))
          }
          return
        }

        // Fall through to /api/adsb/flights list handler
        return next()
      })

      // ── GET /api/adsb/flights ──────────────────────────────────────
      server.middlewares.use('/api/adsb/flights', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const tail = u.searchParams.get('tail')
          const from = u.searchParams.get('from')
          const to = u.searchParams.get('to')

          const fleet = await adsb.loadFleet()
          const zoneConfig = await adsb.loadZones()
          const { flights } = await buildFlights(zoneConfig, fleet, tail, from, to)

          // Strip internal fields
          const clean = flights.map(({ _startIdx, _endIdx, ...rest }) => rest)

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ flights: clean }))
        } catch (err) {
          console.error('[adsb/flights] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // ── GET /api/adsb/stats ────────────────────────────────────────
      server.middlewares.use('/api/adsb/stats', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const tail = u.searchParams.get('tail')
          const from = u.searchParams.get('from')
          const to = u.searchParams.get('to')
          const groupBy = u.searchParams.get('group_by') || 'all'

          const fleet = await adsb.loadFleet()
          const zoneConfig = await adsb.loadZones()
          const { flights } = await buildFlights(zoneConfig, fleet, tail, from, to)
          const groups = adsb.aggregateStats(flights, groupBy)

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ groups }))
        } catch (err) {
          console.error('[adsb/stats] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // ── GET /api/adsb/active-tow ───────────────────────────────────
      server.middlewares.use('/api/adsb/active-tow', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const fleet = await adsb.loadFleet()
          const zoneConfig = await adsb.loadZones()
          const live = await loadLive()

          // Pair tow planes with gliders via ADS-B proximity
          const gliderPairs = adsb.pairTowWithGliders(live.tracks || [], fleet, zoneConfig)

          const towPlanes = []
          for (const t of live.tracks || []) {
            const hex = (t.hex || '').toLowerCase()
            const entry = fleet[hex]
            if (!entry || entry.role !== 'tow') continue
            if (!t.points?.length) continue

            const state = adsb.currentPhase(t.points, zoneConfig)
            if (!state) continue

            const eta = adsb.predictEta(
              state.phase, state.current_alt_ft || 0, state.climb_rate_fpm || 0, zoneConfig
            )

            // Find current cycle start
            const phases = adsb.detectPhases(t.points, zoneConfig)
            let cycleStart = null
            for (let i = phases.length - 1; i >= 0; i--) {
              if (phases[i].type === 'on_ground' || phases[i].type === 'taxiing') {
                cycleStart = phases[i].end_ts ? new Date(phases[i].end_ts).toISOString() : null
                break
              }
            }

            const pair = gliderPairs.get(hex)
            towPlanes.push({
              tail: entry.tail,
              icao: hex,
              phase: state.phase,
              current_alt_ft: state.current_alt_ft,
              climb_rate_fpm: state.climb_rate_fpm,
              est_release_ts: eta.est_release_s != null
                ? new Date(Date.now() + eta.est_release_s * 1000).toISOString()
                : null,
              est_available_ts: eta.est_available_s != null
                ? new Date(Date.now() + eta.est_available_s * 1000).toISOString()
                : null,
              current_cycle_start_ts: cycleStart,
              paired_glider_tail: pair?.glider_tail || null,
              paired_glider_icao: pair?.glider_hex || null,
            })
          }

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ tow_planes: towPlanes }))
        } catch (err) {
          console.error('[adsb/active-tow] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // ── GET/PUT /api/adsb/config/fleet ─────────────────────────────
      server.middlewares.use('/api/adsb/config/fleet', async (req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }

        if (req.method === 'GET') {
          const fleet = await adsb.loadFleet()
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(fleet))
          return
        }
        if (req.method === 'PUT') {
          try {
            const body = await readJsonBody(req)
            await adsb.saveFleet(body)
            flightsCache = { ts: 0, flights: [], byId: new Map() }
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true }))
          } catch (err) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: String(err) }))
          }
          return
        }
        next()
      })

      // ── GET/PUT /api/adsb/config/zones ─────────────────────────────
      server.middlewares.use('/api/adsb/config/zones', async (req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }

        if (req.method === 'GET') {
          const zones = await adsb.loadZones()
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(zones))
          return
        }
        if (req.method === 'PUT') {
          try {
            const body = await readJsonBody(req)
            await adsb.saveZones(body)
            flightsCache = { ts: 0, flights: [], byId: new Map() }
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true }))
          } catch (err) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: String(err) }))
          }
          return
        }
        next()
      })

      // ── WebSocket /api/adsb/stream ─────────────────────────────────
      // Piggybacks on the Vite HMR WebSocket server. Clients connect to
      // ws://host:port/api/adsb/stream and receive JSON messages.
      if (server.httpServer) {
        const { WebSocketServer } = await import('ws')
        const wss = new WebSocketServer({ noServer: true })

        server.httpServer.on('upgrade', (req, socket, head) => {
          if (req.url === '/api/adsb/stream') {
            wss.handleUpgrade(req, socket, head, (ws) => {
              wsClients.add(ws)
              ws.on('close', () => wsClients.delete(ws))
              ws.on('error', () => wsClients.delete(ws))
            })
          }
          // Let other upgrade requests (Vite HMR) pass through
        })

        // Broadcast position updates every 5s (matches capture poll cadence)
        const broadcast = async () => {
          if (wsClients.size === 0) return
          try {
            const fleet = await adsb.loadFleet()
            const zoneConfig = await adsb.loadZones()
            const live = await loadLive()

            for (const t of live.tracks || []) {
              const hex = (t.hex || '').toLowerCase()
              const entry = fleet[hex]
              if (!entry) continue
              if (!t.points?.length) continue

              const last = t.points[t.points.length - 1]
              const state = adsb.currentPhase(t.points, zoneConfig)

              const msg = JSON.stringify({
                type: 'position',
                icao: hex,
                tail: entry.tail,
                lat: last[0],
                lon: last[1],
                alt: last[2] || null,
                vs: state?.climb_rate_fpm || null,
                gs: null,
              })

              for (const ws of wsClients) {
                try { ws.send(msg) } catch {}
              }
            }
          } catch (err) {
            console.error('[adsb/stream] broadcast error', err)
          }
        }

        if (wsBroadcastTimer) clearInterval(wsBroadcastTimer)
        wsBroadcastTimer = setInterval(broadcast, 5000)
        server.httpServer.on('close', () => {
          if (wsBroadcastTimer) { clearInterval(wsBroadcastTimer); wsBroadcastTimer = null }
          for (const ws of wsClients) try { ws.close() } catch {}
          wsClients.clear()
        })
        console.log('[adsb-api] WebSocket stream registered at /api/adsb/stream')
      }

      console.log('[adsb-api] endpoints registered: /api/adsb/{live,track,flights,stats,active-tow,config/*,stream}')
    },
  }
}

// ───────────────────────────────────────────────────────────────────────
// Flight Impact feed — scores each completed flight on how gentle it was on
// the community below (ground noise × population density, community voices,
// and time spent low over noise-abatement areas, all divided by trip time)
// and turns that into an encouraging "Good Neighbor Score" where higher is
// better. Reuses adsb.extractTowCycles, flightScore.js, src/geo.js zones,
// data/complaints.json, and population_density.json.
//
//   GET /api/adsb/impact?airport=KBDU[&minutes=30]  — recent landings + scores
//   GET /api/adsb/impact/:id                         — one flight, full detail
//   GET /api/adsb/impact/:id/frame                   — embeddable Leaflet map
//   GET /kiosk/impact                                — self-contained kiosk page
function flightImpactPlugin() {
  const AIRPORTS = {
    KBDU: [40.0394, -105.2258], KBJC: [39.9088, -105.1172], KEIK: [40.0098, -105.0488],
    KLMO: [40.1636, -105.1636], KAPA: [39.5701, -104.8493], KDEN: [39.8617, -104.6731],
    KGXY: [40.4348, -104.6331], KFNL: [40.4517, -105.0114],
  }
  const FIELD_ELEV_FT = { KBDU: 5288, KBJC: 5673, KEIK: 5130, KLMO: 5055, KAPA: 5885, KFNL: 5016 }

  const nmFrom = (lat, lon, rLat, rLon) => {
    const dLat = (lat - rLat) * 60
    const dLon = (lon - rLon) * 60 * Math.cos(((lat + rLat) / 2) * Math.PI / 180)
    return Math.hypot(dLat, dLon)
  }
  const nearestAirport = (lat, lon, maxNm = 3) => {
    let best = null, bestD = Infinity
    for (const [code, [aLat, aLon]] of Object.entries(AIRPORTS)) {
      const d = nmFrom(lat, lon, aLat, aLon)
      if (d < bestD) { bestD = d; best = code }
    }
    return bestD <= maxNm ? best : null
  }

  // ── Lazy-loaded, cached supporting data ──
  let popGridCache = null
  const loadPopGrid = async () => {
    if (popGridCache !== null) return popGridCache
    try {
      const fs = await import('fs/promises')
      const path = await import('path')
      const buf = await fs.default.readFile(path.default.resolve('public/population_density.json'), 'utf8')
      popGridCache = JSON.parse(buf)
    } catch { popGridCache = false }
    return popGridCache
  }

  let zonesCache = null
  const loadZonesByName = async () => {
    if (zonesCache) return zonesCache
    const mod = await import('./src/noiseZones.js')
    zonesCache = (mod.NOISE_ZONES || []).map(z => ({
      name: z.name,
      airport: (z.name || '').split(/\s+/, 1)[0] || null,
      polygon: z.polygon,
    }))
    return zonesCache
  }

  const loadComplaints = async () => {
    if (db.useDb) {
      try { return await db.getComplaints(null) } catch { return [] }
    }
    try {
      const fs = await import('fs/promises')
      const path = await import('path')
      const buf = await fs.default.readFile(path.default.resolve('data/complaints.json'), 'utf8')
      return JSON.parse(buf).complaints || []
    } catch { return [] }
  }

  // Mirrors loadComplaints — pulls the raw noise-report records (with
  // reportedSegments[] when present, or the older `excursion` shape) from
  // Postgres or the local JSON fallback. Audio attachments are deliberately
  // untouched here; see flightScore.matchReportSegments for the projection.
  const loadNoiseReports = async () => {
    if (db.useDb) {
      try { return await db.getNoiseReports(null) } catch { return [] }
    }
    try {
      const fs = await import('fs/promises')
      const path = await import('path')
      const buf = await fs.default.readFile(path.default.resolve('data/noise_reports.json'), 'utf8')
      const parsed = JSON.parse(buf)
      return Array.isArray(parsed) ? parsed : (parsed.reports || [])
    } catch { return [] }
  }

  const loadLive = async () => {
    if (db.useDb) return db.loadLiveFromDb()
    const fs = await import('fs/promises')
    const path = await import('path')
    try {
      const buf = await fs.default.readFile(path.default.resolve('public/tracks_live.json'), 'utf8')
      return JSON.parse(buf)
    } catch { return { tracks: [], updated_at: null } }
  }

  // Score every completed flight that touched down near `airport` within the
  // last `minutes`. Returns the scored objects (with track slices attached
  // so the detail/frame routes can reuse them) keyed by id.
  //
  // `opts.reportSource` filters per-segment noise_reports[]: 'manual' (only
  // human-submitted), 'auto' (only auto-generated), or 'any' (default).
  const scoreRecentLandings = async (airport, minutes, opts = {}) => {
    const score = await import('./flightScore.js')
    const [zoneConfig, fleet, live, allZones, complaints, popGrid, noiseReports] = await Promise.all([
      adsb.loadZones(), adsb.loadFleet(), loadLive(),
      loadZonesByName(), loadComplaints(), loadPopGrid(),
      loadNoiseReports(),
    ])
    const reportSource = opts.reportSource || 'any'
    const zonesForAirport = allZones.filter(
      z => !airport || (z.airport || '').toUpperCase() === airport
    )
    const fieldElevFt = FIELD_ELEV_FT[airport] || zoneConfig.field_elevation_ft || 5288
    const cutoff = Date.now() - minutes * 60 * 1000

    // First pass: extract cycles per aircraft, remember how many landed at
    // this airport (for the home-vs-visitor call).
    const landedHereCount = {}
    const candidates = [] // { flight, points, hex, type }
    for (const t of live.tracks || []) {
      const hex = (t.hex || '').toLowerCase()
      const tail = fleet[hex]?.tail || t.call || hex
      if (!t.points?.length) continue
      const cycles = adsb.extractTowCycles(hex, tail, t.points, zoneConfig)
      for (const f of cycles) {
        if (!f.landing_ts) continue // only completed (terminated) flights
        const endIdx = f._endIdx ?? (t.points.length - 1)
        const landPt = t.points[Math.min(endIdx, t.points.length - 1)]
        if (!landPt) continue
        const apt = nearestAirport(landPt[0], landPt[1])
        if (!apt) continue
        if (airport && apt !== airport) continue
        landedHereCount[hex] = (landedHereCount[hex] || 0) + 1
        const landedMs = Date.parse(f.landing_ts)
        if (!(landedMs >= cutoff)) continue
        const startIdx = f._startIdx || 0
        candidates.push({
          flight: f, hex, type: t.type || fleet[hex]?.type || '',
          points: t.points.slice(startIdx, Math.min(endIdx, t.points.length - 1) + 1),
          airport: apt, landedMs,
        })
      }
    }

    const scored = []
    const byId = new Map()
    for (const c of candidates) {
      const inFleet = !!fleet[c.hex]
      const isHome = inFleet || (landedHereCount[c.hex] || 0) >= 2
      const result = score.scoreFlight(c.flight, c.points, {
        type: c.type, zones: zonesForAirport, complaints, popGrid: popGrid || null,
        fieldElevFt, isHome, airport: c.airport,
      })
      result._points = c.points
      result._zones = zonesForAirport
      // Per-segment noise-report enrichment (separate from voices_heard,
      // which counts complaints). Each entry is one reportedSegments[]
      // element, or one synthetic excursion-as-segment fallback.
      const startMs = c.points[0]?.[3] ?? c.landedMs
      const endMs = c.points[c.points.length - 1]?.[3] ?? c.landedMs
      result.noise_reports = score.matchReportSegments(
        noiseReports, result.tail, startMs, endMs, { source: reportSource },
      )
      byId.set(result.id, result)
      scored.push(result)
    }
    scored.sort((a, b) => (Date.parse(b.landed_ts) || 0) - (Date.parse(a.landed_ts) || 0))
    return { scored, byId }
  }

  // Strip the heavy internal fields for the list view.
  const summarize = (r) => ({
    id: r.id, tail: r.tail, type: r.type, airport: r.airport,
    landed_ts: r.landed_ts, trip_minutes: r.trip_minutes,
    score: r.score, tier: r.tier, home: r.home, greeting: r.greeting,
    gentleness: r.gentleness, highlights: r.highlights, detail: r.detail,
    noise_reports: r.noise_reports || [],
  })

  const json = (res, code, body) => {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.end(JSON.stringify(body))
  }
  const html = (res, code, body) => {
    res.statusCode = code
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.end(body)
  }

  return {
    name: 'flight-impact-api',
    configureServer(server) {
      console.log('[flight-impact] registered /api/adsb/impact + /kiosk/impact')

      // ── Detail + embeddable frame (register BEFORE the feed prefix) ──
      server.middlewares.use('/api/adsb/impact/', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const parts = u.pathname.replace(/^\//, '').split('/').filter(Boolean)
          const id = decodeURIComponent(parts[0] || '')
          const wantFrame = parts[1] === 'frame'
          if (!id) return next()

          // The id encodes the icao + takeoff epoch; widen the lookback so an
          // older-but-still-listed flight resolves regardless of the 30 min feed.
          const minutes = Math.min(720, Math.max(30, Number(u.searchParams.get('minutes')) || 360))
          const reportSource = (u.searchParams.get('reports') || 'any').toLowerCase()
          const reportSourceOk = ['manual', 'auto', 'any'].includes(reportSource) ? reportSource : 'any'
          const { byId } = await scoreRecentLandings(null, minutes, { reportSource: reportSourceOk })
          const r = byId.get(id)
          if (!r) {
            if (wantFrame) return html(res, 404, '<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:2rem">Flight not found or no longer in the live window.</body>')
            return json(res, 404, { error: 'flight not found' })
          }

          if (wantFrame) return html(res, 200, renderFrame(r))

          const grid = r._grid || {}
          json(res, 200, {
            ...summarize(r),
            path: (r._points || []).map(p => ({ lat: p[0], lon: p[1], alt: p[2], ts: p[3] || null })),
            zones: (r._zones || []).map(z => ({ name: z.name, polygon: z.polygon })),
            impact_overlay: grid.bounds ? {
              bounds: grid.bounds, w: grid.w, h: grid.h,
              // dB grid (ground noise) — null cells are quiet. The frame
              // multiplies visually by population; the score already did.
              db: grid.db ? Array.from(grid.db).map(v => (isFinite(v) ? +v.toFixed(1) : null)) : null,
            } : null,
            report_source_filter: reportSourceOk,
          })
        } catch (err) {
          console.error('[flight-impact/detail] error', err)
          json(res, 500, { error: String(err) })
        }
      })

      // ── Recent-landings feed ──
      server.middlewares.use('/api/adsb/impact', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        // Mounted at /api/adsb/impact, so req.url is the remainder: '/' for
        // the feed itself; anything deeper is a detail/frame (handled above).
        const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
        if (u.pathname !== '/') return next()
        try {
          const airport = (u.searchParams.get('airport') || '').trim().toUpperCase() || null
          const minutes = Math.min(720, Math.max(1, Number(u.searchParams.get('minutes')) || 30))
          // Accept ?reports=manual|auto|any to filter the per-flight
          // noise_reports[] enrichment. Default is 'any' (return both).
          const reportSourceRaw = (u.searchParams.get('reports') || 'any').toLowerCase()
          const reportSource = ['manual', 'auto', 'any'].includes(reportSourceRaw) ? reportSourceRaw : 'any'
          const { scored } = await scoreRecentLandings(airport, minutes, { reportSource })
          json(res, 200, {
            airport, window_minutes: minutes,
            generated_at: new Date().toISOString(),
            count: scored.length,
            report_source_filter: reportSource,
            flights: scored.map(summarize),
          })
        } catch (err) {
          console.error('[flight-impact/feed] error', err)
          json(res, 500, { error: String(err) })
        }
      })

      // ── Kiosk page ──
      server.middlewares.use('/kiosk/impact', (req, res, next) => {
        if (req.method !== 'GET') return next()
        html(res, 200, renderKiosk())
      })
    },
  }
}

// Embeddable map frame for a single scored flight. Self-contained HTML —
// pulls Leaflet from a CDN, fetches the flight detail, and paints the flight
// path, the ground-noise heat (× population is baked into the score badge),
// and the noise-abatement polygons.
function renderFrame(r) {
  const tierColor = { Gold: '#f5c518', Silver: '#b9c2cc', Bronze: '#c97b3c', Rising: '#7c9cff' }
  const color = tierColor[r.tier] || '#7c9cff'
  const data = JSON.stringify({ id: r.id, score: r.score, tier: r.tier })
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Good Neighbor Score — ${r.tail || ''}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  html,body,#map{height:100%;margin:0}
  body{font:14px/1.4 system-ui,sans-serif;background:#0b1020;color:#e8edf6}
  #badge{position:absolute;z-index:1000;top:12px;left:12px;background:rgba(11,16,32,.88);
    border:1px solid ${color};border-radius:14px;padding:12px 16px;max-width:60%}
  #badge .score{font-size:34px;font-weight:800;color:${color}}
  #badge .tier{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:${color}}
  #badge .greet{margin-top:6px;font-size:13px;opacity:.95}
  #badge ul{margin:8px 0 0;padding-left:18px;font-size:12px;opacity:.9}
  .leaflet-container{background:#0b1020}
</style></head>
<body>
<div id="badge"><div class="tier" id="tier"></div><div class="score" id="score"></div>
<div class="greet" id="greet"></div><ul id="hl"></ul></div>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const SEED = ${data};
(async () => {
  const map = L.map('map', { zoomControl: true, attributionControl: false });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);
  const r = await fetch('/api/adsb/impact/' + encodeURIComponent(SEED.id)).then(x => x.json());
  document.getElementById('tier').textContent = (r.tier || '') + ' · Good Neighbor';
  document.getElementById('score').textContent = (r.score ?? '–') + ' / 100';
  document.getElementById('greet').textContent = r.greeting || '';
  document.getElementById('hl').innerHTML = (r.highlights || []).map(h => '<li>' + h + '</li>').join('');

  // Noise-abatement polygons.
  (r.zones || []).forEach(z => {
    L.polygon(z.polygon, { color: '#facc15', weight: 1, fillColor: '#facc15', fillOpacity: 0.08 })
      .addTo(map).bindTooltip(z.name);
  });

  // Ground-noise heat overlay (canvas from the dB grid).
  const ov = r.impact_overlay;
  if (ov && ov.db) {
    const { w, h, db, bounds } = ov;
    let lo = Infinity, hi = -Infinity;
    for (const v of db) { if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    const span = Math.max(1, hi - lo);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d'); const img = ctx.createImageData(w, h);
    for (let row = 0; row < h; row++) {
      const src = h - 1 - row; // grid row 0 = south, canvas row 0 = north
      for (let col = 0; col < w; col++) {
        const v = db[src * w + col]; const i = (row * w + col) * 4;
        if (v == null) { img.data[i + 3] = 0; continue; }
        const t = Math.min(1, Math.max(0, (v - lo) / span));
        img.data[i] = t < .5 ? 0 : Math.round(255 * (t - .5) * 2);
        img.data[i + 1] = t < .5 ? Math.round(255 * t * 2) : Math.round(255 * (1 - (t - .5) * 2));
        img.data[i + 2] = t < .5 ? Math.round(255 * (1 - t * 2)) : 0;
        img.data[i + 3] = Math.round(40 + 170 * t);
      }
    }
    ctx.putImageData(img, 0, 0);
    L.imageOverlay(cv.toDataURL('image/png'), bounds, { opacity: 0.6 }).addTo(map);
  }

  // Flight path.
  const pts = (r.path || []).filter(p => p.lat != null).map(p => [p.lat, p.lon]);
  if (pts.length > 1) {
    const line = L.polyline(pts, { color: '${color}', weight: 3, opacity: 0.95 }).addTo(map);
    map.fitBounds(line.getBounds().pad(0.2));
  } else if (ov && ov.bounds) {
    map.fitBounds(ov.bounds);
  } else {
    map.setView([40.0394, -105.2258], 12);
  }
})();
</script></body></html>`
}

// Self-contained kiosk: asks for an airport, then lists recent landings with
// their Good Neighbor Scores and refreshes every 30 s.
function renderKiosk() {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recent Landings — Good Neighbor Scores</title>
<style>
  :root{--gold:#f5c518;--silver:#b9c2cc;--bronze:#c97b3c;--rising:#7c9cff}
  body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#0b1020;color:#e8edf6}
  header{padding:18px 24px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;
    border-bottom:1px solid #1c2540;position:sticky;top:0;background:#0b1020;z-index:5}
  h1{font-size:20px;margin:0}
  select,button{font:15px system-ui;padding:8px 12px;border-radius:10px;border:1px solid #2a355c;
    background:#131a33;color:#e8edf6}
  .muted{opacity:.6;font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;padding:24px}
  .card{background:#111831;border:1px solid #1f2a4d;border-radius:16px;padding:16px;display:flex;gap:14px}
  .ring{flex:0 0 84px;width:84px;height:84px;border-radius:50%;display:flex;align-items:center;
    justify-content:center;font-size:26px;font-weight:800;border:4px solid var(--rising)}
  .tier-Gold .ring{border-color:var(--gold);color:var(--gold)}
  .tier-Silver .ring{border-color:var(--silver);color:var(--silver)}
  .tier-Bronze .ring{border-color:var(--bronze);color:var(--bronze)}
  .tier-Rising .ring{border-color:var(--rising);color:var(--rising)}
  .body{flex:1;min-width:0}
  .tail{font-size:18px;font-weight:700}
  .greet{font-size:13px;opacity:.9;margin:2px 0 6px}
  .hl{font-size:12px;opacity:.85;margin:6px 0 0;padding-left:16px}
  .meta{font-size:12px;opacity:.6;margin-top:6px}
  a.frame{font-size:12px;color:#7c9cff;text-decoration:none}
  .empty{padding:48px;text-align:center;opacity:.6}
</style></head>
<body>
<header>
  <h1>🛬 Recent Landings — Good Neighbor Scores</h1>
  <label>Airport
    <select id="airport">
      <option value="KBDU">KBDU</option><option value="KBJC">KBJC</option>
      <option value="KEIK">KEIK</option><option value="KLMO">KLMO</option>
      <option value="KFNL">KFNL</option><option value="">All nearby</option>
    </select>
  </label>
  <label>Window
    <select id="minutes"><option value="30">30 min</option><option value="60">60 min</option>
      <option value="120">2 hours</option></select>
  </label>
  <button id="refresh">Refresh</button>
  <span class="muted" id="status"></span>
</header>
<div id="list" class="grid"></div>
<script>
const $ = s => document.querySelector(s);
async function load() {
  const ap = $('#airport').value, mins = $('#minutes').value;
  $('#status').textContent = 'loading…';
  try {
    const q = new URLSearchParams({ minutes: mins }); if (ap) q.set('airport', ap);
    const r = await fetch('/api/adsb/impact?' + q).then(x => x.json());
    const list = $('#list');
    if (!r.flights || !r.flights.length) {
      list.innerHTML = '<div class="empty">No landings in the last ' + mins + ' minutes. Check back soon — gentle skies ahead. ✈️</div>';
    } else {
      list.innerHTML = r.flights.map(f => {
        const t = f.tier || 'Rising';
        const hl = (f.highlights || []).slice(0, 2).map(h => '<li>' + h + '</li>').join('');
        return '<div class="card tier-' + t + '">' +
          '<div class="ring">' + f.score + '</div>' +
          '<div class="body"><div class="tail">' + (f.tail || '—') + (f.home ? ' · 🏠 home' : ' · ✈️ visitor') + '</div>' +
          '<div class="greet">' + (f.greeting || '') + '</div>' +
          '<ul class="hl">' + hl + '</ul>' +
          '<div class="meta">' + (f.type || '') + ' · ' + (f.trip_minutes ?? '–') + ' min · ' +
          new Date(f.landed_ts).toLocaleTimeString() + ' · ' + t +
          ' · <a class="frame" target="_blank" href="/api/adsb/impact/' + encodeURIComponent(f.id) + '/frame">map ↗</a></div>' +
          '</div></div>';
      }).join('');
    }
    $('#status').textContent = 'updated ' + new Date().toLocaleTimeString() + ' · ' + r.count + ' flight(s)';
  } catch (e) { $('#status').textContent = 'error: ' + e.message; }
}
$('#refresh').onclick = load; $('#airport').onchange = load; $('#minutes').onchange = load;
load(); setInterval(load, 30000);
</script></body></html>`
}

// GET /api/noise-zones[?airport=KBDU]
//   Voluntary noise abatement polygons with their upper altitude ceiling.
//   Source data lives in src/noiseZones.js (auto-generated by import_kml.py).
//   The airport prefix is derived from the zone name; ceiling_ft defaults to
//   the global ALT_THRESHOLD_FT (7500 MSL) and can be overridden per zone or
//   per airport via the maps below.
function noiseZonesApiPlugin() {
  // Default ceiling for the global "overflight below" rule. Mirrors
  // ALT_THRESHOLD_FT in src/geo.js — keep in sync if that changes.
  const DEFAULT_CEILING_FT = 7500
  // Airport-level ceiling overrides. Empty for now; populate when airports
  // publish different abatement ceilings (e.g. KAPA at higher field elev).
  const AIRPORT_CEILING_FT = {}
  // Per-zone ceiling overrides (keyed by zone name). Empty until specific
  // zones publish their own ceilings.
  const ZONE_CEILING_FT = {}

  let cached = null
  const buildZones = async () => {
    if (cached) return cached
    const mod = await import('./src/noiseZones.js')
    const zones = (mod.NOISE_ZONES || []).map(z => {
      // Names are written as "KBDU Frasier Meadows", "KAPA Cherry Creek"
      // — first whitespace-delimited token is the airport ICAO.
      const airport = (z.name || '').split(/\s+/, 1)[0] || null
      const ceiling_ft =
        ZONE_CEILING_FT[z.name] ??
        AIRPORT_CEILING_FT[airport] ??
        DEFAULT_CEILING_FT
      return {
        name: z.name,
        airport,
        note: z.note || null,
        ceiling_ft,
        polygon: z.polygon,
      }
    })
    cached = zones
    return zones
  }

  return {
    name: 'noise-zones-api',
    configureServer(server) {
      server.middlewares.use('/api/noise-zones', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const airportFilter = (u.searchParams.get('airport') || '').trim().toUpperCase()
          const all = await buildZones()
          const zones = airportFilter
            ? all.filter(z => (z.airport || '').toUpperCase() === airportFilter)
            : all
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          // Polygons are static config — clients can cache for an hour.
          // Bust by changing the filename or appending ?v=... in the URL.
          res.setHeader('Cache-Control', 'public, max-age=3600')
          res.end(JSON.stringify({
            count: zones.length,
            default_ceiling_ft: DEFAULT_CEILING_FT,
            zones,
          }))
        } catch (err) {
          console.error('[noise-zones-api] error', err)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}

// ── Self-discovery / API manifest ──────────────────────────────────────
// GET /api/discover           → markdown (prompt-ready, default)
// GET /api/discover?format=json → structured JSON manifest
//
// The single source of truth for what endpoints exist and what params they
// take. Keep this list updated when adding/changing routes — agents and
// integrators should be able to fetch this and act on it without digging
// through source.
const API_MANIFEST = {
  title: 'FlightSafe / Noise KBDU API',
  description:
    'Noise-monitoring and glider-ops API for KBDU (Boulder Municipal Airport, CO). ' +
    'All endpoints return JSON (or audio/markdown where noted) with permissive CORS. ' +
    'Coordinates are WGS-84 decimal degrees; altitudes are MSL feet unless suffixed _agl.',
  base_urls: {
    production: 'https://web-app-production-fedf.up.railway.app',
    local: 'http://localhost:5174',
  },
  groups: [
    {
      name: 'Flight tracks (location-aware)',
      summary: 'Recent ADS-B flight paths classified against noise zones.',
      endpoints: [
        {
          method: 'GET',
          path: '/api/excursions/segments',
          purpose: 'Flight paths with violation segments. Filter by location + radius + time range. Time range can be a lookback (hours) OR an explicit from/to window.',
          params: [
            { name: 'lat', type: 'float', desc: 'Center latitude (decimal degrees, WGS-84). Required for radius filtering.' },
            { name: 'lon', type: 'float', desc: 'Center longitude. Required for radius filtering.' },
            { name: 'radius_mi', type: 'float', default: 4, desc: 'Radius in statute miles. Tracks with at least one point inside the circle are returned.' },
            { name: 'radius_nm', type: 'float', desc: 'Alternative: nautical miles. Converted internally to radius_mi (1 nm = 1.15078 mi).' },
            { name: 'from', type: 'iso-8601 | epoch-ms', desc: 'Window start. ISO 8601 (e.g. 2026-05-07T20:15:00Z) or epoch-ms. Combined with `to` for arbitrary windows. When set, live-track points are filtered at sub-second precision.' },
            { name: 'to', type: 'iso-8601 | epoch-ms', desc: 'Window end. Defaults to now if omitted but `from` is given.' },
            { name: 'hours', type: 'int', default: 24, desc: 'Lookback window from now. Ignored when `from`/`to` is provided.' },
            { name: 'tail', type: 'string', desc: 'Optional: restrict to a single aircraft tail number.' },
            { name: 'limit', type: 'int', default: 200, desc: 'Cap on number of tracks returned (sorted by recency).' },
          ],
          response: {
            tracks: '[{tail, type, src, date, live, phase, descents, base_airport, alt_offset_ft, segments:[{klass, zone, points, startedAt, endedAt}]}]',
            center: '{lat, lon, radius_mi, radius_ft} | null',
            window: '{hours, from, to, limit}',
            matched: 'int — total tracks before limit',
          },
          example: '/api/excursions/segments?lat=40.04&lon=-105.22&radius_mi=5&hours=2',
          example2: '/api/excursions/segments?lat=40.04&lon=-105.22&radius_nm=2&from=2026-05-07T20:15:00Z&to=2026-05-07T20:30:00Z',
          notes: 'Each segment.klass is null|yellow|orange|red — null = clean, others = noise violation severity. Points are [lat, lon, alt_ft, ts_ms] with alt already corrected by alt_offset_ft (regional-smoothed per-track ADS-B baro-drift offset; 0 when no calibration available — see ADJUSTED_ALT.md). Live tracks (src=live) carry per-point timestamps for sub-second filtering; historical tracks are date-only.',
        },
        {
          method: 'GET',
          path: '/api/excursions/boot',
          purpose: 'Combined active-excursions list + recent tracks in one request (used by the main UI).',
          params: [
            { name: 'hours', type: 'int', default: 1, desc: 'Lookback window.' },
            { name: 'limit', type: 'int', default: 100, desc: 'Cap on tracks returned.' },
            { name: 'include', type: 'csv', desc: 'Opt-in joins: reports, notifications.' },
          ],
          response: { active: '[{tail, worst, counts, pointsHit, lastDate, live}]', tracks: 'array of tracks with bands + server-classified phase/descents/hasDescents (same classifier as /api/excursions/segments)', live: '{updated_at, tracks}' },
          example: '/api/excursions/boot?hours=1&include=reports,notifications',
          notes: 'Each track has phase ∈ {overflight, departure, arrival, pattern} and descents (int). Use these instead of any client-side altitude-trend heuristic — they handle stale fixes, thermalling gliders, and touch-and-goes correctly.',
        },
        {
          method: 'GET',
          path: '/api/excursions/active',
          purpose: 'Per-tail aggregated noise violations within a time window.',
          params: [
            { name: 'hours', type: 'int', default: 48 },
            { name: 'include', type: 'csv', desc: 'reports, notifications.' },
          ],
          example: '/api/excursions/active?hours=24&include=reports',
        },
      ],
    },
    {
      name: 'ADS-B (live + fleet)',
      summary: 'Live ADS-B positions, per-aircraft tracks, and tow-cycle analytics.',
      endpoints: [
        {
          method: 'GET',
          path: '/api/adsb/live',
          purpose: 'Current position for every tracked aircraft (~600+).',
          params: [{ name: 'icao', type: 'csv', desc: 'Comma-separated hex codes to filter (e.g. a59663,a5f99b).' }],
          response: { aircraft: '[{icao, tail, lat, lon, alt_ft, gs_kts, track_deg, vs_fpm, last_seen_s}]' },
          example: '/api/adsb/live?icao=a59663',
        },
        {
          method: 'GET',
          path: '/api/adsb/current-flights',
          purpose: 'Aircraft BASED at airport that are currently airborne within range, with how long they have been flying and a placeholder flight-phase label.',
          params: [
            { name: 'airport', type: 'string', default: 'KBDU', desc: 'ICAO code. Must be in the enrichment list (KBDU/KBJC/KEIK/KLMO/KAPA/KGXY/KFNL/KDEN).' },
            { name: 'range_nm', type: 'float', default: 10, desc: 'Search radius in nautical miles. Clamped to [0.5, 50].' },
          ],
          response: {
            airport: 'string', range_nm: 'float', count: 'int',
            phase_labels: '["on_ground","taxiing","pattern","landed_full_stop","practice_area","departing","inbound","en_route","nearby"]',
            phase_source: '"phaseML"',
            flights: '[{icao, tail, type, desc, base, purpose, school, lat, lon, alt_ft, alt_agl, gs_kts, track_deg, vs_fpm, dist_nm, last_seen_s, flying_minutes, takeoff_ts, phase, phase_source, current_maneuvers, intent}]',
          },
          example: '/api/adsb/current-flights?airport=KBDU&range_nm=10',
          notes: '`flying_minutes` is wall-clock minutes since the current contiguous session\'s first airborne fix (session = no gap > 30 min and no below-ground-ceiling fix). `phase` comes from noise/web/phaseML — same engine exposed at /api/phase-ml/classify. `current_maneuvers` lists PTS detections (steep_turn, s_turns_across_road, touch_and_go, etc.) whose end is within the last 60 s, each with confidence and decisionCue. `intent` is the Bayesian multi-airport posterior — prior is biased 2× to the requested airport. Skips aircraft whose last fix is > 3 min old, anonymized ~hex tails, and aircraft not based at the requested airport (use ?include=visitors to drop the based filter).',
        },
        {
          method: 'GET',
          path: '/api/adsb/track',
          purpose: 'Per-aircraft rolling track window. Two URL shapes — `?icao=<hex>&minutes=<N>` returns raw point tuples (preferred for downstream pipelines like phase-ml); `/track/<hex>?since=<iso>` returns named-object points (legacy).',
          params: [
            { name: 'icao', type: 'hex', desc: 'ICAO hex (matches what airplanes.live emits). Query-param form.' },
            { name: 'minutes', type: 'int', default: 30, desc: 'Window size in minutes, clamped to [1, 60]. Only when `icao` is set via query.' },
            { name: 'since', type: 'iso-timestamp', default: '4h ago', desc: 'Legacy: only points after this time. Used when caller hits /track/<hex>.' },
          ],
          response: {
            icao: 'string', tail: 'string',
            window: '{minutes, since, point_count}',
            points: 'When called as ?icao=&minutes= → [[lat, lon, alt_ft, ts_ms]] tuples. When called as /track/<hex> → [{ts, lat, lon, alt, gs, vs}] objects.',
            phases: '[{type, start_ts, end_ts, alt_start, alt_end}] — same rule-based phases as before',
          },
          example: '/api/adsb/track?icao=a59663&minutes=30',
          notes: 'Tuple shape `[lat, lon, alt_ft, ts_ms]` matches the live store and noise/phase-ml/phase_ml/data_loader.py — feed directly to the Python classifier without re-parsing dates.',
        },
        {
          method: 'GET',
          path: '/api/adsb/flights',
          purpose: 'Extracted tow cycles (takeoff → climb → release → descend → land).',
          params: [
            { name: 'tail', type: 'string', desc: 'Filter by tail. Without this, only fleet aircraft are returned.' },
            { name: 'from', type: 'date', desc: 'YYYY-MM-DD start.' },
            { name: 'to', type: 'date', desc: 'YYYY-MM-DD end.' },
          ],
        },
        { method: 'GET', path: '/api/adsb/flights/:id/track', purpose: 'Position points for a specific completed flight.' },
        {
          method: 'GET',
          path: '/api/adsb/stats',
          purpose: 'Aggregated tow performance (cycle time, climb rate percentiles).',
          params: [
            { name: 'tail', type: 'string' },
            { name: 'from', type: 'date' },
            { name: 'to', type: 'date' },
            { name: 'group_by', type: 'string', default: 'all', desc: 'all | da_band | hour | glider' },
          ],
        },
        { method: 'GET', path: '/api/adsb/active-tow', purpose: 'Real-time tow plane state with ETA + glider pairing.' },
        { method: 'GET/PUT', path: '/api/adsb/config/fleet', purpose: 'ICAO hex → tail/operator/role mapping.' },
        { method: 'GET/PUT', path: '/api/adsb/config/zones', purpose: 'Airport geofence + phase detection thresholds.' },
        { method: 'WS', path: '/api/adsb/stream', purpose: 'Live position broadcasts every 2s for fleet aircraft.' },
      ],
    },
    {
      name: 'Noise zones',
      summary: 'Voluntary noise abatement polygons.',
      endpoints: [
        {
          method: 'GET',
          path: '/api/noise-zones',
          purpose: 'All noise abatement polygons with their upper altitude ceiling.',
          params: [{ name: 'airport', type: 'string', desc: 'Filter by airport (e.g. KBDU). Default: all.' }],
          response: { count: 'int', default_ceiling_ft: 7500, zones: '[{name, airport, note, ceiling_ft, polygon: [[lat, lon], ...]}]' },
        },
      ],
    },
    {
      name: 'Noise exposure (location-centric)',
      summary: 'Answer "what is my noise exposure?" — for any lat/lon, enumerate flights whose paths came within radius, estimate ground dBA at the listener, and aggregate to a histogram + breakdowns.',
      endpoints: [
        {
          method: 'GET',
          path: '/api/noise/exposure',
          purpose: 'Per-listener noise exposure over a window. Scans historical + live ADS-B tracks within radius, scores each pass with the same noise kernel as the Good Neighbor Score, and returns one event per pass plus aggregated histogram + breakdowns.',
          params: [
            { name: 'lat', type: 'float', desc: 'Listener latitude (WGS-84). Required.' },
            { name: 'lon', type: 'float', desc: 'Listener longitude. Required.' },
            { name: 'radius_nm', type: 'float', default: 5, desc: 'Audible-range cap in nautical miles. Clamped to [0.5, 20].' },
            { name: 'hours', type: 'int', default: 24, desc: 'Rolling lookback in hours (1..168). Ignored when from/to is set.' },
            { name: 'from', type: 'iso-8601', desc: 'Window start. Pairs with `to` for arbitrary windows.' },
            { name: 'to', type: 'iso-8601', desc: 'Window end. Defaults to now when `from` is set.' },
            { name: 'elev_ft', type: 'float', desc: 'Listener terrain elevation MSL. Defaults to the nearest Front Range airport elevation.' },
            { name: 'db_floor', type: 'float', desc: 'Drop events with peak dBA below this. Default: no floor (all bins).' },
            { name: 'bins', type: 'csv', desc: 'Histogram bin edges (ascending dBA). Default: 35,40,45,50,55,60,65,70,75,80,85,90.' },
          ],
          response: {
            listener: '{lat, lon, elev_ft, radius_nm}',
            window: '{from, to, hours}',
            summary: '{total_events, peak_db, peak_tail, peak_type, peak_ts, mean_db, median_db, db_floor}',
            histogram: '{bins: [..], counts: [..]}  — counts[i] is the number of events with est_db ∈ [bins[i], bins[i+1])',
            by_purpose: '[{key, count, peak_db, mean_db}]',
            by_operator: '[{key, count, peak_db, mean_db}]',
            by_base: '[{key, count, peak_db, mean_db}]',
            by_type: '[{key, count, peak_db, mean_db}]',
            by_hour_local: '[{hour_local, count, peak_db}] — 24 buckets in America/Denver',
            events: '[{hex, tail, type, operator, base, purpose, pass_index, est_db, ts_at_closest, dist_ft, alt_agl_ft, slant_ft}]',
          },
          example: '/api/noise/exposure?lat=40.005&lon=-105.205&radius_nm=5&hours=24',
          example2: '/api/noise/exposure?lat=40.04&lon=-105.22&radius_nm=10&from=2026-05-30T00:00:00Z&to=2026-05-31T00:00:00Z&db_floor=50',
          notes: 'Engineless aircraft (gliders, balloons) are scored silent — they contribute no events. A pass is a contiguous run of in-radius points with no gap > 5 min. The est_db is LMax (the loudest single segment) at the listener, computed by flightScore.dbAtListener using the same kernel as buildImpactGrid.',
        },
        {
          method: 'GET',
          path: '/api/noise/exposure/flight/:hex',
          purpose: 'Per-pass dBA trace at the listener for one aircraft (drill-down from /api/noise/exposure).',
          params: [
            { name: 'lat', type: 'float', desc: 'Listener lat. Required.' },
            { name: 'lon', type: 'float', desc: 'Listener lon. Required.' },
            { name: 'pass', type: 'int', default: 0, desc: 'Which pass to return (chronological, 0-indexed).' },
            { name: 'hours', type: 'int', default: 24, desc: 'Rolling lookback (1..168).' },
            { name: 'radius_nm', type: 'float', default: 5 },
            { name: 'elev_ft', type: 'float' },
          ],
          response: {
            hex: 'string', tail: 'string', type: 'string',
            listener: '{lat, lon, elev_ft}',
            pass_index: 'int', pass_count: 'int',
            peak: '{peakDb, peakTs, closestSlantFt, closestHorizFt, closestAglFt, closestLat, closestLon, closestAltFt, closestTs}',
            samples: '[{ts, db, dist_ft, alt_agl_ft}] — one per segment in the pass',
          },
          example: '/api/noise/exposure/flight/a59663?lat=40.005&lon=-105.205&pass=0',
        },
      ],
    },
    {
      name: 'Noise reports & complaints',
      summary: 'User-submitted noise reports with optional MP3 audio attachments.',
      endpoints: [
        {
          method: 'POST',
          path: '/api/noise-reports',
          purpose: 'Create a noise report. Returns { id, receivedAt }.',
          body: 'JSON: { reporter (string|object), score?, location?, note?, ... }',
        },
        {
          method: 'GET',
          path: '/api/noise-reports',
          purpose: 'List noise reports, optionally filtered by reporter.',
          params: [{ name: 'reporter', type: 'string', desc: 'Email/id/name match against reporter field.' }],
        },
        {
          method: 'POST',
          path: '/api/noise-reports/:id/audio/:slot',
          purpose: 'Attach raw MP3 bytes to a report. Slot ∈ {spliced10s, loudest5s}. Content-Type must be audio/mpeg. Body capped at 1 MB.',
        },
        { method: 'GET', path: '/api/noise-reports/:id/audio/:slot', purpose: 'Retrieve the raw MP3 bytes for a report+slot.' },
        { method: 'POST/GET', path: '/api/complaints', purpose: 'Quick noise complaints (lighter than full reports).' },
      ],
    },
    {
      name: 'Flights — Pilot Console CURRENT surface',
      summary: 'Per-flight CURRENT feed and acknowledge endpoint backing the touch-screen Pilot Console. A "flight" groups T&Gs and taxi-back full-stops into one sortie; only a crew-replacement-sized ground gap (≥ FLIGHT_GAP_MIN, per-airport) starts a new one. See FLIGHT_DATA_SERVICE.md.',
      endpoints: [
        {
          method: 'GET',
          path: '/api/flights/current',
          purpose: 'Unified CURRENT feed: airborne flights within range_nm OR landed-at-airport-and-not-yet-acknowledged. Each row carries inline V/P/N indicators (vnap_count, pop_impact 0-100, complaint_count), a worst_segment (30s sliding-window dBA × density), and incursion_segments (per-zone VNAP-polygon runs with significant/minor severity tiers). pop_impact and worst_segment exclude the strict airport pattern envelope; incursion_segments use the full track.',
          params: [
            { name: 'airport', type: 'string', default: 'KBDU', desc: 'ICAO of the airport whose CURRENT to return.' },
            { name: 'landed_hours', type: 'number', default: 6, desc: 'Hours to look back for unacked landings (0.5..48).' },
            { name: 'range_nm', type: 'number', default: 25, desc: 'Range from the airport to include airborne traffic (1..50).' },
          ],
        },
        {
          method: 'POST',
          path: '/api/flights/acknowledge',
          purpose: 'One tap acks every issue on the flight (VNAP crossings, population-impact moments, complaints). Idempotent for same acknowledged_by; 409 with prior attribution for a different operator.',
          body: 'JSON: { flight_id, acknowledged_by, note?, tail? }',
        },
        {
          method: 'GET',
          path: '/api/flights/acknowledgements',
          purpose: 'Read-only dump of flight-ack records — lets the Pilot Console reconcile its localStorage queue on reconnect.',
          params: [
            { name: 'airport', type: 'string', desc: 'Filter to flight_ids whose airport prefix matches (e.g. kbdu).' },
            { name: 'since', type: 'ISO timestamp', desc: 'Only return acks created at or after this time.' },
          ],
        },
      ],
    },
    {
      name: 'Self-discovery',
      summary: 'This manifest.',
      endpoints: [
        {
          method: 'GET',
          path: '/api/discover',
          purpose: 'Returns this API manifest. Markdown by default; ?format=json for structured.',
          params: [{ name: 'format', type: 'string', default: 'markdown', desc: 'markdown | json' }],
        },
      ],
    },
  ],
}

function manifestToMarkdown(m) {
  const lines = []
  lines.push(`# ${m.title}`)
  lines.push('')
  lines.push(m.description)
  lines.push('')
  lines.push(`**Production:** ${m.base_urls.production}`)
  lines.push(`**Local:** ${m.base_urls.local}`)
  lines.push('')
  for (const g of m.groups) {
    lines.push(`## ${g.name}`)
    if (g.summary) { lines.push(''); lines.push(g.summary) }
    lines.push('')
    for (const e of g.endpoints) {
      lines.push(`### \`${e.method} ${e.path}\``)
      lines.push('')
      lines.push(e.purpose)
      lines.push('')
      if (e.params?.length) {
        lines.push('| Param | Type | Default | Description |')
        lines.push('|---|---|---|---|')
        for (const p of e.params) {
          lines.push(`| \`${p.name}\` | ${p.type} | ${p.default ?? '—'} | ${p.desc || ''} |`)
        }
        lines.push('')
      }
      if (e.body) { lines.push(`**Body:** ${e.body}`); lines.push('') }
      if (e.response) {
        lines.push('**Response shape:**')
        lines.push('```')
        for (const [k, v] of Object.entries(e.response)) lines.push(`${k}: ${v}`)
        lines.push('```')
      }
      if (e.example) { lines.push(`**Example:** \`${e.example}\``); lines.push('') }
      if (e.example2) { lines.push(`**Example (arbitrary window):** \`${e.example2}\``); lines.push('') }
      if (e.notes) { lines.push(`> ${e.notes}`); lines.push('') }
    }
  }
  return lines.join('\n')
}

// ───────────────────────────────────────────────────────────────────────
// Noise Exposure — "what did THIS point on the ground hear?"
//
// Answers "what is my noise exposure?" for any lat/lon over a time window.
// Walks historical + recent ADS-B tracks, filters to flights whose paths
// passed within `radius_nm` of the listener, and scores each pass with
// flightScore.dbAtListener (same noise kernel as the impact heatmap).
//
//   GET /api/noise/exposure?lat=&lon=[&radius_nm=5][&hours=24|&from=&to=][&elev_ft=]
//   GET /api/noise/exposure/flight/:hex?lat=&lon=[&pass=N]
function noiseExposurePlugin() {
  const FIELD_ELEV_FT = { KBDU: 5288, KBJC: 5673, KEIK: 5130, KLMO: 5055, KAPA: 5885, KFNL: 5016, KGXY: 4697, KDEN: 5434 }
  const AIRPORTS = {
    KBDU: [40.0394, -105.2258], KBJC: [39.9088, -105.1172], KEIK: [40.0098, -105.0488],
    KLMO: [40.1636, -105.1636], KAPA: [39.5701, -104.8493], KDEN: [39.8617, -104.6731],
    KGXY: [40.4348, -104.6331], KFNL: [40.4517, -105.0114],
  }
  const DEFAULT_HIST_BINS = [35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90]
  const PASS_GAP_MS = 5 * 60 * 1000 // > 5 min gap inside the radius starts a new pass

  const nearestAirportElev = (lat, lon) => {
    let best = null, bestD = Infinity
    for (const [code, [aLat, aLon]] of Object.entries(AIRPORTS)) {
      const dLat = (lat - aLat) * 60
      const dLon = (lon - aLon) * 60 * Math.cos(((lat + aLat) / 2) * Math.PI / 180)
      const d = Math.hypot(dLat, dLon)
      if (d < bestD) { bestD = d; best = code }
    }
    return best ? FIELD_ELEV_FT[best] : 5288
  }

  // Local hour-of-day in America/Denver. Avoids pulling Intl into hot path
  // per flight by precomputing the offset once per request.
  function hourLocalFor(ts, denverOffsetMin) {
    const localMs = ts + denverOffsetMin * 60_000
    const d = new Date(localMs)
    return d.getUTCHours()
  }
  function denverOffsetAt(ts) {
    // Use Intl once: returns the UTC offset (minutes) for America/Denver
    // at `ts`. DST-aware (UTC-7 winter, UTC-6 summer).
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver', timeZoneName: 'shortOffset',
    })
    const parts = fmt.formatToParts(new Date(ts))
    const tz = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT-7'
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tz)
    if (!m) return -420
    const sign = m[1] === '-' ? -1 : 1
    return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10))
  }

  async function loadTracksInWindow(fromMs, toMs) {
    const out = []
    if (db.useDb) {
      const fromDate = new Date(fromMs).toISOString().slice(0, 10)
      const toDate = new Date(toMs).toISOString().slice(0, 10)
      // Historical aggregated tracks.
      try {
        const hist = await db.loadTracksFromDb({ fromDate, toDate })
        for (const t of hist.tracks || []) out.push(t)
      } catch (err) { console.error('[noise/exposure] hist load err', err.message) }
      // Live tracks for any window touching the last week (the aggregation
      // job may not yet have rolled today/yesterday into the tracks table).
      if (toMs > Date.now() - 7 * 86400000) {
        try {
          const hoursBack = Math.min(168, Math.ceil((Date.now() - fromMs) / 3600000) + 24)
          const live = await db.loadLiveFromDb(hoursBack)
          for (const t of live.tracks || []) out.push(t)
        } catch (err) { console.error('[noise/exposure] live load err', err.message) }
      }
    } else {
      try {
        const buf = await fs.promises.readFile(path.resolve('public/tracks_live.json'), 'utf8')
        const j = JSON.parse(buf)
        for (const t of j.tracks || []) out.push(t)
      } catch { /* no local file */ }
    }
    return out
  }

  // Split a contiguous run of in-radius points into individual passes —
  // gaps > PASS_GAP_MS (or no timestamps at all → treat as one pass).
  function segmentPasses(inRadiusPoints) {
    if (inRadiusPoints.length < 2) return [inRadiusPoints]
    const passes = []
    let cur = [inRadiusPoints[0]]
    for (let i = 1; i < inRadiusPoints.length; i++) {
      const prev = inRadiusPoints[i - 1]
      const p = inRadiusPoints[i]
      const ta = prev[3], tb = p[3]
      const gap = ta != null && tb != null ? tb - ta : 0
      if (gap > PASS_GAP_MS) {
        if (cur.length >= 2) passes.push(cur)
        cur = [p]
      } else {
        cur.push(p)
      }
    }
    if (cur.length >= 2) passes.push(cur)
    return passes
  }

  // Per-tail base/purpose/school lookup — same query the
  // /api/adsb/current-flights endpoint uses (db_base, school, desc_text).
  async function loadBaseMap(tails) {
    const m = new Map()
    if (!db.useDb || !tails.length) return m
    try {
      const r = await db.queryDb(
        `SELECT call,
           (array_agg(base_airport ORDER BY date DESC) FILTER (WHERE base_airport IS NOT NULL))[1] AS base,
           (array_agg(purpose      ORDER BY date DESC) FILTER (WHERE purpose      IS NOT NULL))[1] AS purpose,
           (array_agg(school       ORDER BY date DESC) FILTER (WHERE school       IS NOT NULL))[1] AS school,
           (array_agg(own_op       ORDER BY date DESC) FILTER (WHERE own_op       IS NOT NULL))[1] AS own_op
         FROM tracks WHERE call = ANY($1) GROUP BY call`, [tails])
      for (const row of r.rows) m.set(row.call, row)
    } catch (err) { console.error('[noise/exposure] base lookup err', err.message) }
    return m
  }

  async function loadSchoolTailMap() {
    if (global.__SCHOOL_TAIL_AIRPORT) return global.__SCHOOL_TAIL_AIRPORT
    try {
      const raw = await fs.promises.readFile('public/flight_schools_fleets.json', 'utf8')
      const sf = JSON.parse(raw)
      const m = new Map()
      for (const s of sf.schools || []) {
        const sAp = (s.airport || '').split(/\s+/)[0].trim().toUpperCase()
        if (!sAp) continue
        for (const ac of s.aircraft || []) {
          const t = (ac.tail || '').trim().toUpperCase()
          if (t && !m.has(t)) m.set(t, { airport: sAp, school: s.name || null })
        }
      }
      global.__SCHOOL_TAIL_AIRPORT = m
      return m
    } catch { return new Map() }
  }

  function aggregate(events, bins, denverOffset) {
    // Histogram (counts per dBA bin; last bin is overflow).
    const counts = new Array(bins.length).fill(0)
    for (const e of events) {
      if (e.est_db == null) continue
      let placed = false
      for (let i = bins.length - 1; i >= 0; i--) {
        if (e.est_db >= bins[i]) { counts[i]++; placed = true; break }
      }
      if (!placed) {
        // Below the lowest bin — drop. Listener didn't really "hear" it.
      }
    }

    const byKey = (keyFn) => {
      const m = new Map()
      for (const e of events) {
        if (e.est_db == null) continue
        const k = keyFn(e) || 'unknown'
        let row = m.get(k)
        if (!row) { row = { key: k, count: 0, peak_db: -Infinity, sum_db: 0 }; m.set(k, row) }
        row.count++
        if (e.est_db > row.peak_db) row.peak_db = e.est_db
        row.sum_db += e.est_db
      }
      return [...m.values()]
        .map(r => ({ key: r.key, count: r.count, peak_db: +r.peak_db.toFixed(1), mean_db: +(r.sum_db / r.count).toFixed(1) }))
        .sort((a, b) => b.count - a.count)
    }

    const byHour = new Array(24).fill(null).map((_, h) => ({ hour_local: h, count: 0, peak_db: null }))
    for (const e of events) {
      if (e.est_db == null || e.ts_at_closest == null) continue
      const h = hourLocalFor(e.ts_at_closest, denverOffset)
      const row = byHour[h]
      row.count++
      if (row.peak_db == null || e.est_db > row.peak_db) row.peak_db = +e.est_db.toFixed(1)
    }

    return {
      histogram: { bins, counts },
      by_purpose: byKey(e => e.purpose),
      by_operator: byKey(e => e.operator),
      by_base: byKey(e => e.base),
      by_type: byKey(e => e.type),
      by_hour_local: byHour,
    }
  }

  return {
    name: 'noise-exposure-api',
    configureServer(server) {
      server.middlewares.use('/api/noise/exposure/flight', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const hex = (u.pathname.replace(/^\/+/, '').split('/').pop() || '').toLowerCase()
          const latRaw = u.searchParams.get('lat')
          const lonRaw = u.searchParams.get('lon')
          const lat = latRaw == null ? NaN : Number(latRaw)
          const lon = lonRaw == null ? NaN : Number(lonRaw)
          if (!hex || !isFinite(lat) || !isFinite(lon)) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'hex (path), lat, lon required' }))
          }
          const passIdx = Math.max(0, parseInt(u.searchParams.get('pass') || '0', 10))
          const hours = Math.max(1, Math.min(168, Number(u.searchParams.get('hours')) || 24))
          const elevFt = Number(u.searchParams.get('elev_ft')) || nearestAirportElev(lat, lon)
          const toMs = Date.now()
          const fromMs = toMs - hours * 3600_000
          const tracks = await loadTracksInWindow(fromMs, toMs)
          const fs2 = await import('./flightScore.js')

          // Collect every track segment for this hex within the window;
          // there may be multiple rows (one per day).
          const all = []
          for (const t of tracks) {
            if ((t.hex || '').toLowerCase() !== hex) continue
            for (const p of t.points || []) {
              const ts = p[3]
              if (ts != null && (ts < fromMs || ts > toMs)) continue
              all.push(p)
            }
            // capture type/call from the first matching row
            if (!all.type && t.type) all.type = t.type
            if (!all.tail && t.call) all.tail = t.call
          }
          if (all.length < 2) {
            res.statusCode = 404
            return res.end(JSON.stringify({ error: 'no track points for hex in window' }))
          }
          all.sort((a, b) => (a[3] || 0) - (b[3] || 0))

          // Filter to in-radius and split into passes.
          const RADIUS_NM = Math.max(0.5, Math.min(20, Number(u.searchParams.get('radius_nm')) || 5))
          const radFt = RADIUS_NM * 6076.12
          const inRad = all.filter(p => distFt(p[0], p[1], lat, lon) <= radFt)
          const passes = segmentPasses(inRad)
          if (!passes[passIdx]) {
            res.statusCode = 404
            return res.end(JSON.stringify({ error: `pass ${passIdx} not found (have ${passes.length})` }))
          }
          const seg = passes[passIdx]
          const type = all.type || null
          const peak = fs2.dbAtListener(seg, type, { lat, lon }, { listenerElevFt: elevFt })

          // Per-segment dB samples so callers can plot the dB(t) trace.
          const samples = []
          for (let i = 1; i < seg.length; i++) {
            const pair = [seg[i - 1], seg[i]]
            const r = fs2.dbAtListener(pair, type, { lat, lon }, { listenerElevFt: elevFt })
            samples.push({
              ts: r.peakTs ?? seg[i][3] ?? null,
              db: r.peakDb,
              dist_ft: r.closestHorizFt,
              alt_agl_ft: r.closestAglFt,
            })
          }
          res.end(JSON.stringify({
            hex, tail: all.tail || null, type,
            listener: { lat, lon, elev_ft: elevFt },
            pass_index: passIdx, pass_count: passes.length,
            peak, samples,
          }))
        } catch (err) {
          console.error('[noise/exposure/flight] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err && err.message || err) }))
        }
      })

      server.middlewares.use('/api/noise/exposure', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const latRaw = u.searchParams.get('lat')
          const lonRaw = u.searchParams.get('lon')
          const lat = latRaw == null ? NaN : Number(latRaw)
          const lon = lonRaw == null ? NaN : Number(lonRaw)
          if (!isFinite(lat) || !isFinite(lon)) {
            res.statusCode = 400
            return res.end(JSON.stringify({ error: 'lat and lon are required query params' }))
          }
          const radiusNm = Math.max(0.5, Math.min(20, Number(u.searchParams.get('radius_nm')) || 5))
          const radFt = radiusNm * 6076.12

          // Time window: explicit ?from=&to= (ISO) takes precedence over ?hours=.
          const nowMs = Date.now()
          const fromParam = u.searchParams.get('from')
          const toParam = u.searchParams.get('to')
          let fromMs, toMs
          if (fromParam || toParam) {
            toMs = toParam ? Date.parse(toParam) : nowMs
            fromMs = fromParam ? Date.parse(fromParam) : (toMs - 24 * 3600_000)
            if (!isFinite(fromMs) || !isFinite(toMs) || toMs <= fromMs) {
              res.statusCode = 400
              return res.end(JSON.stringify({ error: 'from/to must be valid ISO datetimes with to > from' }))
            }
          } else {
            const hours = Math.max(1, Math.min(168, Number(u.searchParams.get('hours')) || 24))
            toMs = nowMs
            fromMs = nowMs - hours * 3600_000
          }
          const elevFt = Number(u.searchParams.get('elev_ft')) || nearestAirportElev(lat, lon)
          const dbFloor = Number(u.searchParams.get('db_floor'))
          const histBins = (u.searchParams.get('bins') || '').trim()
            ? u.searchParams.get('bins').split(',').map(Number).filter(n => isFinite(n)).sort((a, b) => a - b)
            : DEFAULT_HIST_BINS

          res.setHeader('Cache-Control', 'public, max-age=30')

          const tracks = await loadTracksInWindow(fromMs, toMs)
          const fleet = await adsb.loadFleet()
          const schoolMap = await loadSchoolTailMap()
          const tails = [...new Set(tracks.map(t => (t.call || '').trim()).filter(Boolean))]
          const baseInfo = await loadBaseMap(tails)
          const fs2 = await import('./flightScore.js')

          // Dedup: a single (hex, day) may appear in both the live and
          // tracks tables. Prefer whichever has more points.
          const byHexDay = new Map()
          for (const t of tracks) {
            const hex = (t.hex || '').toLowerCase()
            if (!hex) continue
            // Group by hex first; we'll split into passes by time gap later.
            let row = byHexDay.get(hex)
            if (!row) { row = { hex, type: t.type || null, tail: t.call || null, points: [] }; byHexDay.set(hex, row) }
            if (!row.type && t.type) row.type = t.type
            if (!row.tail && t.call) row.tail = t.call
            for (const p of t.points || []) {
              const ts = p[3]
              if (ts != null && (ts < fromMs || ts > toMs)) continue
              row.points.push(p)
            }
          }

          const denverOffset = denverOffsetAt(nowMs)
          const events = []
          for (const row of byHexDay.values()) {
            if (row.points.length < 2) continue
            row.points.sort((a, b) => (a[3] || 0) - (b[3] || 0))
            // Pre-filter: any point within radius? If not, skip the track.
            const inRad = []
            for (const p of row.points) {
              if (p[0] == null || p[1] == null) continue
              if (distFt(p[0], p[1], lat, lon) <= radFt) inRad.push(p)
            }
            if (inRad.length < 2) continue
            const passes = segmentPasses(inRad)
            const tailU = (row.tail || '').toUpperCase()
            const inf = baseInfo.get(row.tail || '') || {}
            const schoolEntry = schoolMap.get(tailU)
            const fleetEntry = fleet[row.hex]
            const operator =
              fleetEntry?.operator ||
              (inf.own_op || null) ||
              (schoolEntry?.school || null) ||
              null
            const base = (inf.base || schoolEntry?.airport || (fleetEntry ? 'KBDU' : null) || null)
            const purpose = resolvePurpose(inf.purpose, row.type, row.tail)
            const tailDisplay = fleetEntry?.tail || row.tail || row.hex

            for (let pi = 0; pi < passes.length; pi++) {
              const seg = passes[pi]
              const r = fs2.dbAtListener(seg, row.type, { lat, lon }, { listenerElevFt: elevFt })
              if (r.silent) continue
              if (r.peakDb == null) continue
              if (isFinite(dbFloor) && r.peakDb < dbFloor) continue
              events.push({
                hex: row.hex,
                tail: tailDisplay,
                type: row.type,
                operator,
                base,
                purpose,
                pass_index: pi,
                est_db: r.peakDb,
                ts_at_closest: r.closestTs ?? r.peakTs ?? null,
                dist_ft: r.closestHorizFt,
                alt_agl_ft: r.closestAglFt,
                slant_ft: r.closestSlantFt,
              })
            }
          }

          events.sort((a, b) => b.est_db - a.est_db)
          const dbs = events.map(e => e.est_db).sort((a, b) => a - b)
          const median = dbs.length ? dbs[Math.floor(dbs.length / 2)] : null
          const mean = dbs.length ? dbs.reduce((s, x) => s + x, 0) / dbs.length : null
          const top = events[0] || null

          const aggregates = aggregate(events, histBins, denverOffset)

          res.end(JSON.stringify({
            listener: { lat, lon, elev_ft: elevFt, radius_nm: radiusNm },
            window: {
              from: new Date(fromMs).toISOString(),
              to: new Date(toMs).toISOString(),
              hours: +((toMs - fromMs) / 3600_000).toFixed(2),
            },
            summary: {
              total_events: events.length,
              peak_db: top ? top.est_db : null,
              peak_tail: top ? top.tail : null,
              peak_type: top ? top.type : null,
              peak_ts: top ? top.ts_at_closest : null,
              mean_db: mean != null ? +mean.toFixed(1) : null,
              median_db: median != null ? +median.toFixed(1) : null,
              db_floor: isFinite(dbFloor) ? dbFloor : null,
            },
            ...aggregates,
            events,
          }))
        } catch (err) {
          console.error('[noise/exposure] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err && err.message || err) }))
        }
      })

      console.log('[noise-exposure-api] endpoints registered: /api/noise/exposure[/flight/:hex]')
    },
  }
}

function discoverPlugin() {
  return {
    name: 'discover-api',
    configureServer(server) {
      server.middlewares.use('/api/discover', (req, res, next) => {
        if (req.method !== 'GET') return next()
        const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
        const format = (u.searchParams.get('format') || 'markdown').toLowerCase()
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Cache-Control', 'public, max-age=300')
        if (format === 'json') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(API_MANIFEST, null, 2))
        } else {
          res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
          res.end(manifestToMarkdown(API_MANIFEST))
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    // On Railway, serve tracks from Postgres; locally, from C:\tmp\noise_data\
    db.useDb ? dbTracksPlugin() : externalDataPlugin(),
    noiseApiPlugin(),  // pre-aggregated stats + filtered tracks (DB-only)
    sendNoticePlugin(),
    excursionsApiPlugin(),
    complaintsApiPlugin(),
    noiseReportsApiPlugin(),
    pilotApiPlugin(),
    flightsApiPlugin(),
    !db.useDb && liveCapturePlugin(),
    livePositionsPlugin(),
    adsbApiPlugin(),
    phaseMLApiPlugin(), // /api/phase-ml/{health,airports,classify,classify-archive}
    flightImpactPlugin(),
    aircraftIconsPlugin(),
    noiseZonesApiPlugin(),
    noiseExposurePlugin(),
    discoverPlugin(),
    // On Railway, strip the @vite/client HMR script from HTML to prevent
    // reload loops (the dev server WebSocket is unreachable via the proxy).
    process.env.RAILWAY_ENVIRONMENT && {
      name: 'strip-hmr-client',
      transformIndexHtml(html) {
        return html.replace(/<script[^>]*\/@vite\/client[^>]*><\/script>\s*/g, '')
      },
    },
  ].filter(Boolean),
  server: {
    port: parseInt(process.env.PORT || '5174'),
    allowedHosts: true,
    open: process.env.RAILWAY_ENVIRONMENT ? false : '/',
    // Disable HMR + warm-up on Railway — the WebSocket URL doesn't match
    // the public domain, causing connect → fail → reload loops.
    hmr: process.env.RAILWAY_ENVIRONMENT ? false : undefined,
    warmup: process.env.RAILWAY_ENVIRONMENT ? { clientFiles: [] } : undefined,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    },
    proxy: {
      // Two live ADS-B feeds. adsb.lol is the preferred primary; the client
      // auto-fails over to airplanes.live when it can't reach the primary.
      // Both are readsb-based; only the URL path differs.
      '/adsblol': {
        target: 'https://api.adsb.lol',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/adsblol/, ''),
      },
      '/airplaneslive': {
        target: 'https://api.airplanes.live',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/airplaneslive/, ''),
      },
      // When REMOTE_API=1 is set, forward /api/* to Railway production so
      // local dev gets the DB-backed endpoints (/api/noise/*, /api/tracks,
      // and live aircraft data) without running Postgres locally.
      // Local API plugins still register first; the proxy only catches
      // unmatched routes (because vite middleware runs before proxy).
      // To force ALL api calls to Railway, also remove the local plugins.
      ...(process.env.REMOTE_API === '1' ? {
        '/api': {
          target: 'https://web-app-production-fedf.up.railway.app',
          changeOrigin: true,
          secure: true,
        },
      } : {}),
    },
  },
})
