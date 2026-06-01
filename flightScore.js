// flightScore.js — Score a completed flight for its impact on the
// community below, then translate that into an encouraging "Good Neighbor
// Score" where a HIGHER number means a gentler, more considerate flight.
//
// Inputs (all reuse modules already tested in this project):
//   1. Noise on the ground × population density   (noise kernel below +
//      population_density.json grid, model mirrors noise/noise_heatmap.py)
//   2. Community voices about the flight           (data/complaints.json)
//   3. Neighborhood overlap — how far/long the path crossed a noise
//      abatement area and how low it was           (src/geo.js trackLengthFt
//      / classifyPoint, the same logic the live map already trusts)
//   4. All of the above is divided by total trip time, so a longer, calmer
//      flight is never penalised for simply staying aloft.
//
// The scoring is deliberately written in carrot language: every field name
// and highlight celebrates considerate flying. There are no penalties here,
// only opportunities to shine.

import { trackLengthFt, classifyPoint, isEnginelessType } from './src/geo.js'

// Engine horsepower by ICAO type — the source value the noise model scales
// from. Mirrors HP_BY_ICAO in src/noise.js; kept here (rather than imported)
// so this scorer stays node-safe and free of the browser-only canvas/terrain
// dependencies that src/noise.js drags in. Keep the two tables in sync.
const DEFAULT_HP = 180
const HP_BY_ICAO = {
  C140: 90, C150: 100, C152: 110, C162: 100, C172: 180, C72R: 180, C177: 180,
  C182: 230, C82R: 230, C185: 300, C206: 300, C210: 300, C240: 230,
  DA40: 180, DV20: 100, SR20: 215, SR22: 310, S22T: 315, SP20: 215,
  COL3: 310, COL4: 310, M20P: 200, M20T: 280,
  P28A: 160, P28B: 180, P28R: 200, P28T: 300, P32R: 300,
  PA11: 90, PA12: 115, PA16: 108, PA18: 150, BE35: 285, BE36: 300, AA5: 150,
  CH7A: 118, CH7B: 150, CRUZ: 100, T34P: 285, T6: 600, HUSK: 200,
  RV4: 160, RV6: 180, RV7: 180, RV8: 180, RV12: 100,
  LNC2: 200, LGEZ: 180, ERCO: 75,
  BDOG: 200, EAGL: 180, FOX: 180, ULAC: 100, VL3: 100, EXPR: 210, AR65: 420,
  BE55: 520, BE76: 360, BE40: 800, C310: 520, C421: 750, C425: 900,
  PA34: 440, PA44: 360, P337: 420, P06T: 700, SW3: 1400,
  BE30: 1250, B350: 2100, PC12: 1200, M600: 600,
  TBM7: 700, TBM8: 850, TBM9: 850, PA46: 350, P46T: 500, PAY1: 1000,
  AC90: 1400, C208: 675,
  B38M: 8000, B752: 10000, C25C: 2500, C25M: 2500, C510: 1800, C525: 2200,
  C55B: 3000, C560: 3500, C56X: 3500, C650: 4500, C680: 4500, C68A: 4500,
  C700: 5000, C750: 5500, CL30: 4500, CL35: 4500, CL60: 5000,
  E135: 5000, E145: 5000, E55P: 2500, F2TH: 5000, F900: 6000,
  G200: 5000, GLEX: 7000, GLF4: 6500, GLF5: 7000, H25B: 5000, HDJT: 1500,
  LJ31: 3000, LJ45: 3500, LJ60: 4500, LJ70: 4500,
  R44: 245, B06: 420, B407: 700, H500: 420, AS50: 590, UH1: 1400,
  GLID: 0, BALL: 0, XNOS: 0, COY2: 0,
}
function hpForType(type) {
  if (!type) return DEFAULT_HP
  const v = HP_BY_ICAO[type.toUpperCase()]
  return v == null ? DEFAULT_HP : v
}

// ── Noise model constants (mirror noise/noise_heatmap.py) ───────────────
// Calibrated so a 180 HP single at 1000 ft overhead full-power climb reads
// ~77 dBA. Kept here as a self-contained scalar kernel so this module runs
// in plain Node (the browser heatmap in src/noise.js needs a <canvas>).
const REF_SOURCE_DB = 95
const HP_REF = 100
const V_REF_KTS = 100
const FT_PER_M = 3.28084
const G_TERRAIN = 0.65
const ALPHA_ATM = 0.0016
const SPREAD_EXP = 25.0
const MIN_SLANT_FT = 50

// ── Population lookup ───────────────────────────────────────────────────
// population_density.json stores row 0 = north (latMax), built by
// noise/build_population_density.py (it reverses the grid before emit).
export function popDensityAt(lat, lon, popGrid) {
  if (!popGrid || !popGrid.grid) return 0
  const { bounds, gridW, gridH, grid } = popGrid
  const { latMin, latMax, lonMin, lonMax } = bounds
  if (lat < latMin || lat > latMax || lon < lonMin || lon > lonMax) return 0
  const col = Math.floor(((lon - lonMin) / (lonMax - lonMin)) * gridW)
  const row = Math.floor(((latMax - lat) / (latMax - latMin)) * gridH)
  const r = grid[row]
  if (!r) return 0
  const v = r[col]
  return v > 0 ? v : 0
}

// ── Ground-noise × population grid ──────────────────────────────────────
// Builds a small local grid around the flight. Each cell holds the loudest
// single-segment level the flight produced there (LMax, in dB), and the
// "impact" = linear noise energy × people-per-km² at that cell. The grid
// doubles as the heat layer for the embeddable map frame.
//
// AGL is taken relative to a flat field elevation — good enough for a
// relative community-exposure measure and keeps the kernel dependency-free.
export function buildImpactGrid(points, type, popGrid, opts = {}) {
  const {
    halfKm = 10,
    cellM = 250,
    dtS = 1,
    influenceKm = 4,
    fieldElevFt = 5288,
    maxPoints = 400,
  } = opts

  const out = { bounds: null, w: 0, h: 0, db: null, impact: null, exposure: 0, peakDb: null }
  if (!points || points.length < 2) return out

  const hp = hpForType(type)
  if (hp <= 0) {
    // Silent aircraft (gliders, balloons) — the gentlest neighbors of all.
    return { ...out, exposure: 0, peakDb: null, silent: true }
  }
  const hpDb = 10 * Math.log10(hp / HP_REF)

  // Subsample very long tracks so a marathon flight stays cheap to score.
  let pts = points.filter((p) => p && p[0] != null && p[1] != null && p[2] != null)
  if (pts.length > maxPoints) {
    const step = Math.ceil(pts.length / maxPoints)
    pts = pts.filter((_, i) => i % step === 0 || i === pts.length - 1)
  }
  if (pts.length < 2) return out

  // Centre the grid on the track's centroid.
  let sumLat = 0, sumLon = 0
  for (const p of pts) { sumLat += p[0]; sumLon += p[1] }
  const lat0 = sumLat / pts.length
  const lon0 = sumLon / pts.length
  const mPerDegLat = 111320
  const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180)

  const n = Math.max(16, Math.round((2 * halfKm * 1000) / cellM))
  const energy = new Float64Array(n * n) // linear LMax power per cell
  const halfIdx = (n - 1) / 2
  const infM = influenceKm * 1000
  const infM2 = infM * infM

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const xa = (a[1] - lon0) * mPerDegLon
    const ya = (a[0] - lat0) * mPerDegLat
    const xb = (b[1] - lon0) * mPerDegLon
    const yb = (b[0] - lat0) * mPerDegLat
    const segDx = xb - xa, segDy = yb - ya
    const seg2 = segDx * segDx + segDy * segDy
    const segDist = Math.sqrt(seg2)

    const dz = b[2] - a[2]
    const stateDb = dz > 50 ? 0 : dz < -50 ? -6 : -3
    const vKts = Math.max(30, (segDist / dtS) * 1.94384)
    const doseDb = 10 * Math.log10(V_REF_KTS / Math.max(vKts, 20))

    let vx = segDx, vy = segDy
    if (segDist < 1e-3) { vx = 1; vy = 0 } else { vx /= segDist; vy /= segDist }

    const srcDb = REF_SOURCE_DB + hpDb + stateDb + doseDb

    const minX = Math.min(xa, xb), maxX = Math.max(xa, xb)
    const minY = Math.min(ya, yb), maxY = Math.max(ya, yb)
    const x0 = Math.max(0, Math.floor((minX - infM) / cellM + halfIdx))
    const x1 = Math.min(n, Math.ceil((maxX + infM) / cellM + halfIdx) + 1)
    const y0 = Math.max(0, Math.floor((minY - infM) / cellM + halfIdx))
    const y1 = Math.min(n, Math.ceil((maxY + infM) / cellM + halfIdx) + 1)

    for (let row = y0; row < y1; row++) {
      const cellY = (row - halfIdx) * cellM
      for (let col = x0; col < x1; col++) {
        const cellX = (col - halfIdx) * cellM

        let tParam = 0
        if (seg2 > 1e-6) {
          tParam = ((cellX - xa) * segDx + (cellY - ya) * segDy) / seg2
          if (tParam < 0) tParam = 0
          else if (tParam > 1) tParam = 1
        }
        const qx = xa + segDx * tParam
        const qy = ya + segDy * tParam
        const qAlt = a[2] + (b[2] - a[2]) * tParam
        const qAglFt = Math.max(qAlt - fieldElevFt, 0)

        const sdx = cellX - qx
        const sdy = cellY - qy
        const horiz2 = sdx * sdx + sdy * sdy
        if (horiz2 > infM2) continue
        const horizFt = Math.sqrt(horiz2) * FT_PER_M
        const slantFt = Math.max(Math.hypot(qAglFt, horizFt), MIN_SLANT_FT)

        let db = srcDb - SPREAD_EXP * Math.log10(slantFt / 100)
        const theta = Math.atan2(qAglFt, Math.max(horizFt, 1e-6))
        db -= G_TERRAIN * (10 - 8 * Math.sin(theta))
        db -= G_TERRAIN * 9.5 * Math.pow(Math.cos(theta), 2.5)
        db -= ALPHA_ATM * slantFt

        const qAglM = qAglFt / FT_PER_M
        const slantM = Math.sqrt(horiz2 + qAglM * qAglM) + 1e-6
        const cosT = (sdx * vx + sdy * vy) / slantM
        const sin2 = Math.max(0, Math.min(1, 1 - cosT * cosT))
        db += 10 * Math.log10(sin2 + 0.05)

        const lin = Math.pow(10, db / 10)
        const idx = row * n + col
        if (lin > energy[idx]) energy[idx] = lin
      }
    }
  }

  // Convert to dB + fold in population density.
  const dbArr = new Float32Array(n * n)
  const impact = new Float32Array(n * n)
  let dbMax = -Infinity
  let exposure = 0
  const cellAreaKm2 = (cellM / 1000) * (cellM / 1000)
  for (let row = 0; row < n; row++) {
    const cellLat = lat0 + ((row - halfIdx) * cellM) / mPerDegLat
    for (let col = 0; col < n; col++) {
      const idx = row * n + col
      const e = energy[idx]
      if (e <= 0) { dbArr[idx] = -Infinity; continue }
      const d = 10 * Math.log10(e)
      dbArr[idx] = d
      if (d > dbMax) dbMax = d
      const cellLon = lon0 + ((col - halfIdx) * cellM) / mPerDegLon
      const people = popDensityAt(cellLat, cellLon, popGrid) * cellAreaKm2
      // Impact for a cell = how much sound energy reached it, multiplied by
      // how many neighbors are there to hear it.
      const cellImpact = e * people
      impact[idx] = cellImpact
      exposure += cellImpact
    }
  }

  const dLat = (halfKm * 1000) / mPerDegLat
  const dLon = (halfKm * 1000) / mPerDegLon
  return {
    bounds: [[lat0 - dLat, lon0 - dLon], [lat0 + dLat, lon0 + dLon]],
    w: n,
    h: n,
    db: dbArr,
    impact,
    exposure,
    peakDb: isFinite(dbMax) ? +dbMax.toFixed(1) : null,
  }
}

// ── Neighborhood overlap (degree + length of time) ──────────────────────
// Reuses src/geo.js classification (zone polygon + 7500 ft overflight rule).
// Reports both how far the path ran through an abatement area (feet, from
// the tested trackLengthFt) and how long it lingered there (seconds, from
// the point timestamps), banded by closeness.
// `opts.typeCode`: when the aircraft is engineless, all zone/time tallies
// stay at zero — gliders and balloons are VNAP-exempt.
export function neighborhoodOverlap(points, zones, opts = {}) {
  const engineless = isEnginelessType(opts.typeCode)
  const lengths = trackLengthFt(points, zones || [], { engineless })

  let yellowS = 0, orangeS = 0, redS = 0, totalS = 0
  if (points.length >= 2 && !engineless) {
    const tags = points.map((p) => classifyPoint(p[0], p[1], p[2], zones || []))
    const rank = { yellow: 1, orange: 2, red: 3 }
    for (let i = 1; i < points.length; i++) {
      const ta = points[i - 1][3], tb = points[i][3]
      const dt = ta != null && tb != null ? Math.max(0, (tb - ta) / 1000) : 0
      totalS += dt
      const worst = (rank[tags[i - 1]] || 0) >= (rank[tags[i]] || 0) ? tags[i - 1] : tags[i]
      if (worst === 'red') redS += dt
      else if (worst === 'orange') orangeS += dt
      else if (worst === 'yellow') yellowS += dt
    }
  }
  return {
    feet: lengths,
    seconds: {
      yellow: +yellowS.toFixed(1),
      orange: +orangeS.toFixed(1),
      red: +redS.toFixed(1),
      inZone: +(yellowS + orangeS + redS).toFixed(1),
      total: +totalS.toFixed(1),
    },
  }
}

// ── Community voices ────────────────────────────────────────────────────
// Find voices raised about this tail whose reported window overlaps the
// flight. Severity weight mirrors the yellow/orange/red bands used
// everywhere else.
const VOICE_WEIGHT = { yellow: 1, orange: 2, red: 3 }

export function matchVoices(complaints, tail, startMs, endMs) {
  if (!Array.isArray(complaints) || !tail) return []
  const T = String(tail).toUpperCase()
  // Pad the flight window so a voice raised a little before/after still counts.
  const pad = 10 * 60 * 1000
  const lo = startMs - pad
  const hi = endMs + pad
  return complaints.filter((c) => {
    if ((c.tail || '').toUpperCase() !== T) return false
    const s = c.startedAt ? Date.parse(c.startedAt) : NaN
    const e = c.endedAt ? Date.parse(c.endedAt) : s
    if (!isFinite(s)) return false
    return e >= lo && s <= hi
  })
}

// ── Complaint projection for kiosk overlay ─────────────────────────────
// Project a raw complaint into the kiosk-friendly shape used by the impact
// feed and the live-flights feed:
//   - geocoded complaints (lat/lon present) → map pin colored by klass
//   - tail-only complaints → halo on the matching flight's track
//
// dBFS is parsed from `notes` when present (the form: "... sustained -82 dBFS …").
// Estimated dBA = dBFS + 132 (caller's calibration constant; keep this in
// lock-step with the kiosk's calibrator).
const COMPLAINT_DBFS_RE = /([-+]?\d+(?:\.\d+)?)\s*dBFS/i
const DBFS_TO_DBA_CALIBRATION = 132

export function projectComplaint(c) {
  if (!c) return null
  const m = c.notes ? COMPLAINT_DBFS_RE.exec(c.notes) : null
  const dbfs = m ? Number(m[1]) : null
  return {
    id: c.id || null,
    tail: c.tail || null,
    klass: c.klass || null,
    created_at: c.createdAt || null,
    started_at: c.startedAt || null,
    ended_at: c.endedAt || null,
    lat: c.lat ?? null,
    lon: c.lon ?? null,
    distance_miles: c.distanceMiles ?? null,
    dbfs: Number.isFinite(dbfs) ? dbfs : null,
    dba_estimate: Number.isFinite(dbfs) ? Math.round(dbfs + DBFS_TO_DBA_CALIBRATION) : null,
    notes: c.notes || null,
  }
}

// Compute a band's [startMs, endMs]. Prefers explicit `start_ms`/`end_ms`
// fields (set by bandsFromPoints, where points carry impact in slot 3 not
// timestamps); otherwise reads timestamps from point tuples / object form.
// Returns null when no usable signal exists (historical 3-tuples) —
// caller falls back to whole-track attribution.
function bandTimeWindow(band) {
  if (!band) return null
  if (typeof band.start_ms === 'number' && typeof band.end_ms === 'number') {
    return [band.start_ms, band.end_ms]
  }
  let lo = null, hi = null
  for (const p of (band.points || [])) {
    // Skip 4-tuples that look like impact (small integers under 1e10) —
    // ms-since-epoch is always > 1e12 for modern dates.
    const v = Array.isArray(p) ? p[3] : (p && (p.ts ?? p.tsUnix))
    const n = typeof v === 'number' ? v : (typeof v === 'string' ? Date.parse(v) : NaN)
    if (Number.isFinite(n) && n > 1e12) {
      if (lo == null || n < lo) lo = n
      if (hi == null || n > hi) hi = n
    }
  }
  return lo != null && hi != null ? [lo, hi] : null
}

// Per-band complaint enrichment.
//
// Mutates `bands` in place adding `complaints[]`, `complaint_dba_max`,
// `complaint_count`, and `complaint_worst_klass`. Mutates `complaints`
// adding `band_indices: [n, m, …]` so the kiosk can render either way
// (per-band glow or per-track halo from the top-level list).
//
// Matching: a complaint belongs to a band when their time windows
// overlap (using the same ±10-min pad as the tail-level match). When a
// band has no per-point timestamps (historical 3-tuple shape), all
// complaints attach to all bands — the kiosk falls back to whole-track
// glow without explicit fallback code.
//
// Returns the bands array for chaining.
const COMPLAINT_KLASS_RANK = { yellow: 1, orange: 2, red: 3 }
export function attachComplaintsToBands(bands, complaints, opts = {}) {
  if (!Array.isArray(bands) || !bands.length) return bands
  const pad = opts.pad ?? 10 * 60 * 1000
  const list = Array.isArray(complaints) ? complaints : []
  // Precompute each band's window (null when not timestamped).
  const windows = bands.map(bandTimeWindow)
  const anyTimestamped = windows.some(w => w != null)
  // Initialise per-band fields.
  for (const b of bands) {
    b.complaints = []
    b.complaint_dba_max = null
    b.complaint_count = 0
    b.complaint_worst_klass = null
  }
  for (const c of list) {
    c.band_indices = []
    const cStart = c.started_at ? Date.parse(c.started_at) : NaN
    const cEnd = c.ended_at ? Date.parse(c.ended_at) : cStart
    const cLo = isFinite(cStart) ? cStart - pad : null
    const cHi = isFinite(cEnd) ? cEnd + pad : null
    for (let i = 0; i < bands.length; i++) {
      const w = windows[i]
      let overlap
      if (w && cLo != null && cHi != null) {
        overlap = w[1] >= cLo && w[0] <= cHi
      } else if (!anyTimestamped) {
        // Whole track has no per-band time info → attach to every band so
        // the kiosk still highlights everything (degrades to track-level).
        overlap = true
      } else {
        // This band lacks timestamps but others have them → can't decide,
        // skip (conservative: avoid mislabeling adjacent bands).
        overlap = false
      }
      if (!overlap) continue
      c.band_indices.push(i)
      const b = bands[i]
      b.complaints.push(c)
      b.complaint_count++
      if (c.dba_estimate != null && (b.complaint_dba_max == null || c.dba_estimate > b.complaint_dba_max)) {
        b.complaint_dba_max = c.dba_estimate
      }
      if (c.klass && (!b.complaint_worst_klass || COMPLAINT_KLASS_RANK[c.klass] > COMPLAINT_KLASS_RANK[b.complaint_worst_klass])) {
        b.complaint_worst_klass = c.klass
      }
    }
  }
  return bands
}

// Tail+window match (same ±10-min pad as matchVoices), projected for the kiosk.
export function matchComplaintsForKiosk(complaints, tail, startMs, endMs) {
  if (!Array.isArray(complaints) || !tail) return []
  const T = String(tail).toUpperCase()
  const pad = 10 * 60 * 1000
  const lo = startMs - pad
  const hi = endMs + pad
  const out = []
  for (const c of complaints) {
    if ((c.tail || '').toUpperCase() !== T) continue
    const s = c.startedAt ? Date.parse(c.startedAt) : NaN
    const e = c.endedAt ? Date.parse(c.endedAt) : s
    if (!isFinite(s)) continue
    if (e < lo || s > hi) continue
    out.push(projectComplaint(c))
  }
  return out
}

// All complaints within a window, projected. Used to drive map pins
// independent of which flight they're attributed to.
export function recentComplaintsForKiosk(complaints, windowMinutes) {
  if (!Array.isArray(complaints)) return []
  const now = Date.now()
  const cutoff = now - windowMinutes * 60 * 1000
  const out = []
  for (const c of complaints) {
    const s = c.createdAt ? Date.parse(c.createdAt) : (c.startedAt ? Date.parse(c.startedAt) : NaN)
    if (!isFinite(s)) continue
    if (s < cutoff || s > now) continue
    out.push(projectComplaint(c))
  }
  // Newest first.
  out.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
  return out
}

// ── Noise reports (per-segment enrichment for /api/adsb/impact) ────────
// Project the persisted noise-report store into the per-flight `noise_reports[]`
// array — one entry per reportedSegments[] element. Falls back to a synthetic
// single-segment when a report has the older `excursion` shape (no points array)
// so callers don't lose data from before reportedSegments[] was wired in.
//
// Pure function, no I/O. Audio attachments (noise_audio, media[], any *.mp3
// references) are intentionally not consulted — this is metadata-only.
//
// `opts.source` filters by inferred submission source: 'manual', 'auto', 'any'.

// Heuristic source classifier. A report is "manual" when a human submitted it
// (reporter email/name/id present and not a system actor); otherwise "auto".
// Explicit fields override: r.source, r.autoGenerated, r.mode === 'auto'.
function inferReportSource(r) {
  if (r && (r.source === 'manual' || r.source === 'auto')) return r.source
  // Prod uses `auto: true` on the raw report and on each segment.
  if (r && (r.autoGenerated === true || r.auto === true)) return 'auto'
  if (r && r.mode === 'auto') return 'auto'
  const rep = r && r.reporter
  // Prod stores reporter as a string like 'anon:phep2io4ah' for auto reports;
  // when no explicit auto-tag, a string reporter starting with 'anon:' is auto.
  if (typeof rep === 'string' && rep.startsWith('anon:')) return 'auto'
  if (rep && typeof rep === 'object' && (rep.email || rep.name || rep.id) && rep.kind !== 'system') return 'manual'
  if (typeof rep === 'string' && rep) return 'manual'
  return 'auto'
}

function parseTsLoose(v) {
  if (v == null) return NaN
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000 // accept s or ms
  if (typeof v === 'string') return Date.parse(v)
  return NaN
}

// Segment points come in two shapes in the wild:
//   tuple  : [lat, lon, alt, ts_ms]   (prod Postgres reportedSegments[].points)
//   object : { ts, lat, lon, alt }    (proposal contract; matchVoices tests)
function ptTs(p) {
  if (Array.isArray(p)) return parseTsLoose(p[3])
  if (p && typeof p === 'object') return parseTsLoose(p.ts ?? p.tsUnix)
  return NaN
}
function ptToObject(p) {
  if (Array.isArray(p)) {
    const ts = parseTsLoose(p[3])
    return { ts: isFinite(ts) ? new Date(ts).toISOString() : null, lat: p[0], lon: p[1], alt: p[2] }
  }
  return p
}

export function matchReportSegments(reports, tail, startMs, endMs, opts = {}) {
  if (!Array.isArray(reports) || !tail) return []
  const T = String(tail).toUpperCase()
  const pad = 10 * 60 * 1000 // same ±10 min as matchVoices
  const lo = startMs - pad
  const hi = endMs + pad
  const sourceFilter = opts.source || 'any' // 'manual' | 'auto' | 'any'

  const out = []
  for (const r of reports) {
    const source = inferReportSource(r)
    if (sourceFilter !== 'any' && source !== sourceFilter) continue

    // Prefer explicit reportedSegments[]; otherwise treat the legacy
    // `excursion` field as a single synthetic segment so older reports
    // still surface here.
    const explicit = Array.isArray(r.reportedSegments) ? r.reportedSegments : []
    const segments = explicit.length
      ? explicit
      : (r.excursion && r.excursion.tail
        ? [{ tail: r.excursion.tail, klass: r.excursion.klass, points: [] }]
        : [])

    for (const seg of segments) {
      // Free-mode reports (no seg.tail) never match.
      if (!seg || !seg.tail) continue
      if (String(seg.tail).toUpperCase() !== T) continue

      const pts = Array.isArray(seg.points) ? seg.points : []
      let segStartMs = NaN, segEndMs = NaN
      if (pts.length) {
        segStartMs = ptTs(pts[0])
        segEndMs = ptTs(pts[pts.length - 1])
      }
      if (!isFinite(segStartMs) || !isFinite(segEndMs)) {
        const ex = r.excursion || {}
        segStartMs = parseTsLoose(ex.startedAt)
        segEndMs = parseTsLoose(ex.endedAt)
        // Prod data sometimes only has lastSeenMs — use it as a point-in-time
        // fallback so excursion-only reports without window still surface.
        if (!isFinite(segStartMs) && isFinite(parseTsLoose(ex.lastSeenMs))) {
          segStartMs = parseTsLoose(ex.lastSeenMs)
        }
        if (!isFinite(segEndMs)) segEndMs = segStartMs
      }
      if (!isFinite(segStartMs)) continue
      if (!isFinite(segEndMs)) segEndMs = segStartMs

      if (segEndMs < lo || segStartMs > hi) continue

      const meter = r.noiseMeter || {}
      const calc = r.calculatedNoise || {}
      out.push({
        report_id: r.id || null,
        submitted_at: r.submittedAt || r.receivedAt || null,
        source,
        klass: seg.klass || (r.excursion && r.excursion.klass) || null,
        segment: {
          start_ts: new Date(segStartMs).toISOString(),
          end_ts: new Date(segEndMs).toISOString(),
          // Normalise to objects regardless of input shape (prod tuples or
          // proposal objects), so downstream renderers don't need to guess.
          points: pts.map(ptToObject),
        },
        reported_dba: {
          live: meter.liveDba ?? null,
          sustained: meter.sustainedDba ?? null,
        },
        calculated_dba: {
          max: seg.autoMaxCalculatedDba ?? calc.maxDba ?? calc.dba ?? null,
        },
      })
    }
  }
  return out
}

// ── Score helpers ───────────────────────────────────────────────────────
// Map a non-negative "load" to a 0..100 score where 0 load → 100 and the
// score eases down smoothly as load grows. Exponential keeps it bounded and
// monotonic (more load is always a lower score, never below 0).
function loadToScore(load, k) {
  return Math.round(100 * Math.exp(-Math.max(0, load) / k))
}

function tierFor(score) {
  if (score >= 90) return 'Gold'
  if (score >= 75) return 'Silver'
  if (score >= 55) return 'Bronze'
  return 'Rising'
}

// ── Top-level scoring ───────────────────────────────────────────────────
/**
 * @param {object} flight       a record from adsb.extractTowCycles
 * @param {Array}  points       raw track slice [[lat,lon,alt,tsMs], ...]
 * @param {object} ctx
 *   - type        ICAO type for the HP/noise model (e.g. 'C172')
 *   - zones       noise abatement zones [{ polygon }]
 *   - complaints  data/complaints.json complaints array
 *   - popGrid     parsed population_density.json
 *   - fieldElevFt airport field elevation (default 5288)
 *   - isHome      true if the aircraft is based at this airport
 *   - airport     ICAO of the landing airport (for the greeting)
 *   - weights     optional tuning overrides
 */
export function scoreFlight(flight, points, ctx = {}) {
  const {
    type = '',
    zones = [],
    complaints = [],
    popGrid = null,
    fieldElevFt = 5288,
    isHome = false,
    airport = null,
    weights = {},
  } = ctx

  // Tunable knobs. Defaults aim for a clean flight = 100 and a typical
  // around-the-pattern flight in the 70s–90s. Ordering (more load → lower
  // score) is what the tests pin down; absolute calibration is adjustable.
  const W = {
    noise: 1.0,        // weight on community sound exposure
    voice: 2.0,        // weight per community voice (× severity)
    zone: 1.0,         // weight on time spent low over an abatement area
    expScale: 1e9,     // divides raw exposure before the log compression
    kNoise: 1.5,       // softness of the quiet-skies curve
    kVoice: 3.0,       // softness of the harmony curve
    kZone: 2.0,        // softness of the altitude-generosity curve
    kOverall: 2.0,     // softness of the blended score
    ...weights,
  }

  // Trip time (minutes) — the great equaliser. A long, high cross-country
  // shouldn't score worse than a quick pattern hop just for being longer.
  let tripMin = flight && flight.cycle_time_min != null ? flight.cycle_time_min : null
  if (tripMin == null && points.length >= 2) {
    const t0 = points[0][3], t1 = points[points.length - 1][3]
    if (t0 != null && t1 != null) tripMin = (t1 - t0) / 60000
  }
  const tMin = Math.max(tripMin || 0, 1)

  // 1. Ground noise × population density.
  const grid = buildImpactGrid(points, type, popGrid, { fieldElevFt })
  const exposure = grid.exposure || 0
  const noiseLoad = Math.log10(1 + exposure / W.expScale)

  // 2. Community voices.
  const startMs = points[0]?.[3] ?? Date.now()
  const endMs = points[points.length - 1]?.[3] ?? startMs
  const voices = matchVoices(complaints, flight?.tail, startMs, endMs)
  const voiceLoad = voices.reduce((s, v) => s + (VOICE_WEIGHT[v.klass] || 1), 0)

  // 3. Neighborhood overlap (degree + time).
  const overlap = neighborhoodOverlap(points, zones, { typeCode: type })
  const zoneLoad =
    (overlap.seconds.red * 3 + overlap.seconds.orange * 2 + overlap.seconds.yellow * 1) / 60

  // 4. Divide everything by trip time → a per-minute consideration load.
  const noisePerMin = (W.noise * noiseLoad) / tMin
  const voicePerMin = (W.voice * voiceLoad) / tMin
  const zonePerMin = (W.zone * zoneLoad) / tMin
  const totalPerMin = noisePerMin + voicePerMin + zonePerMin

  // Encouraging sub-scores (higher = gentler), all 0..100.
  const quietSkies = loadToScore(noisePerMin, W.kNoise)
  const neighborHarmony = loadToScore(voicePerMin, W.kVoice)
  const altitudeGenerosity = loadToScore(zonePerMin, W.kZone)
  const score = loadToScore(totalPerMin, W.kOverall)

  // Carrot highlights — only celebrate, never scold.
  const highlights = []
  if (grid.silent) highlights.push('Whisper-quiet — no engine noise reached the ground at all')
  if (quietSkies >= 85) highlights.push('Kept the skies peaceful over neighborhoods below')
  if (altitudeGenerosity >= 90) highlights.push('Generous altitude over every noise-abatement area')
  else if (overlap.seconds.inZone === 0) highlights.push('Stayed clear of the quiet zones the whole way')
  if (voices.length === 0) highlights.push('A calm flight — the community had nothing but quiet to report')
  if (tripMin && tripMin >= 8 && score >= 80) highlights.push('A long, considerate journey from start to finish')
  if (highlights.length === 0) highlights.push('Thanks for flying — every gentle choice helps the neighborhood')

  // Home vs visitor greeting (carrot only).
  const tail = flight?.tail || ''
  const greeting = isHome
    ? `Welcome home${tail ? `, ${tail}` : ''}! 🛬`
    : `Welcome${tail ? `, ${tail}` : ''} — great to have you visiting ${airport || 'the field'}! 🛬`

  return {
    id: flight?.id || null,
    tail,
    type: type || null,
    airport: airport || null,
    landed_ts: flight?.landing_ts || null,
    trip_minutes: tripMin != null ? +tripMin.toFixed(1) : null,

    score,                 // 0..100 Good Neighbor Score — higher is gentler
    tier: tierFor(score),  // Gold / Silver / Bronze / Rising

    home: !!isHome,
    greeting,

    gentleness: {
      quiet_skies: quietSkies,             // from ground noise × population
      altitude_generosity: altitudeGenerosity, // from time low over zones
      neighbor_harmony: neighborHarmony,   // from community voices
    },

    highlights,

    // Transparent, positively-named detail behind the score.
    detail: {
      community_exposure: +exposure.toFixed(0), // ground noise × people reached
      peak_ground_db: grid.peakDb,
      voices_heard: voices.length,
      considerate_path: {
        // How much of the path stayed gentle over quiet areas.
        gentle_seconds: +(overlap.seconds.total - overlap.seconds.inZone).toFixed(1),
        close_seconds: overlap.seconds.inZone,
        total_seconds: overlap.seconds.total,
        feet_in_zone: +overlap.feet.inZone.toFixed(0),
      },
    },

    // Geometry for the embeddable map frame.
    _grid: grid,
  }
}
