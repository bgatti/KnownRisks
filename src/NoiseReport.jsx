import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconMicrophone,
  IconVideo,
  IconCheck,
  IconArrowRight,
  IconArrowLeft,
  IconX,
  IconPlayerStopFilled,
  IconMapPin,
  IconAlertTriangle,
  IconUser,
  IconUserPlus,
  IconHistory,
  IconMail,
  IconClock,
  IconBuildingBank,
  IconSend,
  IconExternalLink,
} from '@tabler/icons-react'
import {
  fetchActiveExcursions,
  fetchBoot,
  fetchMyComplaints,
  fetchMyReports,
  postComplaint,
  postFullReport,
  KLASS_COLORS,
} from './noiseApi'
import { repsForAirports, TIER_LABELS, buildMailtoForReport, airportsForLocality, formatLocality } from './noiseReps'

const IDENTITY_KEY = 'noise-studio-identity'
function loadIdentity() {
  try { return JSON.parse(localStorage.getItem(IDENTITY_KEY) || 'null') } catch { return null }
}
function saveIdentity(id) {
  try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(id)) } catch {}
}
function clearIdentity() {
  try { localStorage.removeItem(IDENTITY_KEY) } catch {}
}
/** reporter string used for both POSTs and the /api/complaints filter */
function reporterOf(id) {
  if (!id) return null
  if (id.kind === 'email') return id.email || null
  if (id.kind === 'anonymous') return `anon:${id.handle}`
  return null
}

/* ─── Constants ───────────────────────────────────────────────────────────── */
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png'
const LABEL_URL = 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png'

/* ─── DFAID member airports — coordinates + area-of-impact defaults ─── */
const DFAID_AIRPORTS = {
  KLMO: { icao: 'KLMO', name: 'Vance Brand',                city: 'Longmont, CO',           lat: 40.1638, lng: -105.1633, zoom: 12 },
  KEIK: { icao: 'KEIK', name: 'Erie Municipal',             city: 'Erie, CO',               lat: 40.0103, lng: -105.0492, zoom: 12 },
  KBDU: { icao: 'KBDU', name: 'Boulder Municipal',          city: 'Boulder, CO',            lat: 40.0392, lng: -105.2258, zoom: 12 },
  KBJC: { icao: 'KBJC', name: 'Rocky Mountain Metro',       city: 'Broomfield, CO',         lat: 39.9086, lng: -105.1172, zoom: 12 },
  KFNL: { icao: 'KFNL', name: 'Northern Colorado Regional', city: 'Fort Collins / Loveland, CO', lat: 40.4519, lng: -105.0114, zoom: 12 },
  KAPA: { icao: 'KAPA', name: 'Centennial',                 city: 'Englewood, CO',          lat: 39.5700, lng: -104.8497, zoom: 12 },
}
const DEFAULT_AIRPORT = 'KBJC'

/* Parse ?airport=KBDU from the current URL, falling back to KBJC. */
function readAirportFromUrl() {
  if (typeof window === 'undefined') return DFAID_AIRPORTS[DEFAULT_AIRPORT]
  const params = new URLSearchParams(window.location.search)
  const icao = (params.get('airport') || '').toUpperCase()
  return DFAID_AIRPORTS[icao] || DFAID_AIRPORTS[DEFAULT_AIRPORT]
}

const FALLBACK = (() => {
  const a = readAirportFromUrl()
  return { lat: a.lat, lng: a.lng, label: `${a.icao} · ${a.name}`, airport: a }
})()

const PRECISION_OPTIONS = [
  { key: 'city',    label: 'Area',         hint: '±1 km',      pts: 1, snap: 100, radius: 1000 },
  { key: 'cross',   label: 'Cross street', hint: 'Intersection', pts: 3, snap: 1000, radius: 300 },
  { key: 'precise', label: 'Precise',      hint: '±metres',    pts: 5, snap: null, radius: 50  },
]

const OVERPASS_MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

/* ─── Helpers ─────────────────────────────────────────────────────────────── */
/* Wikipedia thumbnail lookup. Uses the MediaWiki API with origin=* for CORS. */
const AIRCRAFT_TYPE_HINTS = {
  PA44: 'Piper PA-44 Seminole',
  PA28: 'Piper PA-28 Cherokee',
  PA32: 'Piper PA-32',
  PA46: 'Piper PA-46',
  C172: 'Cessna 172',
  C152: 'Cessna 152',
  C182: 'Cessna 182',
  C206: 'Cessna 206',
  C210: 'Cessna 210',
  SR20: 'Cirrus SR20',
  SR22: 'Cirrus SR22',
  DA40: 'Diamond DA40',
  DA42: 'Diamond DA42',
  BE33: 'Beechcraft Bonanza',
  BE35: 'Beechcraft Bonanza',
  BE36: 'Beechcraft Bonanza',
  BE58: 'Beechcraft Baron',
  BE76: 'Beechcraft Duchess',
  M20P: 'Mooney M20',
  M20J: 'Mooney M20',
  RV7:  'Van\'s Aircraft RV-7',
  RV8:  'Van\'s Aircraft RV-8',
}

async function fetchAircraftPhoto(type, { signal } = {}) {
  if (!type || type === 'Unknown') return null
  const query = AIRCRAFT_TYPE_HINTS[type] || `${type} aircraft`
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*' +
    '&prop=pageimages&pithumbsize=320&generator=search&gsrlimit=1' +
    '&gsrsearch=' + encodeURIComponent(query)
  try {
    const res = await fetch(url, { signal })
    if (!res.ok) return null
    const data = await res.json()
    const pages = data?.query?.pages
    if (!pages) return null
    const first = Object.values(pages)[0]
    return first?.thumbnail?.source || null
  } catch {
    return null
  }
}

/** Round to nearest Fibonacci tenth of a mile (0.1, 0.2, 0.3, 0.5, 0.8, 1.3, 2.1, 3.4, 5.5, 8.9). */
const FIB_TENTHS = [0.1, 0.2, 0.3, 0.5, 0.8, 1.3, 2.1, 3.4, 5.5, 8.9]
function fibMiles(meters) {
  const mi = meters / 1609.344
  let best = FIB_TENTHS[0]
  for (const f of FIB_TENTHS) {
    if (Math.abs(f - mi) < Math.abs(best - mi)) best = f
  }
  return best
}

/**
 * Clip a points array to the single contiguous run around `center` within
 * `radiusM`. If a flight passes through the area twice, only the segment
 * containing the nearest point is returned — never disjoint pieces.
 */
function clipSegmentNearPoint(points, center, radiusM) {
  if (!points || !center || !points.length) return points || []
  // Find the index of the nearest point to center
  let nearIdx = 0
  let bestD = Infinity
  for (let i = 0; i < points.length; i++) {
    const d = haversine(center[0], center[1], points[i][0], points[i][1])
    if (d < bestD) { bestD = d; nearIdx = i }
  }
  // Expand outward from nearIdx while points are within radius
  let lo = nearIdx
  let hi = nearIdx
  while (lo > 0 && haversine(center[0], center[1], points[lo - 1][0], points[lo - 1][1]) <= radiusM) lo--
  while (hi < points.length - 1 && haversine(center[0], center[1], points[hi + 1][0], points[hi + 1][1]) <= radiusM) hi++
  return points.slice(lo, hi + 1)
}

function formatMiles(meters) {
  if (meters == null || !Number.isFinite(meters)) return ''
  const mi = meters / 1609.344
  if (mi < 10) return `${mi.toFixed(1)} mi`
  return `${Math.round(mi)} mi`
}

function formatAgo(ms) {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 0) return 'just now'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min${m === 1 ? '' : 's'} ago`
  const h = Math.floor(m / 60)
  const rm = m % 60
  if (h < 24) return rm ? `${h}:${String(rm).padStart(2, '0')} hours ago` : `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180
  const R = 6371000
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/**
 * Reverse-geocode via Nominatim to get locality (city/town/village/hamlet,
 * county, state, country). CORS-enabled; respect the 1-req-per-second limit.
 */
async function fetchLocality(lat, lng, { signal } = {}) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=12&addressdetails=1`
  const res = await fetch(url, { signal, headers: { 'Accept-Language': 'en' } })
  if (!res.ok) return null
  const data = await res.json()
  const a = data?.address || {}
  return {
    city: a.city,
    town: a.town,
    village: a.village,
    hamlet: a.hamlet,
    suburb: a.suburb || a.neighbourhood,
    county: a.county,
    state: a.state,
    country: a.country,
    country_code: a.country_code,
    display_name: data.display_name,
  }
}

async function fetchNearestCrossStreet(lat, lng, { signal } = {}) {
  const q =
    `[out:json][timeout:10];` +
    `way(around:400,${lat},${lng})[highway][name];` +
    `out tags geom;`
  for (const url of OVERPASS_MIRRORS) {
    const ctrl = new AbortController()
    const onAbort = () => ctrl.abort()
    signal?.addEventListener('abort', onAbort)
    const timer = setTimeout(() => ctrl.abort(), 8000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(q),
        signal: ctrl.signal,
      })
      if (!res.ok) continue
      const data = await res.json()
      const buckets = new Map()
      for (const w of data.elements || []) {
        const name = w.tags?.name
        if (!name || !w.geometry) continue
        for (const p of w.geometry) {
          const key = `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`
          let b = buckets.get(key)
          if (!b) { b = { lat: p.lat, lng: p.lon, names: new Set() }; buckets.set(key, b) }
          b.names.add(name)
        }
      }
      let best = null
      let bestDist = Infinity
      for (const b of buckets.values()) {
        if (b.names.size < 2) continue
        const d = haversine(lat, lng, b.lat, b.lng)
        if (d < bestDist) { bestDist = d; best = b }
      }
      if (best) return { names: [...best.names].slice(0, 2), distanceMeters: bestDist }
      return null
    } catch (err) {
      if (signal?.aborted) throw err
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  throw new Error('overpass unavailable')
}

function loadLeaflet() {
  return new Promise((resolve, reject) => {
    if (window.L) return resolve(window.L)
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = LEAFLET_CSS
      document.head.appendChild(link)
    }
    const existing = document.querySelector(`script[src="${LEAFLET_JS}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve(window.L))
      existing.addEventListener('error', reject)
      return
    }
    const script = document.createElement('script')
    script.src = LEAFLET_JS
    script.async = true
    script.onload = () => resolve(window.L)
    script.onerror = reject
    document.head.appendChild(script)
  })
}

/* ─── Main page ───────────────────────────────────────────────────────────── */
export function NoiseStudio() {
  // Map refs
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const areaRef = useRef(null)
  const tracesRef = useRef([])
  const nearbyTracesRef = useRef([])

  // Location
  const [rawCoords, setRawCoords] = useState(null)
  const [precision, setPrecision] = useState('precise')
  const [crossStreet, setCrossStreet] = useState(null)
  const [crossLoading, setCrossLoading] = useState(false)
  const [locating, setLocating] = useState(false)
  const [locationError, setLocationError] = useState(null)

  // Excursions
  const [activeList, setActiveList] = useState([])
  const [activeStatus, setActiveStatus] = useState('idle')
  const [typePhotos, setTypePhotos] = useState({}) // { [type]: url | null }
  const [selectedTail, setSelectedTail] = useState(null)
  const [segmentsByTail, setSegmentsByTail] = useState({}) // { [tail]: segmentsResponse }

  // Trace hover → floating "Report this excursion" pill
  const [hoverCard, setHoverCard] = useState(null) // { tail, x, y, lastSeenMs }
  const hoverHideRef = useRef(null)

  // Nearby tracks (all overflights, not just excursions)
  const [nearbyTracks, setNearbyTracks] = useState([])

  // Segments the user selected for the report (multiple allowed).
  // Each stored segment is clipped to ~1 mile around the tapped point.
  const [reportSegments, setReportSegments] = useState([])
  const selectedOverlaysRef = useRef([]) // orange polylines on main map

  const addReportSegment = (seg) => {
    // Clip segment points to ~1 mile (1609m) around nearestPt
    const clipped = clipSegmentNearPoint(seg.points, seg.nearestPt, 1609)
    const entry = { ...seg, points: clipped }
    setReportSegments((prev) => {
      const key = `${entry.tail}:${entry.nearestPt?.[0]},${entry.nearestPt?.[1]}`
      if (prev.some((s) => `${s.tail}:${s.nearestPt?.[0]},${s.nearestPt?.[1]}` === key)) return prev
      return [...prev, entry]
    })
  }
  const removeReportSegment = (idx) => {
    setReportSegments((prev) => prev.filter((_, i) => i !== idx))
  }

  // Wizard
  const [reportOpen, setReportOpen] = useState(false)
  const [step, setStep] = useState(1)
  const [reportMode, setReportMode] = useState('general') // 'general' | 'excursion'
  const [selectedExcursion, setSelectedExcursion] = useState(null)

  // Media
  const [audioBlob, setAudioBlob] = useState(null)
  const [audioUrl, setAudioUrl] = useState(null)
  const [recordingAudio, setRecordingAudio] = useState(false)
  const [audioProgress, setAudioProgress] = useState(0)
  const [audioLevel, setAudioLevel] = useState(0)
  const [audioError, setAudioError] = useState(null)

  const [videoBlob, setVideoBlob] = useState(null)
  const [videoUrl, setVideoUrl] = useState(null)
  const [recordingVideo, setRecordingVideo] = useState(false)
  const [videoSeconds, setVideoSeconds] = useState(0)
  const [videoError, setVideoError] = useState(null)

  const [submitted, setSubmitted] = useState(false)

  // Identity / reporter
  const [identity, setIdentity] = useState(() => loadIdentity())
  const [identityModalOpen, setIdentityModalOpen] = useState(false)

  // Reverse-geocoded locality for escalation when no airport is known
  const [locality, setLocality] = useState(null)

  // My complaints panel (complaints + full reports merged)
  const [myComplaints, setMyComplaints] = useState([])
  const [myReports, setMyReports] = useState([])     // full reports with tracks
  const [sessionReports, setSessionReports] = useState([]) // local-only for anonymous users
  const [myComplaintsStatus, setMyComplaintsStatus] = useState('idle')
  const [complaintsPanelOpen, setComplaintsPanelOpen] = useState(false)

  // View a saved report's track on the map
  const [viewingReport, setViewingReport] = useState(null) // report object with .tracks
  const reportTracesRef = useRef([])
  // Two independent post targets: our own full-fidelity backend, and the
  // noise/web complaints endpoint (tail-centric subset).
  const [fullStatus, setFullStatus] = useState('idle')   // idle|posting|ok|error
  const [fullError,  setFullError]  = useState(null)
  const [fullId,     setFullId]     = useState(null)
  const [complaintStatus, setComplaintStatus] = useState('idle')
  const [complaintError,  setComplaintError]  = useState(null)
  const [complaintId,     setComplaintId]     = useState(null)

  const audioRecRef = useRef(null)
  const audioStreamRef = useRef(null)
  const audioCtxRef = useRef(null)
  const audioAnalyserRef = useRef(null)
  const audioRafRef = useRef(null)
  const audioStartRef = useRef(0)
  const videoRecRef = useRef(null)
  const videoStreamRef = useRef(null)
  const videoPreviewRef = useRef(null)
  const videoTimerRef = useRef(null)

  /* ── Init map ─────────────────────────────────────────────────────── */
  useEffect(() => {
    let cancelled = false
    loadLeaflet().then((L) => {
      if (cancelled || !containerRef.current || mapRef.current) return
      const map = L.map(containerRef.current, {
        center: [FALLBACK.lat, FALLBACK.lng],
        zoom: FALLBACK.airport?.zoom || 11,
        zoomControl: false,
        attributionControl: false,
      })
      L.tileLayer(TILE_URL, { maxZoom: 19 }).addTo(map)
      L.tileLayer(LABEL_URL, { maxZoom: 19 }).addTo(map)
      L.control.zoom({ position: 'bottomright' }).addTo(map)
      mapRef.current = map
    })
    return () => {
      cancelled = true
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null }
    }
  }, [])

  /* ── Silent IP lookup → seed rawCoords so the big breathing ring
         appears immediately, before the user shares precise location. ── */
  useEffect(() => {
    if (rawCoords) return
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const res = await fetch('https://get.geojs.io/v1/ip/geo.json', { signal: ctrl.signal })
        if (!res.ok) return
        const data = await res.json()
        if (ctrl.signal.aborted) return
        const lat = parseFloat(data.latitude)
        const lng = parseFloat(data.longitude)
        if (Number.isNaN(lat) || Number.isNaN(lng)) return
        setRawCoords({
          lat: Math.round(lat * 10) / 10,
          lng: Math.round(lng * 10) / 10,
          accuracy: 10000,
          source: 'ip',
          cityLabel: [data.city, data.region, data.country_code].filter(Boolean).join(', '),
        })
      } catch {}
    })()
    return () => ctrl.abort()
  }, [rawCoords])

  /* ── Single boot call: active excursions + tracks in one request ── */
  const loadBoot = async (signal) => {
    console.log('[noise-report] booting…')
    setActiveStatus((prev) => prev === 'ok' ? 'ok' : 'loading')
    try {
      const data = await fetchBoot({
        hours: 1,
        limit: 100,
        include: 'reports,notifications',
        signal,
      })
      if (signal?.aborted) return

      // Single window constant — nothing older than this appears anywhere
      const MAX_AGE_MS = 30 * 60 * 1000 // 30 minutes
      const now = Date.now()
      const cutoff = now - MAX_AGE_MS

      // Active excursions — filter to 30 min by lastSeenMs
      const active = (data.active || [])
        .filter((a) => a.lastSeenMs && a.lastSeenMs >= cutoff)
        .sort((a, b) => (b.lastSeenMs || 0) - (a.lastSeenMs || 0))
      setActiveList(active)
      setActiveStatus('ok')

      // Tracks: trim points to 30 min, thin
      const MAX_PTS = 500
      const tracks = (data.tracks || [])
        .map((t) => ({
          ...t,
          // Trim every segment's points to only those within the 30-min window
          segments: (t.segments || []).map((s) => {
            if (!s.points) return s
            const trimmed = s.points.filter((p) =>
              typeof p[3] !== 'number' || p[3] >= cutoff
            )
            // Thin if still too many points
            if (trimmed.length > MAX_PTS) {
              const step = Math.ceil(trimmed.length / MAX_PTS)
              return { ...s, points: trimmed.filter((_, i) => i % step === 0 || i === trimmed.length - 1) }
            }
            return { ...s, points: trimmed }
          }).filter((s) => s.points.length >= 2), // drop empty segments
        }))
        .filter((t) => t.segments.length > 0) // drop tracks with no remaining segments
      console.log('[noise-report] boot complete: active:', active.length, 'tracks:', tracks.length, '(from', data.tracks?.length, ')')
      setNearbyTracks(tracks)
    } catch (err) {
      if (err.name === 'AbortError') return
      console.error('[noise-report] boot failed:', err.message)
      setActiveStatus('error')
    }
  }
  useEffect(() => {
    const ctrl = new AbortController()
    loadBoot(ctrl.signal)
    return () => { ctrl.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── Load my complaints when identity is known ──────────────────── */
  const loadMyComplaints = async () => {
    const rep = reporterOf(identity)
    if (!rep) { setMyComplaints([]); setMyReports([]); setMyComplaintsStatus('idle'); return }
    setMyComplaintsStatus('loading')
    try {
      const [complaints, reports] = await Promise.all([
        fetchMyComplaints({ reporter: rep }),
        fetchMyReports({ reporter: rep }),
      ])
      setMyComplaints(complaints)
      setMyReports(reports)
      setMyComplaintsStatus('ok')
    } catch {
      setMyComplaintsStatus('error')
    }
  }
  useEffect(() => {
    loadMyComplaints()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.kind, identity?.handle, identity?.email])

  /* ── Fetch Wikipedia thumbnails sequentially (not parallel, to save memory) ── */
  useEffect(() => {
    if (!activeList.length) return
    const ctrl = new AbortController()
    const types = Array.from(new Set(activeList.map((a) => a.type || 'Unknown')))
      .filter((t) => t !== 'Unknown' && !(t in typePhotos))
    if (!types.length) return
    ;(async () => {
      for (const t of types) {
        if (ctrl.signal.aborted) return
        const url = await fetchAircraftPhoto(t, { signal: ctrl.signal })
        if (ctrl.signal.aborted) return
        setTypePhotos((prev) => ({ ...prev, [t]: url }))
      }
    })()
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeList])

  /* ── segmentsByTail: derived from nearbyTracks (no extra fetches) ─ */
  useEffect(() => {
    // Build segmentsByTail from nearbyTracks so the excursion list
    // can highlight tails that are in the active list. No per-tail API
    // calls — the nearby endpoint already returns everything we need.
    const map = {}
    for (const track of nearbyTracks) {
      const inActive = activeList.some((a) => a.tail === track.tail)
      if (inActive) map[track.tail] = track
    }
    setSegmentsByTail(map)
  }, [nearbyTracks, activeList])

  /* ── Shared hover handler factory ──────────────────────────────── */
  const crosshairRef = useRef(null)
  const makeHoverHandlers = (tail, lastSeenMs, segInfo) => {
    // segInfo: { klass, zone, points, type }
    const showHover = (e) => {
      if (hoverHideRef.current) { clearTimeout(hoverHideRef.current); hoverHideRef.current = null }
      const oe = e.originalEvent || e
      // Find the nearest point in the segment to the clicked map location
      let nearestPt = segInfo?.points?.[0] || null
      if (segInfo?.points && e.latlng) {
        let bestD = Infinity
        for (const p of segInfo.points) {
          const d = Math.abs(p[0] - e.latlng.lat) + Math.abs(p[1] - e.latlng.lng)
          if (d < bestD) { bestD = d; nearestPt = p }
        }
      }
      setHoverCard({ tail, x: oe.clientX, y: oe.clientY, lastSeenMs, ...segInfo, nearestPt })
      // Draw crosshair at nearest point
      if (crosshairRef.current) { crosshairRef.current.remove(); crosshairRef.current = null }
      if (nearestPt && window.L && mapRef.current) {
        crosshairRef.current = window.L.circleMarker([nearestPt[0], nearestPt[1]], {
          radius: 8,
          color: segInfo?.klass ? (KLASS_COLORS[segInfo.klass] || '#fb923c') : '#fb923c',
          weight: 3,
          fillColor: '#000',
          fillOpacity: 0.5,
          interactive: false,
          className: 'crosshair-marker',
        }).addTo(mapRef.current)
      }
    }
    const hideHover = () => {
      if (hoverHideRef.current) clearTimeout(hoverHideRef.current)
      hoverHideRef.current = setTimeout(() => {
        setHoverCard(null)
        if (crosshairRef.current) { crosshairRef.current.remove(); crosshairRef.current = null }
      }, 220)
    }
    const clickSelect = (e) => {
      // Find nearest point to the click location
      let nearestPt = segInfo?.points?.[0] || null
      if (segInfo?.points && e.latlng) {
        let bestD = Infinity
        for (const p of segInfo.points) {
          const d = Math.abs(p[0] - e.latlng.lat) + Math.abs(p[1] - e.latlng.lng)
          if (d < bestD) { bestD = d; nearestPt = p }
        }
      }
      const match = activeList.find((a) => a.tail === tail)
      if (match) setSelectedExcursion(match)
      addReportSegment({ tail, lastSeenMs, ...segInfo, nearestPt })
      setHoverCard(null)
      if (crosshairRef.current) { crosshairRef.current.remove(); crosshairRef.current = null }
    }
    return { showHover, hideHover, clickSelect }
  }

  /**
   * Snake-draw animation: reveal a Leaflet polyline progressively from
   * start to end using SVG stroke-dashoffset. `durationMs` is the total
   * draw time; `delayMs` is the staggered start.
   */
  const snakeDraw = (line, durationMs, delayMs) => {
    const el = line._path || line.getElement?.()
    if (!el) return
    // Need the path to be in the DOM so getTotalLength works.
    requestAnimationFrame(() => {
      const len = el.getTotalLength()
      if (!len) return
      el.style.strokeDasharray = `${len}`
      el.style.strokeDashoffset = `${len}`
      el.style.transition = 'none'
      // Force reflow then start animation
      // eslint-disable-next-line no-unused-expressions
      el.getBoundingClientRect()
      el.style.transition = `stroke-dashoffset ${durationMs}ms ease-out ${delayMs}ms`
      el.style.strokeDashoffset = '0'
    })
  }

  /* ── (single draw effect handles all tracks) ─────────────────────── */

  /* ── Auto-request location after a delay so the map renders first ── */
  useEffect(() => {
    const timer = setTimeout(async () => {
      let state = 'prompt'
      try {
        if (navigator.permissions?.query) {
          const r = await navigator.permissions.query({ name: 'geolocation' })
          state = r.state
        }
      } catch {}
      if (state !== 'denied') requestLocation()
    }, 2000) // 2s delay — let map + active list settle first
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── Location request ────────────────────────────────────────────── */
  function requestLocation() {
    setLocating(true)
    setLocationError(null)
    if (!navigator.geolocation) {
      setLocationError('Geolocation not available')
      setLocating(false)
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setRawCoords({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy || 0,
          source: 'browser',
        })
        setCrossStreet(null) // invalidate any IP-era lookup
        setLocating(false)
      },
      (err) => {
        setLocationError(err.code === 1 ? 'Permission denied' : 'Location unavailable')
        setLocating(false)
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    )
  }

  /* ── Draw selected segments as bright orange on top of everything ── */
  useEffect(() => {
    const L = window.L
    const map = mapRef.current
    for (const p of selectedOverlaysRef.current) p.remove()
    selectedOverlaysRef.current = []
    if (!L || !map || !reportSegments.length) return
    // Create a pane above the default overlay (z-index 450) so selections
    // always render over flight traces + the audibility circle.
    if (!map.getPane('selectedSegments')) {
      map.createPane('selectedSegments')
      map.getPane('selectedSegments').style.zIndex = 650
    }
    for (const seg of reportSegments) {
      if (!seg.points || seg.points.length < 2) continue
      const latlngs = seg.points.map((p) => [p[0], p[1]])
      // Glow under-stroke
      const glow = L.polyline(latlngs, {
        color: '#ff8c00',
        weight: 14,
        opacity: 0.25,
        lineCap: 'round',
        lineJoin: 'round',
        pane: 'selectedSegments',
        interactive: false,
      }).addTo(map)
      const line = L.polyline(latlngs, {
        color: '#ff8c00',
        weight: 7,
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round',
        pane: 'selectedSegments',
        interactive: false,
      }).addTo(map)
      selectedOverlaysRef.current.push(glow, line)
    }
  }, [reportSegments])

  /* ── View a saved report: show only the reported segments ────────── */
  useEffect(() => {
    const L = window.L
    const map = mapRef.current
    for (const p of reportTracesRef.current) p.remove()
    reportTracesRef.current = []
    if (!L || !map) return

    // When viewing a report: dim all existing traces to 25%, draw
    // the reported segments at full orange, click map to clear.
    const segs = viewingReport?.reportedSegments || viewingReport?.reportedSegment
      ? [].concat(viewingReport.reportedSegments || viewingReport.reportedSegment || [])
      : null
    if (!segs?.length) {
      // Restore opacity on all existing traces
      for (const p of [...tracesRef.current, ...nearbyTracesRef.current]) {
        if (p._path) p._path.style.opacity = ''
      }
      return
    }

    // Dim everything
    for (const p of [...tracesRef.current, ...nearbyTracesRef.current]) {
      if (p._path) p._path.style.opacity = '0.15'
    }

    // Draw reported segments in bright orange on the selected-segments pane
    if (!map.getPane('selectedSegments')) {
      map.createPane('selectedSegments')
      map.getPane('selectedSegments').style.zIndex = 650
    }
    const bounds = L.latLngBounds([])
    for (const seg of segs) {
      if (!seg.points?.length || seg.points.length < 2) continue
      const latlngs = seg.points.map((p) => [p[0], p[1]])
      const glow = L.polyline(latlngs, {
        color: '#ff8c00', weight: 14, opacity: 0.3,
        lineCap: 'round', lineJoin: 'round',
        pane: 'selectedSegments', interactive: false,
      }).addTo(map)
      const line = L.polyline(latlngs, {
        color: '#ff8c00', weight: 7, opacity: 1,
        lineCap: 'round', lineJoin: 'round',
        pane: 'selectedSegments', interactive: false,
      }).addTo(map)
      reportTracesRef.current.push(glow, line)
      latlngs.forEach((ll) => bounds.extend(ll))
    }
    if (bounds.isValid()) {
      map.flyToBounds(bounds.pad(0.25), { duration: 1, maxZoom: 14 })
    }

    // Click anywhere on the map to clear the viewed report
    const clearView = () => setViewingReport(null)
    map.once('click', clearView)
    reportTracesRef.current.push({ remove: () => map.off('click', clearView) })
  }, [viewingReport])

  /* ── Reverse-geocode to locality (any browser-precision coords) ── */
  useEffect(() => {
    if (!rawCoords || rawCoords.source === 'ip') { setLocality(null); return }
    const ctrl = new AbortController()
    fetchLocality(rawCoords.lat, rawCoords.lng, { signal: ctrl.signal })
      .then((loc) => { if (!ctrl.signal.aborted) setLocality(loc) })
      .catch(() => {})
    return () => ctrl.abort()
  }, [rawCoords?.lat, rawCoords?.lng, rawCoords?.source])

  /* ── Cross-street lookup removed — slow and unnecessary ────────── */

  // 4 NM audibility radius for GA aircraft at pattern altitude (~7408 meters)
  const AUDIBLE_RADIUS_M = 4 * 1852

  /* ── Draw audibility circle on map ──────────────────────────────── */
  useEffect(() => {
    const tryDraw = () => {
      if (!window.L || !mapRef.current) { requestAnimationFrame(tryDraw); return }
      if (areaRef.current) { areaRef.current.remove(); areaRef.current = null }
      if (!rawCoords) return
      areaRef.current = window.L.circle([rawCoords.lat, rawCoords.lng], {
        radius: AUDIBLE_RADIUS_M,
        color: '#fafafa',
        weight: 2,
        opacity: 0.75,
        fillColor: '#ffffff',
        fillOpacity: 0.08,
        className: 'area-ring',
        interactive: false,
      }).addTo(mapRef.current)
      areaRef.current.bringToFront()
      if (!reportOpen) {
        // Zoom to fit the audibility circle
        mapRef.current.flyToBounds(areaRef.current.getBounds().pad(0.05), { duration: 1 })
      }
    }
    tryDraw()
  }, [rawCoords, reportOpen])

  /* ── Tracks now loaded via boot call above ──────────────────────── */

  // Build a set of keys for segments already reported (from sessionReports).
  // Used to render those segments in blue + tooltip.
  const reportedSegKeys = useMemo(() => {
    const keys = new Set()
    for (const sr of sessionReports) {
      for (const seg of sr.reportedSegments || []) {
        if (seg.nearestPt) keys.add(`${seg.tail}:${seg.nearestPt[0]},${seg.nearestPt[1]}`)
      }
    }
    return keys
  }, [sessionReports])

  const isSegReported = (tail, nearestPt) => {
    if (!nearestPt) return false
    return reportedSegKeys.has(`${tail}:${nearestPt[0]},${nearestPt[1]}`)
  }

  /* ── Draw all tracks with time-based opacity ──────────────────────── */
  useEffect(() => {
    console.log('[noise-report] draw nearby effect, tracks:', nearbyTracks.length)
    try {
    const L = window.L
    const map = mapRef.current
    if (!L || !map) return
    for (const p of nearbyTracesRef.current) p.remove()
    nearbyTracesRef.current = []
    if (!nearbyTracks.length) return

    const now = Date.now()
    const WINDOW_MS = 30 * 60 * 1000 // 30 minutes

    for (const track of nearbyTracks) {
      const lastSeg = track.segments?.[track.segments.length - 1]
      const lastPt = lastSeg?.points?.[lastSeg.points.length - 1]
      for (const seg of track.segments || []) {
        if (!seg.points || seg.points.length < 2) continue
        // Ensure points are chronological (old → new = direction of travel)
        const pts = [...seg.points]
        const firstTs = pts[0]?.[3]
        const lastTs = pts[pts.length - 1]?.[3]
        if (typeof firstTs === 'number' && typeof lastTs === 'number' && firstTs > lastTs) {
          pts.reverse()
        }
        const latlngs = pts.map((p) => [p[0], p[1]])

        // Most recent timestamp in this segment → drives opacity
        let segLastMs = 0
        for (const p of pts) {
          if (typeof p[3] === 'number' && p[3] > segLastMs) segLastMs = p[3]
        }
        const age = segLastMs ? (now - segLastMs) / WINDOW_MS : 0.5
        const timeOpacity = Math.max(0.08, 1 - age)

        // Check if this segment was already reported → render blue
        const midPt = seg.points[Math.floor(seg.points.length / 2)]
        const reported = isSegReported(track.tail, midPt)

        const isExcursion = !!seg.klass
        const color = reported ? '#38bdf8' : isExcursion ? (KLASS_COLORS[seg.klass] || '#aaa') : 'rgba(200,200,200,0.8)'
        const weight = isExcursion ? 5 : 3.5
        const opacity = reported ? 0.9 : isExcursion ? Math.max(0.3, timeOpacity) : timeOpacity

        const line = L.polyline(latlngs, {
          color, weight, opacity,
          lineCap: 'round', lineJoin: 'round',
          className: 'flight-trace',
        }).addTo(map)
        if (reported) {
          const sr = sessionReports.find((r) =>
            r.reportedSegments?.some((s) => s.tail === track.tail)
          )
          if (sr) {
            line.bindTooltip(`Reported ${new Date(sr.createdAt).toLocaleDateString()}`, {
              direction: 'top', className: 'user-pin-tooltip',
            })
          }
        }

        const { showHover, hideHover, clickSelect } = makeHoverHandlers(track.tail, segLastMs || null, {
          klass: seg.klass, zone: seg.zone, points: pts, type: track.type || '',
        })
        const hit = L.polyline(latlngs, {
          color: '#ffffff',
          weight: weight + 20,
          opacity: 0,
          lineCap: 'round', lineJoin: 'round',
          interactive: true,
        }).addTo(map)
        hit.on('mouseover', showHover)
        hit.on('mouseout', hideHover)
        hit.on('click', clickSelect)

        // Tag with first + last timestamps for time-scheduled animation
        const segFirstMs = pts.find((p) => typeof p[3] === 'number')?.[3] || 0
        line._segFirstMs = segFirstMs
        line._segLastMs = segLastMs || 0
        nearbyTracesRef.current.push(line, hit)
      }

      // Aircraft icons now managed by the live-positions poll effect.
    }
    // Snake-draw animation: schedule each segment to appear based on its
    // actual start time, compressed into a ~5 second animation window.
    const nearbyQueue = nearbyTracesRef.current.filter((p) => p._segFirstMs != null)
    if (nearbyQueue.length) {
      const minTs = Math.min(...nearbyQueue.map((p) => p._segFirstMs))
      const maxTs = Math.max(...nearbyQueue.map((p) => p._segLastMs || p._segFirstMs))
      const span = maxTs - minTs || 1
      const ANIM_WINDOW = 5000 // compress the 30-min span into 5 seconds
      for (const line of nearbyQueue) {
        // Delay = where this segment starts relative to the oldest, scaled to 5s
        const delay = Math.round(((line._segFirstMs - minTs) / span) * ANIM_WINDOW)
        // Duration proportional to segment length in time (min 300ms, max 2s)
        const segSpan = (line._segLastMs || line._segFirstMs) - line._segFirstMs
        const duration = Math.max(300, Math.min(2000, (segSpan / span) * ANIM_WINDOW))
        snakeDraw(line, duration, delay)
      }
    }
    if (areaRef.current) areaRef.current.bringToFront()
    } catch (err) {
      console.error('[noise-report] draw crash:', err)
      try { localStorage.setItem('noise-report-crash', `${new Date().toISOString()} ${err.message}\n${err.stack}`) } catch {}
    }
  }, [nearbyTracks])

  /* ── Aircraft icons at the leading edge of each drawn live track ── */
  const liveMarkersRef = useRef(new Map()) // tail → L.Marker
  useEffect(() => {
    const L = window.L
    const map = mapRef.current
    if (!L || !map) return

    // Clear all existing icons
    for (const [, marker] of liveMarkersRef.current) marker.remove()
    liveMarkersRef.current.clear()

    const now = Date.now()
    for (const track of nearbyTracks) {
      if (!track.live || !track.segments?.length) continue
      // Get the very last point of the last segment — that's the leading edge
      const lastSeg = track.segments[track.segments.length - 1]
      const lastPt = lastSeg?.points?.[lastSeg.points.length - 1]
      if (!lastPt) continue
      // Only show if the last point is recent (< 5 minutes)
      if (typeof lastPt[3] === 'number' && now - lastPt[3] > 5 * 60 * 1000) continue

      // Compute heading from last two points
      let hdg = null
      if (lastSeg.points.length >= 2) {
        const prev = lastSeg.points[lastSeg.points.length - 2]
        const toRad = (d) => d * Math.PI / 180
        const toDeg = (r) => r * 180 / Math.PI
        const dLon = toRad(lastPt[1] - prev[1])
        const y = Math.sin(dLon) * Math.cos(toRad(lastPt[0]))
        const x = Math.cos(toRad(prev[0])) * Math.sin(toRad(lastPt[0])) -
                  Math.sin(toRad(prev[0])) * Math.cos(toRad(lastPt[0])) * Math.cos(dLon)
        hdg = Math.round((toDeg(Math.atan2(y, x)) + 360) % 360)
      }

      const photo = typePhotos?.[track.type]
      const iconHtml = photo
        ? `<img src="${photo}" alt="${track.type}" style="width:26px;height:26px;border-radius:50%;border:2px solid rgba(255,255,255,0.7);object-fit:cover;box-shadow:0 2px 8px rgba(0,0,0,0.7);${hdg != null ? `transform:rotate(${hdg}deg);` : ''}" />`
        : `<div style="width:22px;height:22px;border-radius:50%;background:#333;border:2px solid rgba(255,255,255,0.5);display:flex;align-items:center;justify-content:center;font-size:7px;color:#aaa;font-weight:bold">${(track.type || '?').slice(0, 3)}</div>`
      const icon = L.divIcon({
        className: 'live-aircraft-icon',
        html: iconHtml,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      })
      const marker = L.marker([lastPt[0], lastPt[1]], { icon, interactive: false, zIndexOffset: 1000 }).addTo(map)
      liveMarkersRef.current.set(track.tail, marker)
    }
  }, [nearbyTracks, typePhotos])

  /* ── Displayed location text ─────────────────────────────────────── */
  const displayedLocation = useMemo(() => {
    if (!rawCoords) return null
    if (rawCoords.source === 'ip') {
      return {
        text: rawCoords.cityLabel ? `~ ${rawCoords.cityLabel}` : `~${rawCoords.lat.toFixed(1)}, ${rawCoords.lng.toFixed(1)}`,
        detail: 'Approximate (IP-based)',
      }
    }
    if (precision === 'city') {
      return { text: `~${rawCoords.lat.toFixed(2)}, ${rawCoords.lng.toFixed(2)}`, detail: 'General area · ±1 km' }
    }
    if (precision === 'cross') {
      if (crossStreet) return {
        text: crossStreet.names.join(' & '),
        detail: `nearest intersection · ≈${Math.round(crossStreet.distanceMeters)} m`,
      }
      return { text: crossLoading ? 'Looking up intersection…' : 'No intersection found', detail: '' }
    }
    return {
      text: `${rawCoords.lat.toFixed(5)}, ${rawCoords.lng.toFixed(5)}`,
      detail: `Precise · ±${Math.round(rawCoords.accuracy)} m`,
    }
  }, [rawCoords, precision, crossStreet, crossLoading])

  /* ── Audio recording ─────────────────────────────────────────────── */
  async function startAudio() {
    setAudioError(null)
    if (audioUrl) { URL.revokeObjectURL(audioUrl); setAudioUrl(null); setAudioBlob(null) }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      audioStreamRef.current = stream
      const ACtx = window.AudioContext || window.webkitAudioContext
      const ctx = new ACtx()
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      src.connect(analyser)
      audioCtxRef.current = ctx
      audioAnalyserRef.current = analyser
      const rec = new MediaRecorder(stream)
      const chunks = []
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
        setAudioBlob(blob)
        setAudioUrl(URL.createObjectURL(blob))
        teardownAudio()
      }
      audioRecRef.current = rec
      audioStartRef.current = Date.now()
      rec.start()
      setRecordingAudio(true)
      tickAudio()
      setTimeout(() => { if (rec.state === 'recording') rec.stop() }, 5000)
    } catch (err) {
      setAudioError(err.message || 'Microphone denied')
      teardownAudio()
    }
  }
  function tickAudio() {
    const analyser = audioAnalyserRef.current
    if (!analyser) return
    const data = new Uint8Array(analyser.fftSize)
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v }
    setAudioLevel(Math.min(1, Math.sqrt(sum / data.length) * 3.5))
    setAudioProgress(Math.min(1, (Date.now() - audioStartRef.current) / 5000))
    audioRafRef.current = requestAnimationFrame(tickAudio)
  }
  function teardownAudio() {
    setRecordingAudio(false)
    setAudioLevel(0)
    if (audioRafRef.current) { cancelAnimationFrame(audioRafRef.current); audioRafRef.current = null }
    if (audioStreamRef.current) { audioStreamRef.current.getTracks().forEach((t) => t.stop()); audioStreamRef.current = null }
    if (audioCtxRef.current) { try { audioCtxRef.current.close() } catch {} audioCtxRef.current = null }
    audioAnalyserRef.current = null
  }

  /* ── Video recording ─────────────────────────────────────────────── */
  async function startVideo() {
    setVideoError(null)
    if (videoUrl) { URL.revokeObjectURL(videoUrl); setVideoUrl(null); setVideoBlob(null) }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: true,
      })
      videoStreamRef.current = stream
      if (videoPreviewRef.current) {
        videoPreviewRef.current.srcObject = stream
        videoPreviewRef.current.muted = true
        await videoPreviewRef.current.play().catch(() => {})
      }
      const mimes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
      const mimeType = mimes.find((m) => MediaRecorder.isTypeSupported(m)) || ''
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      const chunks = []
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: rec.mimeType || 'video/webm' })
        setVideoBlob(blob)
        setVideoUrl(URL.createObjectURL(blob))
        teardownVideo()
      }
      videoRecRef.current = rec
      rec.start()
      setRecordingVideo(true)
      setVideoSeconds(0)
      videoTimerRef.current = setInterval(() => {
        setVideoSeconds((s) => {
          const n = s + 1
          if (n >= 15 && rec.state === 'recording') rec.stop()
          return n
        })
      }, 1000)
    } catch (err) {
      setVideoError(err.message || 'Camera denied')
      teardownVideo()
    }
  }
  function stopVideo() { if (videoRecRef.current?.state === 'recording') videoRecRef.current.stop() }
  function teardownVideo() {
    setRecordingVideo(false)
    if (videoTimerRef.current) { clearInterval(videoTimerRef.current); videoTimerRef.current = null }
    if (videoStreamRef.current) { videoStreamRef.current.getTracks().forEach((t) => t.stop()); videoStreamRef.current = null }
    if (videoPreviewRef.current) videoPreviewRef.current.srcObject = null
  }

  useEffect(() => () => { teardownAudio(); teardownVideo() }, [])

  /* ── Scoring ─────────────────────────────────────────────────────── */
  const score = useMemo(() => {
    let total = 0
    const breakdown = []
    if (videoBlob) { total += 5; breakdown.push({ label: 'Video evidence', pts: 5 }) }
    else if (audioBlob) { total += 3; breakdown.push({ label: 'Audio recording', pts: 3 }) }
    if (rawCoords) {
      const p = PRECISION_OPTIONS.find((o) => o.key === precision)
      total += p.pts
      breakdown.push({ label: p.label, pts: p.pts })
    }
    return { total, max: 10, breakdown }
  }, [audioBlob, videoBlob, rawCoords, precision])
  const tier = score.total >= 9 ? 'Exceptional' : score.total >= 6 ? 'Strong' : score.total >= 3 ? 'Useful' : 'Minimal'
  const tierColor = score.total >= 9 ? 'text-emerald-300' : score.total >= 6 ? 'text-sky-300' : score.total >= 3 ? 'text-amber-300' : 'text-neutral-400'

  /* ── Wizard nav ──────────────────────────────────────────────────── */
  function openReport(mode = 'general') {
    setReportMode(mode)
    if (mode === 'general') setSelectedExcursion(null)
    setReportOpen(true)
    setStep(1)
    setSubmitted(false)
  }
  function closeReport() {
    setReportOpen(false)
    teardownAudio()
    teardownVideo()
  }
  async function submitReport() {
    teardownAudio()
    teardownVideo()
    setSubmitted(true)
    setFullStatus('posting'); setFullError(null); setFullId(null)
    setComplaintStatus('idle'); setComplaintError(null); setComplaintId(null)

    const reporter = reporterOf(identity)

    // ── Find the nearest segment point to the user's location.
    // This is more useful than the user's GPS for a noise report — it tells
    // the noise office exactly where the aircraft was when the noise occurred.
    let nearestSegPoint = null
    if (rawCoords && selectedExcursion) {
      const data = segmentsByTail[selectedExcursion.tail]
      let bestDist = Infinity
      if (data?.tracks) {
        for (const track of data.tracks) {
          for (const seg of track.segments || []) {
            for (const p of seg.points || []) {
              const d = haversine(rawCoords.lat, rawCoords.lng, p[0], p[1])
              if (d < bestDist) {
                bestDist = d
                nearestSegPoint = { lat: p[0], lng: p[1], alt: p[2], klass: seg.klass, zone: seg.zone, distMeters: d }
              }
            }
          }
        }
      }
    }

    // ── Full-fidelity report → noise/web archive (all data) ──
    const meta = {
      mode: reportMode,
      submittedAt: new Date().toISOString(),
      reporter,
      identity: identity ? { kind: identity.kind, label: identity.email || identity.handle } : null,
      // No reporter location stored — only the offending flight segment position.
      nearestFlightPoint: nearestSegPoint,
      reportedSegments: reportSegments.length ? reportSegments.map((s) => ({
        tail: s.tail,
        klass: s.klass,
        zone: s.zone,
        type: s.type,
        nearestPt: s.nearestPt,
        points: s.points,
      })) : null,
      score: { total: score.total, max: score.max, tier, breakdown: score.breakdown },
      media: {
        audio: audioBlob ? { bytes: audioBlob.size, type: audioBlob.type } : null,
        video: videoBlob ? { bytes: videoBlob.size, type: videoBlob.type } : null,
      },
      excursion: reportMode === 'excursion' && selectedExcursion
        ? {
            tail: selectedExcursion.tail,
            type: selectedExcursion.type,
            worst: selectedExcursion.worst,
            counts: selectedExcursion.counts,
            lastSeenMs: selectedExcursion.lastSeenMs,
            school: selectedExcursion.school,
            airport: selectedExcursion.airport,
          }
        : null,
      // Snapshot the flight track so the report is self-contained:
      // clicking a past report can replay the path without re-fetching.
      // Only store classified (non-clean) segments to keep payload modest.
      tracks: (() => {
        if (!selectedExcursion) return null
        const data = segmentsByTail[selectedExcursion.tail]
        if (!data?.tracks) return null
        return data.tracks.map((t) => ({
          src: t.src,
          date: t.date,
          live: t.live,
          segments: (t.segments || [])
            .filter((s) => s.klass)
            .map((s) => ({ klass: s.klass, zone: s.zone, points: s.points })),
        })).filter((t) => t.segments.length)
      })(),
    }

    const fullPromise = postFullReport({ meta })
      .then((result) => {
        setFullId(result?.id || null)
        setFullStatus('ok')
      })
      .catch((err) => {
        setFullError(err.message || String(err))
        setFullStatus('error')
      })

    // ── Complaints subset → noise/web (only what that endpoint accepts) ──
    // Tail-centric, so general-mode reports skip it entirely.
    let complaintPromise = Promise.resolve()
    if (reportMode === 'excursion' && selectedExcursion) {
      setComplaintStatus('posting')
      const endMs = selectedExcursion.lastSeenMs || Date.now()
      const startMs = endMs - 30 * 1000
      const notes = [
        `Score ${score.total}/${score.max} (${tier})`,
        audioBlob && 'audio captured',
        videoBlob && 'video captured',
        nearestSegPoint && `flight pos: ${nearestSegPoint.lat.toFixed(4)},${nearestSegPoint.lng.toFixed(4)}`,
      ].filter(Boolean).join(' · ')

      // Only the flight-track point — never the reporter's position.
      const reportLat = nearestSegPoint?.lat
      const reportLon = nearestSegPoint?.lng

      // Distance from reporter to nearest flight point, rounded to Fibonacci
      // tenths of a mile for anonymity. No exact distance or position stored.
      const distanceFibMi = (rawCoords && nearestSegPoint)
        ? fibMiles(haversine(rawCoords.lat, rawCoords.lng, nearestSegPoint.lat, nearestSegPoint.lng))
        : null

      complaintPromise = postComplaint({
        tail: selectedExcursion.tail,
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date(endMs).toISOString(),
        klass: nearestSegPoint?.klass || selectedExcursion.worst,
        zone: nearestSegPoint?.zone || selectedExcursion.zone || 'unknown',
        lat: reportLat,
        lon: reportLon,
        reporter: reporter || undefined,
        score: score.total,
        mediaKind: videoBlob ? 'video' : audioBlob ? 'audio' : null,
        precision,
        type: selectedExcursion.type || null,
        distanceMiles: distanceFibMi,
        notes,
      })
        .then((result) => {
          setComplaintId(result?.id || null)
          setComplaintStatus('ok')
        })
        .catch((err) => {
          setComplaintError(err.message || String(err))
          setComplaintStatus('error')
        })
    }

    await Promise.all([fullPromise, complaintPromise])
    // Clear selection after reporting
    setReportSegments([])
    for (const p of selectedOverlaysRef.current) p.remove()
    selectedOverlaysRef.current = []

    // Track locally so anonymous users see their count increase immediately.
    setSessionReports((prev) => [{
      id: fullId || `local-${Date.now()}`,
      createdAt: new Date().toISOString(),
      tail: selectedExcursion?.tail,
      type: selectedExcursion?.type,
      klass: selectedExcursion?.worst,
      reportedSegments: reportSegments.map((s) => ({
        tail: s.tail, klass: s.klass, zone: s.zone, type: s.type,
        nearestPt: s.nearestPt, points: s.points,
      })),
    }, ...prev])
    // Refresh server-side lists then transition to My Reports after a brief pause.
    loadMyComplaints()
    loadBoot()

    // After 1.5s, close the wizard and open the reports panel so the user
    // sees their saved reports with the new one at the top.
    setTimeout(() => {
      setReportOpen(false)
      setSubmitted(false)
      setComplaintsPanelOpen(true)
    }, 1500)
  }
  function resetReport() {
    setSubmitted(false)
    setFullStatus('idle'); setFullError(null); setFullId(null)
    setComplaintStatus('idle'); setComplaintError(null); setComplaintId(null)
    setAudioBlob(null); if (audioUrl) URL.revokeObjectURL(audioUrl); setAudioUrl(null)
    setVideoBlob(null); if (videoUrl) URL.revokeObjectURL(videoUrl); setVideoUrl(null)
    setSelectedExcursion(null)
    setReportSegments([])
    for (const p of selectedOverlaysRef.current) p.remove()
    selectedOverlaysRef.current = []
    setStep(1)
    setReportOpen(false)
    // Clear orange overlays from the main map
    if (crosshairRef.current) { crosshairRef.current.remove(); crosshairRef.current = null }
  }

  // Location is the only hard requirement. Audio/video capture and aircraft
  // identification are optional — they just raise the report's score.
  const submitBlockers = []
  if (!rawCoords) submitBlockers.push('Share your location')
  const canSubmit = submitBlockers.length === 0

  /* ── Distance from user to each tail's nearest offending point ─── */
  const distanceByTail = useMemo(() => {
    if (!rawCoords) return {}
    const out = {}
    for (const tail of Object.keys(segmentsByTail)) {
      const data = segmentsByTail[tail]
      if (!data?.tracks) continue
      let best = Infinity
      for (const track of data.tracks) {
        for (const seg of track.segments || []) {
          if (!seg.klass) continue // ignore "clean" segments
          for (const p of seg.points || []) {
            const d = haversine(rawCoords.lat, rawCoords.lng, p[0], p[1])
            if (d < best) best = d
          }
        }
      }
      if (Number.isFinite(best)) out[tail] = best
    }
    return out
  }, [segmentsByTail, rawCoords])
  const totalSteps = 3
  const isReviewStep = step === totalSteps
  const isIdentifyStep = step === 2

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black text-neutral-100">
      <style>{`
        .leaflet-container { background: #0a0a0a; outline: none; }
        .leaflet-control-zoom a {
          background: rgba(20,20,20,0.85) !important;
          color: #e5e5e5 !important;
          border: 1px solid rgba(255,255,255,0.08) !important;
          backdrop-filter: blur(8px);
        }
        .leaflet-overlay-pane svg path.flight-trace {
          filter: drop-shadow(0 2px 1.5px rgba(0,0,0,0.95))
                  drop-shadow(0 5px 9px rgba(0,0,0,0.65));
          cursor: pointer;
        }
        .live-aircraft-icon { transition: transform 4.5s linear; }
        .crosshair-marker {
          filter: drop-shadow(0 0 6px rgba(251,146,60,0.8));
        }
        .leaflet-overlay-pane svg path.area-ring { animation: areaRingBreathe 3.8s ease-in-out infinite; }
        @keyframes areaRingBreathe {
          0%,100% { stroke-opacity: 0.4; stroke-width: 1.25; }
          50%     { stroke-opacity: 1;   stroke-width: 2.75; }
        }
        @keyframes micPulse {
          0%   { transform: scale(0.95); opacity: 0.6; }
          70%  { transform: scale(1.25); opacity: 0; }
          100% { transform: scale(1.25); opacity: 0; }
        }
        .wizard-enter { animation: wizardIn 280ms ease-out; }
        @keyframes wizardIn {
          from { transform: translateY(24px); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        .panel-slide-in { animation: panelSlideIn 350ms ease-out; }
        .report-new { animation: reportNew 1.5s ease-out; }
        @keyframes reportNew {
          0%   { background: rgba(56,189,248,0.25); }
          100% { background: transparent; }
        }
        @keyframes panelSlideIn {
          from { transform: translateX(100%); }
          to   { transform: translateX(0); }
        }
      `}</style>

      <div ref={containerRef} className="absolute inset-0" />

      {/* Top-right: identity + my reports */}
      <div className="absolute top-2 right-2 md:top-4 md:right-4 z-[1040] flex items-center gap-1.5 pointer-events-auto">
        <IdentityChip identity={identity} onEdit={() => setIdentityModalOpen(true)} />
        <button
          onClick={() => setComplaintsPanelOpen(true)}
          className="relative flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-md hover:bg-white/10 border border-white/10 px-2 py-1 text-[10px] text-neutral-300"
          title="My reports"
        >
          <IconHistory size={12} />
          <span className="hidden md:inline">My reports</span>
          {(myComplaints.length + sessionReports.length) > 0 && (
            <span className="rounded-full bg-sky-400/80 text-[9px] text-white font-semibold px-1.5">
              {myComplaints.length + sessionReports.length}
            </span>
          )}
        </button>
      </div>

      {/* Hover pill over a flight track */}
      {hoverCard && (() => {
        const isExcursion = !!hoverCard.klass
        const ago = hoverCard.lastSeenMs ? formatAgo(hoverCard.lastSeenMs) : null
        const pillBg = isExcursion
          ? 'bg-gradient-to-r from-rose-500 to-amber-500 shadow-[0_8px_24px_rgba(244,63,94,0.55)]'
          : 'bg-gradient-to-r from-orange-400 to-amber-400 shadow-[0_8px_24px_rgba(251,146,60,0.55)]'
        const arrowColor = isExcursion ? 'rgb(251,146,60)' : 'rgb(251,191,36)'
        return (
          <div
            className="absolute z-[1050] pointer-events-auto"
            style={{
              left: hoverCard.x,
              top: hoverCard.y,
              transform: 'translate(-50%, calc(-100% - 14px))',
            }}
            onMouseEnter={() => {
              if (hoverHideRef.current) { clearTimeout(hoverHideRef.current); hoverHideRef.current = null }
            }}
            onMouseLeave={() => {
              hoverHideRef.current = setTimeout(() => {
                setHoverCard(null)
                if (crosshairRef.current) { crosshairRef.current.remove(); crosshairRef.current = null }
              }, 160)
            }}
          >
            <div
              className={`flex items-center gap-2 rounded-full text-white text-xs font-medium pl-3 pr-4 py-2 border border-white/15 whitespace-nowrap pointer-events-none ${pillBg}`}
            >
              Tap to select
              <span className="text-[10px] text-white/80">
                {hoverCard.type && `· ${hoverCard.type}`}
                {ago && ` · ${ago}`}
              </span>
            </div>
            <div
              className="absolute left-1/2 -translate-x-1/2 w-0 h-0"
              style={{
                top: '100%',
                borderLeft: '6px solid transparent',
                borderRight: '6px solid transparent',
                borderTop: `6px solid ${arrowColor}`,
              }}
            />
          </div>
        )
      })()}

      {/* Top header */}
      <header className="absolute top-0 left-0 right-0 z-[1000] p-2 md:p-4 pointer-events-none">
        <div className="max-w-5xl mx-auto flex items-start justify-between gap-2 md:gap-4">
          <div className="pointer-events-auto bg-black/60 backdrop-blur-md border border-white/10 rounded-lg px-2.5 py-1.5 md:px-4 md:py-2.5 shadow-2xl">
            <p className="text-[9px] md:text-[10px] uppercase tracking-[0.2em] text-neutral-500">Aircraft Noise</p>
            <h1 className="text-sm md:text-base font-semibold text-neutral-100">Noise Report</h1>
            {/* Identity + My reports moved to top-right */}
          </div>
          {/* LocationCard hidden — location auto-requests silently on load.
              Precision defaults to precise. No user interaction needed. */}
        </div>
      </header>

      {identityModalOpen && (
        <IdentityModal
          initial={identity}
          onClose={() => setIdentityModalOpen(false)}
          onSave={(id) => { saveIdentity(id); setIdentity(id); setIdentityModalOpen(false) }}
          onClear={() => { clearIdentity(); setIdentity(null); setIdentityModalOpen(false) }}
        />
      )}

      {complaintsPanelOpen && (
        <MyComplaintsPanel
          identity={identity}
          complaints={myComplaints}
          reports={myReports}
          sessionReports={sessionReports}
          status={myComplaintsStatus}
          activeList={activeList}
          locality={locality}
          viewingReport={viewingReport}
          onViewReport={setViewingReport}
          onRefresh={loadMyComplaints}
          onClose={() => { setComplaintsPanelOpen(false); setViewingReport(null) }}
          onSetIdentity={() => { setComplaintsPanelOpen(false); setIdentityModalOpen(true) }}
        />
      )}

      {/* Active excursions panel — floating tiles on mobile, sidebar on desktop */}
      <aside className="absolute z-[1000] pointer-events-auto
        bottom-14 left-2 md:bottom-auto md:top-24 md:left-4 md:right-auto md:w-72 md:max-h-[60vh]">
        <ExcursionList
          activeList={activeList}
          activeStatus={activeStatus}
          selectedTail={selectedTail}
          onSelectTail={setSelectedTail}
          distanceByTail={distanceByTail}
          typePhotos={typePhotos}
        />
      </aside>

      {/* Bottom Report button — sits above the mobile excursion strip */}
      {!reportOpen && (
        <div className="absolute bottom-[3.75rem] md:bottom-8 left-0 right-0 z-[1000] flex justify-center pointer-events-none pb-[env(safe-area-inset-bottom)]">
          <button
            onClick={() => openReport(activeList.length ? 'excursion' : 'general')}
            className="pointer-events-auto group relative flex items-center gap-1.5 md:gap-3 rounded-full bg-gradient-to-r from-rose-500 to-amber-500 px-3.5 md:px-7 py-2 md:py-4 text-[11px] md:text-base font-semibold text-white shadow-[0_10px_40px_rgba(244,63,94,0.45)] hover:shadow-[0_10px_50px_rgba(244,63,94,0.65)] transition-all hover:scale-[1.02]"
          >
            <IconAlertTriangle size={14} />
            {reportSegments.length > 0
              ? (() => {
                  const uniqueTails = new Set(reportSegments.map((s) => s.tail))
                  const n = reportSegments.length
                  const a = uniqueTails.size
                  return <>Report {n} Segment{n > 1 ? 's' : ''} · {a} Aircraft</>
                })()
              : 'Report Flight Noise'
            }
            <IconArrowRight size={14} />
          </button>
          {reportSegments.length > 0 && (
            <button
              onClick={() => {
                setReportSegments([])
                for (const p of selectedOverlaysRef.current) p.remove()
                selectedOverlaysRef.current = []
              }}
              className="pointer-events-auto rounded-full bg-black/70 backdrop-blur-md border border-white/15 text-neutral-300 hover:text-white text-[11px] px-3 py-2"
            >
              <IconX size={12} className="inline mr-1" />
              Clear
            </button>
          )}
        </div>
      )}

      {/* Wizard overlay */}
      {reportOpen && (
        <div className="absolute inset-0 z-[1100] flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="wizard-enter w-full max-w-lg bg-neutral-950/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
            <WizardHeader step={step} submitted={submitted} onClose={closeReport} />

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {submitted ? (
                <SubmittedView
                  score={score}
                  selectedExcursion={selectedExcursion}
                  onReset={resetReport}
                  fullStatus={fullStatus} fullError={fullError} fullId={fullId}
                  complaintStatus={complaintStatus} complaintError={complaintError} complaintId={complaintId}
                  identity={identity}
                  onSaveIdentity={(id) => { saveIdentity(id); setIdentity(id) }}
                />
              ) : (
                <>
                  {step === 1 && (
                    <CaptureStep
                      recordingAudio={recordingAudio}
                      audioProgress={audioProgress}
                      audioLevel={audioLevel}
                      audioBlob={audioBlob}
                      audioUrl={audioUrl}
                      audioError={audioError}
                      startAudio={startAudio}
                      recordingVideo={recordingVideo}
                      videoSeconds={videoSeconds}
                      videoBlob={videoBlob}
                      videoUrl={videoUrl}
                      videoError={videoError}
                      videoPreviewRef={videoPreviewRef}
                      startVideo={startVideo}
                      stopVideo={stopVideo}
                    />
                  )}
                  {isIdentifyStep && (
                    <IdentifyStep
                      activeList={activeList}
                      activeStatus={activeStatus}
                      typePhotos={typePhotos}
                      selected={selectedExcursion}
                      onSelect={setSelectedExcursion}
                      mapSelectedTail={selectedTail}
                    />
                  )}
                  {isReviewStep && (
                    <ReviewStep
                      score={score}
                      tier={tier}
                      tierColor={tierColor}
                      displayedLocation={displayedLocation}
                      audioUrl={audioUrl}
                      videoUrl={videoUrl}
                      selectedExcursion={selectedExcursion}
                      reportMode={reportMode}
                      reportSegments={reportSegments}
                      onRemoveSegment={removeReportSegment}
                    />
                  )}
                </>
              )}
            </div>

            {!submitted && (
              <footer className="border-t border-white/10 p-4 flex items-center gap-2">
                <button
                  onClick={() => (step > 1 ? setStep((s) => s - 1) : closeReport())}
                  className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.07] px-4 py-2 text-sm text-neutral-300"
                >
                  <IconArrowLeft size={14} /> {step > 1 ? 'Back' : 'Cancel'}
                </button>
                <div className="flex-1" />
                {!isReviewStep && (
                  <button
                    onClick={() => setStep((s) => s + 1)}
                    className="flex items-center gap-1 rounded-lg px-5 py-2 text-sm font-semibold bg-white text-black hover:bg-neutral-200"
                  >
                    Next <IconArrowRight size={14} />
                  </button>
                )}
                {isReviewStep && (
                  <div className="flex items-center gap-3">
                    {!canSubmit && (
                      <div className="text-[11px] text-amber-300/90 text-right leading-tight max-w-[180px]">
                        {submitBlockers[0]}
                        {submitBlockers.length > 1 && (
                          <div className="text-[10px] text-neutral-500">
                            +{submitBlockers.length - 1} more
                          </div>
                        )}
                      </div>
                    )}
                    <button
                      onClick={submitReport}
                      disabled={!canSubmit}
                      title={canSubmit ? '' : submitBlockers.join(' · ')}
                      className={[
                        'flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-semibold transition-colors',
                        canSubmit ? 'bg-emerald-400 text-black hover:bg-emerald-300' : 'bg-white/10 text-neutral-500 cursor-not-allowed',
                      ].join(' ')}
                    >
                      Submit <IconCheck size={14} stroke={3} />
                    </button>
                  </div>
                )}
              </footer>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Subcomponents ───────────────────────────────────────────────────── */

function LocationCard({ rawCoords, precision, setPrecision, displayedLocation, requestLocation, locating, locationError }) {
  const needsUpgrade = !rawCoords || rawCoords.source === 'ip'
  return (
    <div className="pointer-events-auto bg-black/60 backdrop-blur-md border border-white/10 rounded-lg p-3 shadow-2xl w-72">
      <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Your Location</p>
      {rawCoords && (
        <>
          <div className="text-sm text-neutral-100 font-medium mt-0.5 truncate">{displayedLocation?.text}</div>
          <div className="text-[10px] text-neutral-500 truncate">{displayedLocation?.detail}</div>
        </>
      )}
      {needsUpgrade && (
        <button
          onClick={requestLocation}
          disabled={locating}
          className="mt-2 w-full flex items-center justify-center gap-2 rounded-md bg-sky-500/90 hover:bg-sky-500 text-white text-xs font-medium py-2 disabled:opacity-50"
        >
          <IconMapPin size={14} />
          {locating ? 'Requesting location…' : 'Request Location'}
        </button>
      )}
      {locationError && <p className="text-[10px] text-rose-300 mt-1">{locationError}</p>}

      {/* Precision picker removed — defaulting to precise. Uncomment to restore.
      <div className="mt-2.5 grid grid-cols-3 gap-1 p-0.5 rounded border border-white/10 bg-white/5">
        {PRECISION_OPTIONS.map((opt) => {
          const active = precision === opt.key
          return (
            <button
              key={opt.key}
              onClick={() => setPrecision(opt.key)}
              className={[
                'text-[10px] py-1 rounded transition-colors',
                active ? 'bg-white/15 text-white' : 'text-neutral-400 hover:text-white',
              ].join(' ')}
              title={opt.hint}
            >
              <div className="font-medium">{opt.label}</div>
              <div className="text-[9px] opacity-70">{opt.hint}</div>
            </button>
          )
        })}
      </div> */}
    </div>
  )
}

function ExcursionList({ activeList, activeStatus, selectedTail, onSelectTail, distanceByTail, typePhotos }) {
  // "N mins ago" updates on data refresh, no interval needed.

  const groups = useMemo(() => {
    const m = new Map()
    for (const a of activeList) {
      const k = a.type || 'Unknown'
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(a)
    }
    const sev = { yellow: 1, orange: 2, red: 3 }
    const arr = Array.from(m.entries()).map(([type, tails]) => {
      const worst = tails.reduce((w, a) => (sev[a.worst] > sev[w.worst] ? a : w), tails[0])
      const mostRecent = tails.reduce((r, a) => ((a.lastSeenMs || 0) > (r.lastSeenMs || 0) ? a : r), tails[0])
      // Nearest distance across all tails of this type
      let nearest = Infinity
      for (const a of tails) {
        const d = distanceByTail?.[a.tail]
        if (d != null && d < nearest) nearest = d
      }
      // Aggregate status across tails (sum reports, most-advanced pilot action,
      // any operator/pilot notification across the group).
      const actionRank = { none: 0, acknowledged: 1, reviewed: 2, completed: 3 }
      let reportCount = 0
      let operatorNotified = null
      let pilotNotified = null
      let bestAction = { status: 'none' }
      let hasReportsField = false
      let hasNotifField = false
      for (const a of tails) {
        if (typeof a.reportCount === 'number') {
          hasReportsField = true
          reportCount += a.reportCount
        }
        if (a.operatorNotified !== undefined) hasNotifField = true
        if (a.pilotNotified !== undefined) hasNotifField = true
        if (a.operatorNotified && !operatorNotified) operatorNotified = a.operatorNotified
        if (a.pilotNotified && !pilotNotified) pilotNotified = a.pilotNotified
        const act = a.pilotAction
        if (act && actionRank[act.status] > actionRank[bestAction.status]) bestAction = act
      }
      return {
        type,
        tails,
        worst: worst.worst,
        mostRecentMs: mostRecent.lastSeenMs,
        nearestMeters: Number.isFinite(nearest) ? nearest : null,
        reportCount: hasReportsField ? reportCount : null,
        operatorNotified,
        pilotNotified,
        pilotAction: hasNotifField ? bestAction : null,
      }
    })
    // Sort by distance ascending when we have one; unknown-distance groups
    // sink to the bottom sorted by most recent.
    arr.sort((a, b) => {
      const da = a.nearestMeters
      const db = b.nearestMeters
      if (da == null && db == null) return (b.mostRecentMs || 0) - (a.mostRecentMs || 0)
      if (da == null) return 1
      if (db == null) return -1
      return da - db
    })
    return arr
  }, [activeList, distanceByTail])

  const items = groups.map((g) => {
    const selectedInGroup = g.tails.find((a) => a.tail === selectedTail)
    const anyActive = !!selectedInGroup
    const onClick = () => {
      if (!g.tails.length) return
      if (anyActive) {
        const idx = g.tails.findIndex((a) => a.tail === selectedTail)
        const next = g.tails[(idx + 1) % g.tails.length]
        onSelectTail(g.tails.length === 1 ? null : next.tail)
      } else {
        const pick = g.tails.reduce((r, a) => ((a.lastSeenMs || 0) > (r.lastSeenMs || 0) ? a : r), g.tails[0])
        onSelectTail(pick.tail)
      }
    }
    return { ...g, anyActive, onClick }
  })

  return (
    <div>
      {/* ─ Mobile: bare floating tiles, no panel background ─ */}
      <div className="md:hidden">
        <ul className="flex gap-1.5 overflow-x-auto scrollbar-none">
          {items.map((g) => (
            <li key={g.type} className="flex-shrink-0">
              <button
                onClick={g.onClick}
                title={`${g.type}${g.nearestMeters != null ? ' · ' + formatMiles(g.nearestMeters) : ''}`}
                className={[
                  'relative h-11 w-11 rounded-lg overflow-hidden shadow-lg transition-all',
                  g.anyActive
                    ? 'border-2 border-sky-400 ring-2 ring-sky-400/40 scale-110'
                    : 'border border-white/20',
                ].join(' ')}
              >
                {typePhotos?.[g.type] ? (
                  <img src={typePhotos[g.type]} alt={g.type} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
                ) : (
                  <div className="absolute inset-0 bg-neutral-900 flex items-center justify-center text-[7px] text-neutral-400 font-semibold leading-none text-center px-0.5">{g.type}</div>
                )}
                <span
                  className="absolute bottom-0.5 right-0.5 h-2 w-2 rounded-full border border-black/50"
                  style={{ background: KLASS_COLORS[g.worst], boxShadow: `0 0 6px ${KLASS_COLORS[g.worst]}` }}
                />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* ─ Desktop: vertical sidebar list ─ */}
      <div className="hidden md:flex md:flex-col md:overflow-hidden bg-black/60 backdrop-blur-md border border-white/10 rounded-lg shadow-2xl">
        <div className="px-3 py-2.5 border-b border-white/10">
          <p className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">Active Excursions</p>
          <p className="text-[11px] text-neutral-400">
            {activeStatus === 'loading' && 'Loading…'}
            {activeStatus === 'error' && <span className="text-rose-300">Feed unavailable</span>}
            {activeStatus === 'ok' && `${activeList.length} aircraft · 2h`}
          </p>
        </div>
        <ul className="overflow-y-auto">
          {activeStatus === 'ok' && items.length === 0 && (
            <li className="px-3 py-3 text-[11px] text-neutral-500">No recent excursions.</li>
          )}
          {items.map((g) => (
            <li key={g.type} className="border-b border-white/5 last:border-b-0">
              <button
                onClick={g.onClick}
                className={[
                  'w-full text-left px-3 py-2.5 flex items-center gap-2.5 transition-colors',
                  g.anyActive ? 'bg-white/10' : 'hover:bg-white/5',
                ].join(' ')}
              >
                <div className="relative h-10 w-14 flex-shrink-0 rounded overflow-hidden bg-black/40 border border-white/10">
                  {typePhotos?.[g.type] ? (
                    <img src={typePhotos[g.type]} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center"><IconVideo size={14} className="text-neutral-700" /></div>
                  )}
                  <span
                    className="absolute top-0.5 left-0.5 h-1.5 w-1.5 rounded-full"
                    style={{ background: KLASS_COLORS[g.worst], boxShadow: `0 0 6px ${KLASS_COLORS[g.worst]}` }}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium text-neutral-100 truncate">{g.type}</div>
                    {g.nearestMeters != null && (
                      <div className="text-[11px] font-mono text-neutral-200 flex-shrink-0">
                        {formatMiles(g.nearestMeters)}
                      </div>
                    )}
                  </div>
                  <div className="text-[10px] text-neutral-500 flex items-center gap-1.5">
                    <span>{g.tails.length} aircraft</span>
                    <span>·</span>
                    <span>{formatAgo(g.mostRecentMs) || g.worst}</span>
                  </div>
                  <ExcursionStatusBar
                    reportCount={g.reportCount}
                    operatorNotified={g.operatorNotified}
                    pilotNotified={g.pilotNotified}
                    pilotAction={g.pilotAction}
                  />
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function WizardHeader({ step, submitted, onClose }) {
  const steps = [
    { n: 1, label: 'Capture' },
    { n: 2, label: 'Identify' },
    { n: 3, label: 'Review' },
  ]
  return (
    <header className="px-5 py-4 border-b border-white/10 bg-gradient-to-b from-white/[0.03] to-transparent">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">File a report</p>
          <h2 className="text-base font-semibold text-neutral-100">Aircraft Noise Excursion</h2>
        </div>
        <button onClick={onClose} className="text-neutral-500 hover:text-neutral-200"><IconX size={18} /></button>
      </div>
      {!submitted && (
        <ol className="flex items-center gap-2 mt-3">
          {steps.map((s, i) => {
            const active = step === s.n
            const done = step > s.n
            return (
              <li key={s.n} className="flex-1 flex items-center gap-2">
                <div className={[
                  'h-5 w-5 rounded-full flex items-center justify-center text-[9px] font-bold',
                  done ? 'bg-emerald-400/20 text-emerald-300 border border-emerald-400/40'
                    : active ? 'bg-sky-400/20 text-sky-300 border border-sky-400/40'
                    : 'bg-white/5 text-neutral-500 border border-white/10',
                ].join(' ')}>
                  {done ? <IconCheck size={10} stroke={3} /> : s.n}
                </div>
                <span className={`text-[10px] ${active ? 'text-neutral-100' : 'text-neutral-500'}`}>{s.label}</span>
                {i < steps.length - 1 && <div className={`flex-1 h-px ${done ? 'bg-emerald-400/40' : 'bg-white/10'}`} />}
              </li>
            )
          })}
        </ol>
      )}
    </header>
  )
}

function CaptureStep(props) {
  const {
    recordingAudio, audioProgress, audioLevel, audioBlob, audioUrl, audioError, startAudio,
    recordingVideo, videoSeconds, videoBlob, videoUrl, videoError, videoPreviewRef, startVideo, stopVideo,
  } = props
  return (
    <>
      <Card title="Record the Aircraft" subtitle="Capture 5 seconds of audio, or a short video for stronger evidence.">
        <div className="flex flex-col items-center gap-3">
          <CircularCaptureButton
            recording={recordingAudio}
            progress={audioProgress}
            level={audioLevel}
            onClick={startAudio}
            hasRecording={!!audioBlob}
            icon={IconMicrophone}
            idleLabel="Record audio"
          />
          <div className="text-[11px] text-neutral-500 text-center">
            {recordingAudio
              ? `Recording… ${Math.max(0, 5 - Math.round(audioProgress * 5))}s`
              : audioBlob ? 'Audio captured — tap to re-record' : 'Tap to record 5 seconds'}
          </div>
          {audioUrl && !recordingAudio && <audio controls src={audioUrl} className="w-full" />}
          {audioError && <div className="text-xs text-rose-300">{audioError}</div>}
        </div>
      </Card>
      <Card title="Or Record Video" subtitle="Video counts as stronger evidence. Up to 15 seconds.">
        <div className="flex flex-col items-center gap-3">
          <div className="relative aspect-video w-full rounded-lg overflow-hidden bg-black border border-white/10">
            {recordingVideo ? (
              <video ref={videoPreviewRef} className="w-full h-full object-cover" playsInline muted />
            ) : videoUrl ? (
              <video src={videoUrl} controls className="w-full h-full object-cover" playsInline />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-neutral-600"><IconVideo size={32} /></div>
            )}
            {recordingVideo && (
              <div className="absolute top-2 left-2 flex items-center gap-1.5 bg-rose-500/90 text-white text-[10px] font-bold px-2 py-0.5 rounded">
                <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
                REC {videoSeconds}s
              </div>
            )}
          </div>

          <CircularCaptureButton
            recording={recordingVideo}
            progress={Math.min(1, videoSeconds / 15)}
            onClick={recordingVideo ? stopVideo : startVideo}
            hasRecording={!!videoBlob}
            icon={recordingVideo ? IconPlayerStopFilled : IconVideo}
            idleLabel="Record video"
            activeGradient="from-rose-400 to-rose-600"
            glowColor="244,63,94"
          />

          <div className="text-[11px] text-neutral-500 text-center">
            {recordingVideo
              ? `Recording… ${Math.max(0, 15 - videoSeconds)}s remaining (tap to stop)`
              : videoBlob
              ? 'Video captured — tap to re-record'
              : 'Tap to record up to 15 seconds'}
          </div>
          {videoError && <div className="text-xs text-rose-300">{videoError}</div>}
        </div>
      </Card>
    </>
  )
}

function IdentifyStep({ activeList, activeStatus, typePhotos, selected, onSelect, mapSelectedTail }) {
  // One card per aircraft type, each card tagged to the most-recently-seen
  // tail of that type behind the scenes. Tails are never shown.
  const groups = useMemo(() => {
    const m = new Map()
    for (const a of activeList) {
      const k = a.type || 'Unknown'
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(a)
    }
    const sev = { yellow: 1, orange: 2, red: 3 }
    return Array.from(m.entries()).map(([type, tails]) => {
      const worst = tails.reduce((w, a) => (sev[a.worst] > sev[w.worst] ? a : w), tails[0]).worst
      const pick = tails.reduce((r, a) => ((a.lastSeenMs || 0) > (r.lastSeenMs || 0) ? a : r), tails[0])
      const mostRecentMs = pick.lastSeenMs || 0
      return { type, count: tails.length, worst, pick, mostRecentMs }
    })
  }, [activeList])

  // Prefer the type currently selected on the map
  const mapSelectedType = useMemo(() => {
    if (!mapSelectedTail) return null
    const a = activeList.find((x) => x.tail === mapSelectedTail)
    return a?.type || null
  }, [mapSelectedTail, activeList])

  return (
    <Card title="Identify the Aircraft" subtitle="Tap the type you heard. Reports tied to an excursion are followed up first.">
      {activeStatus === 'loading' && <p className="text-[11px] text-neutral-500">Loading…</p>}
      {activeStatus === 'error' && <p className="text-[11px] text-rose-300">Feed unavailable.</p>}
      {selected && (
        <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-sky-400/40 bg-sky-400/10 px-3 py-2">
          <div className="flex items-center gap-3">
            {typePhotos?.[selected.type] ? (
              <img src={typePhotos[selected.type]} alt="" className="h-10 w-14 object-cover rounded border border-white/10" />
            ) : (
              <div className="h-10 w-14 rounded bg-white/5 border border-white/10" />
            )}
            <div>
              <div className="text-[10px] uppercase tracking-[0.15em] text-sky-300">Tagged</div>
              <div className="text-sm font-medium text-neutral-100">{selected.type}</div>
            </div>
          </div>
          <button onClick={() => onSelect(null)} className="text-neutral-400 hover:text-neutral-200"><IconX size={16} /></button>
        </div>
      )}
      <ul className="grid grid-cols-2 gap-2">
        {groups.map((g) => {
          const picked = selected?.type === g.type
          const hint = !picked && mapSelectedType === g.type
          const photo = typePhotos?.[g.type]
          return (
            <li key={g.type}>
              <button
                onClick={() => onSelect(g.pick)}
                className={[
                  'w-full rounded-xl overflow-hidden border-2 text-left transition-all relative',
                  picked
                    ? 'border-sky-400 bg-sky-400/15 shadow-[0_0_32px_rgba(56,189,248,0.45)] scale-[1.02]'
                    : hint
                    ? 'border-white/25 bg-white/[0.04]'
                    : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/20',
                ].join(' ')}
              >
                <div className="relative aspect-[16/10] bg-black/60">
                  {photo ? (
                    <img
                      src={photo}
                      alt={g.type}
                      loading="lazy"
                      className={[
                        'absolute inset-0 w-full h-full object-cover transition-all',
                        picked ? '' : 'brightness-75 saturate-50',
                      ].join(' ')}
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-neutral-600 text-[10px]">
                      {typePhotos && g.type in typePhotos ? 'No photo' : 'Loading…'}
                    </div>
                  )}
                  <span
                    className="absolute top-1.5 left-1.5 h-2.5 w-2.5 rounded-full"
                    style={{ background: KLASS_COLORS[g.worst], boxShadow: `0 0 8px ${KLASS_COLORS[g.worst]}` }}
                  />
                  {picked && (
                    <>
                      <div className="absolute inset-0 ring-2 ring-sky-400 ring-inset pointer-events-none" />
                      <div className="absolute top-1.5 right-1.5 h-6 w-6 rounded-full bg-sky-400 flex items-center justify-center shadow-lg">
                        <IconCheck size={14} stroke={3} className="text-white" />
                      </div>
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-sky-500/80 to-transparent py-1.5 text-center">
                        <span className="text-[10px] font-bold text-white uppercase tracking-wider">Selected</span>
                      </div>
                    </>
                  )}
                </div>
                <div className={[
                  'px-2.5 py-2',
                  picked ? 'bg-sky-400/10' : '',
                ].join(' ')}>
                  <div className={[
                    'text-sm font-semibold truncate',
                    picked ? 'text-sky-200' : 'text-neutral-100',
                  ].join(' ')}>{g.type}</div>
                  <div className="text-[10px] text-neutral-500">
                    {g.count} aircraft
                    {g.mostRecentMs ? ` · ${formatAgo(g.mostRecentMs)}` : ''}
                  </div>
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

function ReviewStep({ score, tier, tierColor, displayedLocation, audioUrl, videoUrl, selectedExcursion, reportMode, reportSegments, onRemoveSegment }) {
  return (
    <>
      {/* Mini-map showing reported segments */}
      {reportSegments?.length > 0 && (() => {
        const uniqueTails = new Set(reportSegments.map((s) => s.tail))
        return (
        <Card
          title={`${reportSegments.length} Segment${reportSegments.length > 1 ? 's' : ''} · ${uniqueTails.size} Aircraft`}
          subtitle="Tap × to remove individual segments"
        >

          <SegmentsMiniMap segments={reportSegments} />
          <ul className="mt-2 space-y-1">
            {reportSegments.map((seg, i) => {
              const isExc = !!seg.klass
              return (
                <li key={i} className="flex items-center gap-2 text-[11px]">
                  <span
                    className="h-2 w-2 rounded-full flex-shrink-0"
                    style={{ background: '#ff8c00' }}
                  />
                  <span className="flex-1 text-neutral-200 truncate">
                    {seg.type || seg.tail || 'Unknown'}
                    {isExc && <span className="text-neutral-500"> · {seg.klass}</span>}
                  </span>
                  <button
                    onClick={() => onRemoveSegment(i)}
                    className="text-neutral-500 hover:text-rose-300 flex-shrink-0"
                    title="Remove from report"
                  >
                    <IconX size={12} />
                  </button>
                </li>
              )
            })}
          </ul>
        </Card>
        )
      })()}
      <Card title="Report Score" subtitle="Higher scores are prioritised for follow-up.">
        <div className="flex items-center gap-4">
          <div className="relative w-24 h-24 flex-shrink-0">
            <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="6" />
              <circle cx="50" cy="50" r="44" fill="none" stroke="currentColor" className={tierColor}
                strokeWidth="6" strokeLinecap="round" strokeDasharray={2 * Math.PI * 44}
                strokeDashoffset={2 * Math.PI * 44 * (1 - score.total / score.max)}
                style={{ transition: 'stroke-dashoffset 400ms ease' }} />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center text-center">
              <div>
                <div className="text-2xl font-bold text-neutral-100">{score.total}</div>
                <div className="text-[9px] uppercase tracking-wider text-neutral-500">/ {score.max}</div>
              </div>
            </div>
          </div>
          <div className="flex-1">
            <div className={`text-sm font-semibold ${tierColor}`}>{tier}</div>
            <ul className="mt-2 space-y-1">
              {score.breakdown.length === 0 && <li className="text-[11px] text-neutral-500">Nothing captured yet.</li>}
              {score.breakdown.map((b) => (
                <li key={b.label} className="flex justify-between text-[11px]">
                  <span className="text-neutral-400">{b.label}</span>
                  <span className="text-neutral-200 font-mono">+{b.pts}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Card>
      <Card title="Summary">
        <dl className="space-y-2 text-xs">
          <Row label="Segments" value={`${reportSegments?.length || 0} segments · ${new Set(reportSegments?.map((s) => s.tail)).size || 0} aircraft`} />
          <Row label="Audio" value={audioUrl ? '5-second clip captured' : 'None'} />
          <Row label="Video" value={videoUrl ? 'Clip captured' : 'None'} />
          <Row
            label={reportMode === 'general' ? 'Type' : 'Aircraft'}
            value={
              reportMode === 'general'
                ? 'General ambient noise'
                : selectedExcursion ? selectedExcursion.type : 'Not identified'
            }
            sub={reportMode === 'excursion' ? selectedExcursion?.tail : undefined}
          />
        </dl>
      </Card>
    </>
  )
}

function SubmittedView({
  score, selectedExcursion, onReset,
  fullStatus, fullError, fullId,
  complaintStatus, complaintError, complaintId,
  identity, onSaveIdentity,
}) {
  // Overall headline picks the least-happy relevant status.
  const relevant = [fullStatus, complaintStatus].filter((s) => s !== 'idle')
  const posting = relevant.includes('posting')
  const anyError = relevant.includes('error')
  const allOk = relevant.length > 0 && relevant.every((s) => s === 'ok')

  const icon = anyError
    ? <IconX size={28} className="text-rose-300" stroke={2.5} />
    : posting
    ? <div className="h-7 w-7 rounded-full border-2 border-sky-300 border-t-transparent animate-spin" />
    : <IconCheck size={28} className="text-emerald-300" stroke={2.5} />
  const ring = anyError ? 'bg-rose-400/20 border-rose-400/40'
    : posting ? 'bg-sky-400/20 border-sky-400/40'
    : 'bg-emerald-400/20 border-emerald-400/40'
  const headline = anyError ? (allOk ? 'Report submitted' : 'Partial submission')
    : posting ? 'Submitting…'
    : 'Report submitted'

  return (
    <div className="py-6 text-center">
      <div className={`mx-auto w-14 h-14 rounded-full border flex items-center justify-center ${ring}`}>
        {icon}
      </div>
      <h2 className="mt-4 text-lg font-semibold text-neutral-100">{headline}</h2>
      <p className="text-xs text-neutral-400 mt-1">
        Scored {score.total}/{score.max}
        {selectedExcursion && ` · tagged ${selectedExcursion.type}`}
      </p>

      <ul className="mt-4 space-y-1.5 text-left max-w-xs mx-auto">
        <StatusRow label="Dashboard archive" status={fullStatus} error={fullError} id={fullId} />
        {complaintStatus !== 'idle' && (
          <StatusRow label="Noise office complaint" status={complaintStatus} error={complaintError} id={complaintId} />
        )}
      </ul>

      {!identity && !posting && (
        <TrackReportSection onSaveIdentity={onSaveIdentity} />
      )}
      {identity && !posting && (
        <p className="mt-5 text-[11px] text-neutral-500">
          Tracking as <span className="text-neutral-300">{identity.email || `@${identity.handle}`}</span>
        </p>
      )}

      <button onClick={onReset} className="mt-5 text-xs text-sky-300 hover:text-sky-200 underline underline-offset-2">
        File another report
      </button>
    </div>
  )
}

function TrackReportSection({ onSaveIdentity }) {
  const [tab, setTab] = useState('email') // 'email' | 'login' | 'signup'
  const [email, setEmail] = useState('')
  const [handle, setHandle] = useState('')
  const [pass, setPass] = useState('')
  const [confirmPass, setConfirmPass] = useState('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  const emailValid = /^\S+@\S+\.\S+$/.test(email)
  const loginValid = handle.trim().length >= 3 && pass.length >= 4
  const signupValid = loginValid && pass === confirmPass

  if (saved) {
    return (
      <div className="mt-5 rounded-lg border border-emerald-400/30 bg-emerald-400/5 p-3 text-left max-w-sm mx-auto">
        <div className="flex items-center gap-2">
          <IconCheck size={14} className="text-emerald-300" stroke={3} />
          <span className="text-[12px] text-neutral-100 font-medium">Tracking enabled</span>
        </div>
        <p className="text-[10px] text-neutral-500 mt-1">
          You'll see this report — and its pilot/operator status — in <strong>My reports</strong>.
        </p>
      </div>
    )
  }

  return (
    <div className="mt-5 rounded-lg border border-white/10 bg-white/[0.02] p-4 text-left max-w-sm mx-auto">
      <div className="flex items-center gap-2">
        <IconHistory size={14} className="text-sky-300" />
        <span className="text-[12px] font-semibold text-neutral-100">Track this report</span>
      </div>
      <p className="text-[10px] text-neutral-500 mt-1 leading-relaxed">
        Leave contact info or sign in — we'll show the pilot/operator response in <strong>My reports</strong>.
      </p>

      <div className="mt-3 grid grid-cols-3 gap-1 p-0.5 rounded-md border border-white/10 bg-white/5">
        {[
          { key: 'email',  label: 'Email',     icon: IconMail },
          { key: 'login',  label: 'Log in',    icon: IconUser },
          { key: 'signup', label: 'Sign up',   icon: IconUserPlus },
        ].map((t) => {
          const active = tab === t.key
          const Icon = t.icon
          return (
            <button
              key={t.key}
              onClick={() => { setTab(t.key); setError(null) }}
              className={[
                'flex items-center gap-1 justify-center py-1.5 rounded text-[10px] font-medium transition-colors',
                active ? 'bg-white text-black' : 'text-neutral-400 hover:text-white',
              ].join(' ')}
            >
              <Icon size={11} />
              {t.label}
            </button>
          )
        })}
      </div>

      <div className="mt-3 space-y-2">
        {tab === 'email' && (
          <>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-md bg-black/50 border border-white/10 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-sky-400"
            />
            <button
              onClick={() => {
                if (!emailValid) { setError('Please enter a valid email'); return }
                onSaveIdentity({ kind: 'email', email: email.trim() })
                setSaved(true)
              }}
              disabled={!emailValid}
              className={[
                'w-full rounded-md py-2 text-xs font-semibold transition-colors',
                emailValid ? 'bg-sky-500 hover:bg-sky-400 text-white' : 'bg-white/10 text-neutral-500 cursor-not-allowed',
              ].join(' ')}
            >
              Track with email
            </button>
          </>
        )}

        {tab === 'login' && (
          <>
            <input
              type="text"
              value={handle}
              onChange={(e) => setHandle(e.target.value.replace(/\s+/g, ''))}
              placeholder="handle"
              className="w-full rounded-md bg-black/50 border border-white/10 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-sky-400"
            />
            <input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder="passphrase"
              className="w-full rounded-md bg-black/50 border border-white/10 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-sky-400"
            />
            <button
              onClick={() => {
                if (!loginValid) { setError('Handle ≥3 chars, passphrase ≥4 chars'); return }
                onSaveIdentity({ kind: 'anonymous', handle: handle.trim(), passphrase: pass })
                setSaved(true)
              }}
              disabled={!loginValid}
              className={[
                'w-full rounded-md py-2 text-xs font-semibold transition-colors',
                loginValid ? 'bg-sky-500 hover:bg-sky-400 text-white' : 'bg-white/10 text-neutral-500 cursor-not-allowed',
              ].join(' ')}
            >
              Log in
            </button>
          </>
        )}

        {tab === 'signup' && (
          <>
            <input
              type="text"
              value={handle}
              onChange={(e) => setHandle(e.target.value.replace(/\s+/g, ''))}
              placeholder="choose a handle"
              className="w-full rounded-md bg-black/50 border border-white/10 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-sky-400"
            />
            <input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder="choose a passphrase"
              className="w-full rounded-md bg-black/50 border border-white/10 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-sky-400"
            />
            <input
              type="password"
              value={confirmPass}
              onChange={(e) => setConfirmPass(e.target.value)}
              placeholder="confirm passphrase"
              className="w-full rounded-md bg-black/50 border border-white/10 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-sky-400"
            />
            <button
              onClick={() => {
                if (!loginValid)    { setError('Handle ≥3 chars, passphrase ≥4 chars'); return }
                if (pass !== confirmPass) { setError('Passphrases do not match'); return }
                onSaveIdentity({ kind: 'anonymous', handle: handle.trim(), passphrase: pass })
                setSaved(true)
              }}
              disabled={!signupValid}
              className={[
                'w-full rounded-md py-2 text-xs font-semibold transition-colors',
                signupValid ? 'bg-sky-500 hover:bg-sky-400 text-white' : 'bg-white/10 text-neutral-500 cursor-not-allowed',
              ].join(' ')}
            >
              Create account
            </button>
          </>
        )}

        {error && <p className="text-[10px] text-rose-300">{error}</p>}
      </div>
    </div>
  )
}

function StatusRow({ label, status, error, id }) {
  const dot = status === 'ok' ? 'bg-emerald-400'
    : status === 'error' ? 'bg-rose-400'
    : status === 'posting' ? 'bg-sky-400 animate-pulse'
    : 'bg-neutral-600'
  return (
    <li className="flex items-start gap-2 text-[11px]">
      <span className={`mt-1 h-2 w-2 rounded-full flex-shrink-0 ${dot}`} />
      <div className="flex-1 min-w-0">
        <div className="flex justify-between gap-2">
          <span className="text-neutral-300">{label}</span>
          <span className={`font-mono ${
            status === 'ok' ? 'text-emerald-300'
            : status === 'error' ? 'text-rose-300'
            : 'text-neutral-500'
          }`}>
            {status === 'posting' ? 'sending…' : status}
          </span>
        </div>
        {id && <div className="text-[10px] text-neutral-600 font-mono truncate">#{id}</div>}
        {status === 'error' && error && (
          <div className="text-[10px] text-rose-300/90 break-words">{error}</div>
        )}
      </div>
    </li>
  )
}

function CircularCaptureButton({
  recording,
  progress,
  level = 0,
  onClick,
  hasRecording,
  icon: Icon,
  idleLabel,
  activeGradient = 'from-sky-400 to-sky-600',
  glowColor = '56,189,248',
  doneGradient = 'from-emerald-400 to-emerald-600',
  doneGlow = '52,211,153',
}) {
  const size = 136
  const stroke = 3
  const r = (size - stroke) / 2 - 8
  const c = 2 * Math.PI * r
  const offset = c * (1 - progress)
  const scale = recording ? 1 + level * 0.06 : 1
  return (
    <button onClick={onClick} className="relative" style={{ width: size, height: size }} aria-label={idleLabel}>
      <div
        className="absolute inset-0 rounded-full transition-all duration-200"
        style={{
          background: recording
            ? `radial-gradient(closest-side, rgba(${glowColor},${0.25 + level * 0.75}) 0%, rgba(${glowColor},0) 70%)`
            : 'radial-gradient(closest-side, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 70%)',
          transform: `scale(${1.1 + level * 0.25})`,
        }}
      />
      {!recording && !hasRecording && (
        <span className="absolute inset-2 rounded-full border border-white/10" style={{ animation: 'micPulse 2.6s ease-out infinite' }} />
      )}
      <div
        className={[
          'absolute inset-2 rounded-full flex items-center justify-center transition-all duration-150',
          recording ? `bg-gradient-to-br ${activeGradient} shadow-[0_0_40px_rgba(${glowColor},0.5)]`
            : hasRecording ? `bg-gradient-to-br ${doneGradient} shadow-[0_0_30px_rgba(${doneGlow},0.35)]`
            : 'bg-gradient-to-br from-neutral-100 to-neutral-300 text-black shadow-[0_10px_40px_rgba(0,0,0,0.5)]',
        ].join(' ')}
        style={{ transform: `scale(${scale})` }}
      >
        {hasRecording && !recording ? <IconCheck size={40} stroke={2.5} className="text-white" />
          : <Icon size={40} stroke={2} className={recording ? 'text-white' : 'text-black'} />}
      </div>
      {recording && (
        <svg className="absolute inset-0 -rotate-90" width={size} height={size}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="white" strokeWidth={stroke}
            strokeLinecap="round" strokeDasharray={c} strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 60ms linear' }} />
        </svg>
      )}
    </button>
  )
}

function SegmentsMiniMap({ segments }) {
  const ref = useRef(null)
  const mapRef2 = useRef(null)
  useEffect(() => {
    const L = window.L
    if (!L || !ref.current) return
    if (mapRef2.current) { mapRef2.current.remove(); mapRef2.current = null }
    const bounds = L.latLngBounds([])
    const map = L.map(ref.current, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      touchZoom: false,
    })
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', { maxZoom: 17 }).addTo(map)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', { maxZoom: 17 }).addTo(map)
    // Only the selected segments in bright orange — no location indicators.
    for (const seg of segments) {
      if (!seg.points?.length) continue
      const pts = seg.points.map((p) => [p[0], p[1]])
      L.polyline(pts, {
        color: '#ff8c00',
        weight: 6,
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(map)
      if (seg.nearestPt) {
        L.circleMarker([seg.nearestPt[0], seg.nearestPt[1]], {
          radius: 5, color: '#ff8c00', weight: 2, fillColor: '#000', fillOpacity: 0.5, interactive: false,
        }).addTo(map)
      }
      pts.forEach((p) => bounds.extend(p))
    }
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.2), { maxZoom: 14 })
    mapRef2.current = map
    return () => { map.remove(); mapRef2.current = null }
  }, [segments])

  return (
    <div ref={ref} className="w-full h-40 rounded-lg overflow-hidden border border-white/10" style={{ background: '#0a0a0a' }} />
  )
}

function Card({ title, subtitle, children }) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-neutral-100">{title}</h3>
        {subtitle && <p className="text-[11px] text-neutral-500 mt-0.5 leading-relaxed">{subtitle}</p>}
      </div>
      {children}
    </section>
  )
}

function ExcursionStatusBar({ reportCount, operatorNotified, pilotNotified, pilotAction }) {
  // Render nothing until the feed actually carries notification/report fields.
  if (reportCount == null && !operatorNotified && !pilotNotified && !pilotAction) return null
  const actionStatus = pilotAction?.status || 'none'
  const actionLabel =
    actionStatus === 'completed'    ? 'Completed'
    : actionStatus === 'reviewed'   ? 'Reviewed'
    : actionStatus === 'acknowledged' ? 'Acked'
    : null
  const actionColor =
    actionStatus === 'completed'    ? 'text-emerald-300 border-emerald-400/40 bg-emerald-400/10'
    : actionStatus === 'reviewed'   ? 'text-sky-300 border-sky-400/40 bg-sky-400/10'
    : actionStatus === 'acknowledged' ? 'text-amber-300 border-amber-400/40 bg-amber-400/10'
    : 'text-neutral-500 border-white/10 bg-white/[0.02]'
  return (
    <div className="mt-1 flex items-center gap-1 flex-wrap">
      {reportCount != null && reportCount > 0 && (
        <span
          className="inline-flex items-center gap-0.5 rounded-full border border-rose-400/40 bg-rose-400/10 text-rose-300 px-1.5 py-0 text-[9px] font-semibold"
          title={`${reportCount} citizen report${reportCount === 1 ? '' : 's'} filed`}
        >
          <IconAlertTriangle size={9} /> {reportCount}
        </span>
      )}
      <span
        className={[
          'inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0 text-[9px]',
          operatorNotified ? 'border-sky-400/40 bg-sky-400/10 text-sky-300' : 'border-white/10 bg-white/[0.02] text-neutral-500',
        ].join(' ')}
        title={operatorNotified ? `Operator notified ${formatAgo(Date.parse(operatorNotified.at || ''))}` : 'Operator not yet notified'}
      >
        <IconMail size={9} /> op
      </span>
      <span
        className={[
          'inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0 text-[9px]',
          pilotNotified ? 'border-sky-400/40 bg-sky-400/10 text-sky-300' : 'border-white/10 bg-white/[0.02] text-neutral-500',
        ].join(' ')}
        title={pilotNotified ? `Pilot notified ${formatAgo(Date.parse(pilotNotified.at || ''))}` : 'Pilot not yet notified'}
      >
        <IconUser size={9} /> pilot
      </span>
      {actionLabel && (
        <span
          className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0 text-[9px] ${actionColor}`}
          title={`Pilot action: ${actionStatus}${pilotAction.at ? ' ' + formatAgo(Date.parse(pilotAction.at)) : ''}`}
        >
          <IconCheck size={9} stroke={3} /> {actionLabel}
        </span>
      )}
    </div>
  )
}

function IdentityChip({ identity, onEdit }) {
  if (!identity) {
    return (
      <button
        onClick={onEdit}
        className="flex items-center gap-1 rounded-md bg-sky-500/80 hover:bg-sky-500 text-white px-2 py-1 text-[10px] font-medium"
        title="Required before submitting a report"
      >
        <IconUserPlus size={12} />
        Set identity
      </button>
    )
  }
  const label = identity.kind === 'email'
    ? identity.email
    : `@${identity.handle}`
  const Icon = identity.kind === 'email' ? IconMail : IconUser
  return (
    <button
      onClick={onEdit}
      className="flex items-center gap-1 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 px-2 py-1 text-[10px] text-neutral-200 max-w-[160px]"
      title={`Signed in as ${label} — click to change`}
    >
      <Icon size={12} className="flex-shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  )
}

function IdentityModal({ initial, onClose, onSave, onClear }) {
  const [kind, setKind] = useState(initial?.kind || 'email')
  const [email, setEmail] = useState(initial?.email || '')
  const [handle, setHandle] = useState(initial?.handle || '')
  const [passphrase, setPassphrase] = useState('')
  const valid = kind === 'email'
    ? /^\S+@\S+\.\S+$/.test(email)
    : handle.trim().length >= 3 && passphrase.length >= 4

  return (
    <div className="absolute inset-0 z-[1200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm bg-neutral-950/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
        <header className="px-5 py-4 border-b border-white/10 flex items-start justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Identity</p>
            <h2 className="text-base font-semibold text-neutral-100">Who are you reporting as?</h2>
          </div>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-200"><IconX size={18} /></button>
        </header>

        <div className="p-5 space-y-4">
          <p className="text-[11px] text-neutral-500 leading-relaxed">
            Reports are more credible with a reachable contact. You can stay anonymous with a
            handle + passphrase if you prefer — the passphrase keeps your reports grouped so you
            can see their status later.
          </p>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setKind('email')}
              className={[
                'flex items-center gap-1.5 justify-center rounded-lg py-2 text-[11px] font-medium border transition-colors',
                kind === 'email'
                  ? 'bg-sky-500/90 text-white border-sky-400'
                  : 'bg-white/[0.03] text-neutral-300 border-white/10 hover:bg-white/[0.06]',
              ].join(' ')}
            >
              <IconMail size={13} /> Email contact
            </button>
            <button
              onClick={() => setKind('anonymous')}
              className={[
                'flex items-center gap-1.5 justify-center rounded-lg py-2 text-[11px] font-medium border transition-colors',
                kind === 'anonymous'
                  ? 'bg-white/15 text-white border-white/20'
                  : 'bg-white/[0.03] text-neutral-300 border-white/10 hover:bg-white/[0.06]',
              ].join(' ')}
            >
              <IconUser size={13} /> Anonymous
            </button>
          </div>

          {kind === 'email' ? (
            <div>
              <label className="text-[10px] uppercase tracking-[0.15em] text-neutral-500">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-1 w-full rounded-md bg-black/50 border border-white/10 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-sky-400"
                autoFocus
              />
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="text-[10px] uppercase tracking-[0.15em] text-neutral-500">Handle</label>
                <input
                  type="text"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value.replace(/\s+/g, ''))}
                  placeholder="night-owl-42"
                  className="mt-1 w-full rounded-md bg-black/50 border border-white/10 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-sky-400"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.15em] text-neutral-500">Passphrase</label>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="min 4 characters"
                  className="mt-1 w-full rounded-md bg-black/50 border border-white/10 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-sky-400"
                />
                <p className="text-[10px] text-neutral-500 mt-1">
                  Stored on this device only. Keep it to read your own complaint history.
                </p>
              </div>
            </div>
          )}
        </div>

        <footer className="border-t border-white/10 px-5 py-3 flex items-center gap-2">
          {initial && (
            <button onClick={onClear} className="text-[11px] text-rose-300 hover:text-rose-200">
              Forget me
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="rounded-md border border-white/10 bg-white/[0.03] hover:bg-white/[0.07] px-4 py-1.5 text-xs text-neutral-300"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              const id = kind === 'email'
                ? { kind: 'email', email: email.trim() }
                : { kind: 'anonymous', handle: handle.trim(), passphrase }
              onSave(id)
            }}
            disabled={!valid}
            className={[
              'rounded-md px-4 py-1.5 text-xs font-semibold transition-colors',
              valid ? 'bg-white text-black hover:bg-neutral-200' : 'bg-white/10 text-neutral-500 cursor-not-allowed',
            ].join(' ')}
          >
            Save
          </button>
        </footer>
      </div>
    </div>
  )
}

function MyComplaintsPanel({ identity, complaints, reports, sessionReports, status, activeList, locality, viewingReport, onViewReport, onRefresh, onClose, onSetIdentity }) {
  const [repsOpen, setRepsOpen] = useState(false)

  // Derive airports in scope. Preference order:
  //   1. Airports inferred from the user's complaints (tail → airport join)
  //   2. Airports whose catchment matches the user's reverse-geocoded locality
  //      (city/town/county) — used when complaints don't name a city
  //   3. (The dialog's own fallback of "all airports" if still empty)
  const { airports, source } = useMemo(() => {
    const tailToAirport = new Map()
    for (const a of activeList || []) if (a.tail && a.airport) tailToAirport.set(a.tail, a.airport)
    const fromComplaints = new Set()
    for (const c of complaints) {
      const ap = tailToAirport.get(c.tail)
      if (ap) fromComplaints.add(ap)
    }
    if (fromComplaints.size) return { airports: Array.from(fromComplaints), source: 'complaint' }
    const fromLocality = airportsForLocality(locality)
    if (fromLocality.length) return { airports: fromLocality, source: 'locality' }
    return { airports: [], source: 'fallback' }
  }, [complaints, activeList, locality])

  return (
    <div className="panel-slide-in absolute inset-y-0 right-0 z-[1150] w-full sm:w-96 bg-neutral-950/95 backdrop-blur-md border-l border-white/10 shadow-2xl flex flex-col">
      <header className="px-5 py-4 border-b border-white/10 flex items-start justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">History</p>
          <h2 className="text-base font-semibold text-neutral-100">My Complaints</h2>
          {identity && (
            <p className="text-[11px] text-neutral-500 mt-0.5">
              as <span className="text-neutral-300">{identity.email || `@${identity.handle}`}</span>
            </p>
          )}
        </div>
        <button onClick={onClose} className="text-neutral-500 hover:text-neutral-200"><IconX size={18} /></button>
      </header>

      {identity && complaints.length > 0 && (
        <div className="px-5 pt-3 pb-2 border-b border-white/5">
          <button
            onClick={() => setRepsOpen(true)}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-sky-500 to-indigo-500 hover:from-sky-400 hover:to-indigo-400 text-white text-xs font-semibold py-2.5 shadow-[0_6px_20px_rgba(59,130,246,0.35)]"
          >
            <IconBuildingBank size={14} />
            Report all to my representatives
          </button>
          <p className="text-[10px] text-neutral-500 mt-1.5 text-center">
            City council · county · state · U.S. Congress · governor
          </p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {!identity && (
          <div className="p-5 text-center">
            <p className="text-[12px] text-neutral-400">Set an identity to see your reports.</p>
            <button
              onClick={onSetIdentity}
              className="mt-3 rounded-md bg-sky-500/90 hover:bg-sky-500 text-white text-xs font-medium px-4 py-2"
            >
              Set identity
            </button>
          </div>
        )}
        {identity && status === 'loading' && (
          <p className="p-5 text-[11px] text-neutral-500">Loading…</p>
        )}
        {identity && status === 'error' && (
          <p className="p-5 text-[11px] text-rose-300">Feed unavailable.</p>
        )}
        {identity && status === 'ok' && complaints.length === 0 && sessionReports.length === 0 && (
          <p className="p-5 text-[11px] text-neutral-500">No complaints filed yet.</p>
        )}
        <ul className="divide-y divide-white/5">
          {complaints.map((c) => {
            // Find the matching full report (by tail + close timestamp) to get the saved track.
            const match = reports.find((r) =>
              r.excursion?.tail === c.tail &&
              r.tracks?.length
            )
            const hasTracks = !!match?.tracks?.length
            const isViewing = viewingReport === match
            return (
              <li key={c.id}>
                <button
                  onClick={() => {
                    if (!match) return
                    onViewReport(isViewing ? null : match)
                  }}
                  disabled={!hasTracks}
                  className={[
                    'w-full text-left px-5 py-3 transition-colors',
                    isViewing ? 'bg-sky-400/10' : hasTracks ? 'hover:bg-white/[0.04] cursor-pointer' : '',
                  ].join(' ')}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="h-2 w-2 rounded-full flex-shrink-0"
                        style={{ background: KLASS_COLORS[c.klass] || '#666' }}
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-neutral-100 truncate">
                          {c.tail}
                          {hasTracks && (
                            <span className={`ml-1.5 text-[9px] ${isViewing ? 'text-sky-300' : 'text-neutral-500'}`}>
                              {isViewing ? '(viewing track)' : '(click to view)'}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-neutral-500 truncate">
                          {c.zone || 'unknown zone'} · {formatAgo(Date.parse(c.createdAt))}
                        </div>
                      </div>
                    </div>
                    <div className="text-[9px] font-mono text-neutral-600">#{c.id?.slice(-6)}</div>
                  </div>
                  <StatusPills complaint={c} />
                  {c.notes && (
                    <p className="mt-1.5 text-[10px] text-neutral-500 line-clamp-2">{c.notes}</p>
                  )}
                </button>
              </li>
            )
          })}
          {/* Session-only reports (before identity is set) */}
          {sessionReports.map((sr, idx) => {
            const isViewing = viewingReport === sr
            const isNewest = idx === 0 && Date.now() - Date.parse(sr.createdAt) < 10000
            return (
              <li key={sr.id} className={isNewest ? 'report-new' : ''}>
                <button
                  onClick={() => onViewReport(isViewing ? null : sr)}
                  className={[
                    'w-full text-left px-5 py-3 transition-colors',
                    isViewing ? 'bg-sky-400/10' : 'hover:bg-white/[0.04] cursor-pointer',
                  ].join(' ')}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ background: '#ff8c00' }} />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-neutral-100 truncate">
                          {sr.type || sr.tail || 'Flight report'}
                          <span className={`ml-1.5 text-[9px] ${isViewing ? 'text-sky-300' : 'text-neutral-500'}`}>
                            {isViewing ? '(viewing)' : '(tap to view)'}
                          </span>
                        </div>
                        <div className="text-[10px] text-neutral-500 truncate">
                          {sr.reportedSegments?.length || 0} segment{(sr.reportedSegments?.length || 0) === 1 ? '' : 's'} · {formatAgo(Date.parse(sr.createdAt))}
                        </div>
                      </div>
                    </div>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      {identity && (
        <footer className="border-t border-white/10 p-3 flex items-center gap-2">
          <button
            onClick={onRefresh}
            className="text-[10px] text-sky-300 hover:text-sky-200 underline underline-offset-2"
          >
            Refresh
          </button>
          <div className="flex-1" />
          <button
            onClick={onSetIdentity}
            className="text-[10px] text-neutral-400 hover:text-neutral-200 underline underline-offset-2"
          >
            Change identity
          </button>
        </footer>
      )}

      {repsOpen && (
        <RepsDialog
          airports={airports}
          source={source}
          locality={locality}
          complaints={complaints}
          identity={identity}
          onClose={() => setRepsOpen(false)}
        />
      )}
    </div>
  )
}

function RepsDialog({ airports, source, locality, complaints, identity, onClose }) {
  const reps = useMemo(() => repsForAirports(airports.length ? airports : Object.keys({ KBDU:1,KLMO:1,KEIK:1,KBJC:1,KFNL:1 })), [airports])
  const localityLabel = formatLocality(locality)
  // Start with all email-able reps selected by default. Web-form-only reps
  // are shown in a separate section and can't be auto-sent.
  const [selected, setSelected] = useState(() => {
    const s = new Set()
    for (const r of reps) if (!r.web) s.add(r.id)
    return s
  })

  const emailReps = reps.filter((r) => !r.web)
  const webReps   = reps.filter((r) =>  r.web)

  const tiers = ['city', 'county', 'state', 'federal', 'governor']

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  // Compose the email subject + body from the user's complaints.
  const subject = `Aircraft noise complaints near ${airports.join(', ') || 'our community'}`
  const body = useMemo(() => {
    const lines = []
    lines.push(`I am submitting the following aircraft noise complaints for your awareness and action.`)
    lines.push('')
    if (identity?.email) lines.push(`Reporter: ${identity.email}`)
    else if (identity?.handle) lines.push(`Reporter: @${identity.handle} (anonymous)`)
    lines.push(`Airports affected: ${airports.join(', ') || '—'}`)
    lines.push(`Total complaints: ${complaints.length}`)
    lines.push('')
    lines.push('Complaints:')
    for (const c of complaints) {
      const when = c.createdAt ? new Date(c.createdAt).toLocaleString() : ''
      lines.push(`  • ${c.tail || 'unknown tail'} — ${c.klass || 'unclassified'} — ${c.zone || 'unknown zone'} — ${when}`)
      if (c.notes) lines.push(`      notes: ${c.notes}`)
    }
    lines.push('')
    lines.push('Thank you for your attention to these community noise concerns.')
    return lines.join('\n')
  }, [complaints, airports, identity])

  const pickedEmailReps = emailReps.filter((r) => selected.has(r.id))
  const mailto = buildMailtoForReport({ reps: pickedEmailReps, subject, body })

  return (
    <div className="absolute inset-0 z-[1200] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md max-h-[90vh] bg-neutral-950/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <header className="px-5 py-4 border-b border-white/10 flex items-start justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Escalate</p>
            <h2 className="text-base font-semibold text-neutral-100">Report to representatives</h2>
            <p className="text-[11px] text-neutral-500 mt-0.5">
              {airports.length
                ? `For ${airports.join(', ')}`
                : 'For Front Range airports'}
              {source === 'locality' && localityLabel && ` · based on your location: ${localityLabel}`}
              {source === 'fallback' && ' · no city known — showing all'}
            </p>
          </div>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-200"><IconX size={18} /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {tiers.map((tier) => {
            const tierEmailReps = emailReps.filter((r) => r.tier === tier)
            if (!tierEmailReps.length) return null
            return (
              <section key={tier}>
                <p className="text-[10px] uppercase tracking-[0.15em] text-neutral-500 mb-1.5">{TIER_LABELS[tier]}</p>
                <ul className="space-y-1">
                  {tierEmailReps.map((r) => {
                    const on = selected.has(r.id)
                    return (
                      <li key={r.id}>
                        <button
                          onClick={() => toggle(r.id)}
                          className={[
                            'w-full flex items-center gap-2 rounded-md px-2.5 py-2 text-left border transition-colors',
                            on
                              ? 'border-sky-400/50 bg-sky-400/10'
                              : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.05]',
                          ].join(' ')}
                        >
                          <span
                            className={[
                              'h-4 w-4 rounded border flex items-center justify-center flex-shrink-0',
                              on ? 'bg-sky-400 border-sky-300' : 'border-white/20',
                            ].join(' ')}
                          >
                            {on && <IconCheck size={10} stroke={3} className="text-white" />}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="text-[12px] text-neutral-100 truncate">{r.name}</div>
                            <div className="text-[10px] text-neutral-500 truncate">{r.role} · {r.email}</div>
                          </div>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}

          {webReps.length > 0 && (
            <section>
              <p className="text-[10px] uppercase tracking-[0.15em] text-neutral-500 mb-1.5">Web-form contacts</p>
              <p className="text-[10px] text-neutral-500 mb-2">
                These offices only accept messages through a form. Open each and paste the draft below.
              </p>
              <ul className="space-y-1">
                {webReps.map((r) => (
                  <li key={r.id}>
                    <a
                      href={r.email}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 rounded-md px-2.5 py-2 border border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"
                    >
                      <IconExternalLink size={12} className="text-sky-300 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] text-neutral-100 truncate">{r.name}</div>
                        <div className="text-[10px] text-neutral-500 truncate">{r.role}</div>
                      </div>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <details className="rounded-md border border-white/10 bg-white/[0.02] px-3 py-2">
            <summary className="text-[11px] text-neutral-300 cursor-pointer">Preview draft</summary>
            <div className="mt-2 text-[10px] text-neutral-400 whitespace-pre-wrap font-mono max-h-60 overflow-y-auto">
              <div className="text-neutral-500">Subject: {subject}</div>
              <div className="mt-1">{body}</div>
            </div>
          </details>
        </div>

        <footer className="border-t border-white/10 p-3 flex items-center gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-white/10 bg-white/[0.03] hover:bg-white/[0.07] px-4 py-1.5 text-xs text-neutral-300"
          >
            Cancel
          </button>
          <div className="flex-1" />
          <a
            href={mailto || '#'}
            onClick={(e) => { if (!mailto) e.preventDefault() }}
            aria-disabled={!mailto}
            className={[
              'flex items-center gap-2 rounded-md px-4 py-1.5 text-xs font-semibold transition-colors',
              mailto ? 'bg-sky-500 hover:bg-sky-400 text-white' : 'bg-white/10 text-neutral-500 cursor-not-allowed',
            ].join(' ')}
          >
            <IconSend size={13} />
            Compose email
            {pickedEmailReps.length > 0 && (
              <span className="text-[10px] opacity-80">({pickedEmailReps.length})</span>
            )}
          </a>
        </footer>
      </div>
    </div>
  )
}

function StatusPills({ complaint }) {
  // Optimistic rendering for status fields the server doesn't emit yet.
  // Any missing field renders as "pending".
  const items = [
    { key: 'operatorNotified', label: 'Operator informed', have: !!complaint.operatorNotified },
    { key: 'pilotNotified',    label: 'Pilot informed',    have: !!complaint.pilotNotified },
    { key: 'pilotAck',         label: 'Pilot acknowledged', have: complaint.pilotAction?.status === 'acknowledged' || complaint.pilotAction?.status === 'reviewed' || complaint.pilotAction?.status === 'completed' },
    { key: 'pilotReviewed',    label: 'Flight reviewed',    have: complaint.pilotAction?.status === 'reviewed' || complaint.pilotAction?.status === 'completed' },
  ]
  return (
    <ul className="mt-2 flex flex-wrap gap-1">
      {items.map((it) => (
        <li
          key={it.key}
          className={[
            'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px]',
            it.have
              ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
              : 'border-white/10 bg-white/[0.02] text-neutral-500',
          ].join(' ')}
        >
          {it.have ? <IconCheck size={9} stroke={3} /> : <IconClock size={9} />}
          {it.label}
        </li>
      ))}
    </ul>
  )
}

function Row({ label, value, sub }) {
  return (
    <div className="flex justify-between items-start gap-3">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-right">
        <div className="text-neutral-100">{value}</div>
        {sub && <div className="text-[10px] text-neutral-500">{sub}</div>}
      </dd>
    </div>
  )
}
