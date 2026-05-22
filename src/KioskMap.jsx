import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, Polygon, Marker, Tooltip, Pane, useMap } from 'react-leaflet'
import L from 'leaflet'
import { NOISE_ZONES } from './noiseZones'
import { classifyPoint, distFt } from './geo'
import { nmFrom, nearestAirport } from './airports'
import { buildPopulationContours } from './populationContours'
import SvgCurve from './SvgCurve.jsx'

// ---------------------------------------------------------------------------
// Kiosk view — a self-running, dark "metro" map for a wall display.
//
// Layers (bottom → top):
//   1. CartoDB dark-matter basemap
//   2. Noise abatement zones for the selected airport (dashed purple)
//   3. "All flights today" — relevant tracks from the daily capture, drawn as
//      faded, decimated, smooth catmull-bezier paths with a drop-shadow
//      (noise-report styling) + flight-study smoothing.
//   4. Live aircraft — relevant traffic polled from the ADS-B feed, drawn as
//      bright bezier trails + labeled, heading-rotated plane markers.
//
// Violating segments (low + inside a zone, per geo.classifyPoint) are colored
// red / orange / yellow on both the historical and live layers.
//
// "Relevant" = traffic plausibly operating AT this field: at some point it
// descended/climbed through a low band near the runway. A jet overflying at
// cruise never dips below the field's relevance ceiling, so it drops out — but
// the ceiling is per-airport, so a bizjet field (KBJC) keeps its jets.
// ---------------------------------------------------------------------------

const CLASS_COLOR = {
  red: '#dc2626',
  orange: '#f97316',
  yellow: '#facc15',
}

// CSS blend modes for the two underlay layers. `screen` is the additive,
// glow-on-dark counterpart to `multiply` — it reads well on the near-black
// basemap. Flip either to 'multiply' | 'overlay' | 'soft-light' to taste.
const ZONE_BLEND = 'screen'
const POP_BLEND = 'screen'

// Per-airport kiosk config. `relevanceCeilingAgl` is how high above the field
// an aircraft can be (while near the field) and still count as "operating
// here". GA fields stay low; a jet field keeps a high ceiling so arriving /
// departing bizjets aren't filtered out as overflights.
const AIRPORT_CONFIG = {
  KBDU: { name: 'Boulder Muni',        lat: 40.0394, lon: -105.2258, elevFt: 5288, relevanceCeilingAgl: 4500 },
  KAPA: { name: 'Centennial',          lat: 39.5701, lon: -104.8493, elevFt: 5885, relevanceCeilingAgl: 8000 },
  KBJC: { name: 'Rocky Mtn Metro',     lat: 39.9088, lon: -105.1172, elevFt: 5673, relevanceCeilingAgl: 9000 },
  KEIK: { name: 'Erie Muni',           lat: 40.0098, lon: -105.0488, elevFt: 5001, relevanceCeilingAgl: 4500 },
  KLMO: { name: 'Longmont / Vance Brand', lat: 40.1636, lon: -105.1636, elevFt: 5055, relevanceCeilingAgl: 4500 },
}
const AIRPORT_ORDER = ['KBDU', 'KAPA', 'KBJC', 'KEIK', 'KLMO']

const RELEVANCE_RADIUS_NM = 6  // "near the field" ring for the relevance test
const LIVE_RADIUS_NM = 20      // feed query radius around the field
const LIVE_TRAIL_MIN = 40      // how far back a still-flying aircraft's bright trail reaches
const ALT_CAP_FT = 10000       // ignore points above this everywhere

// Live ADS-B feed providers (same shape as the main map). First is primary.
const LIVE_FEEDS = [
  { id: 'adsb.lol', makeUrl: (lat, lon, nm) => `/adsblol/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
  { id: 'airplanes.live', makeUrl: (lat, lon, nm) => `/airplaneslive/v2/point/${lat}/${lon}/${nm}` },
]

// --- geometry helpers ------------------------------------------------------

// Perpendicular distance (ft) of point p from segment a→b, flat-earth.
function perpDistFt(p, a, b) {
  const latRef = (a[0] + b[0] + p[0]) / 3
  const cos = Math.cos((latRef * Math.PI) / 180)
  const FT = 364560
  const px = (p[1] - a[1]) * FT * cos, py = (p[0] - a[0]) * FT
  const dx = (b[1] - a[1]) * FT * cos, dy = (b[0] - a[0]) * FT
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px, py)
  let t = (px * dx + py * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - t * dx, py - t * dy)
}

// Douglas–Peucker decimation, keeping altitude on retained points.
function decimate(points, epsilonFt) {
  if (points.length < 3 || epsilonFt <= 0) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1; keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop()
    let maxD = 0, idx = -1
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistFt(points[i], points[lo], points[hi])
      if (d > maxD) { maxD = d; idx = i }
    }
    if (maxD > epsilonFt && idx >= 0) { keep[idx] = 1; stack.push([lo, idx]); stack.push([idx, hi]) }
  }
  return points.filter((_, i) => keep[i])
}

const cls = (p) => classifyPoint(p[0], p[1], p[2], NOISE_ZONES)
const lerpPt = (A, B, t) => [
  A[0] + (B[0] - A[0]) * t,
  A[1] + (B[1] - A[1]) * t,
  (A[2] || 0) + ((B[2] || 0) - (A[2] || 0)) * t,
]

// Binary-search the parameter t∈(0,1) along A→B where `sideA(point)` flips
// from true to false. Used to find where a segment crosses a zone/band edge.
function findEdge(A, B, sideA) {
  let lo = 0, hi = 1
  for (let k = 0; k < 18; k++) {
    const mid = (lo + hi) / 2
    if (sideA(lerpPt(A, B, mid))) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

// Band a decimated track into runs of identical classification, clipping the
// colored extent to the actual zone boundary.
//
// Two rules driven by ADS-B dropout concerns:
//   1. A segment is only flagged if at least one of its REAL endpoints is
//      in-zone. A straight interpolation across a gap whose endpoints are both
//      clean is never flagged, even if the drawn line crosses a zone.
//   2. When a segment straddles a boundary (one endpoint in, one out, or two
//      different bands), it's split at the crossing point so only the in-zone
//      portion carries the violation color.
// Interpolated points are used ONLY to locate the geometric edge — never to
// invent a flag — so dropout artifacts can't fabricate an incursion.
function bandRuns(points) {
  if (points.length < 2) return []
  const segs = []
  for (let i = 0; i < points.length - 1; i++) {
    const A = points[i], B = points[i + 1]
    const ca = cls(A), cb = cls(B)
    if (!ca && !cb) {
      segs.push({ klass: null, pts: [A, B] })          // rule 1: no real point in-zone
    } else if (ca && cb && ca === cb) {
      segs.push({ klass: ca, pts: [A, B] })
    } else if (ca && cb) {
      const t = findEdge(A, B, (p) => cls(p) === ca)   // both in-zone, different bands
      const M = lerpPt(A, B, t)
      segs.push({ klass: ca, pts: [A, M] }, { klass: cb, pts: [M, B] })
    } else if (ca && !cb) {
      const t = findEdge(A, B, (p) => !!cls(p))         // exits the zone
      const M = lerpPt(A, B, t)
      segs.push({ klass: ca, pts: [A, M] }, { klass: null, pts: [M, B] })
    } else {
      const t = findEdge(A, B, (p) => !cls(p))          // enters the zone
      const M = lerpPt(A, B, t)
      segs.push({ klass: null, pts: [A, M] }, { klass: cb, pts: [M, B] })
    }
  }
  // Merge consecutive same-class segments into continuous runs.
  const runs = []
  for (const s of segs) {
    const last = runs[runs.length - 1]
    if (last && last.klass === s.klass) last.pts.push(s.pts[1])
    else runs.push({ klass: s.klass, pts: [s.pts[0], s.pts[1]] })
  }
  return runs
}

// Is this track relevant to the given airport? (Operating at the field, not a
// high overflight.) True if it descended/climbed through the field's relevance
// band near the runway, or its first/last fix is at the field.
function isRelevant(points, cfg, code) {
  if (!points || points.length < 2) return false
  const ceilMsl = cfg.elevFt + cfg.relevanceCeilingAgl
  for (const p of points) {
    if (p[2] == null || p[2] > ALT_CAP_FT) continue
    if (nmFrom(p[0], p[1], cfg.lat, cfg.lon) <= RELEVANCE_RADIUS_NM && p[2] <= ceilMsl) return true
  }
  const a = points[0], b = points[points.length - 1]
  return nearestAirport(a[0], a[1], 2) === code || nearestAirport(b[0], b[1], 2) === code
}

// Keep points below the alt cap. No spatial clip — the map container clips
// paths to its own (rectangular) borders, and SvgCurve reprojects every point
// on pan/zoom, so paths fill the full map instead of being cut to a circle.
function clipTrack(points) {
  return points.filter((p) => p[2] != null && p[2] <= ALT_CAP_FT)
}

// Normalize a callsign/tail for cross-source matching (feed hex/flight vs the
// daily-capture call/reg). Today's history and live positions come from
// different feeds, so we bridge them by normalized callsign.
const normCall = (s) => (s || '').trim().toUpperCase()

// Altitude-driven drop-shadow: the higher above the field a segment is, the
// further the shadow is cast (down-right) and the softer/lighter it gets — so
// the path reads as floating that much higher off the ground. Saturates at
// 5000 ft AGL.
function aglShadow(avgAltFt, elevFt) {
  const agl = Math.max(0, (avgAltFt || 0) - elevFt)
  const t = Math.min(1, agl / 5000)
  const dy = (2 + 22 * t).toFixed(1)
  const dx = (1 + 9 * t).toFixed(1)
  const blur = (1.5 + 9 * t).toFixed(1)
  const op = (0.9 - 0.5 * t).toFixed(2)
  return `drop-shadow(${dx}px ${dy}px ${blur}px rgba(0,0,0,${op}))`
}

const avgAltOf = (pts) => (pts.length ? pts.reduce((s, p) => s + (p[2] || 0), 0) / pts.length : 0)

// SvgCurve appends its <path>s to the SVG renderer in Leaflet's overlayPane.
// The zone polygons now live in their own blend Pane, so without this nothing
// would create that overlay SVG and every track would silently fail to draw.
function EnsureOverlaySvg() {
  const map = useMap()
  useEffect(() => {
    const renderer = L.svg({ pane: 'overlayPane' }).addTo(map)
    return () => renderer.remove()
  }, [map])
  return null
}

// Population iso-contours as true cubic-bezier SVG paths (Catmull-Rom → C
// commands, closed). One <path> per density level, drawn into a dedicated
// blend pane. fill-rule evenodd lets a level's nested loops cut holes.
export function ContourLayer({ levels }) {
  const map = useMap()
  useEffect(() => {
    if (!levels.length) return
    let pane = map.getPane('kiosk-pop')
    if (!pane) pane = map.createPane('kiosk-pop')
    pane.style.zIndex = 300
    pane.style.mixBlendMode = POP_BLEND
    const renderer = L.svg({ pane: 'kiosk-pop' }).addTo(map)
    const svg = renderer._container
    const paths = levels.map((lvl) => {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      p.setAttribute('fill', lvl.fill)
      p.setAttribute('fill-opacity', lvl.fillOpacity)
      p.setAttribute('fill-rule', 'evenodd')
      p.setAttribute('stroke', 'none')
      svg.appendChild(p)
      return p
    })
    const loopD = (loop) => {
      let pts = loop
      const last = pts.length - 1
      if (pts.length > 1 && pts[0][0] === pts[last][0] && pts[0][1] === pts[last][1]) pts = pts.slice(0, -1)
      const n = pts.length
      if (n < 3) return ''
      const px = pts.map((ll) => map.latLngToLayerPoint(ll))
      let d = `M${px[0].x} ${px[0].y}`
      for (let i = 0; i < n; i++) {
        const p0 = px[(i - 1 + n) % n], p1 = px[i], p2 = px[(i + 1) % n], p3 = px[(i + 2) % n]
        const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6
        const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6
        d += ` C${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`
      }
      return d + ' Z'
    }
    const update = () => {
      levels.forEach((lvl, li) => {
        paths[li].setAttribute('d', lvl.polygons.map(loopD).join(' '))
      })
    }
    update()
    map.on('zoomend moveend viewreset', update)
    return () => {
      map.off('zoomend moveend viewreset', update)
      paths.forEach((p) => p.remove())
      renderer.remove()
    }
  }, [map, levels])
  return null
}

function makePlaneIcon(heading, fill, violation) {
  return L.divIcon({
    className: 'kiosk-plane-icon',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    html: `
      <div style="transform: rotate(${heading || 0}deg); width:26px; height:26px;">
        <svg viewBox="0 0 24 24" width="26" height="26" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2 L14 10 L22 12 L14 14 L13 22 L12 18 L11 22 L10 14 L2 12 L10 10 Z"
                fill="${fill}" stroke="#0a0a0a" stroke-width="1" stroke-linejoin="round"/>
        </svg>
      </div>`,
  })
}

function readAirportFromUrl() {
  try {
    const a = new URLSearchParams(window.location.search).get('airport')
    if (a && AIRPORT_CONFIG[a.toUpperCase()]) return a.toUpperCase()
  } catch {}
  return 'KBDU'
}

// `dataBase` is the origin of the centralized data services (boot API, ADS-B
// feed proxy, population_density.json). Default '' = same origin. A second app
// can either proxy these paths to the noise server (leave dataBase='') or pass
// an absolute base like 'https://web-app-production-fedf.up.railway.app' (the
// boot + noise-zones endpoints send CORS; for the population file and the
// /adsblol proxy use a proxy, since those don't).
export default function KioskMap({ dataBase = '' } = {}) {
  const [airport, setAirport] = useState(readAirportFromUrl)
  const cfg = AIRPORT_CONFIG[airport]
  const [todayTracks, setTodayTracks] = useState([])
  const [recentByCall, setRecentByCall] = useState(new Map()) // normCall → today points (with ts)
  const [todayTick, setTodayTick] = useState(0) // bumps to re-pull today data so trails stay current
  const [liveByIcao, setLiveByIcao] = useState(new Map())
  const [lastLiveAt, setLastLiveAt] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [popContours, setPopContours] = useState([])

  // Wall clock tick.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // Population density — vectorized into iso-contour polygons (marching
  // squares) so it draws as crisp SVG at any zoom instead of a blocky raster.
  // Blended into the basemap (see POP_BLEND) so dense cores glow like city lights.
  useEffect(() => {
    let cancelled = false
    fetch(`${dataBase}/population_density.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => { if (!cancelled) setPopContours(buildPopulationContours(d)) })
      .catch((e) => console.warn('[kiosk] population load failed:', e))
    return () => { cancelled = true }
  }, [dataBase])

  // Zones for the selected airport — name's first token is the airport code.
  const zones = useMemo(
    () => NOISE_ZONES.filter((z) => (z.name || '').split(/\s+/)[0] === airport),
    [airport],
  )

  // --- Load "all flights today" -------------------------------------------
  // Production (Postgres) has no daily JSON file — the capture-worker writes to
  // the `live_tracks` table, surfaced by /api/excursions/boot with pre-banded
  // geometry. Local dev writes /tracks_live_<date>.json. Try the API first,
  // then the daily file, then the rolling capture. In every case we end up with
  // a flat [[lat,lon,alt,ts],...] point list per track.
  useEffect(() => {
    let cancelled = false
    const today = new Date().toISOString().slice(0, 10)
    // Each entry: how to fetch + how to pull a points array out of one track.
    const sources = [
      { url: `${dataBase}/api/excursions/boot?hours=24&limit=500`,
        rows: (d) => d.tracks || [],
        points: (t) => (t.bands || []).flatMap((b) => b.points || []) },
      { url: `${dataBase}/tracks_live_${today}.json`, rows: (d) => d.tracks || [], points: (t) => t.points || [] },
      { url: `${dataBase}/tracks_live.json`, rows: (d) => d.tracks || [], points: (t) => t.points || [] },
    ]
    ;(async () => {
      for (const s of sources) {
        try {
          const r = await fetch(s.url)
          if (!r.ok) continue
          const d = await r.json()
          if (cancelled) return
          const rows = s.rows(d)
          if (!rows.length) continue
          const out = []
          const recent = new Map()
          for (const t of rows) {
            const pts = s.points(t)
            if (!isRelevant(pts, cfg, airport)) continue
            const clipped = clipTrack(pts)
            if (clipped.length < 2) continue
            out.push({
              key: t.hex || t.reg || t.call,
              call: (t.call || t.reg || t.hex || '').trim(),
              type: t.type || '',
              runs: bandRuns(decimate(clipped, 150)),
            })
            // History for trail-seeding: keep full timestamped points keyed by
            // callsign. Only points with a timestamp are useful for the window.
            const key = normCall(t.call || t.reg || t.hex)
            if (key && clipped[0].length > 3) {
              const prior = recent.get(key) || []
              recent.set(key, prior.concat(clipped))
            }
          }
          for (const [k, arr] of recent) recent.set(k, arr.sort((a, b) => a[3] - b[3]))
          setTodayTracks(out)
          setRecentByCall(recent)
          return
        } catch { /* try next source */ }
      }
      if (!cancelled) { setTodayTracks([]); setRecentByCall(new Map()) }
    })()
    return () => { cancelled = true }
  }, [airport, cfg, todayTick, dataBase])

  // Re-pull today data periodically so the faded backdrop and the seed history
  // for still-flying aircraft stay current as the day progresses.
  useEffect(() => {
    const id = setInterval(() => setTodayTick((t) => t + 1), 90 * 1000)
    return () => clearInterval(id)
  }, [])

  // --- Poll live ADS-B around the field -------------------------------------
  useEffect(() => {
    setLiveByIcao(new Map()) // reset accumulated trails when the airport changes
    let cancelled = false
    const poll = async () => {
      let d = null
      for (const feed of LIVE_FEEDS) {
        if (cancelled) return
        try {
          const r = await fetch(`${dataBase}${feed.makeUrl(cfg.lat, cfg.lon, LIVE_RADIUS_NM)}`)
          if (!r.ok) continue
          const parsed = await r.json()
          if (parsed && Array.isArray(parsed.ac)) { d = parsed; break }
        } catch { /* next feed */ }
      }
      if (cancelled || !d) return
      const ts = Date.now()
      setLastLiveAt(ts)
      setLiveByIcao((prev) => {
        const next = new Map(prev)
        for (const ac of d.ac) {
          if (ac.lat == null || ac.lon == null) continue
          const alt = typeof ac.alt_baro === 'number' ? ac.alt_baro : null
          if (alt == null || alt <= 0 || alt > ALT_CAP_FT) continue
          const ex = next.get(ac.hex)
          const pt = [ac.lat, ac.lon, alt, ts]
          if (ex) {
            const last = ex.points[ex.points.length - 1]
            const points = (!last || last[0] !== ac.lat || last[1] !== ac.lon)
              ? [...ex.points, pt] : ex.points
            next.set(ac.hex, { ...ex, points, heading: ac.track ?? ex.heading, gs: ac.gs ?? ex.gs, lastTs: ts })
          } else {
            next.set(ac.hex, {
              icao: ac.hex,
              tail: (ac.flight || ac.r || ac.hex || '').trim(),
              type: ac.t || '',
              heading: typeof ac.track === 'number' ? ac.track : 0,
              gs: typeof ac.gs === 'number' ? ac.gs : null,
              lastTs: ts,
              points: [pt],
            })
          }
        }
        // Prune trails older than the trail window and aircraft with no recent fix.
        const TRAIL_MS = LIVE_TRAIL_MIN * 60 * 1000
        for (const [icao, a] of next) {
          const pts = a.points.filter((p) => ts - p[3] < TRAIL_MS)
          if (pts.length === 0 || ts - a.lastTs > 90 * 1000) next.delete(icao)
          else if (pts.length !== a.points.length) next.set(icao, { ...a, points: pts })
        }
        return next
      })
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [airport, cfg, dataBase])

  // Relevant flying aircraft, drawn bright and on top. Each trail is seeded
  // with the aircraft's last LIVE_TRAIL_MIN minutes of today's history (matched
  // by callsign) so the trail reaches back before the kiosk loaded, then
  // extended with the real-time accumulated feed positions.
  const liveAircraft = useMemo(() => {
    const out = []
    for (const a of liveByIcao.values()) {
      const last = a.points[a.points.length - 1]
      const windowStart = (last?.[3] || Date.now()) - LIVE_TRAIL_MIN * 60 * 1000
      // Seed from today history before the live feed's first fix.
      const firstLiveTs = a.points[0]?.[3] ?? Infinity
      const seed = (recentByCall.get(normCall(a.tail)) || [])
        .filter((p) => p[3] >= windowStart && p[3] < firstLiveTs)
      const merged = seed.concat(a.points).filter((p) => p[3] >= windowStart)
      if (!isRelevant(merged, cfg, airport)) continue
      const clipped = clipTrack(merged)
      if (clipped.length < 1) continue
      const thin = clipped.length >= 3 ? decimate(clipped, 120) : clipped
      const violating = !!classifyPoint(last[0], last[1], last[2], NOISE_ZONES)
      out.push({ ...a, runs: thin.length >= 2 ? bandRuns(thin) : [], last, violating })
    }
    return out
  }, [liveByIcao, recentByCall, cfg, airport])

  const liveCount = liveAircraft.length
  const liveViolations = liveAircraft.filter((a) => a.violating).length
  const todayViolations = todayTracks.filter((t) => t.runs.some((r) => r.klass === 'red' || r.klass === 'orange')).length
  const staleSec = lastLiveAt ? Math.round((now - lastLiveAt) / 1000) : null

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black text-neutral-100">
      <style>{`
        .leaflet-container { background: #050608; outline: none; }
        /* base shadow comes from an inline, altitude-driven filter per path */
        .kiosk-plane-icon { filter: drop-shadow(0 0 4px rgba(0,0,0,0.9)); }
      `}</style>

      <MapContainer
        center={[cfg.lat, cfg.lon]}
        zoom={12}
        className="h-full w-full"
        zoomControl={false}
        attributionControl={false}
        key={airport /* recenter on airport change */}
      >
        <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />
        <EnsureOverlaySvg />

        {/* Population density — vectorized iso-contours as true bezier SVG */}
        <ContourLayer levels={popContours} />

        {/* Noise abatement zones — borderless, blended fill */}
        <Pane name="kiosk-zones" style={{ zIndex: 350, mixBlendMode: ZONE_BLEND }}>
          {zones.map((z, i) => (
            <Polygon key={i} positions={z.polygon}
              pathOptions={{ stroke: false, weight: 0, fillColor: '#a855f7', fillOpacity: 0.4 }}>
              <Tooltip sticky direction="top">
                <div className="text-xs max-w-[220px]">
                  <div className="font-semibold text-purple-300">{z.name}</div>
                  <div className="text-white/70">{z.note}</div>
                </div>
              </Tooltip>
            </Polygon>
          ))}
        </Pane>

        {/* All flights today — faded decimated bezier, altitude-driven shadow */}
        {todayTracks.flatMap((t) =>
          t.runs.map((r, ri) => (
            <SvgCurve
              key={`today-${t.key}-${ri}`}
              points={r.pts.map((p) => [p[0], p[1]])}
              color={r.klass ? CLASS_COLOR[r.klass] : '#2a6b6b'}
              weight={r.klass ? 3 : 2}
              opacity={r.klass ? 0.5 : 0.32}
              curveType="catmull"
              className="kiosk-trace"
              shadow={aglShadow(avgAltOf(r.pts), cfg.elevFt)}
            />
          )),
        )}

        {/* Live trails — bright bezier, violations pulse, altitude-driven shadow */}
        {liveAircraft.flatMap((a) =>
          a.runs.map((r, ri) => (
            <SvgCurve
              key={`live-${a.icao}-${ri}-${a.points.length}`}
              points={r.pts.map((p) => [p[0], p[1]])}
              color={r.klass ? CLASS_COLOR[r.klass] : '#38bdf8'}
              weight={r.klass ? 5 : 4}
              opacity={0.95}
              curveType="catmull"
              className="kiosk-trace"
              shadow={aglShadow(avgAltOf(r.pts), cfg.elevFt)}
            />
          )),
        )}

        {/* Live aircraft markers */}
        {liveAircraft.map((a) => {
          const stale = lastLiveAt && a.lastTs < lastLiveAt - 6000
          return (
            <Marker
              key={`mk-${a.icao}`}
              position={[a.last[0], a.last[1]]}
              icon={makePlaneIcon(a.heading, a.violating ? '#dc2626' : '#38bdf8', a.violating)}
              opacity={stale ? 0.3 : 1}
            >
              <Tooltip direction="top" offset={[0, -12]} permanent>
                <div className="text-[10px] leading-tight">
                  <div className="font-semibold">{a.tail || a.icao}</div>
                  <div className="text-white/70">{a.type || '—'} · {a.last[2]} ft</div>
                </div>
              </Tooltip>
            </Marker>
          )
        })}
      </MapContainer>

      {/* Header / metro chrome */}
      <div className="pointer-events-none absolute top-0 left-0 right-0 z-[1000] flex items-start justify-between p-4">
        <div className="pointer-events-auto bg-black/60 backdrop-blur-md border border-white/10 rounded-xl px-5 py-3 shadow-2xl">
          <div className="flex items-center gap-3">
            <select
              value={airport}
              onChange={(e) => {
                setAirport(e.target.value)
                const u = new URL(window.location.href)
                u.searchParams.set('airport', e.target.value)
                window.history.replaceState(null, '', u)
              }}
              className="bg-transparent text-2xl font-bold tracking-tight text-white outline-none cursor-pointer"
            >
              {AIRPORT_ORDER.map((code) => (
                <option key={code} value={code} className="bg-neutral-900 text-base">
                  {code} — {AIRPORT_CONFIG[code].name}
                </option>
              ))}
            </select>
          </div>
          <div className="text-[11px] uppercase tracking-[0.2em] text-cyan-300/80 mt-0.5">
            Noise Watch · Live
          </div>
        </div>

        <div className="pointer-events-auto bg-black/60 backdrop-blur-md border border-white/10 rounded-xl px-5 py-3 shadow-2xl text-right">
          <div className="text-3xl font-bold tabular-nums text-white">
            {new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </div>
          <div className="text-[11px] text-white/50 mt-0.5">
            {staleSec == null ? 'connecting…'
              : staleSec <= 8 ? <span className="text-emerald-400">● feed live</span>
              : <span className="text-amber-400">● {staleSec}s since update</span>}
          </div>
        </div>
      </div>

      {/* Stat tiles + legend */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-[1000] flex items-end justify-between p-4">
        <div className="pointer-events-auto flex gap-3">
          <div className="bg-black/60 backdrop-blur-md border border-white/10 rounded-xl px-5 py-3 shadow-2xl">
            <div className="text-3xl font-bold tabular-nums text-sky-400">{liveCount}</div>
            <div className="text-[10px] uppercase tracking-wide text-white/50">live now</div>
          </div>
          <div className="bg-black/60 backdrop-blur-md border border-white/10 rounded-xl px-5 py-3 shadow-2xl">
            <div className="text-3xl font-bold tabular-nums text-rose-400">{liveViolations}</div>
            <div className="text-[10px] uppercase tracking-wide text-white/50">in zone now</div>
          </div>
          <div className="bg-black/60 backdrop-blur-md border border-white/10 rounded-xl px-5 py-3 shadow-2xl">
            <div className="text-3xl font-bold tabular-nums text-amber-400">{todayViolations}</div>
            <div className="text-[10px] uppercase tracking-wide text-white/50">flagged today</div>
          </div>
        </div>

        <div className="pointer-events-auto bg-black/60 backdrop-blur-md border border-white/10 rounded-xl px-4 py-3 shadow-2xl text-[11px] space-y-1.5">
          <Legend swatch="#38bdf8" label="Live traffic" />
          <Legend swatch="#2a6b6b" label="Flown today" dim />
          <Legend swatch="#a855f7" label="Noise zone" />
          <Legend swatch={CLASS_COLOR.red} label="VNAP Excursion (deep / low)" />
          <Legend swatch={CLASS_COLOR.orange} label="VNAP Excursion (inside zone)" />
          <Legend swatch={CLASS_COLOR.yellow} label="Near zone edge" />
        </div>
      </div>
    </div>
  )
}

function Legend({ swatch, label, dim }) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-block w-5 h-1.5 rounded-full" style={{ background: swatch, opacity: dim ? 0.45 : 1 }} />
      <span className="text-white/75">{label}</span>
    </div>
  )
}
