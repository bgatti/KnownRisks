import { useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { MapContainer, TileLayer, Polyline, Polygon, CircleMarker, Marker, Tooltip, Circle, ImageOverlay, Pane } from 'react-leaflet'
import { computeSingleTrackHeatmap, computeMultiTrackHeatmap } from './noise'
import L from 'leaflet'
import { NOISE_ZONES } from './noiseZones'
import { classifyPoint, distFt } from './geo'
import YearOverYear from './YearOverYear.jsx'
import BasesDiagnostic from './BasesDiagnostic.jsx'
import NoticePage from './NoticePage.jsx'
import ThinningTest from './ThinningTest.jsx'
import NoiseImpactTest from './NoiseImpactTest.jsx'
import { computeNoiseRaster, computeImpactRaster } from './noiseRaster'
import { loadPopulationDensity, rasterizePopulation } from './populationRaster'
import { loadTerrain, terrainAt } from './terrain'

function ComposeNoticeModal({ compose, onClose }) {
  const [status, setStatus] = useState('')
  const { subject, body, school, tail } = compose
  const [to, setTo] = useState(compose.to || '')
  const toValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())
  const mailtoHref =
    `mailto:${to}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        `To: ${to}\nSubject: ${subject}\n\n${body}`,
      )
      setStatus('Copied to clipboard')
      setTimeout(() => setStatus(''), 2000)
    } catch {
      setStatus('Copy failed')
    }
  }
  const [sending, setSending] = useState(false)
  const send = async () => {
    setSending(true)
    setStatus('Sending…')
    try {
      const resp = await fetch('/api/send-notice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, body, tail, school }),
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        setStatus(`Failed: ${data.error || resp.status}`)
      } else if (data.dryRun) {
        setStatus('Dry run (no RESEND_API_KEY set) — check server log')
      } else {
        setStatus('Sent ✓')
      }
    } catch (e) {
      setStatus(`Error: ${e.message}`)
    } finally {
      setSending(false)
      setTimeout(() => setStatus(''), 4000)
    }
  }
  return (
    <div
      className="fixed inset-0 z-[2000] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-neutral-900 border border-white/15 rounded-lg w-full max-w-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-white/40">
              Noise notice · {tail}
            </div>
            <div className="text-sm text-white/90">{school || 'Unknown school'}</div>
          </div>
          <button
            onClick={onClose}
            className="text-white/50 hover:text-white text-lg leading-none px-2"
          >
            ×
          </button>
        </div>
        <div className="p-4 space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-white/40 w-16 text-[11px] uppercase tracking-wide">To</span>
            <input
              type="email"
              value={to}
              placeholder={compose.to ? '' : 'enter recipient email…'}
              onChange={(e) => setTo(e.target.value)}
              className={`flex-1 bg-black/40 border rounded px-2 py-1 font-mono text-xs ${
                toValid
                  ? 'border-white/10 text-cyan-300'
                  : 'border-amber-400/40 text-amber-200'
              }`}
            />
          </div>
          {!compose.to && (
            <div className="text-[10px] text-amber-300/80 -mt-1 ml-[4.5rem]">
              No email on file for {school || 'this aircraft'} — enter one to continue.
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-white/40 w-16 text-[11px] uppercase tracking-wide">Subject</span>
            <input
              readOnly
              value={subject}
              className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1 text-white/90 text-xs"
            />
          </div>
          <div>
            <div className="text-white/40 text-[11px] uppercase tracking-wide mb-1">Body</div>
            <textarea
              readOnly
              value={body}
              rows={14}
              className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-white/80 text-xs font-mono leading-relaxed resize-none"
            />
          </div>
          <div className="flex items-center gap-2 pt-2">
            {toValid ? (
              <a
                href={mailtoHref}
                className="px-3 py-1.5 rounded border border-cyan-400/50 text-cyan-300 text-xs hover:bg-cyan-400/10"
              >
                Open in mail app
              </a>
            ) : (
              <span
                title="Enter a recipient email first"
                className="px-3 py-1.5 rounded border border-white/10 text-white/30 text-xs cursor-not-allowed"
              >
                Open in mail app
              </span>
            )}
            <button
              onClick={copy}
              className="px-3 py-1.5 rounded border border-white/20 text-white/80 text-xs hover:bg-white/10"
            >
              Copy
            </button>
            <button
              onClick={send}
              disabled={sending || !toValid}
              title={
                toValid
                  ? 'POST /api/send-notice — dry run unless RESEND_API_KEY is set'
                  : 'Enter a recipient email first'
              }
              className="px-3 py-1.5 rounded border border-emerald-400/50 text-emerald-300 text-xs hover:bg-emerald-400/10 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
            {status && (
              <span className="text-[11px] text-emerald-300 ml-1">{status}</span>
            )}
          </div>
          <div className="text-[10px] text-white/40 pt-1 border-t border-white/5">
            Send posts to <code className="text-white/60">/api/send-notice</code> (Vite dev
            middleware). Set <code className="text-white/60">RESEND_API_KEY</code> and{' '}
            <code className="text-white/60">NOISE_NOTICE_FROM</code> env vars to go live;
            unset = dry run (server log only).
          </div>
        </div>
      </div>
    </div>
  )
}

function useRoute() {
  const [path, setPath] = useState(() => window.location.pathname || '/')
  useEffect(() => {
    const onChange = () => setPath(window.location.pathname || '/')
    window.addEventListener('popstate', onChange)
    return () => window.removeEventListener('popstate', onChange)
  }, [])
  return path
}

function navigate(to) {
  window.history.pushState(null, '', to)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function Nav({ route }) {
  const link = (to, label) => (
    <a
      href={to}
      onClick={(e) => { e.preventDefault(); navigate(to) }}
      className={`px-2 py-1 rounded ${
        route === to ? 'bg-white/15 text-white' : 'text-white/60 hover:text-white'
      }`}
    >
      {label}
    </a>
  )
  return (
    <nav className="flex items-center gap-1 text-xs">
      {link('/', 'Map')}
      {link('/yoy', 'Year over Year')}
      {link('/bases', 'Bases')}
      {link('/thinning', 'Thinning')}
      {link('/impact', 'Impact Model')}
    </nav>
  )
}

const KBDU = [40.0394, -105.2258]
const LOCAL_RADIUS_NM = 3
const MAP_RADIUS_NM = 6 // drop segments outside this ring for render perf

// Live ADS-B feed providers. First entry is the preferred primary; the
// client falls through to the next on any connection failure, non-200, or
// invalid JSON. Both feeds have the same response shape (readsb-based).
const LIVE_FEEDS = [
  {
    id: 'adsb.lol',
    makeUrl: (lat, lon, nm) => `/adsblol/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
  },
  {
    id: 'airplanes.live',
    makeUrl: (lat, lon, nm) => `/airplaneslive/v2/point/${lat}/${lon}/${nm}`,
  },
]
const VIOLATION_RADIUS_NM = 4 // only segments inside this ring count toward % red/orange/yellow
const DECIMATION_TARGET = 200 // progressive-decimation target count per filter context

// Airports within ~50 nm of KBDU. Used to tag each aircraft's home base via
// its most common origin on first observation of the day.
const AIRPORTS = [
  { code: 'KBDU', lat: 40.0394, lon: -105.2258 },
  { code: 'KBJC', lat: 39.9088, lon: -105.1172 },
  { code: 'KEIK', lat: 40.0098, lon: -105.0488 },
  { code: 'KLMO', lat: 40.1636, lon: -105.1636 },
  { code: 'KAPA', lat: 39.5701, lon: -104.8493 },
  { code: 'KDEN', lat: 39.8617, lon: -104.6731 },
  { code: 'KBKF', lat: 39.7017, lon: -104.7517 },
  { code: 'KCFO', lat: 39.7831, lon: -104.5369 },
  { code: 'KGXY', lat: 40.4348, lon: -104.6331 },
  { code: 'KFTG', lat: 39.7850, lon: -104.5428 },
  { code: 'KLIC', lat: 39.2744, lon: -103.6662 },
  { code: 'KFNL', lat: 40.4517, lon: -105.0114 },
]

// Aircraft marker icon for live data. Rotates an SVG plane by the current
// track heading so it points the way the aircraft is flying. Fill color
// carries the aircraft's classification (offense color, or local/transient
// blue/violet if clean).
function makeLiveIcon(heading, fill, stroke) {
  return L.divIcon({
    className: 'live-plane-icon',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    html: `
      <div style="transform: rotate(${heading || 0}deg); width:22px; height:22px;">
        <svg viewBox="0 0 24 24" width="22" height="22" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2 L14 10 L22 12 L14 14 L13 22 L12 18 L11 22 L10 14 L2 12 L10 10 Z"
                fill="${fill}"
                stroke="${stroke}"
                stroke-width="1"
                stroke-linejoin="round"/>
        </svg>
      </div>
    `,
  })
}

const LIVE_LOCAL_COLOR = '#3b82f6'     // blue-500
const LIVE_TRANSIENT_COLOR = '#a855f7' // purple-500

function nearestAirport(lat, lon, maxNm = 3) {
  let best = null, bestD = Infinity
  for (const ap of AIRPORTS) {
    const dLat = (lat - ap.lat) * 60
    const dLon = (lon - ap.lon) * 60 * Math.cos(((lat + ap.lat) / 2) * Math.PI / 180)
    const d = Math.hypot(dLat, dLon)
    if (d < bestD) { bestD = d; best = ap }
  }
  return bestD <= maxNm ? best.code : null
}
const IMPACT_ZERO_ALT_FT = 8000 // MSL — above this, an aircraft contributes no impact

// Classify a track's departure direction by looking at the initial climb.
// Find the first sustained altitude gain (≥200 ft over ≥5 consecutive
// points), then check if the net horizontal displacement during that climb
// is more eastbound or westbound.
// Returns 'east', 'west', or null (no clear climb found).
function classifyDepartureDirection(points) {
  if (!points || points.length < 10) return null
  // Scan for the start of the first climb: a run of ≥5 points where
  // each point is at or above the previous altitude.
  for (let i = 0; i < points.length - 5; i++) {
    let climbing = true
    for (let j = i + 1; j <= i + 5; j++) {
      if (points[j][2] < points[j - 1][2] - 25) { climbing = false; break }
    }
    if (!climbing) continue
    // Found start of climb at i. Extend until altitude stops rising.
    let end = i + 5
    while (end < points.length - 1 && points[end + 1][2] >= points[end][2] - 25) end++
    const altGain = points[end][2] - points[i][2]
    if (altGain < 200) continue // too shallow — keep scanning
    const dLon = points[end][1] - points[i][1]
    return dLon > 0 ? 'east' : 'west'
  }
  return null
}

// Great-circle-ish distance in nautical miles using local flat projection.
// 1° lat = 60 nm; cos-weight lon so this works across the KBDU area fine.
function nmFromKBDU(lat, lon) {
  const dLat = (lat - KBDU[0]) * 60
  const dLon = (lon - KBDU[1]) * 60 * Math.cos(((lat + KBDU[0]) / 2) * Math.PI / 180)
  return Math.hypot(dLat, dLon)
}

const DATASETS = [
  { id: 'yearly', label: 'Globe history (location-filtered)', file: '/tracks_yearly.json' },
]

// Fetch tracks in pages from /api/tracks (Postgres-backed) with progress
// callback. Falls back to single /tracks_yearly.json fetch for local dev.
// onStatus receives string messages shown in the progress bar.
async function fetchTracksChunked(onProgress, onStatus) {
  onStatus('Connecting to /api/tracks...')
  console.log('[tracks-loader] starting fetch')
  try {
    const first = await fetch('/api/tracks?page=0&size=2000')
    console.log(`[tracks-loader] /api/tracks response: ${first.status}`)
    if (!first.ok) {
      onStatus(`API returned ${first.status}, falling back to /tracks_yearly.json...`)
      console.log('[tracks-loader] falling back to /tracks_yearly.json')
      const r = await fetch('/tracks_yearly.json')
      if (!r.ok) throw new Error(`tracks_yearly.json: ${r.status} ${r.statusText}`)
      const d = await r.json()
      console.log(`[tracks-loader] fallback loaded ${d.tracks?.length || 0} tracks`)
      onStatus(`Loaded ${d.tracks?.length || 0} tracks from file`)
      return d
    }
    const firstData = await first.json()
    console.log(`[tracks-loader] page 0: ${firstData.tracks?.length} tracks, total=${firstData.total}, pages=${firstData.pages}`)

    // If server returned the legacy empty response, bail
    if (firstData._use_api || !firstData.tracks) {
      throw new Error('Server returned empty _use_api response')
    }

    const { tracks, pages, total, size } = firstData
    const allTracks = [...tracks]
    onProgress(allTracks.length, total)
    onStatus(`Page 1/${pages} loaded (${allTracks.length} tracks)`)

    // Fetch remaining pages in parallel batches of 4
    for (let i = 1; i < pages; i += 4) {
      const batch = []
      for (let j = i; j < Math.min(i + 4, pages); j++) batch.push(j)

      const results = await Promise.all(
        batch.map(async (p) => {
          const r = await fetch(`/api/tracks?page=${p}&size=${size}`)
          if (!r.ok) throw new Error(`Page ${p} failed: ${r.status}`)
          return r.json()
        })
      )
      for (const r of results) {
        if (r.tracks) allTracks.push(...r.tracks)
      }
      onProgress(allTracks.length, total)
      onStatus(`Pages ${i+1}-${Math.min(i+4, pages)}/${pages} (${allTracks.length.toLocaleString()} tracks)`)
    }

    console.log(`[tracks-loader] done: ${allTracks.length} tracks loaded`)
    onStatus(`Complete: ${allTracks.length.toLocaleString()} tracks`)
    return { tracks: allTracks }
  } catch (e) {
    console.error('[tracks-loader] FAILED:', e)
    onStatus(`ERROR: ${e.message}`)
    throw e
  }
}

const CLASS_COLOR = {
  red: '#dc2626',
  orange: '#f97316',
  yellow: '#facc15',
}

// Color for clean (non-violation) portions of a track, based on what
// fraction of the TOTAL flight is spent in noise zones.
// Calibrated to real data: 89% of flights have 0% excursion,
// p90 = 1.8%, p95 = 16%. So the gradient maxes at ~15%.
//
//   0% excursion  → dark cyan    — clean flight, the majority
//   ~2%           → teal         — slight incursion
//   ~5%           → muted olive  — notable
//  ≥15%           → warm amber   — worst 5%, significant excursion
function trackCleanColor(excursionPct) {
  if (excursionPct == null || excursionPct <= 0) return '#1a7070' // dark cyan — zero excursion
  const t = Math.min(1, excursionPct / 0.15) // normalize to 0–1, max at 15%
  // dark cyan → warm amber
  const r = Math.round(26 + (180 - 26) * t)
  const g = Math.round(112 + (120 - 112) * t)
  const b = Math.round(112 + (50 - 112) * t)
  return `rgb(${r},${g},${b})`
}

// Split a track into runs of identical classification so we can draw each run
// as one Polyline. Returns [{klass, points, avgAlt}, ...]. Adjacent runs share
// a vertex to keep the line visually continuous.
function bandTrack(points) {
  const tags = points.map((p) => classifyPoint(p[0], p[1], p[2], NOISE_ZONES))
  const runs = []
  let i = 0
  while (i < points.length - 1) {
    const k = tags[i]
    let j = i
    while (j < points.length - 1 && tags[j + 1] === k) j++
    const slice = points.slice(i, j + 2) // include the next point for continuity
    const avgAlt = slice.reduce((s, p) => s + p[2], 0) / slice.length
    runs.push({ klass: k, points: slice, avgAlt })
    i = j + 1
  }
  return runs
}

export default function App() {
  const path = useRoute()
  const route = path.split('?')[0]
  if (route === '/notice') {
    return <NoticePage />
  }
  if (route === '/yoy' || route === '/bases' || route === '/thinning' || route === '/impact') {
    return (
      <div className="h-full w-full flex flex-col">
        <header className="px-4 py-3 border-b border-white/10 flex items-center gap-4">
          <h1 className="text-lg font-semibold">Front Range Aviation Monitor</h1>
          <Nav route={route} />
        </header>
        <div className="flex-1 overflow-hidden">
          {route === '/yoy'
            ? <YearOverYear />
            : route === '/bases'
              ? <BasesDiagnostic />
              : route === '/thinning'
                ? <ThinningTest />
                : <NoiseImpactTest />}
        </div>
      </div>
    )
  }
  return <MapPage />
}

function MapPage() {
  const route = useRoute()
  const [enabled, setEnabled] = useState({ yearly: true })
  const [yearFilter, setYearFilter] = useState(null) // null = not initialized, 'all' or a specific year
  const [baseFilter, setBaseFilter] = useState('all') // 'all' or an airport code
  const [schoolFilter, setSchoolFilter] = useState('all') // 'all' or school name
  const [purposeFilter, setPurposeFilter] = useState('all') // 'all' or purpose category
  const [offenderTab, setOffenderTab] = useState('pct') // 'pct' or 'len'
  const [baseTab, setBaseTab] = useState('pct') // 'pct' or 'len'
  const [trendTab, setTrendTab] = useState('pct') // 'pct' or 'len'
  const [liveActive, setLiveActive] = useState(false)
  const [liveAircraft, setLiveAircraft] = useState([]) // growing per-icao position lists
  const [lastLiveAt, setLastLiveAt] = useState(null)
  const [activeFeedId, setActiveFeedId] = useState(LIVE_FEEDS[0].id)
  const [clockTick, setClockTick] = useState(0) // forces re-render every 5 s while Live is active

  useEffect(() => {
    if (!liveActive) return
    const id = setInterval(() => setClockTick((t) => t + 1), 5000)
    return () => clearInterval(id)
  }, [liveActive])

  // Live-data localStorage helpers. One key per day (YYYY-MM-DD local) so we
  // can later add a calendar picker that loads an arbitrary day's capture.
  const todayKey = () => `noise_live_${new Date().toISOString().slice(0, 10)}`
  // Keep trail points < 3 h old. Offense points (inside a noise zone) are
  // retained up to 24 h so the offender list can still show them after their
  // trail has faded away.
  const pruneLiveAircraft = (aircraft) => {
    const now = Date.now()
    const TRAIL_MS = 3 * 60 * 60 * 1000
    const OFFENSE_MS = 24 * 60 * 60 * 1000
    const out = []
    for (const ac of aircraft) {
      if (!ac || !Array.isArray(ac.points)) continue
      const kept = []
      for (const p of ac.points) {
        const age = now - (p[3] || 0)
        if (age < TRAIL_MS) { kept.push(p); continue }
        if (age < OFFENSE_MS && classifyPoint(p[0], p[1], p[2], NOISE_ZONES)) {
          kept.push(p)
        }
      }
      if (kept.length === 0) continue
      out.push({ ...ac, points: kept })
    }
    return out
  }
  const loadLiveDay = (key = todayKey()) => {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed?.aircraft) ? parsed.aircraft : []
      return pruneLiveAircraft(list)
    } catch {
      return []
    }
  }
  const saveLiveDay = (aircraft, key = todayKey()) => {
    try {
      localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), aircraft }))
    } catch (e) {
      console.warn('live save failed (likely quota):', e)
    }
  }

  // Toggling Live ON hydrates from today's saved capture (if any) and resumes
  // accumulating. OFF simply stops polling; saved data stays in localStorage.
  // Live overlays are independent of the year filter.
  const toggleLive = () => {
    setLiveActive((v) => {
      const next = !v
      if (next) {
        setLiveAircraft(loadLiveDay())
        setYearFilter(null) // turning Live on clears the historical year filter
      }
      return next
    })
  }

  // Poll adsb.lol every 20s while Live mode is on. Each poll appends the
  // latest position to each aircraft's growing track. The data flows into
  // the same banded/visible pipeline as the historical set.
  useEffect(() => {
    if (!liveActive) return
    let cancelled = false
    // Walk LIVE_FEEDS in order every poll so we auto-recover to the primary
    // (adsb.lol) as soon as it comes back, rather than sticking on the
    // fallback once we've failed over.
    const fetchLive = async () => {
      let d = null
      let winnerId = null
      for (const feed of LIVE_FEEDS) {
        if (cancelled) return
        const url = feed.makeUrl(KBDU[0], KBDU[1], 15)
        try {
          const r = await fetch(url)
          if (!r.ok) {
            console.warn(`live feed ${feed.id}: HTTP ${r.status}`)
            continue
          }
          const parsed = await r.json()
          if (parsed && Array.isArray(parsed.ac)) {
            d = parsed
            winnerId = feed.id
            break
          }
        } catch (e) {
          console.warn(`live feed ${feed.id} failed:`, e.message || e)
        }
      }
      if (cancelled) return
      if (!d) {
        console.warn('all live feeds failed')
        return
      }
      setActiveFeedId((prev) => (prev === winnerId ? prev : winnerId))
      try {
        setLastLiveAt(Date.now())
        setLiveAircraft((prev) => {
          const byIcao = new Map(prev.map((a) => [a.icao, { ...a, points: [...a.points] }]))
          for (const ac of d.ac || []) {
            if (ac.lat == null || ac.lon == null) continue
            const alt = typeof ac.alt_baro === 'number' ? ac.alt_baro : null
            if (alt == null || alt <= 0 || alt >= 10000) continue
            const ts = Date.now()
            const existing = byIcao.get(ac.hex)
            if (existing) {
              const last = existing.points[existing.points.length - 1]
              if (!last || last[0] !== ac.lat || last[1] !== ac.lon) {
                existing.points.push([ac.lat, ac.lon, alt, ts])
              }
              existing.heading = typeof ac.track === 'number' ? ac.track : existing.heading
              existing.gs = typeof ac.gs === 'number' ? ac.gs : existing.gs
              existing.lastTs = ts
            } else {
              byIcao.set(ac.hex, {
                icao: ac.hex,
                call: ((ac.flight || ac.r || ac.hex) + '').trim(),
                reg: ac.r || '',
                type: ac.t || '',
                src: `live/${ac.hex}`,
                year: 'live',
                heading: typeof ac.track === 'number' ? ac.track : 0,
                gs: typeof ac.gs === 'number' ? ac.gs : null,
                lastTs: ts,
                points: [[ac.lat, ac.lon, alt, ts]],
              })
            }
          }
          const merged = pruneLiveAircraft(Array.from(byIcao.values()))
          saveLiveDay(merged)
          return merged
        })
      } catch (e) {
        console.warn('live fetch failed', e)
      }
    }
    fetchLive()
    const id = setInterval(fetchLive, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [liveActive])
  const [datasets, setDatasets] = useState({})
  const [errors, setErrors] = useState({})
  const [loadProgress, setLoadProgress] = useState(null) // { loaded, total, status } or null

  // --- Server-side pre-computed stats (from /api/noise/stats) ---
  const [noiseStats, setNoiseStats] = useState(null) // { perTail, cube, years, bases, schools }
  const [serverTracks, setServerTracks] = useState(null) // { tracks, total }
  const [serverLoading, setServerLoading] = useState(false)
  const useServerApi = true // toggle for DB-backed mode
  const [schoolsByTail, setSchoolsByTail] = useState(new Map())
  const [compose, setCompose] = useState(null) // { to, subject, body, school, tail }

  // Load flight-school fleet data and build a tail → school lookup map.
  useEffect(() => {
    fetch('/flight_schools_fleets.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.schools) return
        const map = new Map()
        for (const s of data.schools) {
          for (const ac of s.aircraft || []) {
            if (ac.tail) {
              map.set(ac.tail, {
                school: s.name,
                airport: s.airport,
                type: ac.type || '',
                email: s.email || '',
                website: s.website || '',
              })
            }
          }
        }
        setSchoolsByTail(map)
      })
      .catch(() => {})
  }, [])
  const [altCap, setAltCap] = useState(7500)
  const [showPaths, setShowPaths] = useState(true)
  const [showZones, setShowZones] = useState(true)
  const [showHeatmap, setShowHeatmap] = useState(false) // legacy — kept for code refs but unused
  const [heatmap, setHeatmap] = useState(null) // { url, bounds } — global PNG
  // Precomputed heatmap matrix keyed by `${year}_${origin}`. Built by
  // noise/precompute_heatmaps.py into /heatmaps/manifest.json. The frontend
  // fetches the manifest once and swaps PNGs as filters change — no LMax
  // runs in the browser for year/origin changes.
  const [heatmapManifest, setHeatmapManifest] = useState(null)

  useEffect(() => {
    if (!showHeatmap) return
    let cancelled = false
    // Try the precomputed manifest first; fall back to the legacy single PNG.
    fetch('/heatmaps/manifest.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        if (cancelled) return
        const byKey = {}
        for (const e of (d.entries || [])) {
          byKey[`${e.year}_${e.origin}`] = e
        }
        setHeatmapManifest({ ...d, byKey })
      })
      .catch(() => {
        // No manifest — fall back to the single global PNG from the older path.
        fetch('/noise_heatmap.json')
          .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
          .then((d) => {
            if (cancelled) return
            const { south, north, west, east } = d.bounds
            setHeatmap({
              url: '/' + (d.png || 'noise_heatmap.png'),
              bounds: [[south, west], [north, east]],
            })
          })
          .catch((e) => console.warn('no heatmap data', e))
      })
    return () => {
      cancelled = true
    }
  }, [showHeatmap])
  const [onlyViolations, setOnlyViolations] = useState(false)
  const [realImpact, setRealImpact] = useState(true)
  const [impactOpacity, setImpactOpacity] = useState(1.0)
  const [showPopDensity, setShowPopDensity] = useState(false)
  const [popDensityOverlay, setPopDensityOverlay] = useState(null)
  const [popDensityOpacity, setPopDensityOpacity] = useState(0.5)
  useEffect(() => {
    if (!showPopDensity) { setPopDensityOverlay(null); return }
    let cancelled = false
    loadPopulationDensity()
      .then((data) => {
        if (cancelled) return
        const result = rasterizePopulation(data)
        setPopDensityOverlay(result)
      })
      .catch((e) => console.warn('population density load failed:', e))
    return () => { cancelled = true }
  }, [showPopDensity])
  const [clipToRadius, setClipToRadius] = useState(false)
  const mapRef = useRef(null)
  const [todFilter, setTodFilter] = useState(false)
  const [todStart, setTodStart] = useState(7)
  const [todEnd, setTodEnd] = useState(22)
  const [todAnimate, setTodAnimate] = useState(false)
  const [todAnimIdx, setTodAnimIdx] = useState(0)
  const [todCache, setTodCache] = useState(null)
  const [dirFilter, setDirFilter] = useState('all') // 'all' | 'east' | 'west'
  const [originFilter, setOriginFilter] = useState('all') // 'all' | 'local' | 'transient'
  const [selectedTails, setSelectedTails] = useState([])
  const isSelected = (tail) => selectedTails.includes(tail)
  // Plain click replaces selection, ctrl/cmd/shift-click toggles the tail in/out.
  const selectTail = (tail, evt) => {
    const additive = evt && (evt.ctrlKey || evt.metaKey || evt.shiftKey)
    setSelectedTails((s) => {
      if (additive) return s.includes(tail) ? s.filter((t) => t !== tail) : [...s, tail]
      return s.length === 1 && s[0] === tail ? [] : [tail]
    })
  }
  const clearSelected = () => setSelectedTails([])

  // Deep-link: read ?tail=<N-number> from the URL once on mount and
  // auto-select it. Used by external services hitting the landing URL from
  // /api/offenses responses. Also sets year=all so history isn't hidden.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const tailParam = params.get('tail')
      if (tailParam) {
        setSelectedTails([tailParam.trim()])
        setYearFilter('all')
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Clear selection on Escape, on year-filter change, or on right-click of the map.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') clearSelected() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => { clearSelected() }, [yearFilter, baseFilter])

  useEffect(() => {
    // Pre-load terrain grid for AGL calculations (non-blocking).
    loadTerrain()
  }, [])

  // --- Server-side API: fetch stats (sidebar rankings, cube) ---
  // Re-fetches when filters change. ~50KB response vs 60MB before.
  useEffect(() => {
    if (!useServerApi) return
    if (todAnimate) return // animate manages its own fetches via cache
    const params = new URLSearchParams()
    if (yearFilter && yearFilter !== 'all') params.set('year', yearFilter)
    if (baseFilter !== 'all') params.set('base', baseFilter)
    if (schoolFilter !== 'all') params.set('school', schoolFilter)
    if (purposeFilter !== 'all') params.set('purpose', purposeFilter)
    if (todFilter) { params.set('tod_start', todStart); params.set('tod_end', todEnd) }
    fetch(`/api/noise/stats?${params}`)
      .then(r => r.ok ? r.json() : r.json().then(d => Promise.reject(d.error || r.status)))
      .then(data => {
        console.log('[noise-api] stats loaded:', data.perTail?.length, 'tails')
        setNoiseStats(data)
      })
      .catch(e => console.error('[noise-api] stats error:', e))
  }, [useServerApi, yearFilter, baseFilter, schoolFilter, purposeFilter, todFilter, todStart, todEnd, todAnimate])

  // --- Server-side API: fetch pre-banded tracks for map ---
  // ~200-500KB for 500 tracks. Re-fetches on filter change.
  useEffect(() => {
    if (!useServerApi) return
    if (todAnimate) return // animate manages its own fetches via cache
    setServerLoading(true)
    const params = new URLSearchParams()
    if (yearFilter && yearFilter !== 'all') params.set('year', yearFilter)
    if (baseFilter !== 'all') params.set('base', baseFilter)
    if (schoolFilter !== 'all') params.set('school', schoolFilter)
    if (purposeFilter !== 'all') params.set('purpose', purposeFilter)
    if (todFilter) { params.set('tod_start', todStart); params.set('tod_end', todEnd) }
    if (onlyViolations) params.set('violations_only', '1')
    params.set('limit', '500')
    fetch(`/api/noise/tracks?${params}`)
      .then(r => r.ok ? r.json() : r.json().then(d => Promise.reject(d.error || r.status)))
      .then(data => {
        console.log(`[noise-api] tracks loaded: ${data.tracks?.length}/${data.total}`)
        setServerTracks(data)
        setServerLoading(false)
      })
      .catch(e => {
        console.error('[noise-api] tracks error:', e)
        setServerLoading(false)
      })
  }, [useServerApi, yearFilter, baseFilter, schoolFilter, purposeFilter, onlyViolations, todFilter, todStart, todEnd, todAnimate])

  // --- Fallback: load all tracks from file for local dev ---
  useEffect(() => {
    if (useServerApi) return
    setLoadProgress({ loaded: 0, total: 0, status: 'Starting...' })
    fetchTracksChunked(
      (loaded, total) => setLoadProgress(p => ({ ...p, loaded, total })),
      (status) => setLoadProgress(p => ({ ...p, status }))
    )
      .then((d) => {
        setDatasets((s) => ({ ...s, yearly: d }))
        setLoadProgress(null)
      })
      .catch((e) => {
        setErrors((s) => ({ ...s, yearly: String(e) }))
        setLoadProgress(p => ({ ...p, status: `FAILED: ${e.message}`, error: true }))
      })
  }, [useServerApi])

  // Precompute everything that depends on the FULL raw dataset. Heavy work
  // (classifying ~1.2M points) is chunked and yields to the main thread every
  // 200 tracks so the UI stays responsive during initial load.
  const [rawStats, setRawStats] = useState({
    tailToBaseInfo: new Map(),
    cube: {},
    perTrack: [],
    violatorSrcs: new Set(),
    ready: false,
  })
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const rank = { yellow: 1, orange: 2, red: 3 }
      const baseCounts = new Map()
      const perTrack = []
      const allTracks = []
      for (const ds of DATASETS) {
        const d = datasets[ds.id]
        if (!d?.tracks) continue
        for (const t of d.tracks) allTracks.push(t)
      }
      const CHUNK = 200
      for (let start = 0; start < allTracks.length; start += CHUNK) {
        if (cancelled) return
        const end = Math.min(start + CHUNK, allTracks.length)
        for (let j = start; j < end; j++) {
          const t = allTracks[j]
          if (!t.points || t.points.length < 2 || !t.year) continue
          const pts = t.points.filter((p) => p[2] < 7500)
          if (pts.length < 2) continue
          const first = pts[0]
          const last = pts[pts.length - 1]
          const firstBase = nearestAirport(first[0], first[1], 3)
          const lastBase = nearestAirport(last[0], last[1], 3)
          const isLocal = nmFromKBDU(first[0], first[1]) <= LOCAL_RADIUS_NM
          const origin = isLocal ? 'local' : 'transient'
          const tags = pts.map((p) => classifyPoint(p[0], p[1], p[2], NOISE_ZONES))
          let total = 0, yellow = 0, orange = 0, red = 0
          let totalFt = 0, yellowFt = 0, orangeFt = 0, redFt = 0
          for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1]
            const b = pts[i]
            if (nmFromKBDU((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) > VIOLATION_RADIUS_NM) continue
            const seg = distFt(a[0], a[1], b[0], b[1])
            total++
            totalFt += seg
            const ta = tags[i - 1], tb = tags[i]
            const worst = (rank[ta] || 0) >= (rank[tb] || 0) ? ta : tb
            if (worst === 'red') { red++; redFt += seg }
            else if (worst === 'orange') { orange++; orangeFt += seg }
            else if (worst === 'yellow') { yellow++; yellowFt += seg }
          }
          const tail = t.call || t.reg
          if (tail) {
            let info = baseCounts.get(tail)
            if (!info) { info = { counts: {}, total: 0 }; baseCounts.set(tail, info) }
            if (firstBase) {
              info.counts[firstBase] = (info.counts[firstBase] || 0) + 1
              info.total++
            }
            if (lastBase && lastBase !== firstBase) {
              info.counts[lastBase] = (info.counts[lastBase] || 0) + 1
              info.total++
            }
          }
          // Count how many of the filtered points fall inside the map ring.
          let inRingPoints = 0
          for (const p of pts) {
            if (nmFromKBDU(p[0], p[1]) <= MAP_RADIUS_NM) {
              inRingPoints++
              if (inRingPoints >= 2) break
            }
          }
          const inRing = inRingPoints >= 2
          // Extract capture date from src (e.g. "globe/2025-07-15/<hex>")
          const dateMatch = (t.src || '').match(/(\d{4}-\d{2}-\d{2})/)
          const date = dateMatch ? dateMatch[1] : null
          perTrack.push({
            src: t.src,
            year: t.year,
            date,
            tail,
            firstBase,
            lastBase,
            origin,
            total,
            yellow,
            orange,
            red,
            totalFt,
            yellowFt,
            orangeFt,
            redFt,
            isLocal,
            inRing,
          })
        }
        await new Promise((r) => setTimeout(r, 0))
      }
      if (cancelled) return
      const tailToBaseInfo = new Map()
      for (const [tail, m] of baseCounts) {
        const entries = Object.entries(m.counts).sort((a, b) => b[1] - a[1])
        if (!entries.length) continue
        const significant = entries.filter(([, n]) => m.total && n / m.total >= 0.2)
        const display = significant.length > 1
          ? significant.slice(0, 3).map(([c]) => c).join('+')
          : entries[0][0]
        tailToBaseInfo.set(tail, {
          top: entries[0][0],
          display,
          allBases: new Set(entries.map(([c]) => c)),
        })
      }
      const cube = {}
      for (const pt of perTrack) {
        if (pt.total === 0) continue
        const info = tailToBaseInfo.get(pt.tail)
        const bases = info ? Array.from(info.allBases) : []
        if (bases.length === 0 && (pt.firstBase || pt.lastBase)) {
          bases.push(pt.firstBase || pt.lastBase)
        }
        if (bases.length === 0) bases.push('(unknown)')
        if (!cube[pt.year]) cube[pt.year] = {}
        for (const base of bases) {
          if (!cube[pt.year][base]) cube[pt.year][base] = {}
          if (!cube[pt.year][base][pt.origin]) {
            cube[pt.year][base][pt.origin] = { total: 0, red: 0 }
          }
          cube[pt.year][base][pt.origin].total += pt.total
          cube[pt.year][base][pt.origin].red += pt.red
        }
      }
      const violatorSrcs = new Set()
      const inRingSrcs = new Set()
      for (const pt of perTrack) {
        if ((pt.red > 0 || pt.orange > 0) && pt.src) violatorSrcs.add(pt.src)
        if (pt.inRing && pt.src) inRingSrcs.add(pt.src)
      }
      if (!cancelled) {
        setRawStats({ tailToBaseInfo, cube, perTrack, violatorSrcs, inRingSrcs, ready: true })
      }
    }
    run()
    return () => { cancelled = true }
  }, [datasets])

  // Build the list of tracks + per-track banded runs. Memoized on dataset load
  // and alt cap — expensive when data is large, so do it once.
  const banded = useMemo(() => {
    const out = []

    // --- Server-side path: tracks come pre-banded from /api/noise/tracks ---
    if (useServerApi && serverTracks?.tracks) {
      for (const t of serverTracks.tracks) {
        // Map server bands to the runs format the renderer expects
        const runs = (t.bands || []).map(b => ({
          klass: b.klass,
          points: b.points,
          avgAlt: b.points.length ? b.points.reduce((s, p) => s + (p[2] || 0), 0) / b.points.length : 0,
        }))
        if (runs.length === 0) continue
        // Collect all points for compatibility with code that reads t.points
        const allPts = []
        for (const r of runs) for (const p of r.points) allPts.push(p)
        // Per-track excursion fractions (% of total flight in each zone)
        const totalFt = t.len_total_ft || 0
        const pctRed = totalFt > 0 ? (t.len_red_ft || 0) / totalFt : 0
        const pctOrange = totalFt > 0 ? (t.len_orange_ft || 0) / totalFt : 0
        const pctYellow = totalFt > 0 ? (t.len_yellow_ft || 0) / totalFt : 0
        const excursionPct = pctRed + pctOrange + pctYellow
        const _cleanColor = trackCleanColor(excursionPct)

        out.push({
          call: t.call, type: t.type, desc: t.desc, ownOp: t.ownOp, src: t.src,
          year: t.year, t0: null,
          _src: 'yearly',
          points: allPts,
          rawPoints: allPts,
          runs,
          isLocal: t.origin === 'local',
          base: t.base,
          firstBase: t.base,
          lastBase: null,
          worst: t.worst,
          depDir: null,
          pctRed, pctOrange, pctYellow, excursionPct,
          totalFt,
          _cleanColor,
        })
      }
      // Add live tracks if active
      if (liveActive && liveAircraft.length) {
        for (const a of liveAircraft) {
          const pts = (a.points || []).filter(p => nmFromKBDU(p[0], p[1]) <= MAP_RADIUS_NM)
          if (pts.length < 2) continue
          const runs = bandTrack(pts)
          out.push({
            ...a, _src: 'live', points: pts, rawPoints: a.points, runs,
            isLocal: nmFromKBDU(pts[0][0], pts[0][1]) <= LOCAL_RADIUS_NM,
            base: nearestAirport(pts[0][0], pts[0][1], 3),
          })
        }
      }
      return out
    }

    // --- Fallback: client-side computation for local dev ---
    const allTracks = []
    // Historical datasets — progressively decimated for render perf.
    //   specific year: start with every 10th track (mod 10 = 0). If fewer
    //   than 100 result, widen to include mod 10 = 1, then 2, etc., until
    //   we have at least 100 tracks or run out of residues.
    //   'all yrs'             → same logic but base stride is 40
    //   null (historic hidden) → don't load historic at all
    if (yearFilter !== null) {
      const baseStride = yearFilter === 'all' ? 40 : 10
      const schoolActive = schoolFilter !== 'all'
      const vioOnly = onlyViolations && rawStats.ready && rawStats.violatorSrcs.size > 0
      const useRingFilter = rawStats.ready && rawStats.inRingSrcs && rawStats.inRingSrcs.size > 0
      // When the ring pre-filter isn't ready yet (initial load), the pool
      // includes tracks that will drop out of banded downstream, so we aim
      // for 2× the target to land AT LEAST DECIMATION_TARGET on screen.
      const target = useRingFilter ? DECIMATION_TARGET : DECIMATION_TARGET * 2
      const pool = []
      for (const ds of DATASETS) {
        const d = datasets[ds.id]
        if (!d?.tracks) continue
        for (const t of d.tracks) {
          if (yearFilter !== 'all' && t.year !== yearFilter) continue
          if (schoolActive) {
            const sch = schoolsByTail.get(t.call || t.reg)
            if (!sch || sch.school !== schoolFilter) continue
          }
          if (vioOnly && !rawStats.violatorSrcs.has(t.src)) continue
          if (useRingFilter && !rawStats.inRingSrcs.has(t.src)) continue
          pool.push({ t, src: ds.id })
        }
      }
      // Progressive decimation: start with residue 0, widen until the pool
      // slice reaches DECIMATION_TARGET or we've used every residue class.
      let residuesNeeded = 1
      while (residuesNeeded < baseStride) {
        const count = Math.floor((pool.length * residuesNeeded) / baseStride)
        if (count >= target) break
        residuesNeeded++
      }
      for (let i = 0; i < pool.length; i++) {
        if (i % baseStride >= residuesNeeded) continue
        allTracks.push({ ...pool[i].t, _src: pool[i].src })
      }
    }
    // Live-accumulated tracks from adsb.lol polling — never decimated.
    if (liveActive && liveAircraft.length) {
      allTracks.push(...liveAircraft.map((a) => ({ ...a, _src: 'live' })))
    }
    for (const t of allTracks) {
        // Filter to altitude cap + the 6 nm map ring. Local-ness is tested
        // BEFORE the ring cut so a flight that took off from KBDU and climbed
        // out past 6 nm still counts as local.
        const rawPoints = t.points.filter((p) => p[2] < altCap)
        const withinRing = clipToRadius
          ? rawPoints.filter((p) => nmFromKBDU(p[0], p[1]) <= MAP_RADIUS_NM)
          : rawPoints
        if (withinRing.length < 2) continue
        const runs = bandTrack(withinRing)
        const rawFirst = rawPoints[0] || withinRing[0]
        const isLocal = nmFromKBDU(rawFirst[0], rawFirst[1]) <= LOCAL_RADIUS_NM
        // Per-track "based at" guess. Check the first point of the day first;
        // if not near any airport, fall back to the last point. The idea: a
        // KBDU-based aircraft's trace begins near KBDU on departure, or ends
        // near KBDU on arrival; either is strong evidence for the base.
        const rawLast = rawPoints[rawPoints.length - 1] || null
        const firstBase = rawFirst ? nearestAirport(rawFirst[0], rawFirst[1], 3) : null
        const lastBase = rawLast ? nearestAirport(rawLast[0], rawLast[1], 3) : null
        const baseAirport = firstBase || lastBase
        out.push({
          ...t,
          points: withinRing,
          rawPoints,
          runs,
          isLocal,
          depDir: classifyDepartureDirection(rawPoints),
          year: t.year || null,
          base: baseAirport,
          firstBase,
          lastBase,
        })
    }
    return out
  }, [datasets, altCap, liveActive, liveAircraft, yearFilter, schoolFilter, schoolsByTail, onlyViolations, rawStats, clipToRadius, useServerApi, serverTracks])

  // Unique years — from server stats or from loaded data
  const availableYears = useMemo(() => {
    if (noiseStats?.years) return noiseStats.years
    const ys = new Set()
    for (const ds of DATASETS) {
      const d = datasets[ds.id]
      if (!d?.tracks) continue
      for (const t of d.tracks) if (t.year) ys.add(t.year)
    }
    return Array.from(ys).sort()
  }, [noiseStats, datasets])

  const tailToBaseInfo = rawStats.tailToBaseInfo

  // Thermal color for pill backgrounds — blue (low) → red (high) via HSLA.
  // Held at 30% opacity so the pill row stays subtle.
  const thermalColor = (pct, maxPct) => {
    if (maxPct <= 0) return 'rgba(80,80,80,0.1)'
    const t = Math.min(1, pct / maxPct)
    const hue = 240 - 240 * t
    return `hsla(${hue}, 70%, 50%, 0.3)`
  }

  // Compute % red per year AND per base in a single pass. Year colors respect
  // the current base filter (but not the year filter), and vice versa — so
  // selecting one dimension updates the other's pill colors automatically.
  // Pill stats — aggregate the precomputed year × base × origin cube,
  // applying the currently-selected filters on every dimension EXCEPT the
  // one being colored. Tiny iteration, runs instantly on every filter click.
  const pillStats = useMemo(() => {
    const cube = rawStats.cube
    const years = new Map()
    const bases = new Map()
    const origins = { local: { total: 0, red: 0 }, transient: { total: 0, red: 0 } }
    for (const year in cube) {
      for (const base in cube[year]) {
        for (const origin in cube[year][base]) {
          const cell = cube[year][base][origin]
          if (cell.total === 0) continue
          const yearOK = yearFilter === null || yearFilter === 'all' || year === yearFilter
          const baseOK = baseFilter === 'all' || base === baseFilter
          const originOK = originFilter === 'all' || origin === originFilter
          // Year coloring: respect base + origin (ignore year filter)
          if (baseOK && originOK) {
            let y = years.get(year)
            if (!y) { y = { total: 0, red: 0 }; years.set(year, y) }
            y.total += cell.total
            y.red += cell.red
          }
          // Base coloring: respect year + origin (ignore base filter)
          if (yearOK && originOK) {
            let b = bases.get(base)
            if (!b) { b = { total: 0, red: 0 }; bases.set(base, b) }
            b.total += cell.total
            b.red += cell.red
          }
          // Origin coloring: respect year + base (ignore origin filter)
          if (yearOK && baseOK) {
            origins[origin].total += cell.total
            origins[origin].red += cell.red
          }
        }
      }
    }
    const yearPct = {}
    let maxYear = 0
    for (const [y, b] of years) {
      const p = b.total ? (b.red / b.total) * 100 : 0
      yearPct[y] = p
      if (p > maxYear) maxYear = p
    }
    const basePct = {}
    let maxBase = 0
    for (const [b, d] of bases) {
      const p = d.total ? (d.red / d.total) * 100 : 0
      basePct[b] = p
      if (p > maxBase) maxBase = p
    }
    const originPct = {
      local: origins.local.total ? (origins.local.red / origins.local.total) * 100 : 0,
      transient: origins.transient.total ? (origins.transient.red / origins.transient.total) * 100 : 0,
    }
    const maxOrigin = Math.max(originPct.local, originPct.transient)
    return { yearPct, maxYear, basePct, maxBase, originPct, maxOrigin }
  }, [rawStats, yearFilter, baseFilter, originFilter])

  const availableBases = useMemo(() => {
    if (noiseStats?.bases) return noiseStats.bases
    const bs = new Set()
    for (const info of tailToBaseInfo.values()) {
      for (const b of info.allBases) bs.add(b)
    }
    return Array.from(bs).sort()
  }, [noiseStats, tailToBaseInfo])

  // Schools actually present in the current filter context (year + base +
  // origin). Computed from the UNDECIMATED rawStats.perTrack cache so the
  // dropdown always reflects the true set available under the filters, not
  // whatever happened to survive the render decimation.
  const availableSchools = useMemo(() => {
    if (noiseStats?.schools) return noiseStats.schools
    if (schoolsByTail.size === 0) return []
    const s = new Set()
    for (const [, info] of schoolsByTail) {
      if (info?.school) s.add(info.school)
    }
    return Array.from(s).sort()
  }, [noiseStats, schoolsByTail])

  // On first data load, default the year filter to the first available year
  // (rather than 'all') so the initial render isn't overwhelmed. Runs once.
  const [didInitYear, setDidInitYear] = useState(false)
  useEffect(() => {
    if (!didInitYear && yearFilter == null && availableYears.length > 0) {
      setYearFilter('all')
      setDidInitYear(true)
    }
  }, [availableYears, yearFilter, didInitYear])

  const visible = useMemo(() => {
    return banded.filter((t) => {
      // Server API already filters by year/base/school/violations — only
      // apply remaining client-side filters (origin, live toggle, tod, dir).
      if (!enabled[t._src]) return false
      if (!useServerApi) {
        if (onlyViolations && !t.runs.some((r) => r.klass === 'orange' || r.klass === 'red')) return false
        if (yearFilter === null) {
          if (t._src !== 'live') return false
        } else if (yearFilter !== 'all' && t.year !== yearFilter) {
          return false
        }
        if (baseFilter !== 'all') {
          const tail = t.call || t.reg
          const info = tailToBaseInfo.get(tail)
          if (!info || !info.allBases.has(baseFilter)) return false
        }
        if (schoolFilter !== 'all') {
          const tail = t.call || t.reg
          const sch = schoolsByTail.get(tail)
          if (!sch || sch.school !== schoolFilter) return false
        }
      }
      if (originFilter === 'local' && !t.isLocal) return false
      if (originFilter === 'transient' && t.isLocal) return false
      // Direction filter: east/west departure direction.
      if (dirFilter !== 'all') {
        if (t.depDir && t.depDir !== dirFilter) return false
      }
      // Time-of-day filter: skip tracks that have no points in the window.
      // Tracks without timestamps pass through (they can't be filtered).
      if (todFilter && t.t0 != null) {
        const TZ = -7 * 3600
        const pts = t.points || []
        let any = false
        for (const p of pts) {
          if (p[3] == null) { any = true; break } // no ts → include
          const localS = t.t0 + p[3] + TZ
          const hour = Math.floor((((localS % 86400) + 86400) % 86400) / 3600)
          const inRange = todStart <= todEnd
            ? hour >= todStart && hour < todEnd
            : hour >= todStart || hour < todEnd
          if (inRange) { any = true; break }
        }
        if (!any) return false
      }
      return true
    })
  }, [banded, enabled, onlyViolations, originFilter, yearFilter, baseFilter, tailToBaseInfo, schoolFilter, schoolsByTail, todFilter, todStart, todEnd, dirFilter])

  // Impact overlay: one Circle per track point, radius ~ AGL (meters) and
  // opacity proportional to climb/level/descend weight with a squared altitude
  // falloff. Climbing is treated as the loudest phase; descending contributes
  // 25% of that.
  //   climbing  (alt delta > +100 ft between neighbors) → weight 1.00
  //   level     (|delta| ≤ 100 ft)                       → weight 0.50
  //   descend   (alt delta < -100 ft)                    → weight 0.25
  // Altitude falloff: factor = max(0, 1 − (alt_MSL − field_elev) / (IMPACT_ZERO − field_elev))²
  // → 1.0 at field elevation, 0 at IMPACT_ZERO_ALT_FT (8000 ft MSL, ≈2700 AGL).
  // ── Time-of-day filter animation ────────────────────────────────────
  const TOD_PRESETS = [
    { label: 'Early', start: 4, end: 8 },
    { label: 'Day', start: 8, end: 17 },
    { label: 'Eve', start: 17, end: 22 },
    { label: 'Night', start: 22, end: 4 },
    { label: 'All', start: 0, end: 24 },
  ]
  const todTimerRef = useRef(null)

  // When animate starts, pre-fetch all 4 TOD blocks in parallel and cache
  useEffect(() => {
    if (!todAnimate) { setTodCache(null); return }
    setTodFilter(true)
    const blocks = TOD_PRESETS.slice(0, 4)
    let cancelled = false

    const buildParams = (block) => {
      const p = new URLSearchParams()
      if (yearFilter && yearFilter !== 'all') p.set('year', yearFilter)
      if (baseFilter !== 'all') p.set('base', baseFilter)
      if (schoolFilter !== 'all') p.set('school', schoolFilter)
      if (purposeFilter !== 'all') p.set('purpose', purposeFilter)
      p.set('tod_start', block.start)
      p.set('tod_end', block.end)
      return p
    }

    Promise.all(blocks.map(async (block) => {
      const p = buildParams(block)
      const [statsRes, tracksRes] = await Promise.all([
        fetch(`/api/noise/stats?${p}`).then(r => r.json()),
        fetch(`/api/noise/tracks?${p}&limit=500`).then(r => r.json()),
      ])
      return { label: block.label, start: block.start, end: block.end, stats: statsRes, tracks: tracksRes }
    })).then(cached => {
      if (cancelled) return
      console.log('[tod-animate] cached all 4 blocks:', cached.map(c => `${c.label}:${c.tracks.tracks?.length}`))
      setTodCache({ blocks: cached })
      // Start animation from block 0
      setTodAnimIdx(0)
      setTodStart(blocks[0].start)
      setTodEnd(blocks[0].end)
      setNoiseStats(cached[0].stats)
      setServerTracks(cached[0].tracks)
    }).catch(e => console.error('[tod-animate] prefetch error:', e))

    return () => { cancelled = true }
  }, [todAnimate, yearFilter, baseFilter, schoolFilter, purposeFilter])

  // Advance to next TOD block only after current frame has rendered.
  // Uses a ref so the raster effect can signal "done" without causing
  // a re-render loop. Minimum 2s display per frame.
  const todFrameReady = useRef(false)
  const todAdvanceTimer = useRef(null)
  const [impactRaster, setImpactRaster] = useState(null)

  // Mark frame as ready when impactRaster updates (or when raster is off)
  useEffect(() => {
    if (!todAnimate || !todCache) return
    todFrameReady.current = true
  }, [impactRaster, todAnimate, todCache])

  // Advance loop: check every 500ms if frame is ready + min time elapsed
  useEffect(() => {
    if (!todAnimate || !todCache) return
    const blocks = todCache.blocks
    let frameStart = Date.now()
    todFrameReady.current = !realImpact // if heatmap is off, ready immediately
    const MIN_DISPLAY_MS = 2500

    const check = () => {
      const elapsed = Date.now() - frameStart
      if (todFrameReady.current && elapsed >= MIN_DISPLAY_MS) {
        // Advance to next block
        setTodAnimIdx(i => {
          const next = (i + 1) % blocks.length
          const b = blocks[next]
          setTodStart(b.start)
          setTodEnd(b.end)
          setNoiseStats(b.stats)
          setServerTracks(b.tracks)
          return next
        })
        todFrameReady.current = false
        frameStart = Date.now()
      }
    }
    todAdvanceTimer.current = setInterval(check, 500)
    return () => clearInterval(todAdvanceTimer.current)
  }, [todAnimate, todCache, realImpact])

  // HP-based noise raster
  useEffect(() => {
    if (!realImpact) { setImpactRaster(null); return }
    const selectedSet = new Set(selectedTails)
    const tracks = visible
      .filter((t) => selectedSet.size === 0 || selectedSet.has(t.call || t.reg))
      .map((t) => ({ points: t.points, type: t.type, t0: t.t0 }))
    if (!tracks.length) { setImpactRaster(null); return }
    // TOD filtering is done server-side — tracks are already filtered,
    // so no need to pass todStart/todEnd to the raster computation.
    const id = setTimeout(() => {
      const result = computeNoiseRaster(tracks, {})
      setImpactRaster(result)
    }, 0)
    return () => clearTimeout(id)
  }, [visible, realImpact, selectedTails])

  // Noise × population density impact raster
  const [showImpact, setShowImpact] = useState(false)
  const [impactPopRaster, setImpactPopRaster] = useState(null)
  const [impactPopOpacity, setImpactPopOpacity] = useState(1.0)
  const [popDataForImpact, setPopDataForImpact] = useState(null)
  useEffect(() => {
    if (!showImpact) return
    if (popDataForImpact) return // already loaded
    loadPopulationDensity()
      .then((d) => setPopDataForImpact(d))
      .catch((e) => console.warn('population density load failed:', e))
  }, [showImpact, popDataForImpact])
  useEffect(() => {
    if (!showImpact || !popDataForImpact) { setImpactPopRaster(null); return }
    const selectedSet = new Set(selectedTails)
    const tracks = visible
      .filter((t) => selectedSet.size === 0 || selectedSet.has(t.call || t.reg))
      .map((t) => ({ points: t.points, type: t.type, t0: t.t0 }))
    if (!tracks.length) { setImpactPopRaster(null); return }
    const id = setTimeout(() => {
      const result = computeImpactRaster(tracks, popDataForImpact, {})
      setImpactPopRaster(result)
    }, 0)
    return () => clearTimeout(id)
  }, [visible, showImpact, popDataForImpact, selectedTails])

  // Aggregate currently-visible tracks by tail number. For each tail, count
  // segments by class and rank by % red. Also tally likely "based" airport
  // from each day's first observed position.
  const byTail = useMemo(() => {
    const map = new Map()
    for (const t of visible) {
      const tail = t.call || t.reg || '(unknown)'
      let agg = map.get(tail)
      if (!agg) {
        agg = {
          tail,
          type: t.type || '',
          total: 0, red: 0, orange: 0, yellow: 0,
          redFt: 0,
          tracks: 0,
          originCounts: {},
          _tracks: [],
        }
        map.set(tail, agg)
      }
      agg.tracks++
      agg._tracks.push(t)
      if (!agg.type && t.type) agg.type = t.type
      for (const r of t.runs) {
        for (let i = 1; i < r.points.length; i++) {
          const a = r.points[i - 1]
          const b = r.points[i]
          const midLat = (a[0] + b[0]) / 2
          const midLon = (a[1] + b[1]) / 2
          if (nmFromKBDU(midLat, midLon) > VIOLATION_RADIUS_NM) continue
          agg.total++
          if (r.klass === 'red') {
            agg.red++
            agg.redFt += distFt(a[0], a[1], b[0], b[1])
          } else if (r.klass === 'orange') agg.orange++
          else if (r.klass === 'yellow') agg.yellow++
        }
      }
      // First observed point of the day for this track
      const raw = t.rawPoints && t.rawPoints.length ? t.rawPoints : t.points
      if (raw && raw.length) {
        const ap = nearestAirport(raw[0][0], raw[0][1])
        if (ap) agg.originCounts[ap] = (agg.originCounts[ap] || 0) + 1
      }
    }
    const rows = Array.from(map.values()).filter((a) => a.total >= 12)
    rows.forEach((a) => {
      a.pctRed = a.total ? (a.red / a.total) * 100 : 0
      a.redNm = a.redFt / 6076
      // Use the shared base info (display string includes multi-base aircraft like "KBDU+KLMO")
      const info = tailToBaseInfo.get(a.tail)
      a.base = info ? info.display : null
      a.baseSet = info ? info.allBases : new Set()
      a.baseTop = info ? info.top : null
    })
    return rows
  }, [visible, tailToBaseInfo])

  // Map tail → aggregate row, for fast lookup in polyline tooltips.
  const byTailMap = useMemo(() => new Map(byTail.map((a) => [a.tail, a])), [byTail])

  // Sorted view of byTail for the top-offenders panel — switches between
  // "highest %" and "most red length" based on the active tab.
  const byTailSorted = useMemo(() => {
    const copy = byTail.slice()
    if (offenderTab === 'len') {
      copy.sort((a, b) => b.redFt - a.redFt || b.pctRed - a.pctRed)
    } else {
      copy.sort((a, b) => b.pctRed - a.pctRed || b.red - a.red)
    }
    return copy
  }, [byTail, offenderTab])

  // Aggregate by based airport AND by flight school. Each aircraft is
  // attributed to every base in its set, plus its school (if known). The
  // panel then shows a mixed list of airports and schools so you can see
  // which operator segment is driving noise at KBDU.
  const byBase = useMemo(() => {
    const m = new Map()
    const addRow = (key, kind, aircraft) => {
      let b = m.get(key)
      if (!b) {
        b = { base: key, kind, aircraft: 0, total: 0, red: 0, orange: 0, yellow: 0, redFt: 0 }
        m.set(key, b)
      }
      b.aircraft++
      b.total += aircraft.total
      b.red += aircraft.red
      b.orange += aircraft.orange
      b.yellow += aircraft.yellow
      b.redFt += aircraft.redFt
    }
    for (const a of byTail) {
      if (a.baseSet && a.baseSet.size > 0) {
        for (const base of a.baseSet) addRow(base, 'airport', a)
      }
      const sch = schoolsByTail.get(a.tail)
      if (sch) addRow(sch.school, 'school', a)
    }
    const rows = Array.from(m.values())
    rows.forEach((b) => {
      b.pctRed = b.total ? (b.red / b.total) * 100 : 0
      b.redNm = b.redFt / 6076
    })
    return rows
  }, [byTail, schoolsByTail])

  const byBaseSorted = useMemo(() => {
    const copy = byBase.slice()
    if (baseTab === 'len') {
      copy.sort((a, b) => b.redFt - a.redFt || b.pctRed - a.pctRed)
    } else {
      copy.sort((a, b) => b.pctRed - a.pctRed || b.red - a.red)
    }
    return copy
  }, [byBase, baseTab])

  // Full-track overlays for any selected aircraft — ignores the 6 nm ring.
  const selectedOverlays = useMemo(() => {
    if (selectedTails.length === 0) return []
    const set = new Set(selectedTails)
    const out = []
    for (const t of banded) {
      const tail = t.call || t.reg
      if (!set.has(tail)) continue
      const pts = t.rawPoints && t.rawPoints.length > 1 ? t.rawPoints : t.points
      if (pts.length < 2) continue
      out.push({ ...t, overlayPoints: pts, overlayRuns: bandTrack(pts) })
    }
    return out
  }, [banded, selectedTails])

  // Client-side heatmap for a single selected aircraft. When showHeatmap is
  // on AND exactly one plane is selected, compute its own footprint. This
  // overrides the global PNG for that selection.
  const singleHeatmap = useMemo(() => {
    if (!showHeatmap) return null
    if (selectedOverlays.length !== 1) return null
    const t = selectedOverlays[0]
    const pts = t.overlayPoints
    if (!pts || pts.length < 2) return null
    try {
      const hm = computeSingleTrackHeatmap(pts, t.type || '', {
        centerLat: KBDU[0],
        centerLon: KBDU[1],
        maxDistNm: 6,
      })
      if (hm) {
        console.log(
          `single heatmap: ${t.call || t.reg} (${t.type || '?'}) `
            + `${pts.length} pts, peak ${hm.dbMax?.toFixed(1)} dB`
        )
      } else {
        console.log('single heatmap returned null', t.call, t.type, pts.length)
      }
      return hm
    } catch (e) {
      console.warn('singleHeatmap failed', e)
      return null
    }
  }, [showHeatmap, selectedOverlays])

  const filteredHeatmap = null // reserved for school/base on-demand later

  // Pick the best precomputed PNG for the current year × origin. Falls
  // back to 'all_all' if the specific slice wasn't computed.
  const activePrecomputed = useMemo(() => {
    if (!heatmapManifest?.byKey) return null
    const yearKey = yearFilter == null || yearFilter === 'all' ? 'all' : String(yearFilter)
    const originKey = originFilter === 'all' ? 'all' : originFilter
    const tryKeys = [
      `${yearKey}_${originKey}`,
      `${yearKey}_all`,
      `all_${originKey}`,
      `all_all`,
    ]
    for (const k of tryKeys) {
      const entry = heatmapManifest.byKey[k]
      if (entry && entry.png) {
        const b = entry.bounds
        return {
          url: '/heatmaps/' + entry.png,
          bounds: [[b.south, b.west], [b.north, b.east]],
          key: k,
        }
      }
    }
    return null
  }, [heatmapManifest, yearFilter, originFilter])

  // Per-live-aircraft color summary — picks one color per aircraft based on
  // the worst classification observed across its full track; falls back to
  // blue (local) or violet (transient) when completely clean.
  const livePerAircraft = useMemo(() => {
    clockTick
    if (!liveActive) return new Map()
    const rank = { yellow: 1, orange: 2, red: 3 }
    const out = new Map()
    for (const ac of liveAircraft) {
      let worst = null
      for (const p of ac.points) {
        const c = classifyPoint(p[0], p[1], p[2], NOISE_ZONES)
        if (c && (!worst || rank[c] > rank[worst])) worst = c
        if (worst === 'red') break
      }
      const first = ac.points[0]
      const isLocal = first ? nmFromKBDU(first[0], first[1]) <= LOCAL_RADIUS_NM : false
      const color = worst
        ? CLASS_COLOR[worst]
        : isLocal ? LIVE_LOCAL_COLOR : LIVE_TRANSIENT_COLOR
      out.set(ac.icao, { worst, isLocal, color })
    }
    return out
  }, [liveAircraft, liveActive, clockTick])

  // Dedicated SVG renderer bound to the live-trails pane. Historical tracks
  // use preferCanvas, which pins every historic polyline to a single canvas
  // in overlayPane (z 400); sharing that renderer would bury live trails
  // under the historical canvas regardless of child order.
  const liveRenderer = useMemo(() => L.svg({ pane: 'live-trails' }), [])

  // Live segments with age-based opacity. Trails fade linearly from 1.0 at
  // fresh to 0 at 3 h, matching the 3-hour retention window for clean points.
  const liveSegments = useMemo(() => {
    clockTick // re-evaluate when the 5 s tick fires
    if (!liveActive) return []
    const now = Date.now()
    const THREE_H_MIN = 180
    const ageOpacity = (ts) => {
      const mins = (now - ts) / 60000
      if (mins <= 0) return 1
      if (mins >= THREE_H_MIN) return 0
      return 1 - mins / THREE_H_MIN
    }
    // Centripetal Catmull-Rom spline (α=0.5) sampled between p1 and p2 using
    // p0/p3 as tangent neighbors. Centripetal parameterization avoids the
    // straight-line collapse and cusps that uniform CR produces on real ADS-B
    // tracks where sample spacing varies with groundspeed.
    const STEPS = 16
    const ALPHA = 0.5
    const curveBetween = (p0, p1, p2, p3) => {
      const d = (a, b) => {
        const dx = a[0] - b[0]
        const dy = a[1] - b[1]
        return Math.pow(Math.hypot(dx, dy), ALPHA)
      }
      const t0 = 0
      const t1 = t0 + (d(p0, p1) || 1e-9)
      const t2 = t1 + (d(p1, p2) || 1e-9)
      const t3 = t2 + (d(p2, p3) || 1e-9)
      const out = []
      for (let s = 0; s <= STEPS; s++) {
        const t = t1 + (t2 - t1) * (s / STEPS)
        const a1x = ((t1 - t) / (t1 - t0)) * p0[0] + ((t - t0) / (t1 - t0)) * p1[0]
        const a1y = ((t1 - t) / (t1 - t0)) * p0[1] + ((t - t0) / (t1 - t0)) * p1[1]
        const a2x = ((t2 - t) / (t2 - t1)) * p1[0] + ((t - t1) / (t2 - t1)) * p2[0]
        const a2y = ((t2 - t) / (t2 - t1)) * p1[1] + ((t - t1) / (t2 - t1)) * p2[1]
        const a3x = ((t3 - t) / (t3 - t2)) * p2[0] + ((t - t2) / (t3 - t2)) * p3[0]
        const a3y = ((t3 - t) / (t3 - t2)) * p2[1] + ((t - t2) / (t3 - t2)) * p3[1]
        const b1x = ((t2 - t) / (t2 - t0)) * a1x + ((t - t0) / (t2 - t0)) * a2x
        const b1y = ((t2 - t) / (t2 - t0)) * a1y + ((t - t0) / (t2 - t0)) * a2y
        const b2x = ((t3 - t) / (t3 - t1)) * a2x + ((t - t1) / (t3 - t1)) * a3x
        const b2y = ((t3 - t) / (t3 - t1)) * a2y + ((t - t1) / (t3 - t1)) * a3y
        const cx = ((t2 - t) / (t2 - t1)) * b1x + ((t - t1) / (t2 - t1)) * b2x
        const cy = ((t2 - t) / (t2 - t1)) * b1y + ((t - t1) / (t2 - t1)) * b2y
        out.push([cx, cy])
      }
      return out
    }
    const rank = { yellow: 1, orange: 2, red: 3 }
    const out = []
    const selectedSet = new Set(selectedTails)
    for (const ac of liveAircraft) {
      const tail = ac.call || ac.icao
      // Isolation: when the user has selected any tail, only that tail's live
      // trail renders.
      if (selectedSet.size > 0 && !selectedSet.has(tail)) continue
      const info = livePerAircraft.get(ac.icao)
      const cleanColor = info && info.isLocal ? LIVE_LOCAL_COLOR : LIVE_TRANSIENT_COLOR
      const pts = ac.points

      // Walk the track once, accumulating consecutive pairs into one continuous
      // "run". A run is cut whenever the data gap exceeds 40 s or the segment
      // classification changes — so each run becomes a single smooth polyline
      // with a uniform color, and there are no per-pair joint artifacts.
      let run = null
      const flush = () => {
        if (run && run.curve.length >= 2) out.push(run)
        run = null
      }
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]
        const b = pts[i]
        if (a[2] == null || b[2] == null) { flush(); continue }
        if ((b[3] || 0) - (a[3] || 0) > 40000) { flush(); continue }
        const ca = classifyPoint(a[0], a[1], a[2], NOISE_ZONES)
        const cb = classifyPoint(b[0], b[1], b[2], NOISE_ZONES)
        const worstEnd = (rank[ca] || 0) >= (rank[cb] || 0) ? ca : cb
        const segColor = worstEnd ? CLASS_COLOR[worstEnd] : cleanColor
        const isViolation = !!worstEnd

        if (!run || run.color !== segColor) {
          flush()
          run = {
            tail,
            type: ac.type,
            color: segColor,
            isViolation,
            curve: [],
            latestTs: b[3] || now,
          }
        }
        const p0 = pts[i - 2] || a
        const p3 = pts[i + 1] || b
        const seg = curveBetween(p0, a, b, p3)
        // Drop the first sample after the run already has one, since it
        // duplicates the last point of the previous pair's curve.
        const start = run.curve.length === 0 ? 0 : 1
        for (let k = start; k < seg.length; k++) run.curve.push(seg[k])
        run.latestTs = b[3] || now
      }
      flush()
    }
    for (const r of out) r.opacity = ageOpacity(r.latestTs)
    return out
  }, [liveAircraft, liveActive, livePerAircraft, selectedTails, clockTick])

  // Trends by date — aggregated from the UNDECIMATED rawStats.perTrack cache
  // with the current filter state applied. Full fidelity, fast filter updates.
  // Per-date excursion stats — from server API (already filtered).
  // During TOD animation, use the cached stats for the current block
  // so the chart updates instantly without waiting for API.
  const byDate = useMemo(() => {
    // Animation: use cached block stats
    if (todAnimate && todCache) {
      const block = todCache.blocks[todAnimIdx]
      if (block?.stats?.byDate) return block.stats.byDate
    }
    if (noiseStats?.byDate) return noiseStats.byDate
    // Fallback: client-side computation from rawStats
    const map = new Map()
    for (const pt of rawStats.perTrack) {
      if (!pt.date) continue
      let b = map.get(pt.date)
      if (!b) {
        b = { date: pt.date, totalFt: 0, yellowFt: 0, orangeFt: 0, redFt: 0 }
        map.set(pt.date, b)
      }
      b.totalFt += pt.totalFt
      b.yellowFt += pt.yellowFt
      b.orangeFt += pt.orangeFt
      b.redFt += pt.redFt
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date))
  }, [noiseStats, rawStats, todAnimate, todCache, todAnimIdx])

  // Live offenses — walk each aircraft's points, find contiguous runs of
  // non-clean points, summarize each as an event. Sorted worst-class first,
  // then most recent.
  const liveOffenses = useMemo(() => {
    if (!liveActive) return []
    const rank = { yellow: 1, orange: 2, red: 3 }
    // Build per-aircraft rows: aircraft header + nested event list
    const byAircraft = []
    for (const ac of liveAircraft) {
      const first = ac.points[0]
      const last = ac.points[ac.points.length - 1]
      const base =
        (first && nearestAirport(first[0], first[1], 3)) ||
        (last && nearestAirport(last[0], last[1], 3)) ||
        null
      const events = []
      let cur = null
      let prevPoint = null
      for (const p of ac.points) {
        const c = classifyPoint(p[0], p[1], p[2], NOISE_ZONES)
        if (c) {
          if (!cur) {
            cur = {
              startTs: p[3],
              endTs: p[3],
              worst: c,
              peakAlt: p[2],
              peakLat: p[0],
              peakLon: p[1],
              distFt: 0,
              points: 1,
            }
          } else {
            cur.endTs = p[3]
            cur.points++
            if (prevPoint) {
              cur.distFt += distFt(prevPoint[0], prevPoint[1], p[0], p[1])
            }
            if (rank[c] > rank[cur.worst]) {
              cur.worst = c
              cur.peakAlt = p[2]
              cur.peakLat = p[0]
              cur.peakLon = p[1]
            } else if (c === cur.worst && p[2] < cur.peakAlt) {
              cur.peakAlt = p[2]
              cur.peakLat = p[0]
              cur.peakLon = p[1]
            }
          }
        } else if (cur) {
          events.push(cur)
          cur = null
        }
        prevPoint = p
      }
      if (cur) { cur.ongoing = true; events.push(cur) }

      if (events.length === 0) continue

      // Landed detection: walk back from the latest point while still within
      // a tight radius; the earliest such ts is when the aircraft went still.
      // If it has been still > 3 min we call it landed, and keep that badge
      // visible for another 15 min.
      const STOP_RADIUS_FT = 200
      const STOP_MIN_MS = 3 * 60 * 1000
      const JUST_LANDED_MS = 15 * 60 * 1000
      let landed = null
      if (ac.points.length > 0) {
        const lp = ac.points[ac.points.length - 1]
        let earliest = lp[3]
        for (let i = ac.points.length - 2; i >= 0; i--) {
          const pp = ac.points[i]
          if (distFt(lp[0], lp[1], pp[0], pp[1]) > STOP_RADIUS_FT) break
          earliest = pp[3]
        }
        const stillMs = Date.now() - earliest
        if (stillMs > STOP_MIN_MS && stillMs < STOP_MIN_MS + JUST_LANDED_MS) {
          landed = { stoppedSince: earliest, stillMs }
        }
      }

      // Attach nearest zone name per event
      for (const e of events) {
        let best = null, bestD = Infinity
        for (const z of NOISE_ZONES) {
          let sLat = 0, sLon = 0
          for (const pp of z.polygon) { sLat += pp[0]; sLon += pp[1] }
          const cLat = sLat / z.polygon.length
          const cLon = sLon / z.polygon.length
          const dx = (e.peakLat - cLat) * 60
          const dy = (e.peakLon - cLon) * 60 * Math.cos((e.peakLat * Math.PI) / 180)
          const dd = Math.hypot(dx, dy)
          if (dd < bestD) { bestD = dd; best = z.name }
        }
        e.zone = best
      }

      const worstOverall = events.reduce(
        (w, e) => (rank[e.worst] > rank[w] ? e.worst : w),
        events[0].worst,
      )
      byAircraft.push({
        icao: ac.icao,
        tail: ac.call || ac.icao,
        type: ac.type || '',
        base,
        worst: worstOverall,
        landed,
        events: events.sort((a, b) => b.endTs - a.endTs),
      })
    }
    byAircraft.sort((a, b) =>
      (rank[b.worst] - rank[a.worst]) ||
      (b.events[0]?.endTs - a.events[0]?.endTs),
    )
    return byAircraft
  }, [liveAircraft, liveActive, clockTick])

  // Live aircraft markers — shown at the latest position of each aircraft,
  // rotated to track heading.
  const liveMarkers = useMemo(() => {
    clockTick // re-evaluate staleness each 5 s tick
    if (!liveActive) return []
    return liveAircraft
      .map((ac) => {
        const last = ac.points[ac.points.length - 1]
        if (!last) return null
        return {
          icao: ac.icao,
          tail: ac.call || ac.icao,
          type: ac.type,
          pos: [last[0], last[1]],
          alt: last[2],
          heading: ac.heading || 0,
          gs: ac.gs,
          lastTs: ac.lastTs || last[3] || 0,
        }
      })
      .filter(Boolean)
  }, [liveAircraft, liveActive, clockTick])

  const stats = useMemo(() => {
    let total = 0, red = 0, orange = 0, yellow = 0
    for (const t of visible) {
      for (const r of t.runs) {
        for (let i = 1; i < r.points.length; i++) {
          const a = r.points[i - 1]
          const b = r.points[i]
          const midLat = (a[0] + b[0]) / 2
          const midLon = (a[1] + b[1]) / 2
          if (nmFromKBDU(midLat, midLon) > VIOLATION_RADIUS_NM) continue
          total++
          if (r.klass === 'red') red++
          else if (r.klass === 'orange') orange++
          else if (r.klass === 'yellow') yellow++
        }
      }
    }
    return { total, red, orange, yellow }
  }, [visible])

  return (
    <div className="h-full w-full flex flex-col">
      {compose && (
        <ComposeNoticeModal compose={compose} onClose={() => setCompose(null)} />
      )}
      <header className="px-4 py-3 border-b border-white/10 flex flex-wrap items-center gap-x-6 gap-y-2">
        <h1 className="text-lg font-semibold">Front Range Aviation Monitor</h1>
        <Nav route={route} />
        <div className="text-xs text-white/60">
          {visible.length} tracks ·{' '}
          <span className="text-red-400">
            {stats.total ? Math.round((stats.red / stats.total) * 100) : 0}% red
          </span>{' '}
          ·{' '}
          <span className="text-orange-400">
            {stats.total ? Math.round((stats.orange / stats.total) * 100) : 0}% orange
          </span>{' '}
          ·{' '}
          <span className="text-yellow-300">
            {stats.total ? Math.round((stats.yellow / stats.total) * 100) : 0}% yellow
          </span>
        </div>

        <div className="flex items-center gap-3 text-xs">
          {/* ALWAYS-PRESENT controls — render on every mount, order is stable */}
          <button
            onClick={toggleLive}
            className={`flex items-center gap-1.5 px-2 py-0.5 text-xs rounded border ${
              liveActive
                ? 'bg-green-500/25 text-white border-green-400/50'
                : 'text-white/60 hover:text-white border-white/15'
            }`}
            title={`Live feed rotation: ${LIVE_FEEDS.map((f) => f.id).join(' → ')}. Polls every 5 s; auto-rolls over to the next feed on failure.`}
          >
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                liveActive ? 'bg-green-400 animate-pulse' : 'bg-white/30'
              }`}
            />
            Live
            {liveActive && (
              <span className="text-[9px] text-white/60">
                {activeFeedId}
                {lastLiveAt && ` · ${Math.max(0, Math.round((Date.now() - lastLiveAt) / 1000))}s`}
              </span>
            )}
          </button>
          <div className="flex items-center gap-1 flex-wrap">
            {[
              { label: 'Paths', active: showPaths, toggle: () => setShowPaths((v) => !v) },
              { label: 'Zones', active: showZones, toggle: () => setShowZones((v) => !v) },
              { label: 'Heatmap', active: realImpact, toggle: () => setRealImpact((v) => !v) },
              { label: 'Population', active: showPopDensity, toggle: () => setShowPopDensity((v) => !v) },
              { label: 'Impact', active: showImpact, toggle: () => setShowImpact((v) => !v) },
              { label: 'Violators', active: onlyViolations, toggle: () => setOnlyViolations((v) => !v) },
            ].map((b) => (
              <button
                key={b.label}
                onClick={b.toggle}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  b.active
                    ? 'border-cyan-400 text-cyan-200 bg-cyan-500/20'
                    : 'border-white/20 text-white/50 hover:border-white/40 hover:text-white/70'
                }`}
              >
                {b.label}
              </button>
            ))}
          </div>
          {showPopDensity && popDensityOverlay && (
            <div className="flex items-center gap-1.5">
              <span className="text-white/50 text-[10px]">density</span>
              <input
                type="range"
                min="0.1"
                max="1"
                step="0.05"
                value={popDensityOpacity}
                onChange={(e) => setPopDensityOpacity(Number(e.target.value))}
                className="w-20 accent-cyan-400"
              />
              <span className="w-6 text-[10px] tabular-nums text-right text-white/50">{popDensityOpacity.toFixed(1)}</span>
            </div>
          )}
          {showImpact && impactPopRaster && (
            <div className="flex items-center gap-1.5">
              <span className="text-white/50 text-[10px]">impact</span>
              <input
                type="range"
                min="0.1"
                max="3"
                step="0.1"
                value={impactPopOpacity}
                onChange={(e) => setImpactPopOpacity(Number(e.target.value))}
                className="w-20 accent-cyan-400"
              />
              <span className="w-6 text-[10px] tabular-nums text-right text-white/50">{impactPopOpacity.toFixed(1)}</span>
            </div>
          )}
          <div className="flex items-center gap-1 flex-wrap">
            {[
              { code: 'KBDU', lat: 40.0394, lon: -105.2258, zoom: 13 },
              { code: 'KBJC', lat: 39.9088, lon: -105.1172, zoom: 13 },
              { code: 'KEIK', lat: 40.0098, lon: -105.0488, zoom: 13 },
              { code: 'KLMO', lat: 40.1636, lon: -105.1636, zoom: 13 },
              { code: 'KAPA', lat: 39.5701, lon: -104.8493, zoom: 13 },
              { code: 'KGXY', lat: 40.4348, lon: -104.6331, zoom: 13 },
              { code: 'All', lat: 39.97, lon: -105.03, zoom: 10 },
            ].map((ap) => (
              <button
                key={ap.code}
                onClick={() => mapRef.current && mapRef.current.flyTo([ap.lat, ap.lon], ap.zoom, { duration: 1 })}
                className="text-[9px] px-1.5 py-0.5 rounded border border-white/20 text-white/70 hover:border-cyan-400 hover:text-cyan-200"
              >
                {ap.code}
              </button>
            ))}
          </div>
          {realImpact && (
            <div className="flex items-center gap-1.5">
              <span className="text-white/50 text-[10px]">heatmap</span>
              <input
                type="range"
                min="0.1"
                max="3"
                step="0.1"
                value={impactOpacity}
                onChange={(e) => setImpactOpacity(Number(e.target.value))}
                className="w-20 accent-cyan-400"
              />
              <span className="w-6 text-[10px] tabular-nums text-right text-white/50">{impactOpacity.toFixed(1)}</span>
            </div>
          )}
          <div className="flex items-center gap-1">
            {['all', 'east', 'west'].map((d) => (
              <button
                key={d}
                onClick={() => setDirFilter(d)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  dirFilter === d
                    ? 'border-cyan-400 text-cyan-200 bg-cyan-500/20'
                    : 'border-white/20 text-white/50 hover:border-white/40 hover:text-white/70'
                }`}
              >
                {d === 'all' ? 'All dirs' : d === 'east' ? 'East dep' : 'West dep'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => { setTodFilter((v) => { if (v) setTodAnimate(false); return !v }); }}
              className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                todFilter
                  ? 'border-cyan-400 text-cyan-200 bg-cyan-500/20'
                  : 'border-white/20 text-white/50 hover:border-white/40 hover:text-white/70'
              }`}
            >
              Time of day
            </button>
            {todAnimate && (
              <button
                onClick={() => setTodAnimate(false)}
                className="text-[9px] px-1.5 py-0.5 rounded border border-amber-400 text-amber-200 bg-amber-500/20 animate-pulse"
              >
                Stop {TOD_PRESETS[todAnimIdx]?.label}
              </button>
            )}
          </div>
          {todFilter && (
            <div className="flex flex-col gap-1 ml-5">
              <div className="flex gap-1">
                {TOD_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => { setTodStart(p.start); setTodEnd(p.end); setTodAnimate(false) }}
                    className={`text-[9px] px-1.5 py-0.5 rounded border ${
                      todStart === p.start && todEnd === p.end && !todAnimate
                        ? 'border-cyan-400 text-cyan-200 bg-cyan-500/20'
                        : 'border-white/20 text-white/60 hover:text-white'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
                <button
                  onClick={() => { setTodFilter(true); setTodAnimate((a) => !a) }}
                  className={`text-[9px] px-1.5 py-0.5 rounded border ${
                    todAnimate
                      ? 'border-amber-400 text-amber-200 bg-amber-500/20 animate-pulse'
                      : 'border-white/20 text-white/60 hover:text-white'
                  }`}
                >
                  {todAnimate ? TOD_PRESETS[todAnimIdx]?.label : 'Animate'}
                </button>
              </div>
              <div className="flex items-center gap-1 text-[9px]">
                <span className="w-6 text-right font-mono">{todStart}h</span>
                <input type="range" min={0} max={24} step={1} value={todStart}
                  onChange={(e) => { setTodStart(+e.target.value); setTodAnimate(false) }}
                  className="w-16" />
                <span className="text-white/40">–</span>
                <input type="range" min={0} max={24} step={1} value={todEnd}
                  onChange={(e) => { setTodEnd(+e.target.value); setTodAnimate(false) }}
                  className="w-16" />
                <span className="w-6 font-mono">{todEnd}h</span>
              </div>
              <div className="text-[9px] text-white/50">
                {visible.length} tracks in view
              </div>
            </div>
          )}
          {/* LATE-LOADING controls appear to the right of the always-present ones */}
          {availableYears.length > 0 && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setYearFilter(yearFilter === 'all' ? null : 'all')}
                className={`px-2.5 py-0.5 text-xs rounded-full border ${
                  yearFilter === 'all'
                    ? 'border-cyan-400 bg-cyan-500/20 text-white'
                    : 'border-white/15 text-white/60 hover:text-white hover:border-white/30'
                }`}
              >
                all yrs
              </button>
              {availableYears.map((y) => {
                const pct = pillStats.yearPct[y] ?? 0
                const bg = thermalColor(pct, pillStats.maxYear)
                return (
                  <button
                    key={y}
                    onClick={() => setYearFilter(yearFilter === y ? null : y)}
                    style={yearFilter !== y ? { backgroundColor: bg } : undefined}
                    className={`px-2.5 py-0.5 text-xs rounded-full border ${
                      yearFilter === y
                        ? 'border-cyan-400 bg-cyan-500/20 text-white'
                        : 'border-white/10 text-white/90 hover:brightness-125'
                    }`}
                    title={`${y} · ${pct.toFixed(1)}% red`}
                  >
                    {y}
                  </button>
                )
              })}
            </div>
          )}
          {availableSchools.length > 0 && (
            <select
              value={schoolFilter}
              onChange={(e) => setSchoolFilter(e.target.value)}
              className="border border-white/15 text-xs rounded-full px-3 py-1 hover:border-white/30 bg-gray-800 text-white/90 max-w-[12rem]"
            >
              <option value="all">all schools</option>
              {availableSchools.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          )}
          {noiseStats?.purposes && (
            <select
              value={purposeFilter}
              onChange={(e) => setPurposeFilter(e.target.value)}
              className="border border-white/15 text-xs rounded-full px-3 py-1 hover:border-white/30 bg-gray-800 text-white/90 max-w-[12rem]"
            >
              <option value="all">all purposes</option>
              {noiseStats.purposes.map((p) => (
                <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>
              ))}
            </select>
          )}
          {availableBases.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="text-[9px] text-white/40 uppercase tracking-wider px-1">Saved Views</div>
              <div className="flex items-center gap-1 flex-wrap">
                <button
                  onClick={() => setBaseFilter('all')}
                  className={`px-2.5 py-0.5 text-xs rounded-full border ${
                    baseFilter === 'all'
                      ? 'border-cyan-400 bg-cyan-500/20 text-white'
                      : 'border-white/15 text-white/60 hover:text-white hover:border-white/30'
                  }`}
                >
                  all airports
                </button>
                {availableBases.map((b) => {
                  const pct = pillStats.basePct[b] ?? 0
                  const bg = thermalColor(pct, pillStats.maxBase)
                  return (
                    <button
                      key={b}
                      onClick={() => setBaseFilter(b)}
                      style={baseFilter !== b ? { backgroundColor: bg } : undefined}
                      className={`px-2.5 py-0.5 text-xs font-mono rounded-full border ${
                        baseFilter === b
                          ? 'border-cyan-400 bg-cyan-500/20 text-white'
                          : 'border-white/10 text-white/90 hover:brightness-125'
                      }`}
                      title={`${b} · ${pct.toFixed(1)}% red`}
                    >
                      {b}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

      </header>

      <div
        className="flex-1 relative"
        onContextMenu={(e) => {
          e.preventDefault()
          clearSelected()
        }}
      >
        {byTail.length > 0 && (
          <div className="absolute top-3 right-3 z-[1000] bg-black/75 backdrop-blur-sm border border-white/10 rounded-lg p-2 text-[11px] max-h-[calc(100%-1.5rem)] overflow-y-auto w-72">
            <div className="flex items-center justify-between mb-1 px-1 gap-2">
              <div className="flex items-center gap-0 rounded overflow-hidden border border-white/15">
                <button
                  onClick={() => setOffenderTab('pct')}
                  className={`px-2 py-0.5 text-[10px] ${
                    offenderTab === 'pct'
                      ? 'bg-cyan-500/30 text-white'
                      : 'text-white/60 hover:text-white'
                  }`}
                >
                  Highest %
                </button>
                <button
                  onClick={() => setOffenderTab('len')}
                  className={`px-2 py-0.5 text-[10px] ${
                    offenderTab === 'len'
                      ? 'bg-cyan-500/30 text-white'
                      : 'text-white/60 hover:text-white'
                  }`}
                >
                  Most
                </button>
              </div>
              {selectedTails.length > 0 && (
                <button
                  onClick={clearSelected}
                  className="text-[9px] text-cyan-300 hover:text-white"
                >
                  clear ({selectedTails.length})
                </button>
              )}
            </div>
            <table className="w-full">
              <tbody>
                {byTailSorted.slice(0, 30).map((a) => {
                  const sel = isSelected(a.tail)
                  const sch = schoolsByTail.get(a.tail)
                  return (
                    <Fragment key={a.tail}>
                      <tr
                        onClick={(e) => selectTail(a.tail, e)}
                        className={`border-t border-white/5 cursor-pointer ${
                          sel ? 'bg-cyan-500/20' : 'hover:bg-white/5'
                        }`}
                      >
                        <td className="px-1 py-0.5 font-mono text-white/90">{a.tail}</td>
                        <td className="px-1 py-0.5 text-white/50">{a.type || '—'}</td>
                        <td className="px-1 py-0.5 text-white/50 font-mono text-[10px]">
                          {a.base || '—'}
                        </td>
                        <td className="px-1 py-0.5 text-right tabular-nums text-red-400">
                          {a.pctRed.toFixed(0)}%
                        </td>
                        {offenderTab === 'len' ? (
                          <td className="px-1 py-0.5 text-right tabular-nums text-red-300">
                            {a.redNm.toFixed(1)} nm
                          </td>
                        ) : (
                          <td className="px-1 py-0.5 text-right tabular-nums text-white/40">
                            {a.tracks}
                          </td>
                        )}
                      </tr>
                      {sch && (
                        <tr
                          onClick={(e) => selectTail(a.tail, e)}
                          className={`cursor-pointer ${
                            sel ? 'bg-cyan-500/20' : ''
                          }`}
                        >
                          <td colSpan={5} className="px-1 pb-1 text-[9px] text-amber-300/80 italic truncate">
                            {sch.school} @ {sch.airport}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {byDate.length > 0 && (() => {
          // Excursion % per date: what fraction of total flight miles
          // were in noise zones, broken down by severity
          const bars = byDate.map((b) => {
            const t = b.totalFt || 0
            return {
              date: b.date,
              flights: b.flights || 0,
              y: t > 0 ? (b.yellowFt / t) * 100 : 0,
              o: t > 0 ? (b.orangeFt / t) * 100 : 0,
              r: t > 0 ? (b.redFt / t) * 100 : 0,
              sum: t > 0 ? ((b.yellowFt + b.orangeFt + b.redFt) / t) * 100 : 0,
            }
          })
          const maxSum = Math.max(0.5, ...bars.map((b) => b.sum))
          const W = 360, H = 130
          const padL = 4, padR = 4, padT = 6, padB = 22
          const barArea = W - padL - padR
          const chartH = H - padT - padB
          const bw = barArea / Math.max(1, bars.length)

          // Linear trend line (least-squares) for each color
          const linReg = (vals) => {
            const n = vals.length
            if (n < 2) return null
            let sx = 0, sy = 0, sxx = 0, sxy = 0
            for (let i = 0; i < n; i++) {
              sx += i; sy += vals[i]; sxx += i * i; sxy += i * vals[i]
            }
            const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx)
            const intercept = (sy - slope * sx) / n
            return { y0: intercept, y1: intercept + slope * (n - 1) }
          }
          const trendR = linReg(bars.map(b => b.r))
          const trendO = linReg(bars.map(b => b.o))
          const trendY = linReg(bars.map(b => b.y))
          const trendLine = (trend, color, id) => {
            if (!trend) return null
            const x1 = padL + bw / 2
            const x2 = padL + (bars.length - 1) * bw + bw / 2
            const y1 = padT + chartH - (trend.y0 / maxSum) * chartH
            const y2 = padT + chartH - (trend.y1 / maxSum) * chartH
            return (
              <g key={id}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="black" strokeWidth="5" opacity="0.5" />
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth="2" opacity="0.95" />
              </g>
            )
          }

          return (
            <div className="absolute bottom-3 left-3 z-[1000] bg-black/75 backdrop-blur-sm border border-white/10 rounded-lg p-2">
              <div className="flex items-center gap-2 mb-1 px-1">
                <span className="text-white/70 text-[10px] font-medium">Excursion %</span>
                <span className="text-white/40 text-[9px]">
                  {bars.length} days · {bars[0]?.date?.slice(2)} → {bars[bars.length - 1]?.date?.slice(2)}
                </span>
                <span className="ml-auto text-white/40 text-[9px] tabular-nums">
                  avg {(bars.reduce((s, b) => s + b.sum, 0) / Math.max(1, bars.length)).toFixed(2)}%
                  · max {maxSum.toFixed(1)}%
                </span>
              </div>
              <svg width={W} height={H} className="block">
                {bars.map((b, i) => {
                  const x = padL + i * bw
                  const hR = (b.r / maxSum) * chartH
                  const hO = (b.o / maxSum) * chartH
                  const hY = (b.y / maxSum) * chartH
                  const yR = padT + chartH - hR
                  const yO = yR - hO
                  const yY = yO - hY
                  const colW = Math.max(2, bw - 1.5)
                  return (
                    <g key={b.date}>
                      <rect x={x} y={yR} width={colW} height={hR} fill="#dc2626" />
                      <rect x={x} y={yO} width={colW} height={hO} fill="#f97316" />
                      <rect x={x} y={yY} width={colW} height={hY} fill="#facc15" />
                      <title>
                        {b.date} ({b.flights} flights)
                        {'\n'}yellow: {b.y.toFixed(2)}%
                        {'\n'}orange: {b.o.toFixed(2)}%
                        {'\n'}red: {b.r.toFixed(2)}%
                        {'\n'}total: {b.sum.toFixed(2)}%
                      </title>
                    </g>
                  )
                })}
                {/* Trend lines */}
                {/* Trend lines: yellow bottom, red on top */}
                {trendLine(trendY, '#facc15', 'ty')}
                {trendLine(trendO, '#f97316', 'to')}
                {trendLine(trendR, '#dc2626', 'tr')}
                {/* X-axis labels */}
                {Array.from(new Set([0, Math.floor(bars.length / 2), bars.length - 1]))
                  .filter((i) => i >= 0 && i < bars.length)
                  .map((i) => (
                    <text
                      key={`lbl-${i}`}
                      x={padL + i * bw + bw / 2}
                      y={H - 6}
                      textAnchor="middle"
                      fontSize="9"
                      fill="#9ca3af"
                    >
                      {bars[i].date.slice(2)}
                    </text>
                  ))}
              </svg>
            </div>
          )
        })()}
        {liveActive && liveOffenses.length > 0 && (() => {
          // Max single-event distance across all visible offenses, used to
          // scale each event's color bar width.
          const maxDist = Math.max(
            1,
            ...liveOffenses.flatMap((a) => a.events.map((e) => e.distFt)),
          )
          return (
            <div className="absolute top-3 right-[19.5rem] z-[1000] bg-black/75 backdrop-blur-sm border border-white/10 rounded-lg p-2 text-[11px] w-64 max-h-[70%] overflow-y-auto">
              <div className="text-white/50 uppercase tracking-wide text-[9px] mb-1 px-1 flex items-center justify-between">
                <span>Live offenders · {liveOffenses.length}</span>
                {selectedTails.length > 0 && (
                  <button
                    onClick={clearSelected}
                    className="text-[9px] text-cyan-300 hover:text-white"
                  >
                    show all
                  </button>
                )}
              </div>
              <div className="space-y-2">
                {liveOffenses.slice(0, 20).map((a) => {
                  const sel = isSelected(a.tail)
                  const sch = schoolsByTail.get(a.tail)
                  const outlineCls = a.worst === 'red' ? 'border-red-500/60' :
                                     a.worst === 'orange' ? 'border-orange-500/60' :
                                     'border-yellow-500/60'
                  const bgCls = sel ? 'bg-cyan-500/15' : 'bg-black/30'
                  return (
                    <div
                      key={a.icao}
                      onClick={(ev) => selectTail(a.tail, ev)}
                      className={`border ${outlineCls} ${bgCls} rounded p-1.5 cursor-pointer hover:bg-white/5`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-semibold text-white/90">{a.tail}</span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-white/50 text-[10px]">{a.type || '—'}</span>
                          {(() => {
                            const to = sch?.email || ''
                            const title = to
                              ? `Compose notice to ${sch.school}`
                              : sch
                                ? `Compose notice — no email on file for ${sch.school}, enter one`
                                : 'Compose notice — school unknown, enter email'
                            return (
                              <button
                                type="button"
                                onClick={(ev) => {
                                  ev.stopPropagation()
                                  const worstEv = a.events.reduce(
                                    (m, e) => (e.distFt > (m?.distFt ?? -1) ? e : m),
                                    null,
                                  )
                                  const distNm = worstEv
                                    ? (worstEv.distFt / 6076).toFixed(2)
                                    : ''
                                  const dateStr = worstEv
                                    ? new Date(worstEv.startTs).toLocaleString()
                                    : ''
                                  const subject = `Welcome to Boulder (KBDU) — a friendly hello about ${a.tail}`
                                  const body =
`Hello${sch?.school ? ' ' + sch.school : ''},

A friendly hello from the team at Boulder Municipal Airport (KBDU). We saw ${a.tail}${a.type ? ' (' + a.type + ')' : ''} in the neighborhood on ${dateStr}, passing near our Voluntary Noise Abatement corridors, and we'd love the chance to introduce you to how we fly here together.

Boulder sits in a narrow strip of shared airspace west of Denver, and the voluntary corridors are pilot-built and pilot-maintained. Visiting pilots are the heart of the progress we're making together — and we'd love to welcome you in.

A few ways to get to know us better:
  • First Saturday fly-in breakfast at KBDU
  • Front Range Airspace Wings events
  • An Airspace Awareness flight with a local CFI who'll walk the flows with you from the cockpit

A friendly map of the visit is here (ADS-B participation is voluntary; this review is for courtesy and education only):
${window.location.origin}/notice?tail=${encodeURIComponent(a.tail)}&at=${worstEv?.startTs || ''}&school=${encodeURIComponent(sch?.school || '')}

Blue skies, and welcome to Boulder,
The team at Boulder Municipal Airport (KBDU)`
                                  setCompose({
                                    to,
                                    subject,
                                    body,
                                    school: sch?.school || '',
                                    tail: a.tail,
                                  })
                                }}
                                title={title}
                                className={`text-[10px] px-1.5 py-0.5 rounded border cursor-pointer ${
                                  to
                                    ? 'border-cyan-400/50 text-cyan-300 hover:bg-cyan-400/10'
                                    : 'border-amber-400/50 text-amber-300 hover:bg-amber-400/10'
                                }`}
                              >
                                ✉
                              </button>
                            )
                          })()}
                        </div>
                      </div>
                      <div className="text-[9px] italic truncate">
                        {sch ? (
                          <span className="text-amber-300/80">
                            {sch.school} @ {sch.airport}
                          </span>
                        ) : (
                          <span className="text-white/30">school?</span>
                        )}
                      </div>
                      <div className="text-white/40 text-[9px] mb-1 flex items-center justify-between">
                        <span>based: <span className="font-mono text-white/60">{a.base || '—'}</span></span>
                        {a.landed && (() => {
                          const mins = Math.round(a.landed.stillMs / 60000)
                          return (
                            <span
                              className="ml-1 px-1 py-[1px] rounded bg-emerald-500/20 border border-emerald-400/40 text-emerald-200 text-[9px] font-semibold tracking-wide"
                              title={`Stationary since ${new Date(a.landed.stoppedSince).toLocaleTimeString()}`}
                            >
                              JUST LANDED · {mins}m
                            </span>
                          )
                        })()}
                      </div>
                      <div className="space-y-0.5">
                        {a.events.map((e, ei) => {
                          const durSec = Math.max(0, Math.round((e.endTs - e.startTs) / 1000))
                          const distNm = e.distFt / 6076
                          const barColor = e.worst === 'red' ? '#dc2626'
                                         : e.worst === 'orange' ? '#f97316'
                                         : '#facc15'
                          const barW = Math.max(4, (e.distFt / maxDist) * 100)
                          // Age label: LIVE for ongoing events, otherwise
                          // "Ns / Nm / Nh ago" based on minutes since endTs.
                          let ageLabel
                          let ageCls = 'text-white/40'
                          if (e.ongoing) {
                            ageLabel = 'LIVE'
                            ageCls = 'text-green-400 font-semibold'
                          } else {
                            const mins = Math.max(0, (Date.now() - e.endTs) / 60000)
                            if (mins < 1) ageLabel = `-${Math.round(mins * 60)}s`
                            else if (mins < 60) ageLabel = `-${Math.round(mins)}m`
                            else ageLabel = `-${Math.round(mins / 60)}h`
                          }
                          return (
                            <div key={ei} className="flex items-center gap-1.5 text-[10px]">
                              <div className="flex-1 h-2 bg-white/5 rounded overflow-hidden">
                                <div
                                  className="h-full"
                                  style={{ width: `${barW}%`, backgroundColor: barColor }}
                                />
                              </div>
                              <span className="tabular-nums text-white/70 w-12 text-right">
                                {distNm.toFixed(2)}nm
                              </span>
                              <span className="tabular-nums text-white/40 w-8 text-right">
                                {durSec}s
                              </span>
                              <span className={`tabular-nums text-right w-14 ${ageCls}`}>
                                {ageLabel}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                      <div className="text-white/30 text-[9px] mt-0.5 truncate">
                        {a.events[0].zone || '—'}
                        {a.events.some((e) => e.ongoing) && ' · live'}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })()}
        {byBase.length > 0 && (
          <div className="absolute bottom-3 right-3 z-[1000] bg-black/75 backdrop-blur-sm border border-white/10 rounded-lg p-2 text-[11px] w-64">
            <div className="flex items-center gap-2 mb-1 px-1">
              <div className="flex items-center gap-0 rounded overflow-hidden border border-white/15">
                <button
                  onClick={() => setBaseTab('pct')}
                  className={`px-2 py-0.5 text-[10px] ${
                    baseTab === 'pct'
                      ? 'bg-cyan-500/30 text-white'
                      : 'text-white/60 hover:text-white'
                  }`}
                >
                  Highest %
                </button>
                <button
                  onClick={() => setBaseTab('len')}
                  className={`px-2 py-0.5 text-[10px] ${
                    baseTab === 'len'
                      ? 'bg-cyan-500/30 text-white'
                      : 'text-white/60 hover:text-white'
                  }`}
                >
                  Most
                </button>
              </div>
              <span className="text-white/40 uppercase tracking-wide text-[9px]">by base</span>
            </div>
            <table className="w-full">
              <thead>
                <tr className="text-white/40 text-[9px]">
                  <th className="text-left px-1">base</th>
                  <th className="text-right px-1">a/c</th>
                  <th className="text-right px-1">% red</th>
                  <th className="text-right px-1">{baseTab === 'len' ? 'red nm' : 'segs'}</th>
                </tr>
              </thead>
              <tbody>
                {byBaseSorted.map((b) => (
                  <tr key={`${b.kind}-${b.base}`} className="border-t border-white/5">
                    <td
                      className={`px-1 py-0.5 truncate max-w-[120px] ${
                        b.kind === 'school'
                          ? 'text-amber-300/90 italic text-[10px]'
                          : 'font-mono text-white/90'
                      }`}
                    >
                      {b.base}
                    </td>
                    <td className="px-1 py-0.5 text-right tabular-nums text-white/60">{b.aircraft}</td>
                    <td className="px-1 py-0.5 text-right tabular-nums text-red-400">
                      {b.pctRed.toFixed(1)}%
                    </td>
                    {baseTab === 'len' ? (
                      <td className="px-1 py-0.5 text-right tabular-nums text-red-300">
                        {b.redNm.toFixed(1)}
                      </td>
                    ) : (
                      <td className="px-1 py-0.5 text-right tabular-nums text-white/40">
                        {b.total}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-[9px] text-white/40 mt-1 px-1 italic">
              right-click or Esc to clear selection
            </div>
          </div>
        )}
        {/* TOD indicator — shows active time range when filter is on */}
        {todFilter && (
          <div className="absolute top-3 right-3 z-[1000] pointer-events-none">
            <div className="bg-black/80 backdrop-blur-sm border border-white/20 rounded-lg px-3 py-2 flex flex-col items-center">
              {/* Clock face showing the active arc */}
              <svg viewBox="0 0 44 44" width="40" height="40">
                <circle cx="22" cy="22" r="19" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
                {/* Active arc */}
                {(() => {
                  const s = todStart, e = todEnd
                  const startAngle = (s / 12) * 360 - 90
                  const endAngle = (e / 12) * 360 - 90
                  const r = 17
                  const x1 = 22 + r * Math.cos(startAngle * Math.PI / 180)
                  const y1 = 22 + r * Math.sin(startAngle * Math.PI / 180)
                  const x2 = 22 + r * Math.cos(endAngle * Math.PI / 180)
                  const y2 = 22 + r * Math.sin(endAngle * Math.PI / 180)
                  const span = s <= e ? e - s : 24 - s + e
                  const large = span > 12 ? 1 : 0
                  return (
                    <path
                      d={`M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2}`}
                      fill="none" stroke="rgba(34,211,238,0.7)" strokeWidth="4" strokeLinecap="round"
                    />
                  )
                })()}
                {/* Hour ticks */}
                {[...Array(12)].map((_, i) => {
                  const a = (i / 12) * 360 - 90
                  const r1 = 15, r2 = 19
                  return (
                    <line key={i}
                      x1={22 + r1 * Math.cos(a * Math.PI / 180)} y1={22 + r1 * Math.sin(a * Math.PI / 180)}
                      x2={22 + r2 * Math.cos(a * Math.PI / 180)} y2={22 + r2 * Math.sin(a * Math.PI / 180)}
                      stroke="rgba(255,255,255,0.3)" strokeWidth="1"
                    />
                  )
                })}
                <circle cx="22" cy="22" r="1.5" fill="rgba(255,255,255,0.5)" />
              </svg>
              <div className="text-[10px] text-white/80 font-mono mt-0.5">
                {todStart}:00 – {todEnd}:00
              </div>
              {todAnimate && (
                <div className="text-[9px] text-amber-300 animate-pulse mt-0.5">
                  {TOD_PRESETS[todAnimIdx]?.label}
                </div>
              )}
            </div>
          </div>
        )}
        {serverLoading && (
          <div className="absolute top-0 left-0 right-0 z-[1000] bg-gray-900/90 px-4 py-2 flex items-center gap-3">
            <div className="flex-1 bg-gray-700 rounded-full h-1.5 overflow-hidden">
              <div className="bg-cyan-400 h-full w-1/3 animate-pulse" />
            </div>
            <span className="text-xs text-white/60">Loading tracks...</span>
          </div>
        )}
        {loadProgress && (
          <div className={`absolute top-0 left-0 right-0 z-[1000] px-4 py-3 flex items-center gap-3 ${
            loadProgress.error ? 'bg-red-900/95' : 'bg-gray-900/90'
          }`}>
            <div className="flex-1 bg-gray-700 rounded-full h-2 overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${loadProgress.error ? 'bg-red-400' : 'bg-cyan-400'}`}
                style={{ width: `${loadProgress.total ? (loadProgress.loaded / loadProgress.total * 100) : 5}%` }}
              />
            </div>
            <span className="text-xs text-white/80 whitespace-nowrap max-w-[50%] truncate">
              {loadProgress.status || `${loadProgress.loaded.toLocaleString()} / ${loadProgress.total.toLocaleString()}`}
            </span>
          </div>
        )}
        {(errors.yearly || errors.stats || errors.tracks) && !loadProgress && (
          <div className="absolute top-0 left-0 right-0 z-[1000] bg-red-900/95 px-4 py-3 text-xs text-white">
            Error: {errors.yearly || errors.stats || errors.tracks}
          </div>
        )}
        <MapContainer center={[39.97, -105.03]} zoom={10} className="h-full w-full" preferCanvas={true} ref={mapRef}>
          <TileLayer
            attribution="&copy; OpenStreetMap"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <Circle
            center={KBDU}
            radius={MAP_RADIUS_NM * 1852}
            pathOptions={{ color: '#22d3ee', weight: 1, fill: false, dashArray: '4 6' }}
          />
          <Circle
            center={KBDU}
            radius={VIOLATION_RADIUS_NM * 1852}
            pathOptions={{ color: '#f97316', weight: 1, fill: false, dashArray: '2 4' }}
          />

          {showZones &&
            NOISE_ZONES.map((z, i) => (
              <Polygon
                key={i}
                positions={z.polygon}
                pathOptions={{
                  color: '#7e22ce',      // purple-700 outline
                  weight: 2,
                  fillColor: '#a855f7',  // purple-500 fill
                  fillOpacity: 0.1,
                  dashArray: '4 4',
                }}
              >
                <Tooltip sticky direction="top" offset={[40, -10]}>
                  <div className="text-xs max-w-[200px]">
                    <div className="font-semibold text-purple-300">{z.name}</div>
                    <div className="text-white/70">{z.note}</div>
                  </div>
                </Tooltip>
              </Polygon>
            ))}

          {/* Population density underlay */}
          {showPopDensity && popDensityOverlay && (
            <ImageOverlay
              url={popDensityOverlay.dataUrl}
              bounds={popDensityOverlay.latLngBounds}
              opacity={popDensityOpacity}
              interactive={false}
            />
          )}

          {/* Impact raster — fades between frames during TOD animation */}
          {realImpact && impactRaster && (
            <Pane name="impact-pane" style={{ transition: 'opacity 0.6s ease-in-out' }}>
              <ImageOverlay
                key={todFilter ? `tod-${todStart}-${todEnd}` : 'all'}
                url={impactRaster.dataUrl}
                bounds={impactRaster.latLngBounds}
                opacity={impactOpacity}
                interactive={false}
              />
            </Pane>
          )}

          {/* Noise × population impact raster */}
          {showImpact && impactPopRaster && (
            <ImageOverlay
              key={todFilter ? `impact-${todStart}-${todEnd}` : 'impact-all'}
              url={impactPopRaster.dataUrl}
              bounds={impactPopRaster.latLngBounds}
              opacity={impactPopOpacity}
              interactive={false}
            />
          )}

          {/* Full-track overlay for the clicked aircraft — drawn last so it sits on top */}
          {showPaths && selectedOverlays.flatMap((t, ti) =>
            t.overlayRuns.map((r, ri) => {
              const color = r.klass ? CLASS_COLOR[r.klass] : (t._cleanColor || '#1a7070')
              return (
                <Polyline
                  key={`sel-${t._src}-${ti}-${ri}`}
                  positions={r.points.map((p) => [p[0], p[1]])}
                  pathOptions={{ color, weight: 4, opacity: 1 }}
                >
                  <Tooltip sticky direction="top" offset={[40, -10]}>
                    <div className="text-xs">
                      <div className="font-semibold">{t.call}</div>
                      <div>{t.type || '—'}</div>
                      {schoolsByTail.get(t.call || t.reg) && (
                        <div className="text-amber-300/90 italic">
                          {schoolsByTail.get(t.call || t.reg).school} @ {schoolsByTail.get(t.call || t.reg).airport}
                        </div>
                      )}
                      <div className="text-white/60">{t.src}</div>
                      {singleHeatmap?.stats && singleHeatmap.stats.hp != null && (
                        <div className="mt-1 pt-1 border-t border-white/20 text-white/80">
                          <div>HP: <span className="tabular-nums">{singleHeatmap.stats.hp}</span>{singleHeatmap.stats.hp === 0 && <span className="text-red-400"> (no engine)</span>}</div>
                          <div>
                            AGL: <span className="tabular-nums">{singleHeatmap.stats.aglMin}–{singleHeatmap.stats.aglMax}</span> (med <span className="tabular-nums">{singleHeatmap.stats.aglMedian}</span>)
                          </div>
                          <div>
                            climb/cruise/desc: <span className="tabular-nums">{singleHeatmap.stats.climb}/{singleHeatmap.stats.cruise}/{singleHeatmap.stats.descent}</span>
                          </div>
                          {singleHeatmap.dbMax != null && (
                            <div>peak: <span className="tabular-nums">{singleHeatmap.dbMax.toFixed(1)} dB</span></div>
                          )}
                        </div>
                      )}
                    </div>
                  </Tooltip>
                </Polyline>
              )
            })
          )}

          {showPaths && visible.flatMap((t, ti) => {
            if (t._src === 'live') return [] // rendered separately with age-based opacity
            const tail = t.call || t.reg
            // Isolation: when any tail is selected, hide every other track on
            // the map so pan/zoom only has to redraw the selected aircraft.
            if (selectedTails.length > 0 && !selectedTails.includes(tail)) return []
            const agg = byTailMap.get(tail)
            return t.runs.map((r, ri) => {
              const color = r.klass ? CLASS_COLOR[r.klass] : (t._cleanColor || '#1a7070')
              return (
                <Polyline
                  key={`${t._src}-${ti}-${ri}`}
                  positions={r.points.map((p) => [p[0], p[1]])}
                  pathOptions={{
                    color,
                    weight: 3,
                    opacity: r.klass ? 0.3 : 0.18,
                  }}
                  eventHandlers={{
                    click: (e) => selectTail(tail, e.originalEvent),
                  }}
                >
                  <Tooltip sticky direction="top" offset={[40, -10]}>
                    <div className="text-xs">
                      <div className="font-semibold">{t.call}</div>
                      <div>{t.type || '—'}</div>
                      {schoolsByTail.get(tail) && (
                        <div className="text-amber-300/90 italic">
                          {schoolsByTail.get(tail).school} @ {schoolsByTail.get(tail).airport}
                        </div>
                      )}
                      <div>
                        avg {Math.round(r.avgAlt)} ft · {r.points.length} pts
                      </div>
                      <div className="text-white/60">
                        {r.klass ? `zone: ${r.klass}` : 'clean'}
                      </div>
                      {agg && (
                        <div className="text-white/70 mt-1 border-t border-white/20 pt-1">
                          base: <span className="font-mono">{agg.base || '—'}</span> ·{' '}
                          <span className="text-red-400">{agg.pctRed.toFixed(0)}% red</span>
                        </div>
                      )}
                      <div className="text-white/50">{t.src}</div>
                      <div className="text-cyan-300 mt-0.5">click to select</div>
                    </div>
                  </Tooltip>
                </Polyline>
              )
            })
          })}

          {/* Live segments — one polyline per consecutive-pair with age-based
              opacity. The map uses preferCanvas for historic tracks, which
              puts every historic polyline on a single canvas bound to
              overlayPane (z 400). A high-z Pane alone is not enough — the
              children would still render into that canvas. We force an SVG
              renderer bound to the custom pane so live trails paint above
              the dense historical canvas instead of getting buried. */}
          <Pane name="live-trails" style={{ zIndex: 550 }}>
            {liveSegments.map((s, i) => (
              <Polyline
                key={`lseg-${i}`}
                positions={s.curve}
                pathOptions={{
                  color: s.color,
                  weight: s.isViolation ? 5 : 4,
                  opacity: s.opacity,
                  renderer: liveRenderer,
                }}
                interactive={false}
              />
            ))}
          </Pane>

          {/* Live aircraft icons at the latest position — always rendered for
              every aircraft, even when isolation is active so the user still
              sees surrounding traffic as context. */}
          {liveMarkers.map((m) => {
            const info = livePerAircraft.get(m.icao)
            const color = info ? info.color : LIVE_TRANSIENT_COLOR
            const stroke = '#111827'
            const stale = lastLiveAt && m.lastTs < lastLiveAt - 6000
            // Isolation: when something is selected, dim non-selected icons
            // (but keep them visible); stale always wins with 10%.
            const isolating = selectedTails.length > 0
            const selected = selectedTails.includes(m.tail)
            let opacity = 1
            if (stale) opacity = 0.1
            else if (isolating && !selected) opacity = 0.4
            return (
            <Marker
              key={`lmk-${m.tail}`}
              position={m.pos}
              icon={makeLiveIcon(m.heading, color, stroke)}
              opacity={opacity}
              eventHandlers={{ click: (e) => selectTail(m.tail, e.originalEvent) }}
            >
              <Tooltip direction="top" offset={[0, -10]}>
                <div className="text-xs">
                  <div className="font-semibold">{m.tail}</div>
                  <div>{m.type || '—'}</div>
                  {schoolsByTail.get(m.tail) && (
                    <div className="text-amber-300/90 italic">
                      {schoolsByTail.get(m.tail).school} @ {schoolsByTail.get(m.tail).airport}
                    </div>
                  )}
                  <div>{m.alt} ft · {m.gs ? `${Math.round(m.gs)} kt` : '—'} · {Math.round(m.heading)}°</div>
                </div>
              </Tooltip>
            </Marker>
            )
          })}
        </MapContainer>
      </div>
    </div>
  )
}
