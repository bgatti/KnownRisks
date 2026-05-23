import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { loadPopGrid, impactSegments, pointImpact, POP_KERNEL } from './src/popGrid.js'
import { distFt, classifyPoint } from './src/geo.js'
import { NOISE_ZONES } from './src/noiseZones.js'

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
function bandsFromPoints(pts, popAt) {
  const out = []
  let cur = null
  let trackTotal = 0
  for (const p of pts) {
    const klass = classifyPoint(p[0], p[1], p[2], NOISE_ZONES)
    let imp = null
    if (popAt) {
      imp = Math.round(pointImpact(p[0], p[1], p[2], popAt))
      trackTotal += imp
    }
    const pt = imp != null ? [p[0], p[1], p[2], imp] : [p[0], p[1], p[2]]
    if (cur && cur.klass === klass) { cur.points.push(pt); if (imp != null) cur.impact += imp }
    else {
      if (cur) out.push(cur)
      cur = { klass, points: [pt] }
      if (imp != null) cur.impact = imp
    }
  }
  if (cur) out.push(cur)
  if (popAt && trackTotal > 0) {
    for (const b of out) b.impact_share = Math.round((b.impact / trackTotal) * 1000) / 1000
  }
  return out
}

// Population grid for the leaderboard's pop-impact explainer (computed live, so
// it works before the backfill column is populated). Optional.
let POPGRID = null
try { POPGRID = loadPopGrid('public/population_density.json') } catch { POPGRID = null }
const POP_SCALE = 1000 // pop_impact-per-ft that maps to impact_index = 1 (keep in sync with leaderboard)
const LEADERBOARD_FLIGHT_EXP = 1.5 // super-linear frequency emphasis
const LEADERBOARD_ZONE_K = 12      // zone-proxy impact scaling (pre-population fallback)
const missionsCache = new Map()    // key `${days}|${scope}|${airport}` → { ts, body } (5-min TTL)

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
          for (const t of matches) {
            const m = (t.src || '').match(/(\d{4}-\d{2}-\d{2})/)
            const date = m ? m[1] : (t.src === 'live' ? toDate : null)
            const isLive = t.src === 'live'
            // Build the point list to walk. When a precise window was
            // requested and the track has per-point timestamps, drop points
            // outside it; otherwise use all points.
            const walk = (filterPointsByTime && t.points.length && typeof t.points[0][3] === 'number')
              ? t.points.filter((p) => p[3] >= fromMs && p[3] <= toMs)
              : t.points
            if (walk.length === 0) continue
            const segments = []
            let cur = null
            for (let i = 0; i < walk.length; i++) {
              const p = walk[i]
              const { klass, zone } = classifyPoint(p[0], p[1], p[2])
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
              // Detect descents: count times the track drops below field elev + 300 ft
              const fieldElev = 5288 // KBDU default; good enough for classification
              const descThreshold = fieldElev + 300
              let descents = 0, wasHigh = false
              for (const p of walk) {
                if (p[2] > descThreshold) wasHigh = true
                else if (wasHigh) { descents++; wasHigh = false }
              }
              const firstLow = walk[0] && walk[0][2] < descThreshold
              const lastLow = walk[walk.length - 1] && walk[walk.length - 1][2] < descThreshold
              let phase = 'overflight'
              if (firstLow && lastLow && descents >= 2) phase = 'pattern'
              else if (firstLow && !lastLow) phase = 'departure'
              else if (!firstLow && lastLow) phase = 'arrival'
              else if (firstLow && lastLow) phase = 'pattern'
              tracksOut.push({
                tail: t.call || t.reg || tail || '?',
                type: t.type || '',
                src: t.src, date, live: isLive,
                phase, descents, hasDescents: descents > 0,
                segments: filtered,
              })
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
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const hours = Number(u.searchParams.get('hours')) || 1
          const limit = Math.min(500, Number(u.searchParams.get('limit')) || 100)
          const includeSet = new Set(
            (u.searchParams.get('include') || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          )
          const SEV = { yellow: 1, orange: 2, red: 3, purple: 4 }
          const nowMs = Date.now()
          const fromDate = new Date(nowMs - hours * 3600 * 1000).toISOString().slice(0, 10)
          const toDate = new Date(nowMs).toISOString().slice(0, 10)

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
              ORDER BY
                CASE WHEN seg_purple > 0 THEN 0
                     WHEN worst_class = 'red' THEN 1
                     WHEN worst_class = 'orange' THEN 2
                     ELSE 3 END,
                rand_key
              LIMIT $3
            `
            tracksRes = await db.queryDb(tracksSql, [fromDate, toDate, limit])
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
            GROUP BY call, type, school, base_airport
            ORDER BY
              CASE MAX(worst_class)
                WHEN 'purple' THEN 4 WHEN 'red' THEN 3
                WHEN 'orange' THEN 2 WHEN 'yellow' THEN 1
                ELSE 0 END DESC,
              SUM(seg_red) DESC
          `
          const activeRes = await db.queryDb(activeSql, [fromDate, toDate])
          const active = activeRes.rows.map(r => ({
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
            const liveRes = await db.queryDb(
              'SELECT tracks, updated_at FROM live_tracks WHERE day = CURRENT_DATE ORDER BY id DESC LIMIT 1'
            )
            if (liveRes.rows.length) {
              const rawLive = liveRes.rows[0].tracks || []
              liveCount = rawLive.length
              liveUpdatedAt = liveRes.rows[0].updated_at || null
              for (const t of rawLive) {
                if (!t.bands || t.bands.length === 0) continue
                // Trim each band's points to the time window when possible.
                // Bands whose last point is older than the cutoff are dropped;
                // bands spanning the cutoff get their leading points sliced.
                const trimmedBands = []
                for (const b of t.bands) {
                  const pts = b.points || []
                  if (!pts.length) continue
                  const hasTs = pts[pts.length - 1].length > 3
                  if (!hasTs) { trimmedBands.push(b); continue }
                  // Find the first point >= windowFromMs
                  let startIdx = pts.length
                  for (let i = 0; i < pts.length; i++) {
                    if (pts[i][3] >= windowFromMs) { startIdx = i; break }
                  }
                  if (startIdx >= pts.length) continue // whole band is too old
                  // Keep the last point before the window as a bridge for continuity
                  const slice = startIdx > 0 ? pts.slice(startIdx - 1) : pts.slice(startIdx)
                  if (slice.length >= 2) trimmedBands.push({ ...b, points: slice })
                }
                if (!trimmedBands.length) continue
                liveTracks.push({
                  call: t.call || t.reg || '?',
                  type: t.type || '',
                  src: 'live',
                  date: toDate,
                  base: null,
                  worst: t.worst || null,
                  school: null,
                  seg_total: t.seg_total || 0,
                  seg_red: t.seg_red || 0,
                  seg_orange: t.seg_orange || 0,
                  seg_yellow: t.seg_yellow || 0,
                  len_total_ft: t.len_total_ft || 0,
                  len_red_ft: t.len_red_ft || 0,
                  len_orange_ft: t.len_orange_ft || 0,
                  len_yellow_ft: t.len_yellow_ft || 0,
                  bands: trimmedBands,
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

          // ── Merge live tracks into per-tail active aggregation ──
          // The active SQL above only scans the historical `tracks` table,
          // which doesn't include today's in-progress flights. Without this
          // merge, /boot returns 0 active for hours<24 even when /active sees
          // live violations. Counts come from the trimmed bands so they
          // reflect points still in the requested window.
          const liveByTail = new Map()
          for (const lt of liveTracks) {
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

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({
            generated_at: new Date(nowMs).toISOString(),
            window: {
              hours, from: fromDate, to: toDate, limit,
              from_ms: windowFromMs, to_ms: nowMs,
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
              note: 'Each track.bands[] is an array of {klass, points} runs. Render each run as a Polyline colored by klass (null = clean_color). Points are [lat, lon, alt_ft]. Adjacent runs share their boundary point for continuity.',
            },
            active,
            tracks: [...tracksRes.rows, ...liveTracks],
            live: { updated_at: liveUpdatedAt, tracks: liveCount },
          }))
        } catch (err) {
          console.error('[excursions-boot] error', err)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
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

// GET  /api/complaints[?tail=...]  → list all or filter by tail
// POST /api/complaints               → lodge a complaint against an excursion
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
            let list
            if (db.useDb) {
              list = await db.getComplaints(tail || null)
            } else {
              const data = await loadAll(fs, path)
              list = tail
                ? data.complaints.filter((c) => (c.tail || '').toUpperCase() === tail)
                : data.complaints
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
          if (!tail || !startedAt || !klass) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'missing required fields: tail, startedAt, klass' }))
            return
          }
          const record = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: new Date().toISOString(),
            tail,
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
            await db.addComplaint(record)
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

          const today = new Date().toISOString().slice(0, 10)
          const range = await db.loadLiveFromDbByDateRange(today, today)
          const tracks = range.tracks || []

          // call → base/purpose/school/desc from the historical classification
          const tails = [...new Set(tracks.map((t) => (t.call || '').trim()).filter(Boolean))]
          const info = new Map()
          if (tails.length) {
            const r = await db.queryDb(
              `SELECT call,
                 (array_agg(base_airport ORDER BY date DESC) FILTER (WHERE base_airport IS NOT NULL))[1] AS base,
                 (array_agg(purpose      ORDER BY date DESC) FILTER (WHERE purpose      IS NOT NULL))[1] AS purpose,
                 (array_agg(school       ORDER BY date DESC) FILTER (WHERE school       IS NOT NULL))[1] AS school,
                 (array_agg(desc_text    ORDER BY date DESC) FILTER (WHERE desc_text    IS NOT NULL))[1] AS descr
               FROM tracks WHERE call = ANY($1) GROUP BY call`, [tails])
            for (const row of r.rows) info.set(row.call, row)
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
            const atAirport = []
            for (const f of adsb.extractTowCycles(t.hex, t.call, pts, zoneConfig)) {
              if (!f.takeoff_ts || !f.landing_ts) continue
              const tMs = Date.parse(f.takeoff_ts), lMs = Date.parse(f.landing_ts)
              if (!Number.isFinite(tMs) || !Number.isFinite(lMs)) continue
              if ((nowMs - lMs) > minutesMs) continue
              // Endpoint of this cycle (last fix at or before landing_ts).
              let endPt = null
              for (const p of pts) { if (p[3] != null && p[3] <= lMs) endPt = p; else if (p[3] > lMs) break }
              if (!endPt) continue
              if (distNmAp(endPt[0], endPt[1], ap.lat, ap.lon) > LANDING_NEAR_NM) continue
              atAirport.push({ takeoff_ts: f.takeoff_ts, landing_ts: f.landing_ts, tMs, lMs })
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
              const groundCeil = ap.elev + 200
              if (last && last[3] != null && (nowMs - last[3]) <= minutesMs
                  && last[2] != null && last[2] <= tdAlt
                  && distNmAp(last[0], last[1], ap.lat, ap.lon) <= LANDING_NEAR_NM) {
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
              out.push({
                tail, type: t.type || null, desc: inf.descr || expandType(t.type),
                icon_url: aircraftIconUrl(t.type, tail),
                base: inf.base || null, purpose, school: inf.school || null,
                origin: o.dist <= 3 ? o.code : null, dest: airport,
                origin_dist_nm: Math.round(distNmAp(p0[0], p0[1], ap.lat, ap.lon) * 10) / 10,
                landed: true,
                landed_at: new Date(lMs).toISOString(),
                on_ground_min: Math.round(Math.max(0, (nowMs - lMs) / 60000) * 10) / 10,
                airborne_min: Math.round(Math.max(0, (lMs - tMs) / 60000) * 10) / 10,
                impact_index: Math.round(impact_index * 1000) / 1000,
                impact_score, impact_grade: impactGrade(impact_score),
                pop_impact: Math.round(total),
                bands: bandsFromPoints(cyclePts, POPGRID.popAt),
              })
            }
          }
          out.sort((a, b) => (b.landed_at || '').localeCompare(a.landed_at || ''))
          res.end(JSON.stringify({
            generated_at: new Date(nowMs).toISOString(),
            airport, minutes, pop_scale: POP_SCALE,
            scoring: {
              impact_index: 'population-noise per ft / POP_SCALE (same kernel as leaderboard & impact-explain)',
              impact_score: 'alias of impact_index (no purpose multiplier — purpose-aware ranking is a caller concern)',
              impact_grade: 'A<0.3 B<0.6 C<1.2 D<2.0 F',
            },
            count: out.length,
            landings: out,
          }))
        } catch (e) {
          console.error('[noise-api] /recent-landings error', e)
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

      // ── GET /api/adsb/track/:icao ──────────────────────────────────
      server.middlewares.use('/api/adsb/track/', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          // Extract icao from path: /api/adsb/track/a59663 → url is /a59663
          const icao = u.pathname.replace(/^\//, '').toLowerCase()
          if (!icao) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'icao required' }))
            return
          }

          const sinceParam = u.searchParams.get('since')
          const since = sinceParam ? new Date(sinceParam).getTime() : Date.now() - 4 * 3600 * 1000

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
            res.end(JSON.stringify({ error: 'icao not found' }))
            return
          }

          // Filter points by since timestamp
          const filtered = (track.points || []).filter(p =>
            !p[3] || p[3] >= since
          )

          const phases = adsb.detectPhases(filtered, zoneConfig)
          const tail = fleet[icao]?.tail || track.call || icao

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({
            icao,
            tail,
            points: filtered.map(p => ({
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
  const scoreRecentLandings = async (airport, minutes) => {
    const score = await import('./flightScore.js')
    const [zoneConfig, fleet, live, allZones, complaints, popGrid] = await Promise.all([
      adsb.loadZones(), adsb.loadFleet(), loadLive(),
      loadZonesByName(), loadComplaints(), loadPopGrid(),
    ])
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
          const { byId } = await scoreRecentLandings(null, minutes)
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
          const { scored } = await scoreRecentLandings(airport, minutes)
          json(res, 200, {
            airport, window_minutes: minutes,
            generated_at: new Date().toISOString(),
            count: scored.length,
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
            tracks: '[{tail, type, src, date, live, phase, descents, segments:[{klass, zone, points, startedAt, endedAt}]}]',
            center: '{lat, lon, radius_mi, radius_ft} | null',
            window: '{hours, from, to, limit}',
            matched: 'int — total tracks before limit',
          },
          example: '/api/excursions/segments?lat=40.04&lon=-105.22&radius_mi=5&hours=2',
          example2: '/api/excursions/segments?lat=40.04&lon=-105.22&radius_nm=2&from=2026-05-07T20:15:00Z&to=2026-05-07T20:30:00Z',
          notes: 'Each segment.klass is null|yellow|orange|red — null = clean, others = noise violation severity. Points are [lat, lon, alt_ft, ts_ms]. Live tracks (src=live) carry per-point timestamps for sub-second filtering; historical tracks are date-only.',
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
          response: { active: '[{tail, worst, counts, pointsHit, lastDate, live}]', tracks: 'array of tracks with bands', live: '{updated_at, tracks}' },
          example: '/api/excursions/boot?hours=1&include=reports,notifications',
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
          path: '/api/adsb/track/:icao',
          purpose: 'Full track + detected flight phases for one aircraft.',
          params: [{ name: 'since', type: 'iso-timestamp', default: '4h ago', desc: 'Only points after this time.' }],
          response: { icao: 'string', tail: 'string', points: '[{ts, lat, lon, alt, gs, vs}]', phases: '[{type, start_ts, end_ts, alt_start, alt_end}]' },
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
    !db.useDb && liveCapturePlugin(),
    livePositionsPlugin(),
    adsbApiPlugin(),
    flightImpactPlugin(),
    aircraftIconsPlugin(),
    noiseZonesApiPlugin(),
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
