// sortieExtract.js — pure extractor that turns a tail's sorted point
// list into one or more sortie objects. Source-agnostic: feed it
// live points, historical band points, or archive points (already in
// epoch-ms form) and it returns the same canonical sortie shape.
// Spec: SORTIE_GLOBAL.md.

export const SORTIE_BREAK_MS = 17 * 60_000
export const AIRPORT_NEAR_NM = 4
export const GROUND_AGL_FT = 200
export const TG_GROUND_S = 60

// Haversine in nm. lat/lon in degrees.
export function distNm(la1, lo1, la2, lo2) {
  const R = 3440.065
  const p1 = la1 * Math.PI / 180
  const p2 = la2 * Math.PI / 180
  const dp = (la2 - la1) * Math.PI / 180
  const dl = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// Find the airport (from `airports` list) within AIRPORT_NEAR_NM of
// (lat, lon). Returns the airport object or null.
function nearestAirport(lat, lon, airports, maxNm = AIRPORT_NEAR_NM) {
  let best = null, bestD = Infinity
  for (const ap of airports) {
    const d = distNm(lat, lon, ap.lat, ap.lon)
    if (d < bestD) { bestD = d; best = ap }
  }
  return (best && bestD <= maxNm) ? best : null
}

// Detect every airport the path passed within maxNm of. Dedupe.
function airportsVisited(points, airports, maxNm = AIRPORT_NEAR_NM) {
  const hits = new Set()
  for (const p of points) {
    const ap = nearestAirport(p[0], p[1], airports, maxNm)
    if (ap) hits.add(ap.code)
  }
  return [...hits]
}

// Detect takeoff / landing / touch_and_go operations along the path.
// Uses the departure airport's elevation when known, otherwise the
// first-fix altitude as a proxy for "ground."
function detectOperations(points, airports) {
  const ops = []
  if (!points.length) return ops
  // Ground reference per consecutive-fix.
  const refAirport = nearestAirport(points[0][0], points[0][1], airports)
  const refElev = refAirport ? refAirport.elev : points[0][2]
  const groundCeil = refElev + GROUND_AGL_FT
  let onGround = points[0][2] <= groundCeil
  let lastLandingIdx = -1
  let lastLandingAp = null
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    if (p[2] == null) continue
    const isGround = p[2] <= groundCeil
    if (onGround && !isGround) {
      // takeoff
      const ap = nearestAirport(p[0], p[1], airports)
      // If we just landed < TG_GROUND_S ago at the same airport, this
      // becomes a touch_and_go on the prior landing, not a fresh takeoff.
      if (lastLandingIdx >= 0 && ap && lastLandingAp && ap.code === lastLandingAp.code) {
        const groundSec = ((p[3] || 0) - (points[lastLandingIdx][3] || 0)) / 1000
        if (groundSec <= TG_GROUND_S) {
          // Replace the prior landing with a touch_and_go.
          ops[ops.length - 1] = { kind: 'touch_and_go', airport: ap.code, time: new Date(points[lastLandingIdx][3]).toISOString() }
          onGround = false
          continue
        }
      }
      ops.push({
        kind: 'takeoff',
        airport: ap ? ap.code : null,
        time: new Date(p[3]).toISOString(),
      })
    } else if (!onGround && isGround) {
      // landing
      const ap = nearestAirport(p[0], p[1], airports)
      ops.push({
        kind: 'landing',
        airport: ap ? ap.code : null,
        time: new Date(p[3]).toISOString(),
      })
      lastLandingIdx = i
      lastLandingAp = ap
    }
    onGround = isGround
  }
  return ops
}

// Compute the metrics block from the sortie's points.
function computeMetrics(points, departure) {
  if (!points.length) return null
  const first = points[0]
  const last = points[points.length - 1]
  const durationMs = (last[3] || 0) - (first[3] || 0)
  let furthestNm = 0, totalNm = 0
  let mslSum = 0, mslMax = -Infinity, mslN = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (p[2] != null) {
      mslSum += p[2]
      if (p[2] > mslMax) mslMax = p[2]
      mslN++
    }
    const d = distNm(first[0], first[1], p[0], p[1])
    if (d > furthestNm) furthestNm = d
    if (i > 0) {
      const prev = points[i - 1]
      totalNm += distNm(prev[0], prev[1], p[0], p[1])
    }
  }
  const travelNm = distNm(first[0], first[1], last[0], last[1])
  const refElev = departure?.alt_ft ?? first[2] ?? 0
  let aglSum = 0, aglMax = -Infinity, aglN = 0
  for (const p of points) {
    if (p[2] == null) continue
    const agl = Math.max(0, p[2] - refElev)
    aglSum += agl
    if (agl > aglMax) aglMax = agl
    aglN++
  }
  return {
    duration_s: Math.round(durationMs / 1000),
    duration_min: Math.round(durationMs / 60_000 * 10) / 10,
    distance: {
      furthest_nm: Math.round(furthestNm * 100) / 100,
      total_nm: Math.round(totalNm * 100) / 100,
      travel_nm: Math.round(travelNm * 100) / 100,
    },
    height: {
      msl_max_ft: mslN ? Math.round(mslMax) : null,
      msl_mean_ft: mslN ? Math.round(mslSum / mslN) : null,
      agl_max_ft: aglN ? Math.round(aglMax) : null,
      agl_mean_ft: aglN ? Math.round(aglSum / aglN) : null,
    },
  }
}

// Compute a stable sortie id: tail + UTC date of takeoff + index.
// `index` is the offset of this sortie within the tail's tracks for
// that day (so two sorties on the same day for the same tail get
// distinct ids).
function computeSortieId(tail, takeoffMs, index = 0) {
  const d = new Date(takeoffMs)
  const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  return `${tail.toLowerCase()}-${ymd}-${index}`
}

// Main extractor. Given a tail's points (sorted ascending by ts) and
// the airport reference list, walk gaps > SORTIE_BREAK_MS and emit one
// sortie per contiguous run.
//
// `points`: array of [lat, lon, alt_msl_ft, ts_ms]
// `opts.airports`: array of { code, lat, lon, elev } — the reference
//                  catalog used to resolve departure / arrival / visits
// `opts.tail`, `opts.type`, `opts.desc`, `opts.ownOp`, `opts.source`
// `opts.copyPoints` — if true (default), embed points; if false,
//                     emit `flightsegments` with source + count only.
//
// Returns: sortie[]
export function extractSorties(points, opts = {}) {
  const {
    airports = [],
    tail = '',
    type = null,
    desc = null,
    ownOp = null,
    source = null,
    copyPoints = true,
    minPoints = 3,
  } = opts
  if (!Array.isArray(points) || points.length < minPoints) return []
  const sorted = points
    .filter(p => Array.isArray(p) && p.length >= 4 && p[3] != null)
    .slice()
    .sort((a, b) => a[3] - b[3])
  if (sorted.length < minPoints) return []

  // Walk gaps.
  const runs = []
  let runStart = 0
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][3] - sorted[i - 1][3] >= SORTIE_BREAK_MS) {
      runs.push([runStart, i - 1])
      runStart = i
    }
  }
  runs.push([runStart, sorted.length - 1])

  const out = []
  let runIdx = 0
  for (const [s, e] of runs) {
    const pts = sorted.slice(s, e + 1)
    if (pts.length < minPoints) { runIdx++; continue }
    const first = pts[0], last = pts[pts.length - 1]
    const depAp = nearestAirport(first[0], first[1], airports)
    const arrAp = nearestAirport(last[0], last[1], airports)
    const departure = {
      airport: depAp ? depAp.code : null,
      time: new Date(first[3]).toISOString(),
      lat: first[0], lon: first[1], alt_ft: first[2],
    }
    const arrival = {
      airport: arrAp ? arrAp.code : null,
      time: new Date(last[3]).toISOString(),
      lat: last[0], lon: last[1], alt_ft: last[2],
    }
    const metrics = computeMetrics(pts, departure)
    // travel_nm = 0 when departure / arrival airports match (operator spec).
    if (departure.airport && arrival.airport && departure.airport === arrival.airport) {
      metrics.distance.travel_nm = 0
    }
    const sortieId = computeSortieId(tail, first[3], runIdx)
    const flightsegments = copyPoints
      ? { source, point_count: pts.length, points: pts }
      : { source, point_count: pts.length, ts_start: first[3], ts_end: last[3] }
    out.push({
      sortie_id: sortieId,
      tail,
      type,
      desc,
      ownOp,
      departure,
      arrival,
      airports_visited: airportsVisited(pts, airports),
      operations: detectOperations(pts, airports),
      purpose: null,        // populated by the caller via purposeML, if available
      tow: null,            // populated by the caller via glider pairing, if applicable
      metrics,
      flightsegments,
      annotations: [],
    })
    runIdx++
  }
  return out
}
