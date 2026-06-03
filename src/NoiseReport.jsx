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
  postReportAudio,
  reportAudioUrl,
  fetchNoiseZones,
  KLASS_COLORS,
} from './noiseApi'
import { repsForAirports, TIER_LABELS, buildMailtoForReport, airportsForLocality, formatLocality } from './noiseReps'
import { computeNoiseRaster } from './noiseRaster'
import { loadTerrain } from './terrain'

const IDENTITY_KEY = 'noise-studio-identity'
// Normalize so " Jane@Example.com " and "jane@example.com" resolve to the
// same reporter key — the API does strict equality, no case-folding or
// trimming server-side.
function normalizeIdentity(id) {
  if (!id) return null
  const out = { ...id }
  if (out.email) out.email = String(out.email).trim().toLowerCase()
  if (out.handle) out.handle = String(out.handle).trim()
  return out
}
function loadIdentity() {
  try { return normalizeIdentity(JSON.parse(localStorage.getItem(IDENTITY_KEY) || 'null')) } catch { return null }
}
function saveIdentity(id) {
  const norm = normalizeIdentity(id)
  try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(norm)) } catch {}
}
function clearIdentity() {
  try { localStorage.removeItem(IDENTITY_KEY) } catch {}
}
/** reporter string used for both POSTs and the /api/complaints filter */
function reporterOf(id) {
  const norm = normalizeIdentity(id)
  if (!norm) return null
  if (norm.kind === 'email') return norm.email || null
  if (norm.kind === 'anonymous') return `anon:${norm.handle}`
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
  PA25: 'Piper PA-25 Pawnee',
  PA18: 'Piper PA-18 Super Cub',
  HUSK: 'Aviat Husky',
  PIAT: 'Pilatus PC-6 Porter',
  PC6:  'Pilatus PC-6 Porter',
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
  AS50: 'Eurocopter AS350 Écureuil helicopter',
  R22:  'Robinson R22 helicopter',
  R44:  'Robinson R44 helicopter',
  R66:  'Robinson R66 helicopter',
  B06:  'Bell 206 JetRanger helicopter',
  B407: 'Bell 407 helicopter',
  H500: 'Hughes MD 500 helicopter',
  EC30: 'Eurocopter EC130 helicopter',
  EC35: 'Eurocopter EC135 helicopter',
  EC45: 'Eurocopter EC145 helicopter',
  C30J: 'Lockheed Martin C-130J Super Hercules',
  C130: 'Lockheed C-130 Hercules',
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

/**
 * Build a 16-bit PCM WAV Blob from an Int16Array of mono samples at sampleRate.
 * Standard RIFF/WAVE header. Plays in <audio> and most servers will accept it
 * even when the documented Content-Type is audio/mpeg (the noise/web API
 * stores raw bytes in the noise_audio table — mime is for playback).
 */
function buildWav(int16, sampleRate) {
  const bytesPerSample = 2
  const dataLen = int16.length * bytesPerSample
  const buf = new ArrayBuffer(44 + dataLen)
  const view = new DataView(buf)
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataLen, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)        // PCM fmt chunk size
  view.setUint16(20, 1, true)          // PCM format
  view.setUint16(22, 1, true)          // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataLen, true)
  // Copy PCM samples little-endian
  for (let i = 0; i < int16.length; i++) view.setInt16(44 + i * bytesPerSample, int16[i], true)
  return new Blob([buf], { type: 'audio/wav' })
}

/**
 * Read the last `seconds` of audio from a PCM ring buffer ending at `endPos`.
 * Returns an Int16Array of `seconds * sampleRate` samples.
 */
function readPcmTail(ring, ringSize, sampleRate, endPos, seconds) {
  const samples = Math.min(Math.floor(seconds * sampleRate), ringSize)
  const out = new Int16Array(samples)
  // ring is filled at endPos's modular position; read backwards.
  const startPos = endPos - samples
  for (let i = 0; i < samples; i++) {
    const idx = (startPos + i) % ringSize
    out[i] = ring[idx < 0 ? idx + ringSize : idx]
  }
  return out
}

/**
 * Build the spliced-10s file: 25 windows of 100 ms separated by 300 ms of
 * silence over a 10-second timeline. Total runtime ≈ 10 s, of which 2.5 s
 * is real audio and 7.5 s is silence padding (preserves original timing).
 * Sourced from the last 10 sec of the PCM ring.
 */
function buildSplicedWav(ring, ringSize, sampleRate, endPos) {
  const SLICE_MS = 100, GAP_MS = 300, TOTAL_MS = 10000
  const stride = SLICE_MS + GAP_MS // 400 ms
  const slicesCount = Math.floor(TOTAL_MS / stride) // 25
  const sliceLen = Math.floor((SLICE_MS / 1000) * sampleRate)
  const gapLen = Math.floor((GAP_MS / 1000) * sampleRate)
  const totalLen = slicesCount * (sliceLen + gapLen)
  const out = new Int16Array(totalLen)
  // Pull a 10-sec PCM tail, then pick 100-ms windows every 400 ms.
  const window = readPcmTail(ring, ringSize, sampleRate, endPos, TOTAL_MS / 1000)
  for (let s = 0; s < slicesCount; s++) {
    const srcOffset = s * stride * (sampleRate / 1000)
    const dstOffset = s * (sliceLen + gapLen)
    for (let i = 0; i < sliceLen; i++) {
      out[dstOffset + i] = window[Math.min(window.length - 1, srcOffset + i)] | 0
    }
    // Gap stays zero-filled (silence)
  }
  return buildWav(out, sampleRate)
}

// ICAO aircraft type designator → human description. Only the common types
// seen at front-range GA airports; falls back to the raw code if not listed.
const TYPE_LABELS = {
  C152: 'Cessna 152',  C162: 'Cessna SkyCatcher',
  C172: 'Cessna 172 Skyhawk', C175: 'Cessna 175', C177: 'Cessna 177 Cardinal',
  C180: 'Cessna 180',  C182: 'Cessna 182 Skylane', C185: 'Cessna 185',
  C206: 'Cessna 206 Stationair', C208: 'Cessna 208 Caravan', C210: 'Cessna 210',
  P28A: 'Piper PA-28 Cherokee', P28B: 'Piper Cherokee 180', P28R: 'Piper Arrow',
  PA22: 'Piper PA-22 Tri-Pacer', PA24: 'Piper PA-24 Comanche',
  PA25: 'Piper PA-25 Pawnee (glider tow / ag)',
  PA32: 'Piper Saratoga', PA46: 'Piper Malibu/Meridian', PA34: 'Piper Seneca',
  PA36: 'Piper PA-36 Pawnee Brave (ag)', PA38: 'Piper Tomahawk',
  PA44: 'Piper Seminole',
  PC12: 'Pilatus PC-12 (turboprop)',
  BE33: 'Beech Debonair', BE35: 'Beech Bonanza', BE36: 'Beech Bonanza A36',
  BE55: 'Beech Baron 55', BE58: 'Beech Baron 58', BE76: 'Beech Duchess',
  DA40: 'Diamond DA40', DA42: 'Diamond DA42 Twinstar', DA20: 'Diamond DA20',
  M20P: 'Mooney M20', M20T: 'Mooney M20 Turbo',
  SR20: 'Cirrus SR20',  SR22: 'Cirrus SR22',
  C25A: 'Cessna Citation CJ2',  C25B: 'Cessna Citation CJ3', C25C: 'Cessna Citation CJ4',
  E55P: 'Embraer Phenom 100',  E50P: 'Embraer Phenom 300',
  TBM7: 'TBM 700', TBM8: 'TBM 850/930', TBM9: 'TBM 940',
  AS21: 'ASW-21 sailplane', AS26: 'ASW-26 sailplane', AS31: 'ASW-31 sailplane',
  DG10: 'DG-100 sailplane', DG15: 'DG-1000 sailplane',
  DISC: 'Discus sailplane', VENT: 'Ventus sailplane', NIMB: 'Nimbus sailplane',
  GLID: 'glider', UHEL: 'helicopter',
  R22:  'Robinson R22', R44: 'Robinson R44', R66: 'Robinson R66',
  B06:  'Bell 206 JetRanger', AS50: 'AS-350 Squirrel',
  B737: 'Boeing 737',  B738: 'Boeing 737-800', A320: 'Airbus A320',
  BL8:  'American Champion 8KCAB',
}

// Flight-purpose code → human-readable label. The /flight-ops endpoint uses
// short codes (ga_single, airline, etc.); we surface friendly names. Special-
// use aircraft (medevac, firefighting, military, government) are now
// classified server-side via /public/special_use_aircraft.json.
const PURPOSE_LABELS = {
  ga_single:    'general aviation',
  ga_multi:     'twin GA',
  ga_turbine:   'turbine GA',
  airline:      'airliner',
  cargo:        'cargo',
  medevac:      'medical / EMS',
  military:     'military',
  government:   'government',
  law_enforcement: 'law enforcement',
  training:     'flight training',
  helicopter:   'helicopter',
  turboprop:    'turboprop',
  glider:       'glider',
  ag:           'agricultural',
  agriculture:  'agricultural',
  fire:         'firefighting',
  firefighting: 'firefighting',
  sar:          'search & rescue',
  search_rescue:'search & rescue',
  business:     'business',
  unknown:      'unknown',
}

// Intent code → friendly verb form. /flight-ops returns things like
// "to_practice", "practicing", "pattern", "inbound", "transit", "returning".
const INTENT_LABELS = {
  to_practice:   'departing for practice',
  practicing:    'practicing',
  pattern:       'in the pattern',
  inbound:       'inbound',
  outbound:      'outbound',
  transit:       'transiting',
  returning:     'returning',
  approach:      'on approach',
  departure:     'departing',
}

const labelType = (code) => TYPE_LABELS[code] || code || 'unknown'

// Aircraft types we should NEVER report for noise — unpowered sailplanes
// only generate airframe noise (no engine), so a noise complaint against
// one is nonsense. Includes both ICAO codes and the human-readable names
// some endpoints return so the predicate works regardless of source.
const SAILPLANE_TYPES = new Set([
  'GLID', 'AS20', 'AS21', 'AS26', 'AS31', 'AS33', 'AS34',
  'DG10', 'DG15', 'DG30', 'DG40', 'DG80', 'DG1T',
  'DISC', 'VENT', 'NIMB', 'JS1J', 'ASTR', 'ASK21', 'ASK13',
  'PIK20', 'LS3', 'LS4', 'LS6', 'LS8', 'JANS', 'STDC',
  'GROB', 'G103', 'G104', 'G102',
  'glider', 'sailplane',
])
const isSailplane = (type) => {
  if (!type) return false
  if (SAILPLANE_TYPES.has(type)) return true
  const lower = String(type).toLowerCase()
  return lower.includes('glider') || lower.includes('sailplane')
}
const labelPurpose = (code) => PURPOSE_LABELS[code] || code || null
const labelIntent = (code) => INTENT_LABELS[code] || code || null

/**
 * Global crash diagnostics. Safari (esp. iOS) sometimes kills the tab
 * with no React error boundary trace because the failure was in an async
 * chain or memory pressure; we stash the most-recent uncaught error and
 * unhandledrejection in localStorage so the next page load can surface it.
 */
if (typeof window !== 'undefined' && !window.__noiseReportCrashHook) {
  window.__noiseReportCrashHook = true
  const log = (kind, ...args) => {
    try {
      const msg = args.map((a) => a?.stack || a?.message || String(a)).join(' | ')
      const entry = `${new Date().toISOString()} [${kind}] ${msg}`.slice(0, 4000)
      localStorage.setItem('noise-report-crash', entry)
      console.error(entry)
    } catch {}
  }
  window.addEventListener('error', (e) => log('error', e.error || e.message))
  window.addEventListener('unhandledrejection', (e) => log('unhandledrejection', e.reason))
}

/* ─── Main page ───────────────────────────────────────────────────────────── */
export function NoiseStudio() {
  // Map refs
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const areaRef = useRef(null)
  const tracesRef = useRef([])
  const nearbyTracesRef = useRef([])

  // Location — supports URL overrides for testing:
  //   ?loc=39.91,-105.12     explicit lat,lng
  //   ?loc=KBJC              named airport (uses DFAID_AIRPORTS lookup)
  // When set, geolocation + IP-fallback are bypassed entirely.
  const locOverride = (() => {
    if (typeof window === 'undefined') return null
    const m = new URL(window.location.href).searchParams.get('loc')
    if (!m) return null
    if (/^[A-Z]{4}$/.test(m) && DFAID_AIRPORTS[m]) {
      const ap = DFAID_AIRPORTS[m]
      return { lat: ap.lat, lng: ap.lng, accuracy: 0, source: `override:${m}`, cityLabel: ap.name }
    }
    const parts = m.split(',').map(Number)
    if (parts.length === 2 && parts.every(Number.isFinite)) {
      return { lat: parts[0], lng: parts[1], accuracy: 0, source: 'override:coords' }
    }
    return null
  })()
  const [rawCoords, setRawCoords] = useState(locOverride)
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

  const addReportSegment = (seg, opts = {}) => {
    // Clip segment points to ~1 mile (1609m) around nearestPt
    const clipped = clipSegmentNearPoint(seg.points, seg.nearestPt, 1609)
    const entry = { ...seg, points: clipped, auto: !!opts.auto }
    setReportSegments((prev) => {
      // For auto-selections, replace any prior auto entry — there is only
      // one "current loudest aircraft". Manual entries are preserved.
      const filtered = opts.auto ? prev.filter((s) => !s.auto) : prev
      const key = `${entry.tail}:${entry.nearestPt?.[0]},${entry.nearestPt?.[1]}`
      if (filtered.some((s) => `${s.tail}:${s.nearestPt?.[0]},${s.nearestPt?.[1]}` === key)) return filtered
      return [...filtered, entry]
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

  // Continuous dB meter (runs while Capture step is open)
  const METER_BANDS = [
    { label: 'Low',    lo: 50,   hi: 200 },
    { label: 'Lo-Mid', lo: 200,  hi: 500 },
    { label: 'Mid',    lo: 500,  hi: 1500 },
    { label: 'Hi-Mid', lo: 1500, hi: 4000 },
    { label: 'High',   lo: 4000, hi: 8000 },
  ]
  const [meter, setMeter] = useState({
    live: null,                 // current overall dBFS (raw, unweighted)
    liveDba: null,              // current A-weighted level (dBFS_A)
    bands: [0, 0, 0, 0, 0],     // live per-band dBFS
    bandsDba: [null, null, null, null, null],          // live per-band dBFS_A
    sustained: [0, 0, 0, 0, 0], // 5-sec min per band (excludes spikes)
    sustainedBandsDba: [null, null, null, null, null], // 5-sec min per band, A-weighted
    overallSustained: null,     // max of sustained bands
    sustainedDba: null,         // 5-sec min of A-weighted overall
    dominantHz: null,           // peak frequency bin (A-weighted)
    dominantSustainedHz: null,  // 5-sec smoothed dominant frequency
    floorDba: null,             // lowest sustained dBA seen (ambient floor)
    peakClipDb: -Infinity,
    peakClipChunks: null,       // MediaRecorder chunks at the moment of peak
    peakClipMime: null,         // mime type of the chunks
  })
  // dBFS_A → dBA SPL. Fixed offset assuming 0 dBFS ≈ 94 dB SPL
  // (1 Pa @ 1 kHz reference). Uncalibrated consumer mic — best-effort.
  // Independent reference checks consistently read higher than the raw
  // calculation, so we apply a 1.35× scale on the final SPL value.
  const SPL_OFFSET = 94
  const SPL_GAIN = 1.5
  const toSpl = (dbfsA) => dbfsA == null ? null : (dbfsA + SPL_OFFSET) * SPL_GAIN
  const meterStreamRef = useRef(null)
  const meterCtxRef = useRef(null)
  const meterTimerRef = useRef(null)
  const meterBandHistoryRef = useRef([[], [], [], [], []])
  const meterBandDbaHistoryRef = useRef([[], [], [], [], []])
  const meterRecRef = useRef(null)
  const meterChunksRef = useRef([])
  const meterPcmRef = useRef(null) // { ring, ringSize, sampleRate, getPos }
  const [meterStarted, setMeterStarted] = useState(false)
  const [meterError, setMeterError] = useState(null)
  const [meterDevices, setMeterDevices] = useState([])
  const [meterDeviceId, setMeterDeviceId] = useState(null)
  const [meterNoSignal, setMeterNoSignal] = useState(false) // true if 2+ sec of silence
  const meterMaxLiveRef = useRef(-100)
  const meterStartedAtRef = useRef(0)
  const meterTriedRef = useRef(new Set()) // device ids already tried in auto-cycle
  const [meterMicInfo, setMeterMicInfo] = useState(null) // { label, deviceId, sampleRate, agc, ec, ns }

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
  // Local audio object URLs keyed by report id (or local-…). Lets the
  // saved-report panel play back the audio immediately, before the server
  // confirms the report or finishes ingesting the upload.
  const [localAudioById, setLocalAudioById] = useState({})
  const sessionAudioBlobsRef = useRef(null) // { peakBlob, splicedBlob } built before POST

  // Auto-Report — when on, fires submitReport() once an aircraft has
  // departed the 4 nm circle. State persists across refreshes / code
  // changes / re-visits via localStorage so the user doesn't have to
  // re-arm it every session.
  const AUTO_REPORT_KEY = 'noise-studio-auto-report'
  const [autoReport, setAutoReport] = useState(() => {
    try { return localStorage.getItem(AUTO_REPORT_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(AUTO_REPORT_KEY, autoReport ? '1' : '0') } catch {}
  }, [autoReport])
  const lastAutoReportRef = useRef(0) // ms — last time auto-fire ran
  const submitSourceRef = useRef('manual') // 'manual' | 'auto' — read by submitReport for the meta flag
  // 1-Hz tick used to re-render the countdown text in the auto-report toggle.
  const [autoTick, setAutoTick] = useState(0)
  useEffect(() => {
    if (!autoReport) return
    const id = setInterval(() => setAutoTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [autoReport])
  // Window peak dBA — resets each time auto-report fires.
  const [windowPeakDba, setWindowPeakDba] = useState(null)
  // Per-aircraft departure tracker. Map<tail, { minDistM, segPoint, seg, type, ... }>
  // An aircraft enters when it's within AUTO_RADIUS_M of the user; it leaves
  // (and triggers an auto-report) when its current distance exceeds its
  // window-min by AUTO_DEPARTURE_BUFFER_M, or when it leaves the radius.
  const departureTrackerRef = useRef(new Map())
  // Last auto-fire timestamp per tail — drives both the 2-min cooldown
  // and the 5-min dedup window so circling aircraft don't spam reports.
  const lastFireByTailRef = useRef(new Map())
  // True when ≥1 aircraft is currently being tracked (inside the 4 nm
  // circle). Drives the breathing/pulse UI on the Auto-Report toggle.
  const [autoActive, setAutoActive] = useState(false)
  // Set of tails currently being tracked — every one gets the icon pulse.
  const [trackedTails, setTrackedTails] = useState(() => new Set())
  // Distance of the most recent submitted aircraft, so the button re-enables
  // when a NEW aircraft comes closer than the last reported one.
  const lastReportedDistRef = useRef(Infinity)

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
    if (locOverride) return // ?loc=… bypasses
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
    // Per-poll boot/draw logs were noisy on Android — silenced.
    if (perfMode) perfRef.current.boot++
    setActiveStatus((prev) => prev === 'ok' ? 'ok' : 'loading')
    try {
      // Boot's `active` subset is currently always empty server-side, so we
      // pull active excursions from the dedicated /active endpoint in parallel.
      const [data, activeData] = await Promise.all([
        fetchBoot({ hours: 1, limit: 100, include: 'reports,notifications', signal }),
        fetchActiveExcursions({ hours: 1, signal }).catch(() => ({ active: [] })),
      ])
      if (signal?.aborted) return

      // Single window constant — nothing older than this appears anywhere
      const MAX_AGE_MS = 30 * 60 * 1000 // 30 minutes
      const now = Date.now()
      const cutoff = now - MAX_AGE_MS

      // Active excursions — filter to 30 min by lastSeenMs
      const active = (activeData?.active || data.active || [])
        .filter((a) => a.lastSeenMs && a.lastSeenMs >= cutoff)
        .sort((a, b) => (b.lastSeenMs || 0) - (a.lastSeenMs || 0))
      setActiveList(active)
      setActiveStatus('ok')

      // Tracks: API returns runs as `bands`; renderer expects `segments`.
      // Trim points to 30 min when timestamps are present (`p[3]` ms),
      // otherwise keep them (server already windowed by `hours`).
      const MAX_PTS = 500
      const tracks = (data.tracks || [])
        .map((t) => ({
          ...t,
          // API returns `call` (call sign); the renderer keys everything off `tail`.
          tail: t.tail || t.call || t.hex || null,
          segments: (t.segments || t.bands || []).map((s) => {
            if (!s.points) return s
            const trimmed = s.points.filter((p) =>
              typeof p[3] !== 'number' || p[3] >= cutoff
            )
            if (trimmed.length > MAX_PTS) {
              const step = Math.ceil(trimmed.length / MAX_PTS)
              return { ...s, points: trimmed.filter((_, i) => i % step === 0 || i === trimmed.length - 1) }
            }
            return { ...s, points: trimmed }
          }).filter((s) => s.points.length >= 2),
        }))
        .filter((t) => t.segments.length > 0)
      // boot-complete log silenced
      setNearbyTracks(tracks)
    } catch (err) {
      if (err.name === 'AbortError') return
      console.error('[noise-report] boot failed:', err.message)
      setActiveStatus('error')
    }
  }
  // Performance diagnostic — enabled via ?perf=1 in the URL. Counts work
  // by subsystem so you can see exactly what's churning without opening
  // DevTools. Renders a small overlay on the bottom-right.
  const perfMode = typeof window !== 'undefined' && /[?&]perf=1\b/.test(window.location.search)
  const perfRef = useRef({
    rafFrames: 0, rafFps: 0, rafLongFrames: 0,
    audio: 0, boot: 0, heat: 0, draws: 0,
    // displayed values (snapshot once per second)
    rafFpsDisp: 0, rafLongDisp: 0,
    audioDisp: 0, bootDisp: 0, heatDisp: 0, drawsDisp: 0,
    lastSec: Math.floor(Date.now() / 1000),
  })
  const [perfTick, setPerfTick] = useState(0)
  useEffect(() => {
    if (!perfMode) return
    const id = setInterval(() => {
      const p = perfRef.current
      const now = Math.floor(Date.now() / 1000)
      if (now > p.lastSec) {
        // Snapshot all counters into "Disp" fields, then zero the live counters.
        p.rafFpsDisp   = p.rafFrames
        p.rafLongDisp  = p.rafLongFrames
        p.audioDisp    = p.audio
        p.bootDisp     = p.boot
        p.heatDisp     = p.heat
        p.drawsDisp    = p.draws
        p.rafFrames = 0
        p.rafLongFrames = 0
        p.audio = 0
        p.boot = 0
        p.heat = 0
        p.draws = 0
        p.lastSec = now
        setPerfTick((t) => t + 1)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [perfMode])

  // Staged load — declared here so every later effect can reference it.
  // 0=shell only, 1=map, 2=audio tools, 3=data fetches. Each stage gets
  // a frame to paint before the next begins.
  const [loadPhase, setLoadPhase] = useState(0)
  useEffect(() => {
    const t1 = setTimeout(() => setLoadPhase(1), 50)
    const t2 = setTimeout(() => setLoadPhase(2), 300)
    const t3 = setTimeout(() => setLoadPhase(3), 600)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [])

  useEffect(() => {
    if (loadPhase < 3) return // staged: defer until after shell/map/audio paint
    const ctrl = new AbortController()
    loadBoot(ctrl.signal)
    return () => { ctrl.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPhase])

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
    if (loadPhase < 3) return
    // Defer the past-reports fetch by another 1.5 s after data phase
    // begins. The boot/heatmap/etc. take precedence — past reports only
    // matter when the user opens the My Reports panel.
    const t = setTimeout(() => loadMyComplaints(), 1500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPhase, identity?.kind, identity?.handle, identity?.email])

  /* ── Fetch Wikipedia thumbnails for every aircraft type we'll draw an
     icon for, sequentially (not parallel, to be polite to Wikipedia and
     save memory). Was keyed off activeList only — most aircraft never
     got their photos because they weren't in the excursion list. */
  useEffect(() => {
    const ctrl = new AbortController()
    const types = new Set()
    for (const a of activeList || []) if (a.type) types.add(a.type)
    for (const t of nearbyTracks || []) if (t.type) types.add(t.type)
    const wanted = [...types].filter((t) => t && t !== 'Unknown' && !(t in typePhotos))
    if (!wanted.length) return
    ;(async () => {
      for (const t of wanted) {
        if (ctrl.signal.aborted) return
        const url = await fetchAircraftPhoto(t, { signal: ctrl.signal })
        if (ctrl.signal.aborted) return
        setTypePhotos((prev) => ({ ...prev, [t]: url }))
      }
    })()
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeList, nearbyTracks])

  /* ── segmentsByTail: derived from nearbyTracks (no extra fetches) ─ */
  useEffect(() => {
    // Build segmentsByTail from nearbyTracks so the excursion list
    // can highlight tails that are in the active list. No per-tail API
    // calls — the nearby endpoint already returns everything we need.
    const map = {}
    for (const track of nearbyTracks) {
      const inActive = activeList.some((a) => a.tail === track.tail)
      // Wrap in { tracks: [...] } to match the shape downstream consumers
      // (distanceByTail, closest-segment effect, etc.) expect.
      if (inActive) map[track.tail] = { tracks: [track] }
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

  /* ── Auto-request location after a delay so the map renders first.
     iOS Safari refuses the prompt unless it comes from a user gesture,
     so we ALSO listen for the first click/touch on the page and try
     again from that gesture context. */
  useEffect(() => {
    if (locOverride) return // ?loc=… bypasses both geolocation + IP fallback
    let firedFromGesture = false
    const tryFromGesture = () => {
      if (firedFromGesture) return
      if (rawCoords) return
      firedFromGesture = true
      requestLocation()
    }
    const timer = setTimeout(async () => {
      let state = 'prompt'
      try {
        if (navigator.permissions?.query) {
          const r = await navigator.permissions.query({ name: 'geolocation' })
          state = r.state
        }
      } catch {}
      if (state !== 'denied') requestLocation()
    }, 2000)
    document.addEventListener('click', tryFromGesture, { once: false, passive: true })
    document.addEventListener('touchstart', tryFromGesture, { once: false, passive: true })
    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', tryFromGesture)
      document.removeEventListener('touchstart', tryFromGesture)
    }
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
      map.getPane('selectedSegments').style.zIndex = 450
    }
    for (const seg of reportSegments) {
      if (!seg.points || seg.points.length < 2) continue
      const latlngs = seg.points.map((p) => [p[0], p[1]])
      // Color by role:
      //   • 'closest' (nearest segment to user) → cyan
      //   • 'excursion' (worst excursive segment) → orange (its klass color is used by the underlying polyline; this overlay calls out user-reported)
      //   • auto-fired → dashed sky-blue
      //   • default manually-tapped → solid orange
      const colors = seg.role === 'closest'
        ? { glow: '#22d3ee', stroke: '#22d3ee' }
        : seg.auto
          ? { glow: '#38bdf8', stroke: '#38bdf8' }
          : { glow: '#ff8c00', stroke: '#ff8c00' }
      const glow = L.polyline(latlngs, {
        color: colors.glow, weight: 14, opacity: 0.25,
        lineCap: 'round', lineJoin: 'round',
        pane: 'selectedSegments', interactive: false,
        dashArray: seg.auto ? '6 8' : null,
      }).addTo(map)
      const line = L.polyline(latlngs, {
        color: colors.stroke, weight: 7, opacity: 1,
        lineCap: 'round', lineJoin: 'round',
        pane: 'selectedSegments', interactive: false,
        dashArray: seg.auto ? '6 8' : null,
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
      map.getPane('selectedSegments').style.zIndex = 450
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

  /* ── Incremental track drawing ────────────────────────────────────
     Each poll arrives with the same long history per tail. We keep what's
     already on the map and only append the points that are new since last
     time (identified by lat/lng of the previously-last drawn point).
     We also animate the aircraft icon along the new segment over the
     poll interval so motion follows the path being drawn.            */
  const drawnTracksRef = useRef(new Map()) // tail → { lastLatLng, polylines: [], hits: [] }
  const iconAnimRef = useRef(new Map()) // tail → rAF id (for cancellation)
  const flightPathsRendererRef = useRef(null) // shared L.canvas renderer for flight paths
  const POLL_MS = 10_000
  const PATH_FADE_MS = 30 * 60 * 1000 // 30 minutes — full fade
  const ageOpacity = (lastMs) => {
    if (!lastMs) return 0.95
    const age = Date.now() - lastMs
    return Math.max(0, Math.min(1, 1 - age / PATH_FADE_MS))
  }
  useEffect(() => {
    // draw-effect log silenced
    if (perfMode) perfRef.current.draws++
    try {
      const L = window.L
      const map = mapRef.current
      if (!L || !map) return
      // Bail out if the poll returned nothing — otherwise the cleanup-by-
      // seenTails block at the bottom would wipe every previously-drawn
      // path. A transient empty poll should leave the prior render intact.
      if (!nearbyTracks.length) return

      const seenTails = new Set()
      const samePt = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6
      // Dedicated pane between the heatmap (350) and selected highlights (450).
      // pointer-events: none lets clicks/hover fall through the canvas-rendered
      // polylines to the SVG hit polyline on the default overlayPane below.
      if (!map.getPane('flightPaths')) {
        map.createPane('flightPaths')
        map.getPane('flightPaths').style.zIndex = 410
        map.getPane('flightPaths').style.pointerEvents = 'none'
      }
      // Shared Canvas renderer — flight paths are drawn into a single
      // canvas bitmap rather than one SVG <path> per polyline. With ~40
      // tracks × ~60 pairs each that's an order-of-magnitude DOM cost
      // reduction; the rAF tick can update setLatLngs without paying
      // SVG layout/repaint per call.
      if (!flightPathsRendererRef.current) {
        flightPathsRendererRef.current = L.canvas({ pane: 'flightPaths', padding: 0.2 })
      }
      const flightCanvas = flightPathsRendererRef.current

      let trackStats = []
      for (const track of nearbyTracks) {
        try {
        seenTails.add(track.tail)
        // Always full redraw — but DON'T wipe the old polylines until we
        // know the new poll actually has enough data to redraw. If the
        // boot endpoint returned a short or empty path for this aircraft
        // this tick, leave the prior render in place until next tick.
        const prior = drawnTracksRef.current.get(track.tail) || { lastLatLng: null, polylines: [], hits: [] }
        const polylinesBefore = 0

        // Flatten segments → { latlng, klass, ts } in chronological order.
        const flat = []
        for (const seg of track.segments || []) {
          if (!seg.points?.length) continue
          for (const p of seg.points) flat.push({ latlng: [p[0], p[1]], klass: seg.klass || null, ts: typeof p[3] === 'number' ? p[3] : null })
        }
        if (flat.length < 2) continue

        // We always full-redraw now: clear prior.lastLatLng so the snap-
        // draw branch below runs unconditionally and wipes-then-redraws.
        prior.lastLatLng = null
        const startIdx = 0
        const newPts = flat.slice(startIdx)

        // First time seeing this tail OR full redraw: wipe the prior
        // polylines NOW that we know we have ≥2 points to draw from.
        if (!prior.lastLatLng) {
          for (const p of prior.polylines) if (p) p.remove()
          for (const p of prior.hits) if (p) p.remove()
          prior.polylines = []
          prior.hits = []
          // Every pair is potentially animated: the global rAF below uses
          // a wall-clock playbackTs = now() − 5 s and walks each tail's
          // pair list, drawing pairs in three states based on that
          // timestamp:
          //   • a.ts ≥ playbackTs → just [a] (icon hasn't reached it yet)
          //   • b.ts ≤ playbackTs → full [a, b] (already passed)
          //   • a.ts < playbackTs < b.ts → [a, lerp(a,b)] (active leading edge)
          // Each pair caches its last state so we only call setLatLngs
          // when its category actually changes — the rAF only does real
          // work for at most one "active" pair per tail per frame.
          prior.pairs = []
          for (let p = 0; p < flat.length - 1; p++) {
            const a = flat[p], b = flat[p + 1]
            const klass = b.klass || a.klass
            const reported = isSegReported(track.tail, a.latlng)
            const isExcursion = !!klass
            const color = reported ? '#38bdf8' : isExcursion ? (KLASS_COLORS[klass] || '#aaa') : '#f5f5f5'
            const weight = isExcursion ? 5 : 4
            const lastMs = Math.max(a.ts || 0, b.ts || 0)
            const baseOp = reported ? 0.9 : 1.0
            const opacity = baseOp * ageOpacity(lastMs)
            // Start empty — rAF will set to full almost immediately for
            // any pair whose b.ts is already older than playbackTs.
            const line = L.polyline([a.latlng], {
              color, weight, opacity,
              lineCap: 'butt', lineJoin: 'miter',
              className: 'flight-trace',
              pane: 'flightPaths',
              renderer: flightCanvas, // Canvas renderer (no SVG node per pair)
              interactive: false,     // events pass through to the SVG hit polyline
            }).addTo(map)
            line._lastMs = lastMs
            line._baseOp = baseOp
            prior.polylines.push(line)
            prior.pairs.push({ line, a, b, state: 'init' })
          }
          // One full-path hit polyline so hover/click feels like a single track.
          // Carry each point's timestamp into hoverPoints[i][3] so the hover
          // tooltip can show "Nm ago" for the exact segment under the cursor.
          const allLatLngs = flat.map((p) => p.latlng)
          const hoverPoints = flat.map((p) => [p.latlng[0], p.latlng[1], null, p.ts ?? null])
          const lastTs = flat[flat.length - 1]?.ts ?? null
          const { showHover, hideHover, clickSelect } = makeHoverHandlers(track.tail, lastTs, { klass: null, zone: null, points: hoverPoints, type: track.type || '' })
          const hit = L.polyline(allLatLngs, { color: '#fff', weight: 24, opacity: 0, interactive: true }).addTo(map)
          hit.on('mouseover', showHover); hit.on('mouseout', hideHover); hit.on('click', clickSelect)
          prior.hits.push(hit)
          prior.lastLatLng = flat[flat.length - 1].latlng
          drawnTracksRef.current.set(track.tail, prior)
          trackStats.push({ tail: track.tail, segs: track.segments?.length || 0, pts: flat.length, drew: prior.polylines.length, live: prior.liveSegments.length })
          continue
        }

        // Append new portions but DRAW THEM PROGRESSIVELY in the icon's
        // rAF loop below. Each klass run becomes a polyline whose latlngs
        // grow as the aircraft passes over the points. Hit polylines are
        // full-length immediately so hover/click stays responsive.
        const newLines = []
        if (newPts.length >= 2) {
          let i = 0
          while (i < newPts.length - 1) {
            const klass = newPts[i].klass
            let j = i + 1
            while (j < newPts.length && newPts[j].klass === klass) j++
            const runEnd = Math.min(j, newPts.length - 1)
            const fullLatlngs = newPts.slice(i, runEnd + 1).map((p) => p.latlng)
            const isExcursion = !!klass
            const color = isExcursion ? (KLASS_COLORS[klass] || '#aaa') : '#f5f5f5'
            const weight = isExcursion ? 5 : 4
            let runLastMs = 0
            for (let k = i; k <= runEnd; k++) if (newPts[k].ts > runLastMs) runLastMs = newPts[k].ts
            const baseOp = 1.0
            const opacity = baseOp * ageOpacity(runLastMs)
            // Start with just the first point — the rAF will grow it.
            const line = L.polyline([fullLatlngs[0]], { color, weight, opacity, lineCap: 'round', lineJoin: 'round', className: 'flight-trace', pane: 'flightPaths' }).addTo(map)
            line._lastMs = runLastMs
            line._baseOp = baseOp
            const hit = L.polyline(fullLatlngs, { color: '#fff', weight: weight + 20, opacity: 0, interactive: true }).addTo(map)
            const { showHover, hideHover, clickSelect } = makeHoverHandlers(track.tail, null, { klass, zone: null, points: fullLatlngs.map((ll) => [ll[0], ll[1]]), type: track.type || '' })
            hit.on('mouseover', showHover); hit.on('mouseout', hideHover); hit.on('click', clickSelect)
            prior.polylines.push(line); prior.hits.push(hit)
            newLines.push({ line, startIdx: i, endIdx: runEnd })
            i = j
          }
          prior.lastLatLng = newPts[newPts.length - 1].latlng
        }

        // Animate icon AND grow polylines synchronously over POLL_MS.
        const marker = liveMarkersRef.current.get(track.tail)
        if (marker && newPts.length >= 2) {
          const prevId = iconAnimRef.current.get(track.tail)
          if (prevId) cancelAnimationFrame(prevId)
          if (marker._icon) marker._icon.style.transition = 'none'
          const segLens = []
          let total = 0
          for (let k = 1; k < newPts.length; k++) {
            const d = Math.hypot(newPts[k].latlng[0] - newPts[k - 1].latlng[0], newPts[k].latlng[1] - newPts[k - 1].latlng[1])
            segLens.push(d); total += d
          }
          if (total === 0) {
            marker.setLatLng(newPts[newPts.length - 1].latlng)
            // Snap all lines to full length
            for (const { line, startIdx, endIdx } of newLines) {
              line.setLatLngs(newPts.slice(startIdx, endIdx + 1).map((p) => p.latlng))
            }
          } else {
            const start = performance.now()
            const step = (now) => {
              const t = Math.min(1, (now - start) / POLL_MS)
              const target = t * total
              let k = 0, acc = 0
              while (k < segLens.length && acc + segLens[k] < target) { acc += segLens[k]; k++ }
              const done = k >= newPts.length - 1
              const lastPt = newPts[newPts.length - 1].latlng
              let curLatLng
              if (done) {
                curLatLng = lastPt
              } else {
                const localT = segLens[k] ? (target - acc) / segLens[k] : 0
                curLatLng = [
                  newPts[k].latlng[0] + (newPts[k + 1].latlng[0] - newPts[k].latlng[0]) * localT,
                  newPts[k].latlng[1] + (newPts[k + 1].latlng[1] - newPts[k].latlng[1]) * localT,
                ]
              }
              marker.setLatLng(curLatLng)
              // Sync each polyline's visible portion to the icon's progress
              for (const { line, startIdx, endIdx } of newLines) {
                if (k < startIdx) {
                  line.setLatLngs([newPts[startIdx].latlng])
                } else if (k >= endIdx || done) {
                  line.setLatLngs(newPts.slice(startIdx, endIdx + 1).map((p) => p.latlng))
                } else {
                  // Trail from segment start up to current interpolated point
                  const trail = newPts.slice(startIdx, k + 1).map((p) => p.latlng)
                  trail.push(curLatLng)
                  line.setLatLngs(trail)
                }
              }
              if (done) { iconAnimRef.current.delete(track.tail); return }
              iconAnimRef.current.set(track.tail, requestAnimationFrame(step))
            }
            iconAnimRef.current.set(track.tail, requestAnimationFrame(step))
          }
        } else if (newLines.length) {
          // No marker yet → snap lines to full length so we don't leave them empty
          for (const { line, startIdx, endIdx } of newLines) {
            line.setLatLngs(newPts.slice(startIdx, endIdx + 1).map((p) => p.latlng))
          }
        }
        drawnTracksRef.current.set(track.tail, prior)
        trackStats.push({ tail: track.tail, segs: track.segments?.length || 0, pts: (track.segments || []).reduce((a, s) => a + (s.points?.length || 0), 0), drew: prior.polylines.length - polylinesBefore })
        } catch (err) {
          console.warn('[noise-report] track draw failed for', track.tail, err?.message)
        }
      }
      // track-stats log silenced (was diagnostic only)

      // Tear down tails that are no longer present
      for (const [tail, state] of drawnTracksRef.current) {
        if (!seenTails.has(tail)) {
          for (const p of state.polylines) p.remove()
          for (const p of state.hits) p.remove()
          drawnTracksRef.current.delete(tail)
          const animId = iconAnimRef.current.get(tail)
          if (animId) { cancelAnimationFrame(animId); iconAnimRef.current.delete(tail) }
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

    // Tails we render this pass — anything missing afterwards gets removed.
    const seen = new Set()

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
      // Sailplanes are excluded from noise reports (no engine), so we dim
      // their icons so users can see they're known and intentionally ignored.
      const dim = isSailplane(track.type) ? 'opacity:0.35;filter:grayscale(0.7);' : ''
      const iconHtml = photo
        ? `<img src="${photo}" alt="${track.type}" style="width:58px;height:58px;border-radius:50%;border:2.5px solid rgba(255,255,255,0.75);object-fit:cover;box-shadow:0 3px 10px rgba(0,0,0,0.7);${dim}" />`
        : `<div style="width:50px;height:50px;border-radius:50%;background:#333;border:2.5px solid rgba(255,255,255,0.5);display:flex;align-items:center;justify-content:center;font-size:13px;color:#aaa;font-weight:bold;${dim}">${(track.type || '?').slice(0, 3)}</div>`
      const icon = L.divIcon({
        className: 'live-aircraft-icon',
        html: iconHtml,
        iconSize: [58, 58],
        iconAnchor: [29, 29],
      })
      // The rAF in the live-animation effect drives marker position via
      // the wall-clock playback timestamp. We only handle creation +
      // heading-icon refresh here; position follows on the next frame.
      const existing = liveMarkersRef.current.get(track.tail)
      if (existing) {
        if (hdg != null && hdg !== existing._lastHdg) {
          existing.setIcon(icon)
          existing._lastHdg = hdg
        }
      } else {
        const marker = L.marker([lastPt[0], lastPt[1]], { icon, interactive: false, zIndexOffset: 1000 }).addTo(map)
        marker._lastHdg = hdg
        liveMarkersRef.current.set(track.tail, marker)
      }
      seen.add(track.tail)
    }
    // Remove markers for tails that disappeared from this update
    for (const [tail, marker] of liveMarkersRef.current) {
      if (!seen.has(tail)) { marker.remove(); liveMarkersRef.current.delete(tail) }
    }
  }, [nearbyTracks, typePhotos])

  /* ── Fetch flight-ops every 30s → tail→purpose map for hover cards. */
  useEffect(() => {
    if (loadPhase < 3) return
    const ctrl = new AbortController()
    const load = async () => {
      try {
        const res = await fetch('https://web-app-production-fedf.up.railway.app/api/excursions/flight-ops?base=KBDU&radius=10', { signal: ctrl.signal })
        if (!res.ok) return
        const data = await res.json()
        const map = {}
        for (const a of data.aircraft || []) {
          if (!a.tail) continue
          // Anonymity: drop fields that identify the operator (school name,
          // special_use.owner). Keep only role/category info.
          map[a.tail] = {
            purpose: a.purpose || null,
            isSchool: !!a.school,
            intent: a.intent || null,
            leg: a.leg || null,
            confidence: a.confidence || null,
            specialRole: a.special_use?.role || null,
            isSpecialUse: !!a.special_use,
          }
        }
        setPurposeByTail(map)
      } catch (err) {
        if (err.name !== 'AbortError') console.warn('[flight-ops] load failed', err.message)
      }
    }
    load()
    const id = setInterval(load, 30_000)
    return () => { ctrl.abort(); clearInterval(id) }
  }, [loadPhase])

  /* ── Pulse the excursive sub-polylines of the selected aircraft.
     Clean sub-polylines keep their original color — the closest-segment
     cyan overlay (driven by reportSegments) is added separately. */
  useEffect(() => {
    for (const [tail, state] of drawnTracksRef.current) {
      const isSel = tail === selectedTail
      for (const line of state.polylines) {
        const path = line._path
        const origColor = line._origColor || (line._origColor = line.options.color)
        const isExc = origColor && origColor !== '#f5f5f5' && origColor !== '#38bdf8'
        if (isSel && isExc) path?.classList.add('excursion-pulse')
        else path?.classList.remove('excursion-pulse')
        // Always keep the original color/weight — never recolor the path.
        line.setStyle({ color: origColor, weight: isExc ? 5 : 4 })
      }
    }
  }, [selectedTail, nearbyTracks])

  /* ── Auto-pick the segment closest to the user as soon as an aircraft
     is selected from the side list. Replaces any prior 'closest' entry
     when selection changes; cleared when nothing is selected.            */
  useEffect(() => {
    if (!selectedTail) {
      setReportSegments((prev) => prev.filter((s) => s.role !== 'closest'))
      return
    }
    if (!rawCoords) return
    const data = segmentsByTail[selectedTail]
    if (!data?.tracks) return
    // Sailplane safety net: even if the user clicks one in the side list,
    // we don't auto-add a closest segment for it (no engine = no noise).
    const aircraftFromList = activeList.find((a) => a.tail === selectedTail)
    if (isSailplane(aircraftFromList?.type) || isSailplane(data.tracks[0]?.type)) {
      setReportSegments((prev) => prev.filter((s) => s.role !== 'closest'))
      return
    }
    // Pure haversine across EVERY point of EVERY segment. No time filter,
    // no klass filter — closest physical point wins, full stop.
    let closeSeg = null, closePt = null, closeDist = Infinity
    let scanned = 0
    for (const tk of data.tracks) {
      for (const seg of tk.segments || []) {
        if (!seg.points?.length) continue
        for (const p of seg.points) {
          const d = haversine(rawCoords.lat, rawCoords.lng, p[0], p[1])
          scanned++
          if (d < closeDist) { closeDist = d; closeSeg = seg; closePt = p }
        }
      }
    }
    if (!closeSeg) return
    const altFt = closePt?.[2]
    const tsMs = closePt?.[3]
    const ageStr = tsMs ? `${((Date.now() - tsMs) / 1000).toFixed(0)}s ago` : 'no ts'
    console.log('[closest-seg]', selectedTail, 'scanned', scanned, 'pts → closest', Math.round(closeDist), 'm', altFt ? `${altFt}ft` : '', ageStr, 'klass=', closeSeg.klass || 'clean')
    const aircraft = activeList.find((a) => a.tail === selectedTail)
    // Selecting from the side list REPLACES every prior selection — the
    // user's intent is "report this aircraft", not "add this aircraft".
    const clipped = clipSegmentNearPoint(closeSeg.points, closePt, 1609)
    setReportSegments([{
      tail: selectedTail,
      lastSeenMs: aircraft?.lastSeenMs || Date.now(),
      klass: closeSeg.klass || aircraft?.worst || null,
      zone: closeSeg.zone || null,
      points: clipped,
      type: aircraft?.type || '',
      nearestPt: closePt,
      role: 'closest',
      distMeters: closeDist,
    }])
    // Also clear any orange/blue overlay polylines from prior selections.
    for (const p of selectedOverlaysRef.current) p.remove()
    selectedOverlaysRef.current = []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTail, segmentsByTail, rawCoords])

  /* ── Highlight every tracked aircraft icon — same amber breath as the
     Auto-Report toggle button. Also highlight the SELECTED aircraft's
     icon (cyan ring) when it's still live on the map. */
  useEffect(() => {
    for (const [tail, marker] of liveMarkersRef.current) {
      const el = marker._icon
      if (!el) continue
      if (trackedTails.has(tail)) el.classList.add('auto-tracked-icon')
      else el.classList.remove('auto-tracked-icon')
      if (tail === selectedTail) el.classList.add('selected-aircraft-icon')
      else el.classList.remove('selected-aircraft-icon')
    }
  }, [trackedTails, nearbyTracks, selectedTail])

  /* ── Single rAF that animates every aircraft against a wall-clock
     playback timestamp 5 seconds behind real time. The icon's position
     and the "drawn" portion of each pair always reflect where the
     aircraft was at (now − 5 s), regardless of when the last poll fired,
     so successive 5-sec polls splice into a continuous, smooth path.
     Each pair caches its last state ('full' / 'empty' / 'active') and
     we only call setLatLngs when the state changes (or every frame for
     the single active pair per tail). */
  const liveAnimFrameRef = useRef(0)
  const PLAYBACK_LAG_MS = 5000
  useEffect(() => {
    // Throttle to ~20 fps: 50 ms between updates is plenty for a 5-sec
    // playback window (≈100 px of motion at most). 60 fps was burning CPU
    // for visually-imperceptible refinement.
    const FRAME_MS = 50
    let lastFrameMs = 0
    const tick = (now) => {
      // Skip work entirely when the tab is hidden — rAF auto-throttles
      // there but we still walk the data; this short-circuit is cheaper.
      if (document.hidden) {
        liveAnimFrameRef.current = requestAnimationFrame(tick)
        return
      }
      if (now - lastFrameMs < FRAME_MS) {
        liveAnimFrameRef.current = requestAnimationFrame(tick)
        return
      }
      lastFrameMs = now
      // perf-mode instrumentation
      const t0 = perfMode ? performance.now() : 0
      perfRef.current.rafFrames++
      const playbackTs = Date.now() - PLAYBACK_LAG_MS
      for (const [tail, state] of drawnTracksRef.current) {
        const pairs = state.pairs
        if (!pairs?.length) continue
        // Resume scan from the previously-active pair instead of from 0.
        // Active pair only advances forward over time, so most frames the
        // first check hits the right pair and we exit immediately.
        let i = state.activeIdx || 0
        if (i >= pairs.length) i = 0
        let leadingLatLng = null
        for (; i < pairs.length; i++) {
          const pair = pairs[i]
          const { line, a, b } = pair
          if (a.ts == null || b.ts == null) continue
          if (b.ts <= playbackTs) {
            if (pair.state !== 'full') {
              line.setLatLngs([a.latlng, b.latlng])
              pair.state = 'full'
            }
            leadingLatLng = b.latlng
            // continue forward to find the active edge
          } else if (a.ts >= playbackTs) {
            // First future pair reached — everything beyond is also future,
            // and we can stop. Lazy-mark this and bail out.
            if (pair.state !== 'empty') {
              line.setLatLngs([a.latlng])
              pair.state = 'empty'
            }
            break
          } else {
            const localT = (playbackTs - a.ts) / (b.ts - a.ts)
            const lat = a.latlng[0] + (b.latlng[0] - a.latlng[0]) * localT
            const lng = a.latlng[1] + (b.latlng[1] - a.latlng[1]) * localT
            line.setLatLngs([a.latlng, [lat, lng]])
            pair.state = 'active'
            leadingLatLng = [lat, lng]
            state.activeIdx = i
            break
          }
        }
        if (leadingLatLng) {
          const marker = liveMarkersRef.current.get(tail)
          if (marker) marker.setLatLng(leadingLatLng)
        }
      }
      if (perfMode) {
        const dt = performance.now() - t0
        if (dt > 16) perfRef.current.rafLongFrames++
        perfRef.current.raf += dt
      }
      liveAnimFrameRef.current = requestAnimationFrame(tick)
    }
    liveAnimFrameRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(liveAnimFrameRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── Adaptive boot poll cadence — saves bandwidth over time.
     • Tab not in focus (document.hidden): every 60 s, regardless.
     • First 10 minutes after load (foreground): every 5 s.
     • After 10 minutes (foreground, idle): every 60 s.
     • Auto-Report tracking ≥ 1 aircraft (foreground): every 10 s,
       regardless of elapsed time, so we don't miss the departure event.
     A `visibilitychange → visible` event triggers an immediate extra
     poll on top of the cadence.                                       */
  const [tabHidden, setTabHidden] = useState(typeof document !== 'undefined' ? document.hidden : false)
  useEffect(() => {
    const onVis = () => setTabHidden(document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  useEffect(() => {
    if (loadPhase < 3) return
    const startedAt = Date.now()
    let timer = null
    const tick = () => {
      const ctrl = new AbortController()
      loadBoot(ctrl.signal)
      const elapsed = Date.now() - startedAt
      const FAST = 5_000, SLOW = 60_000, TRACKING = 10_000
      const next = tabHidden
        ? SLOW
        : autoActive
          ? TRACKING
          : (elapsed < 10 * 60 * 1000 ? FAST : SLOW)
      timer = setTimeout(tick, next)
    }
    timer = setTimeout(tick, 100) // first tick almost immediately
    const onVisible = () => { if (document.visibilityState === 'visible') {
      const ctrl = new AbortController()
      loadBoot(ctrl.signal)
    }}
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoActive, tabHidden, loadPhase])

  // Heatmap state — declared before any effect that uses them.
  const heatImgRef = useRef(null)
  const heatBoundsRef = useRef(null)
  const heatCanvasRef = useRef(null) // reused for getImageData (avoid per-call allocations)
  const noiseZonesRef = useRef([]) // L.Polygon[]
  const [noiseZones, setNoiseZones] = useState([])
  const [heatRev, setHeatRev] = useState(0)
  const [calculatedDba, setCalculatedDba] = useState(null)
  const [calculatedError, setCalculatedError] = useState(null)
  const [purposeByTail, setPurposeByTail] = useState({})
  // Surface weather at the closest DFAID airport — refreshed every 20 min.
  // Wind direction + speed augment the heatmap sampling (sound emitted at
  // altitude drifts with the wind before reaching the ground), and wind/
  // temp/humidity ride along in the report payload.
  const [weather, setWeather] = useState(null)
  // tail-most-recently-resolved closest airport ICAO
  const closestAirport = useMemo(() => {
    if (!rawCoords) return null
    let best = null, bestD = Infinity
    for (const ap of Object.values(DFAID_AIRPORTS)) {
      const d = haversine(rawCoords.lat, rawCoords.lng, ap.lat, ap.lng)
      if (d < bestD) { bestD = d; best = ap }
    }
    return best
  }, [rawCoords])
  useEffect(() => {
    if (!closestAirport) return
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(`https://flightsafeweather-production.up.railway.app/api/metar/${closestAirport.icao}`)
        if (!res.ok) return
        const json = await res.json()
        // FlightSafeWeather shape: { station, data: [METAR…] }
        const m = Array.isArray(json?.data) ? json.data[0]
                : Array.isArray(json?.metars) ? json.metars[0]
                : (json?.metar || json)
        if (cancelled || !m) return
        const parsed = m.parsed?.wind || {}
        // Top-level fields (wdir/wspd/temp/dewp) preferred over the nested
        // parser block; fall back to the parser if needed.
        const windDeg = m.wdir ?? parsed.direction ?? parsed.dir ?? parsed.deg ?? null
        const windKt  = m.wspd ?? parsed.speed     ?? parsed.kt              ?? null
        const gustKt  = m.wgst ?? parsed.gust      ?? null
        const tempC   = m.temp ?? m.parsed?.temperature ?? null
        const dewC    = m.dewp ?? m.parsed?.dewpoint    ?? null
        const humidity = (tempC != null && dewC != null) ? (() => {
          const e  = 6.112 * Math.exp((17.62 * dewC) / (243.12 + dewC))
          const es = 6.112 * Math.exp((17.62 * tempC) / (243.12 + tempC))
          return Math.round(100 * e / es)
        })() : null
        setWeather({
          icao: closestAirport.icao,
          name: closestAirport.name,
          fetchedAt: Date.now(),
          windDeg,
          windKt,
          gustKt,
          tempC,
          dewC,
          humidity,
          rawText: m.rawOb || m.raw_text || m.raw || null,
        })
      } catch (e) {
        if (!cancelled) console.warn('[weather] fetch failed', e?.message)
      }
    }
    load()
    const id = setInterval(load, 20 * 60 * 1000) // 20 min
    return () => { cancelled = true; clearInterval(id) }
  }, [closestAirport])

  // Reporter's public IP — captured silently, never displayed in the UI.
  // Sent server-side with each report so the noise office can correlate
  // multiple reports from the same source without storing more PII.
  const reporterIpRef = useRef(null)
  useEffect(() => {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const res = await fetch('https://get.geojs.io/v1/ip.json', { signal: ctrl.signal })
        if (!res.ok) return
        const data = await res.json()
        if (data?.ip) reporterIpRef.current = data.ip
      } catch {}
    })()
    return () => ctrl.abort()
  }, [])

  /* ── Sample the heatmap at user's location → calculatedDba.
     Runs whenever the heatmap re-renders or the user's location changes. */
  useEffect(() => {
    const img = heatImgRef.current
    const bounds = heatBoundsRef.current
    if (!img) { setCalculatedDba(null); setCalculatedError('no heatmap image yet'); return }
    if (!bounds) { setCalculatedDba(null); setCalculatedError('no heatmap bounds'); return }
    if (!rawCoords) { setCalculatedDba(null); setCalculatedError('no location'); return }
    const [[latMin, lonMin], [latMax, lonMax]] = bounds
    // ── Multi-distance wind-drift model ────────────────────────────────
    // Sound emitted at an aircraft point doesn't only travel straight
    // down — it radiates in all directions and reaches the ground over
    // a SLANT path. For a point at altitude h with horizontal offset r
    // from the user, the slant distance is √(r² + h²), and the time of
    // flight is slant / c_sound. During that time, wind drifts the sound
    // by  wind × t  in the wind's direction. Different altitudes/offsets
    // therefore drift different amounts.
    //
    // The heatmap collapses this into a 2-D ground-projection field, so
    // we approximate the multi-distance behavior by sampling pixel
    // values at SEVERAL upwind offsets corresponding to representative
    // slant distances, then averaging. Bands span common GA-traffic
    // altitudes & nearby horizontal offsets at the user's location.
    const C_SOUND = 340 // m·s⁻¹
    const SLANT_BANDS_M = [500, 1500, 3000, 5000, 8000] // metres of slant
    const ms = weather?.windKt != null ? weather.windKt * 0.5144 : 0
    const headingRad = weather?.windDeg != null
      ? ((weather.windDeg + 180) % 360) * Math.PI / 180  // "wind from" → upwind
      : 0
    const cosLat = Math.cos(rawCoords.lat * Math.PI / 180)
    const offsetsForBand = (slantM) => {
      const t = slantM / C_SOUND
      const shiftM = ms * t
      return {
        slantM,
        timeS: t,
        driftM: shiftM,
        dLat: (shiftM * Math.cos(headingRad)) / 111_320,
        dLng: (shiftM * Math.sin(headingRad)) / (111_320 * cosLat),
      }
    }
    const bands = SLANT_BANDS_M.map(offsetsForBand)
    try {
      // Reuse the canvas painted by the heatmap effect (no per-call alloc).
      const c = heatCanvasRef.current
      if (!c) { setCalculatedDba(null); setCalculatedError('canvas not ready'); return }
      const ctx = c.getContext('2d')
      let totalA = 0, totalLum = 0, totalN = 0, bandsUsed = 0
      for (const b of bands) {
        const sLat = rawCoords.lat + b.dLat
        const sLng = rawCoords.lng + b.dLng
        if (sLat < latMin || sLat > latMax || sLng < lonMin || sLng > lonMax) continue
        const u = (sLng - lonMin) / (lonMax - lonMin)
        const v = 1 - (sLat - latMin) / (latMax - latMin)
        const px = Math.max(0, Math.min(c.width - 1, Math.round(u * (c.width - 1))))
        const py = Math.max(0, Math.min(c.height - 1, Math.round(v * (c.height - 1))))
        const data = ctx.getImageData(Math.max(0, px - 2), Math.max(0, py - 2), 5, 5).data
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3] / 255
          if (a < 0.02) continue
          const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255
          totalA += a; totalLum += lum; totalN++
        }
        bandsUsed++
      }
      // Fallback: if no upwind band landed on energy, sample the user's
      // own pixel directly (treats wind as zero).
      if (totalN === 0) {
        const u = (rawCoords.lng - lonMin) / (lonMax - lonMin)
        const v = 1 - (rawCoords.lat - latMin) / (latMax - latMin)
        if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
          const px = Math.round(u * (c.width - 1))
          const py = Math.round(v * (c.height - 1))
          const data = ctx.getImageData(Math.max(0, px - 2), Math.max(0, py - 2), 5, 5).data
          for (let i = 0; i < data.length; i += 4) {
            const a = data[i + 3] / 255
            if (a < 0.02) continue
            const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255
            totalA += a; totalLum += lum; totalN++
          }
        }
      }
      if (totalN === 0) {
        setCalculatedDba(null)
        setCalculatedError(bandsUsed === 0 ? 'all wind-drift bands fell outside heatmap' : 'no flight energy at your location')
        return
      }
      const meanA = totalA / totalN
      const meanLum = totalLum / totalN
      const intensity = Math.max(0, Math.min(1, 0.4 * meanA + 0.6 * meanLum))
      setCalculatedDba(Math.round(30 + intensity * 65))
      setCalculatedError(null)
    } catch (e) {
      setCalculatedDba(null)
      setCalculatedError(`sample failed: ${e?.message || 'unknown'}`)
    }
  }, [heatRev, rawCoords, weather])

  /* ── Periodic linear fade — recompute opacity for every drawn polyline.
     Each line carries _lastMs (newest point's timestamp) and _baseOp.
     Opacity = baseOp * (1 - age/30min). At age >= 30min the line is
     removed entirely so the map stays trimmed.                          */
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now()
      for (const [, state] of drawnTracksRef.current) {
        // Polylines: per-pair, fade independently. Hits: one per track,
        // not paired by index — leave them alone here.
        const keepLines = []
        for (const line of state.polylines) {
          if (!line) continue
          const age = now - (line._lastMs || now)
          const ratio = Math.max(0, Math.min(1, 1 - age / PATH_FADE_MS))
          if (ratio < 0.02) {
            line.remove()
          } else {
            line.setStyle({ opacity: (line._baseOp || 1) * ratio })
            keepLines.push(line)
          }
        }
        state.polylines = keepLines
      }
    }, 15_000) // every 15s — at 30-min fade that's a 0.83% step, visually smooth
    return () => clearInterval(id)
  }, [])

  /* ── Heatmap of recent flights ─────────────────────────────────────
     Builds a noise-energy raster from the same nearbyTracks data and
     overlays it under the polylines. Recomputed when the track set
     changes (every 10s poll). Terrain data is loaded once.            */
  const HEATMAP_ENABLED = true
  const heatOverlayRef = useRef(null)
  const terrainLoadedRef = useRef(false)
  const lastHeatComputeRef = useRef(0)
  // Heatmap recompute is the most expensive thing on the page (~100-200ms
  // CPU + several MB transient memory). It doesn't need to keep up with
  // 5-sec polls — visual changes between consecutive polls are minor.
  const HEAT_RECOMPUTE_MS = 30_000
  useEffect(() => {
    if (!HEATMAP_ENABLED) {
      if (heatOverlayRef.current) { heatOverlayRef.current.remove(); heatOverlayRef.current = null }
      return
    }
    const L = window.L
    const map = mapRef.current
    if (!L || !map) return
    if (!nearbyTracks.length) return
    // Skip recompute when the tab isn't visible — the user can't see the
    // overlay and the compute is the most expensive thing on the page.
    if (tabHidden) return
    // Skip recompute if the last one was very recent — the raster is
    // expensive (60-100ms + ~5MB transient memory) and visually changes
    // little between consecutive 5-sec polls.
    const now = Date.now()
    if (now - lastHeatComputeRef.current < HEAT_RECOMPUTE_MS) return
    lastHeatComputeRef.current = now
    if (perfMode) perfRef.current.heat++
    let cancelled = false
    ;(async () => {
      if (!terrainLoadedRef.current) {
        try { await loadTerrain() } catch (e) { console.warn('[heatmap] terrain load failed, using fallback elevation', e?.message) }
        terrainLoadedRef.current = true
      }
      if (cancelled) return
      // Scope priority: manual side-list selection > auto-report tracked
      // aircraft (Set) > all aircraft. The calculated dBA at the user's
      // location reflects whichever scope is active. Sailplanes are
      // unconditionally excluded from the heatmap so they never bias the
      // calculated noise reading.
      const scopedTracks = (selectedTail
        ? nearbyTracks.filter((t) => t.tail === selectedTail)
        : (trackedTails.size > 0
            ? nearbyTracks.filter((t) => trackedTails.has(t.tail))
            : nearbyTracks)).filter((t) => !isSailplane(t.type))
      // Crop to a 4 nm circle around the user — points outside don't
      // contribute meaningful noise here, and the smaller bounding box
      // shrinks the raster compute by ~10× (raster scales with area).
      const HEAT_RADIUS_M = 4 * 1852 // 4 nm
      const sourceTracks = rawCoords ? scopedTracks
        .map((t) => {
          const newSegments = (t.segments || []).map((seg) => {
            if (!seg.points?.length) return seg
            const inRange = seg.points.filter((p) =>
              haversine(rawCoords.lat, rawCoords.lng, p[0], p[1]) <= HEAT_RADIUS_M
            )
            return inRange.length >= 2 ? { ...seg, points: inRange } : null
          }).filter(Boolean)
          return newSegments.length ? { ...t, segments: newSegments } : null
        })
        .filter(Boolean)
        : scopedTracks
      // Flatten the track shape: bands → points-only with [lat, lon, alt_ft]
      const tracks = sourceTracks
        .map((t) => ({
          type: t.type || 'C172',
          points: (t.segments || []).flatMap((s) => (s.points || []).map((p) => [p[0], p[1], p[2] || 5000])),
        }))
        .filter((t) => t.points.length >= 2)
      if (!tracks.length) return
      let result
      try {
        result = computeNoiseRaster(tracks, {
          blobsPerNm: 3,         // higher density acceptable at smaller area
          rasterPx: 400,         // 400×400 grid for ~8 nm-side area = good detail, ~640 KB
          accumAutoRange: true,  // small dataset — auto-fit looks better
        })
      } catch (e) {
        console.warn('[heatmap] compute failed:', e?.message)
        return
      }
      if (cancelled || !result) return
      // Dedicated pane below the default overlayPane so the heatmap never
      // covers the flight polylines (overlayPane = 400).
      if (!map.getPane('noiseHeatmap')) {
        map.createPane('noiseHeatmap')
        map.getPane('noiseHeatmap').style.zIndex = 350
        map.getPane('noiseHeatmap').style.pointerEvents = 'none'
      }
      // Reuse a single overlay so we don't flicker on every poll
      if (heatOverlayRef.current) {
        heatOverlayRef.current.setUrl(result.dataUrl)
        heatOverlayRef.current.setBounds(result.latLngBounds)
      } else {
        const overlay = L.imageOverlay(result.dataUrl, result.latLngBounds, {
          opacity: 0.25,
          interactive: false,
          pane: 'noiseHeatmap',
          className: 'noise-heatmap-overlay',
        }).addTo(map)
        heatOverlayRef.current = overlay
      }
      // Stash the rendered image + bounds for the separate sampler effect.
      // We also pre-paint into a single reused canvas so the sampler doesn't
      // create one per call — saves repeated canvas allocations.
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        if (cancelled) return
        // Pre-rasterize into a shared canvas so getImageData reads from it.
        if (!heatCanvasRef.current) heatCanvasRef.current = document.createElement('canvas')
        const c = heatCanvasRef.current
        c.width = img.width; c.height = img.height
        c.getContext('2d').drawImage(img, 0, 0)
        heatImgRef.current = img
        heatBoundsRef.current = result.latLngBounds
        setHeatRev((r) => r + 1)
      }
      img.src = result.dataUrl
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nearbyTracks, selectedTail, trackedTails])

  /* ── Voluntary noise-abatement zones — fetched once, rendered as a
     gentle overlay below the flight paths and heatmap. */
  useEffect(() => {
    if (loadPhase < 3) return
    const ctrl = new AbortController()
    fetchNoiseZones({ signal: ctrl.signal })
      .then((zones) => setNoiseZones(zones))
      .catch((e) => { if (e.name !== 'AbortError') console.warn('[noise-zones] fetch failed', e?.message) })
    return () => ctrl.abort()
  }, [loadPhase])
  useEffect(() => {
    const L = window.L
    const map = mapRef.current
    if (!L || !map || !noiseZones.length) return
    if (!map.getPane('noiseZones')) {
      map.createPane('noiseZones')
      map.getPane('noiseZones').style.zIndex = 250 // tiles=200 < zones=250 < heatmap=350 < paths=410
      map.getPane('noiseZones').style.pointerEvents = 'auto'
    }
    // Clear any prior overlays before re-rendering
    for (const p of noiseZonesRef.current) p.remove()
    noiseZonesRef.current = []
    for (const z of noiseZones) {
      if (!z.polygon?.length) continue
      const poly = L.polygon(z.polygon, {
        pane: 'noiseZones',
        color: 'rgba(255,255,255,0.35)',
        weight: 1.25,
        dashArray: '4 6',
        fillColor: '#a78bfa', // soft violet — distinguishable from track klass colors
        fillOpacity: 0.06,
        interactive: true,
      }).addTo(map)
      poly.bindTooltip(
        `<div class="text-[11px] font-semibold text-neutral-100">${z.name}</div>` +
        `<div class="text-[10px] text-neutral-300">${z.note || ''}</div>` +
        `<div class="text-[10px] text-neutral-400">ceiling: ${z.ceiling_ft.toLocaleString()} ft</div>`,
        { sticky: true, direction: 'top', opacity: 0.95, className: 'noise-zone-tip' }
      )
      noiseZonesRef.current.push(poly)
    }
    return () => {
      for (const p of noiseZonesRef.current) p.remove()
      noiseZonesRef.current = []
    }
  }, [noiseZones])

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

  /* ── Continuous dB meter + rolling peak-clip capture ────────────── */
  // Tear down any active mic so we can swap to a different device.
  const stopMeterStream = () => {
    if (meterTimerRef.current) { clearTimeout(meterTimerRef.current); meterTimerRef.current = null }
    if (meterRecRef.current) { try { meterRecRef.current.stop?.() ?? meterRecRef.current.disconnect?.() } catch {} meterRecRef.current = null }
    if (meterStreamRef.current) { meterStreamRef.current.getTracks().forEach((t) => t.stop()); meterStreamRef.current = null }
    if (meterCtxRef.current) { try { meterCtxRef.current.close() } catch {} meterCtxRef.current = null }
    meterBandHistoryRef.current = [[], [], [], [], []]
    meterBandDbaHistoryRef.current = [[], [], [], [], []]
    meterChunksRef.current = []
  }
  // Started by user gesture (browsers block getUserMedia without one).
  // Pass a deviceId to switch to a specific input (or undefined for default).
  const startMeter = async (deviceId) => {
    setMeterError(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      setMeterError('Microphone API unavailable (HTTPS or localhost required)')
      return
    }
    // Switching devices — tear down current stream first.
    if (meterStreamRef.current) stopMeterStream()
    try {
      // Raw capture: AGC, echo-cancel, and noise-suppression all off so
      // dBA readings reflect the actual acoustic signal. On Android this
      // pushes the audio HAL into raw-capture mode which can duck/glitch
      // system audio (YouTube etc.) — the auto-pause-on-hidden +
      // explicit "Pause mic" button below let the user release the mic
      // when they need clean playback.
      const audio = {
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
        voiceIsolation: false,
      }
      if (deviceId) audio.deviceId = { exact: deviceId }
      const stream = await navigator.mediaDevices.getUserMedia({ audio })
      meterStreamRef.current = stream
      // Now that permission is granted, labels become available — enumerate.
      try {
        const list = await navigator.mediaDevices.enumerateDevices()
        setMeterDevices(list.filter((d) => d.kind === 'audioinput'))
      } catch {}
      const activeId = stream.getAudioTracks()[0]?.getSettings?.().deviceId
      if (activeId) setMeterDeviceId(activeId)
      const tracks = stream.getAudioTracks()
      const settings = tracks[0]?.getSettings?.() || {}
      // Some drivers ignore the constraint — try to force AGC off.
      try { await tracks[0]?.applyConstraints?.({ autoGainControl: false, echoCancellation: false, noiseSuppression: false }) } catch {}
      const after = tracks[0]?.getSettings?.() || {}
      if (after.autoGainControl) console.warn('[meter] AGC could not be disabled — dBA values will drift with input level')
      const micLabel = tracks[0]?.label || ''
      const micId = after.deviceId || settings.deviceId || null
      if (micId) meterTriedRef.current.add(micId)
      setMeterMicInfo({
        label: micLabel,
        deviceId: micId,
        sampleRate: settings.sampleRate || null,
        agc: !!after.autoGainControl,
        ec: !!after.echoCancellation,
        ns: !!after.noiseSuppression,
      })
      console.log('[meter] mic:', micLabel, 'agc=', after.autoGainControl, 'ec=', after.echoCancellation, 'ns=', after.noiseSuppression, 'sr=', settings.sampleRate)
      const AC = window.AudioContext || window.webkitAudioContext
      const ctx = new AC()
      // Chrome blocks AudioContext until resumed after a user gesture
      if (ctx.state === 'suspended') await ctx.resume()
      console.log('[meter] AudioContext state:', ctx.state, 'sampleRate:', ctx.sampleRate)
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      // 1024-pt FFT (was 2048): ~21 ms time window, 512 frequency bins.
      // Halves the per-frame FFT cost on the audio thread. Bins are
      // ~47 Hz wide at 48 kHz — still gives ≥3 bins inside our narrowest
      // band (Low: 50–200 Hz), so dBA accuracy is unchanged.
      analyser.fftSize = 1024
      // Smoothing: AnalyserNode internally exponential-averages successive
      // FFT frames. 0.3 was visibly jittery; 0.85 gives a smooth, glide-
      // like response so the meter doesn't pulse on transient fluctuations.
      analyser.smoothingTimeConstant = 0.85
      src.connect(analyser)
      meterCtxRef.current = ctx

      // Audio capture for clip storage uses MediaRecorder (off main
      // thread) instead of ScriptProcessorNode — ScriptProcessor runs in
      // the JS thread and on Android the per-sample callback contended
      // with React renders, glitching the audio output and triggering
      // Safari/Chrome tab-kills under memory pressure. MediaRecorder
      // emits compressed chunks asynchronously and we keep a small
      // rolling buffer (≈1 second of audio) instead of an uncompressed
      // 10-sec PCM ring (~960 KB → ~30 KB).
      // 250 ms slices ⇒ 4 dataavailable callbacks/sec instead of 10. Same
      // 1-second rolling audio window with a quarter the encoder wakeups,
      // which is the heaviest fixed cost in the audio pipeline.
      const SLICE_MS = 250
      const RING_CHUNKS = 4 // 4 × 250 ms = 1 s of audio
      const chunks = [] // last RING_CHUNKS opus/webm chunks
      try {
        const mime = (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus'))
          ? 'audio/webm;codecs=opus'
          : (MediaRecorder.isTypeSupported?.('audio/mp4') ? 'audio/mp4' : '')
        const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
        rec.ondataavailable = (e) => {
          if (!e.data?.size) return
          chunks.push(e.data)
          while (chunks.length > RING_CHUNKS) chunks.shift()
        }
        rec.start(SLICE_MS)
        meterRecRef.current = rec
        // Reader for submit: returns a Blob of the last 1 second of audio.
        meterPcmRef.current = {
          mime: rec.mimeType,
          getClip: () => chunks.length ? new Blob(chunks.slice(), { type: rec.mimeType }) : null,
          // Snapshot for peak — copy current chunk list so later mutations don't affect it.
          snapshotPeak: () => chunks.slice(),
        }
      } catch (err) {
        console.warn('[meter] audio recorder init failed', err?.message)
        meterRecRef.current = null
      }

      const binHz = ctx.sampleRate / analyser.fftSize
      const freqData = new Float32Array(analyser.frequencyBinCount)
      const timeData = new Uint8Array(analyser.fftSize)
      let peakDb = -Infinity
      let floorDb = Infinity // lowest sustained dBA seen across the session
      // Display refresh throttle.
      //   • Steady-state (history full): max 5 Hz so React stays smooth.
      //   • Warm-up (history filling): drop to 1 Hz since the sustained
      //     min isn't meaningful yet anyway.
      let lastSetMeterMs = 0

      // IEC 61672-1 A-weighting curve. Returns the gain in dB to apply at
      // a given frequency so the spectrum matches human hearing sensitivity.
      const aWeightDb = (f) => {
        if (f <= 0) return -100
        const f2 = f * f
        const ra =
          (12194 * 12194 * f2 * f2) /
          ((f2 + 20.6 * 20.6) *
            Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) *
            (f2 + 12194 * 12194))
        return 20 * Math.log10(ra) + 2.0
      }
      // Pre-compute A-weight gain per FFT bin (constant for this stream).
      const aBinDb = new Float32Array(freqData.length)
      for (let i = 1; i < freqData.length; i++) aBinDb[i] = aWeightDb(i * binHz)
      aBinDb[0] = -100
      const dbaHistory = [] // 5-sec rolling history of liveDba (50 samples @ 10Hz)
      const domHzHistory = [] // 5-sec rolling history of dominant Hz

      const tick = () => {
        if (!meterStreamRef.current) return
        analyser.getFloatFrequencyData(freqData)
        analyser.getByteTimeDomainData(timeData)

        const bands = METER_BANDS.map(({ lo, hi }) => {
          const loBin = Math.max(1, Math.floor(lo / binHz))
          const hiBin = Math.min(freqData.length - 1, Math.ceil(hi / binHz))
          let sum = 0, n = 0
          for (let i = loBin; i <= hiBin; i++) { sum += freqData[i]; n++ }
          return n ? sum / n : -100
        })
        // Per-band A-weighted level — sum power across A-weighted bins
        const bandsDba = METER_BANDS.map(({ lo, hi }) => {
          const loBin = Math.max(1, Math.floor(lo / binHz))
          const hiBin = Math.min(freqData.length - 1, Math.ceil(hi / binHz))
          let p = 0
          for (let i = loBin; i <= hiBin; i++) {
            p += Math.pow(10, (freqData[i] + aBinDb[i]) / 10)
          }
          return p > 1e-12 ? 10 * Math.log10(p) : -100
        })
        for (let b = 0; b < 5; b++) {
          const h = meterBandHistoryRef.current[b]
          h.push(bands[b])
          if (h.length > 20) h.shift()        // 20 samples × 250 ms = 5 s
          const ha = meterBandDbaHistoryRef.current[b]
          ha.push(bandsDba[b])
          if (ha.length > 20) ha.shift()
        }
        const sustained = meterBandHistoryRef.current.map((h) =>
          h.length ? Math.min(...h) : -100,
        )
        const sustainedBandsDba = meterBandDbaHistoryRef.current.map((h) =>
          h.length ? Math.min(...h) : -100,
        )
        const overallSustained = Math.max(...sustained)

        let sumSq = 0
        for (let i = 0; i < timeData.length; i++) {
          const v = (timeData[i] - 128) / 128
          sumSq += v * v
        }
        const rms = Math.sqrt(sumSq / timeData.length)
        const liveDb = rms > 1e-5 ? 20 * Math.log10(rms) : -100

        // A-weighted overall + dominant frequency tracker.
        let aPowerSum = 0
        let domBin = 0, domBinDb = -Infinity
        for (let i = 1; i < freqData.length; i++) {
          const binDb = freqData[i] + aBinDb[i]
          aPowerSum += Math.pow(10, binDb / 10)
          if (binDb > domBinDb) { domBinDb = binDb; domBin = i }
        }
        const liveDba = aPowerSum > 1e-12 ? 10 * Math.log10(aPowerSum) : -100
        const dominantHz = domBin * binHz
        dbaHistory.push(liveDba)
        if (dbaHistory.length > 20) dbaHistory.shift() // 5 s @ 4 Hz
        const sustainedDba = dbaHistory.length ? Math.min(...dbaHistory) : -100
        domHzHistory.push(dominantHz)
        if (domHzHistory.length > 20) domHzHistory.shift() // 5 s @ 4 Hz
        // Median is robust to per-tick jitter; sort copy then pick middle
        const sortedHz = [...domHzHistory].sort((a, b) => a - b)
        const dominantSustainedHz = sortedHz[Math.floor(sortedHz.length / 2)]

        // On a new peak, snapshot the current 1-sec MediaRecorder buffer
        // — these chunks become the loudest-clip blob at submit time.
        let newPeakChunks = null
        if (overallSustained > peakDb && meterPcmRef.current) {
          peakDb = overallSustained
          newPeakChunks = meterPcmRef.current.snapshotPeak()
        }
        // Track ambient floor — lowest sustained dBA seen. Wait 15 s after
        // meter start so transient audio-pipeline noise (codec ramp-up,
        // first-frame jitter, the silence-detection window itself) doesn't
        // pin an unrealistic low floor.
        if (Date.now() - meterStartedAtRef.current >= 15_000 &&
            sustainedDba < floorDb && sustainedDba > -100) {
          floorDb = sustainedDba
        }

        // Update display once per tick (4 Hz steady-state, 1 Hz warm-up).
        // We stopped gating on a "meaningful-change" threshold — that
        // froze the display on quiet/stable signals because liveDba
        // never crossed the 0.5 dB delta needed to unlock the next push.
        const nowMs = Date.now()
        const warmingUp = dbaHistory.length < 20
        // 500 ms minimum between display pushes ⇒ at most 2 React renders
        // /sec for the meter. Each render evaluates the whole NoiseStudio
        // tree (which includes the 40+ aircraft list and per-band layout),
        // so faster updates were starving the rAF.
        const minDelta = warmingUp ? 1000 : 500
        if (nowMs - lastSetMeterMs >= minDelta) {
          lastSetMeterMs = nowMs
          // Spread the prior state first, then overwrite only with values
          // that are real numbers — never let a transient null/undefined
          // from a partial frame blank the display. This is the visual-
          // sync the user asked for: the displayed value only changes
          // when there's a NEW computed value to show.
          setMeter((m) => ({
            ...m,
            live: liveDb ?? m.live,
            liveDba: liveDba ?? m.liveDba,
            bands: bands ?? m.bands,
            bandsDba: bandsDba ?? m.bandsDba,
            sustained: sustained ?? m.sustained,
            sustainedBandsDba: sustainedBandsDba ?? m.sustainedBandsDba,
            overallSustained: overallSustained ?? m.overallSustained,
            sustainedDba: sustainedDba ?? m.sustainedDba,
            dominantHz: dominantHz ?? m.dominantHz,
            dominantSustainedHz: dominantSustainedHz ?? m.dominantSustainedHz,
            floorDba: floorDb < Infinity ? floorDb : m.floorDba,
            peakClipDb: newPeakChunks ? overallSustained : m.peakClipDb,
            peakClipChunks: newPeakChunks || m.peakClipChunks,
            peakClipMime: newPeakChunks ? meterPcmRef.current?.mime : m.peakClipMime,
          }))
        }

        // Silence detection — if after 2s the loudest sample we've ever
        // seen is below -85 dBFS, the chosen mic is probably dead/wrong.
        if (liveDb > meterMaxLiveRef.current) meterMaxLiveRef.current = liveDb
        if (Date.now() - meterStartedAtRef.current > 2000) {
          setMeterNoSignal(meterMaxLiveRef.current < -85)
        }

        if (perfMode) perfRef.current.audio++
        // Tick at 250 ms (4 Hz). Down from 10 Hz — every tick walks the
        // FFT buffer + computes 5 band averages + A-weighted sum, which
        // adds up. 4 Hz is fast enough to catch any sustained-noise
        // event (sustained = 5-sec min, so 5×4=20 samples per window).
        meterTimerRef.current = setTimeout(tick, 250)
      }
      meterMaxLiveRef.current = -100
      meterStartedAtRef.current = Date.now()
      setMeterNoSignal(false)
      setMeterStarted(true)
      tick()
    } catch (err) {
      console.error('[noise-report] meter error', err.message)
      setMeterError(err.message || 'Microphone denied')
    }
  }
  // Enumerate audio inputs immediately so the picker has a list ready the
  // moment we need it (Windows is slow to enumerate the first time). Labels
  // stay blank until permission is granted; we re-enumerate after that.
  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    let cancelled = false
    navigator.mediaDevices.enumerateDevices()
      .then((list) => {
        if (cancelled) return
        setMeterDevices(list.filter((d) => d.kind === 'audioinput'))
      })
      .catch(() => {})
    const onChange = () => {
      navigator.mediaDevices.enumerateDevices()
        .then((list) => setMeterDevices(list.filter((d) => d.kind === 'audioinput')))
        .catch(() => {})
    }
    navigator.mediaDevices.addEventListener?.('devicechange', onChange)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener?.('devicechange', onChange)
    }
  }, [])
  // Auto-start if mic permission was previously granted (no prompt needed)
  useEffect(() => {
    if (meterStarted) return
    if (!navigator.permissions?.query) return
    navigator.permissions.query({ name: 'microphone' })
      .then((p) => { if (p.state === 'granted') startMeter() })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // (Auto-pause-mic-on-tab-hidden removed — mic now keeps running in the
  // background. The "Pause mic" button in the meter card is still
  // available for manual release.)
  // (Both former auto-selects — "closer aircraft than last reported" and
  // "loudest peak picks an aircraft" — have been removed. Selection is
  // now driven entirely by:
  //   1. clicking a path on the map (manual)
  //   2. clicking an aircraft in the side excursion list (closest segment)
  //   3. Auto-Report mode firing on departure from the 4 nm circle
  // This eliminates the multi-aircraft-mixed reports that were happening
  // when the auto-selects competed with manual side-list clicks.)
  const autoPeakRef = useRef(-Infinity) // kept so the submit-reset path still has something to clear
  // Auto-cycle: if the chosen mic is silent for >2s, switch to the next
  // unexplored device. Stops once we find signal or exhaust the list.
  useEffect(() => {
    if (!meterNoSignal) return
    if (!meterDevices.length) return
    const next = meterDevices.find((d) => d.deviceId && !meterTriedRef.current.has(d.deviceId))
    if (next) {
      console.log('[meter] auto-cycling to', next.label || next.deviceId.slice(0, 8))
      startMeter(next.deviceId)
    } else {
      console.warn('[meter] tried all', meterDevices.length, 'mics, no signal anywhere')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meterNoSignal])
  // Cleanup mic resources on unmount
  useEffect(() => {
    return () => {
      if (meterTimerRef.current) { clearTimeout(meterTimerRef.current); meterTimerRef.current = null }
      if (meterRecRef.current) { try { meterRecRef.current.stop?.() ?? meterRecRef.current.disconnect?.() } catch {} meterRecRef.current = null }
      if (meterStreamRef.current) { meterStreamRef.current.getTracks().forEach((t) => t.stop()); meterStreamRef.current = null }
      if (meterCtxRef.current) { try { meterCtxRef.current.close() } catch {} meterCtxRef.current = null }
      meterBandHistoryRef.current = [[], [], [], [], []]
      meterBandDbaHistoryRef.current = [[], [], [], [], []]
      meterChunksRef.current = []
    }
  }, [])

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
    // Audio is uploaded separately via /audio/:slot endpoints after the
    // report is created (PCM ring → spliced10s + loudest5s WAV blobs);
    // no audioBlob promotion needed here.
  }
  function closeReport() {
    setReportOpen(false)
    teardownAudio()
    teardownVideo()
  }
  /**
   * Lean submit: no wizard. Snapshots the current meter + selection state
   * and posts directly. After submit, the My-Reports panel slides open so
   * the user sees the saved entry expanded with all the recorded detail.
   * Audio (spliced10s + loudest5s) is uploaded by submitReport itself.
   */
  async function quickSubmit({ source = 'manual', extraSegments = null } = {}) {
    const segCount = (reportSegments.length || 0) + (extraSegments?.length || 0)
    setReportMode(segCount ? 'excursion' : 'general')
    setStep(1)
    setSubmitted(false)
    submitSourceRef.current = source
    await submitReport(extraSegments).catch((e) => console.warn('[quick-submit]', e?.message))
    submitSourceRef.current = 'manual'
    // Surface the new entry in the right-side My-Reports panel.
    setComplaintsPanelOpen(true)
    if (source === 'auto') lastAutoReportRef.current = Date.now()
  }
  // Auto-Report — every aircraft that comes within AUTO_RADIUS_M of the
  // user is tracked individually; when it departs past its closest approach
  // (or leaves the radius), a report is auto-fired for that aircraft.
  useEffect(() => {
    if (!autoReport) {
      departureTrackerRef.current = new Map()
      lastFireByTailRef.current = new Map()
      setAutoActive(false)
      setTrackedTails(new Set())
      setWindowPeakDba(null)
      return
    }
    if (!rawCoords || !nearbyTracks?.length) return
    const AUTO_RADIUS_M = 4 * 1852          // 4 nm = ~7408 m
    const DEPARTURE_BUFFER_M = 200           // must move past closest by this much
    // Rate-limit per aircraft: at most one auto-fire every 2 minutes. A
    // circling aircraft fires on each departure (one per circle) provided
    // ≥2 min have elapsed since the prior fire for that same tail.
    const PER_AIRCRAFT_COOLDOWN_MS = 2 * 60_000
    const now = Date.now()
    const tracker = departureTrackerRef.current

    // Build a map of currently-visible aircraft → distance + last seg/pt.
    // Sailplanes are skipped here so they're never tracked or auto-reported
    // — they don't have engines, so a noise report against one is nonsense.
    const visibleByTail = new Map()
    for (const t of nearbyTracks) {
      if (isSailplane(t.type)) continue
      const lastSeg = t.segments?.[t.segments.length - 1]
      const lastPt = lastSeg?.points?.[lastSeg.points.length - 1]
      if (!lastPt) continue
      const d = haversine(rawCoords.lat, rawCoords.lng, lastPt[0], lastPt[1])
      visibleByTail.set(t.tail, { d, track: t, seg: lastSeg, pt: lastPt })
    }

    const fireFor = (tail, entry, currentDist) => {
      const lastFire = lastFireByTailRef.current.get(tail) || 0
      const sinceLast = now - lastFire
      if (sinceLast < PER_AIRCRAFT_COOLDOWN_MS) {
        // Within cooldown — drop this approach so the NEXT circle (after
        // 2 min) gets its own fresh report. Don't keep the stale tracker.
        console.log('[auto-report] cooldown-skip for', tail, '— wait', Math.round((PER_AIRCRAFT_COOLDOWN_MS - sinceLast) / 1000), 's')
        tracker.delete(tail)
        return
      }
      console.log('[auto-report] firing for', tail, 'min=', Math.round(entry.minDistM), 'm now=', Math.round(currentDist ?? -1), 'm', 'maxCalc=', entry.maxCalculatedDba, 'type=', entry.type)
      // Skip addReportSegment (which is a queued setState — submitReport
      // would read the stale reportSegments and lose the type/tail). Pass
      // the segment directly via extraSegments so submitReport sees it.
      const segData = {
        tail,
        lastSeenMs: now,
        klass: entry.seg?.klass || null,
        zone: entry.seg?.zone || null,
        points: clipSegmentNearPoint(entry.seg?.points, entry.segPoint, 1609),
        type: entry.type || '',
        nearestPt: entry.segPoint,
        peakDba: meter.sustainedDba != null ? Math.round(toSpl(meter.sustainedDba)) : null,
        autoMaxCalculatedDba: entry.maxCalculatedDba ?? null,
        auto: true,
      }
      quickSubmit({ source: 'auto', extraSegments: [segData] })
      lastAutoReportRef.current = now
      lastFireByTailRef.current.set(tail, now)
      tracker.delete(tail)
    }

    // 1. Add or update every aircraft currently inside the 4 nm circle.
    //    Also stamp the running max of calculatedDba so the auto-fire can
    //    attach the loudest model reading observed during the approach.
    for (const [tail, info] of visibleByTail) {
      if (info.d <= AUTO_RADIUS_M) {
        const existing = tracker.get(tail)
        if (!existing) {
          tracker.set(tail, {
            minDistM: info.d,
            minTs: now,
            type: info.track.type,
            segPoint: info.pt,
            seg: info.seg,
            firedAt: 0,
            maxCalculatedDba: calculatedDba ?? null,
          })
          console.log('[auto-report] entered 4nm:', tail, Math.round(info.d), 'm')
        } else {
          if (info.d < existing.minDistM) {
            existing.minDistM = info.d
            existing.minTs = now
            existing.segPoint = info.pt
            existing.seg = info.seg
          }
          if (calculatedDba != null && (existing.maxCalculatedDba == null || calculatedDba > existing.maxCalculatedDba)) {
            existing.maxCalculatedDba = calculatedDba
          }
        }
      }
    }

    // 2. Check each tracked aircraft: did it depart past its closest, or leave the radius?
    for (const [tail, entry] of tracker) {
      if (now - entry.firedAt < PER_AIRCRAFT_COOLDOWN_MS && entry.firedAt > 0) continue
      const live = visibleByTail.get(tail)
      const livDist = live?.d
      const departedPastMin = livDist != null && livDist > entry.minDistM + DEPARTURE_BUFFER_M
      const leftRadius = livDist == null || livDist > AUTO_RADIUS_M
      if (departedPastMin || leftRadius) {
        fireFor(tail, entry, livDist)
      }
    }

    // 3. Surface the live tracker state to the UI.
    setAutoActive(tracker.size > 0)
    setTrackedTails(new Set(tracker.keys()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoReport, nearbyTracks])

  // Track window peak dBA whenever the meter updates (only while autoReport is on).
  useEffect(() => {
    if (!autoReport) return
    if (meter.sustainedDba == null) return
    const dba = Math.round(toSpl(meter.sustainedDba))
    setWindowPeakDba((prev) => prev == null || dba > prev ? dba : prev)
  }, [meter.sustainedDba, autoReport])
  async function submitReport(extraSegments = null) {
    teardownAudio()
    teardownVideo()
    setSubmitted(true)
    setFullStatus('posting'); setFullError(null); setFullId(null)
    setComplaintStatus('idle'); setComplaintError(null); setComplaintId(null)
    // Auto-fire path passes its segment(s) directly because reportSegments
    // is a queued state update that hasn't landed yet at submit time.
    const allSegments = extraSegments?.length ? [...reportSegments, ...extraSegments] : reportSegments

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
    const submitSource = submitSourceRef.current || 'manual'
    const meta = {
      mode: reportMode,
      submittedAt: new Date().toISOString(),
      reporter,
      // True for the 15-minute auto-report timer; false for a user click.
      auto: submitSource === 'auto',
      source: submitSource,
      // Reporter's public IP — for server-side correlation only; never
      // surfaced in any UI. Stays in the JSONB row for the noise office.
      reporterIp: reporterIpRef.current || null,
      identity: identity ? { kind: identity.kind, label: identity.email || identity.handle } : null,
      // No reporter location stored — only the offending flight segment position.
      nearestFlightPoint: nearestSegPoint,
      reportedSegments: allSegments.length ? allSegments.map((s) => ({
        tail: s.tail,
        klass: s.klass,
        zone: s.zone,
        type: s.type,
        nearestPt: s.nearestPt,
        points: s.points,
        role: s.role,
        auto: s.auto,
        autoMaxCalculatedDba: s.autoMaxCalculatedDba,
      })) : null,
      score: { total: score.total, max: score.max, tier, breakdown: score.breakdown },
      device: (() => {
        const ua = navigator.userAgent || ''
        // Best-effort extraction. Real calibration lookup happens server-side.
        const isIOS = /iPhone|iPad|iPod/.test(ua)
        const isAndroid = /Android/.test(ua)
        let model = null
        if (isIOS) {
          const m = ua.match(/\b(iPhone|iPad|iPod)\b[^;)]*/)
          model = m ? m[0].trim() : 'iOS'
        } else if (isAndroid) {
          // Android UA: ".../... ; Pixel 7 Build/..." or similar
          const m = ua.match(/Android[^;)]*;\s*([^)]+?)(?:\s+Build|[);])/)
          model = m ? m[1].trim() : 'Android'
        }
        return {
          userAgent: ua.slice(0, 200),
          platform: navigator.platform || null,
          vendor: navigator.vendor || null,
          language: navigator.language || null,
          model,
          os: isIOS ? 'iOS' : isAndroid ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown',
          devicePixelRatio: window.devicePixelRatio || 1,
          screenWidth: window.screen?.width || null,
          screenHeight: window.screen?.height || null,
          // Mic sample rate — helps calibrate
          micSampleRate: meterCtxRef.current?.sampleRate || null,
        }
      })(),
      noiseMeter: meter && meter.overallSustained != null ? {
        live: Math.round(meter.live),
        liveDba: meter.liveDba != null ? Math.round(meter.liveDba) : null,
        overallSustained: Math.round(meter.overallSustained),
        sustainedDba: meter.sustainedDba != null ? Math.round(meter.sustainedDba) : null,
        dominantHz: meter.dominantHz != null ? Math.round(meter.dominantHz) : null,
        dominantSustainedHz: meter.dominantSustainedHz != null ? Math.round(meter.dominantSustainedHz) : null,
        // Ambient floor — lowest sustained dBA seen since meter started
        floorDba: meter.floorDba != null ? Math.round(meter.floorDba) : null,
        floorSplEstimate: meter.floorDba != null ? Math.round(toSpl(meter.floorDba)) : null,
        // Estimated SPL using fixed +94 dB offset (1 Pa @ 1 kHz reference)
        liveSplEstimate: meter.liveDba != null ? Math.round(toSpl(meter.liveDba)) : null,
        sustainedSplEstimate: meter.sustainedDba != null ? Math.round(toSpl(meter.sustainedDba)) : null,
        splOffset: SPL_OFFSET,
        splGain: SPL_GAIN,
        mic: meterMicInfo,
        bands: METER_BANDS.map((b, i) => ({
          label: b.label,
          hzLo: b.lo,
          hzHi: b.hi,
          live: Math.round(meter.bands[i] ?? -100),
          sustained: Math.round(meter.sustained[i] ?? -100),
          liveDba: meter.bandsDba?.[i] != null ? Math.round(meter.bandsDba[i]) : null,
          sustainedDba: meter.sustainedBandsDba?.[i] != null ? Math.round(meter.sustainedBandsDba[i]) : null,
          liveSplEstimate: meter.bandsDba?.[i] != null ? Math.round(toSpl(meter.bandsDba[i])) : null,
          sustainedSplEstimate: meter.sustainedBandsDba?.[i] != null ? Math.round(toSpl(meter.sustainedBandsDba[i])) : null,
        })),
        peakClipDb: meter.peakClipChunks?.length ? Math.round(meter.peakClipDb) : null,
        // The actual audio bytes are POSTed to /api/noise-reports/:id/audio/loudest5s
        // separately; this just notes that a peak was captured.
        hasPeakClip: !!meter.peakClipChunks?.length,
      } : null,
      // Surface weather at the closest DFAID airport at submit time.
      // Wind direction shifts the heatmap-sampled dBA upwind; temp +
      // humidity affect sound absorption (audible distance grows ~10%
      // colder/drier; falls in warm humid air).
      weather: weather ? {
        icao: weather.icao,
        windDeg: weather.windDeg,
        windKt: weather.windKt,
        gustKt: weather.gustKt,
        tempC: weather.tempC,
        dewC: weather.dewC,
        humidityPct: weather.humidity,
        fetchedAt: new Date(weather.fetchedAt).toISOString(),
      } : null,
      // Modeled dBA at the reporter's location, sampled from the
      // flight-energy heatmap. For auto-fires, prefer the running max
      // observed during the tracked aircraft's approach over the live
      // snapshot — that's the loudest the aircraft modeled while close.
      calculatedNoise: (() => {
        const autoMax = allSegments
          .map((s) => s.autoMaxCalculatedDba)
          .filter((v) => v != null)
          .reduce((a, b) => Math.max(a, b), -Infinity)
        const finalDba = Number.isFinite(autoMax) ? autoMax : calculatedDba
        if (finalDba == null) return null
        return {
          dba: finalDba,
          liveDba: calculatedDba,
          maxDba: Number.isFinite(autoMax) ? autoMax : null,
          source: 'flight-energy-heatmap',
          scale: { min: 30, max: 95 },
        }
      })(),
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
            // Operator (school) intentionally omitted to preserve anonymity.
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

    // Stable local id used as a fallback if the server doesn't return one.
    // Same key is used for both the sessionReport entry and the local audio
    // map, so SavedReportDetails can find the URLs.
    const localFallbackId = `local-${Date.now()}`
    // Build the audio blob NOW (before POST) so we can stash a local object
    // URL the saved-report panel can play immediately. With the
    // MediaRecorder model we just snapshot the rolling 1-sec chunks; if a
    // peak was caught earlier we use those chunks, otherwise the latest.
    let peakBlob = null
    if (meterPcmRef.current) {
      try {
        if (meter.peakClipChunks?.length) {
          peakBlob = new Blob(meter.peakClipChunks, { type: meter.peakClipMime || meterPcmRef.current.mime })
        } else {
          peakBlob = meterPcmRef.current.getClip()
        }
      } catch (e) { console.warn('[audio] clip build failed', e?.message) }
    }
    const splicedBlob = peakBlob // single 1-sec blob serves both slots
    sessionAudioBlobsRef.current = { splicedBlob, peakBlob }

    const fullPromise = postFullReport({ meta })
      .then(async (result) => {
        const reportId = result?.id || null
        setFullId(reportId)
        setFullStatus('ok')
        // Stash local URLs by id so SavedReportDetails can play them
        // instantly (server URL is also valid once upload completes).
        const splicedUrl = splicedBlob ? URL.createObjectURL(splicedBlob) : null
        const peakUrl = peakBlob ? URL.createObjectURL(peakBlob) : null
        const audioKey = reportId || localFallbackId
        setLocalAudioById((m) => ({ ...m, [audioKey]: { splicedUrl, peakUrl } }))
        // Upload audio slots if we have a server-confirmed id.
        if (reportId) {
          if (splicedBlob) {
            try {
              await postReportAudio(reportId, 'spliced10s', splicedBlob)
              console.log('[audio] spliced10s uploaded', splicedBlob.size, 'bytes')
            } catch (e) { console.warn('[audio] spliced10s upload failed', e?.message) }
          }
          if (peakBlob) {
            try {
              await postReportAudio(reportId, 'loudest5s', peakBlob)
              console.log('[audio] loudest5s uploaded', peakBlob.size, 'bytes')
            } catch (e) { console.warn('[audio] loudest5s upload failed', e?.message) }
          }
        }
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
        meter?.overallSustained != null && `sustained ${Math.round(meter.overallSustained)} dBFS`,
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
    // Record the just-reported aircraft's distance so the auto-select
    // effect re-fires when a CLOSER aircraft appears later.
    if (nearestSegPoint && rawCoords) {
      lastReportedDistRef.current = haversine(rawCoords.lat, rawCoords.lng, nearestSegPoint.lat, nearestSegPoint.lng)
    } else {
      lastReportedDistRef.current = Infinity
    }
    // Reset audio-peak gate so the peak-based auto-select can fire again.
    autoPeakRef.current = -Infinity
    if (submitSource === 'auto') lastAutoReportRef.current = Date.now()

    // Track locally so anonymous users see their count increase immediately.
    // Embed the full meta so the expanded view has everything (no second fetch).
    // Derive top-level tail/type — auto-fires won't have selectedExcursion
    // set, so fall back to the first segment we're submitting.
    const topSeg = allSegments[0]
    setSessionReports((prev) => [{
      id: fullId || localFallbackId,
      createdAt: new Date().toISOString(),
      auto: submitSource === 'auto',
      tail: selectedExcursion?.tail || topSeg?.tail,
      type: selectedExcursion?.type || topSeg?.type,
      klass: selectedExcursion?.worst || topSeg?.klass,
      reportedSegments: allSegments.map((s) => ({
        tail: s.tail, klass: s.klass, zone: s.zone, type: s.type,
        nearestPt: s.nearestPt, points: s.points, role: s.role, auto: s.auto,
      })),
      // Surface fields used by SavedReportDetails on the expanded view.
      noiseMeter: meta.noiseMeter,
      calculatedNoise: meta.calculatedNoise,
      nearestFlightPoint: meta.nearestFlightPoint,
      excursion: meta.excursion,
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
        /* No transform transition: map pan/zoom would otherwise drag
           markers behind the basemap. Icons snap to their new position
           on each 5-second poll. */
        .leaflet-marker-icon.live-aircraft-icon { will-change: transform; }
        /* GPU-blurred heatmap overlay — softens the raster's pixel edges
           without any CPU cost. */
        .leaflet-image-layer.noise-heatmap-overlay {
          filter: blur(10px) saturate(1.1);
        }
        @keyframes autoBreath {
          0%, 100% { box-shadow: 0 0 0 0 rgba(251, 191, 36, 0.4); transform: scale(1); }
          50%      { box-shadow: 0 0 24px 6px rgba(251, 191, 36, 0.55); transform: scale(1.03); }
        }
        /* Aircraft icon being watched by the auto-report tracker — pulses
           in time with the Auto-Report toggle button so it's obvious which
           aircraft we're waiting on. Uses a halo via box-shadow on the
           inner img/div so leaflet's transform isn't disturbed. */
        @keyframes autoIconBreath {
          0%, 100% { filter: drop-shadow(0 0 0 rgba(251, 191, 36, 0)); }
          50%      { filter: drop-shadow(0 0 10px rgba(251, 191, 36, 0.95)); }
        }
        /* Excursive segments of the currently-selected aircraft pulse so
           the user can see where the incursion occurred on the map. */
        @keyframes excursionPulse {
          0%, 100% {
            stroke-width: 5;
            filter: drop-shadow(0 0 0 rgba(255,255,255,0));
          }
          50% {
            stroke-width: 9;
            filter: drop-shadow(0 0 8px rgba(255,255,255,0.8));
          }
        }
        .leaflet-overlay-pane svg path.excursion-pulse {
          animation: excursionPulse 1.4s ease-in-out infinite;
        }
        .leaflet-marker-icon.live-aircraft-icon.auto-tracked-icon > * {
          animation: autoIconBreath 1.6s ease-in-out infinite;
          outline: 2px solid rgba(251, 191, 36, 0.9);
          outline-offset: 2px;
          border-radius: 50%;
        }
        /* Manually-selected aircraft (from the side excursion list) — cyan
           ring + soft pulse so the user can locate it on the map. */
        @keyframes selectedIconBreath {
          0%, 100% { filter: drop-shadow(0 0 0 rgba(34, 211, 238, 0)); }
          50%      { filter: drop-shadow(0 0 12px rgba(34, 211, 238, 0.95)); }
        }
        .leaflet-marker-icon.live-aircraft-icon.selected-aircraft-icon > * {
          animation: selectedIconBreath 1.6s ease-in-out infinite;
          outline: 2.5px solid rgba(34, 211, 238, 0.95);
          outline-offset: 3px;
          border-radius: 50%;
        }
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
        // Prefer the timestamp of the hovered point (per-segment "ago"),
        // fall back to the track's lastSeenMs if the point has no ts.
        const pointTs = hoverCard.nearestPt?.[3]
        const ago = (pointTs != null
          ? formatAgo(pointTs)
          : (hoverCard.lastSeenMs ? formatAgo(hoverCard.lastSeenMs) : null))
        const pillBg = isExcursion
          ? 'bg-gradient-to-r from-rose-500 to-amber-500 shadow-[0_8px_24px_rgba(244,63,94,0.55)]'
          : 'bg-gradient-to-r from-orange-400 to-amber-400 shadow-[0_8px_24px_rgba(251,146,60,0.55)]'
        const arrowColor = isExcursion ? 'rgb(251,146,60)' : 'rgb(251,191,36)'
        const purposeInfo = purposeByTail[hoverCard.tail] || null
        // Anonymity: the operator name is never displayed; we only use the
        // is-school binary as a hint that the flight was training.
        const effectivePurpose = purposeInfo?.isSchool
          ? 'training'
          : labelPurpose(purposeInfo?.purpose)
        const intentLabel = labelIntent(purposeInfo?.intent)
        const typeLabel = labelType(hoverCard.type)
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
              className={`flex items-center gap-2 rounded-full text-white text-sm font-medium pl-4 pr-5 py-2 border border-white/15 whitespace-nowrap pointer-events-none ${pillBg}`}
              style={{
                // Multiply-style drop shadow on text — three layered dark
                // shadows give a high-contrast halo that stays readable
                // over any underlying map/track color.
                textShadow:
                  '0 1px 2px rgba(0,0,0,0.95),' +
                  '0 0 4px rgba(0,0,0,0.85),' +
                  '0 0 8px rgba(0,0,0,0.5)',
              }}
            >
              <span>
                {hoverCard.type && typeLabel}
                {purposeInfo?.specialRole
                  ? ` · ${purposeInfo.specialRole}`
                  : effectivePurpose && ` · ${effectivePurpose}`}
                {intentLabel && ` · ${intentLabel}`}
                {hoverCard.nearestPt?.[2] != null && ` · ${Math.round(hoverCard.nearestPt[2]).toLocaleString()} ft`}
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
          localAudioById={localAudioById}
        />
      )}

      {/* Left sidebar: dB meter + active excursions, stacked so they
          never overlap. Mobile keeps the excursion strip at the bottom. */}
      <aside className="absolute z-[1000] pointer-events-auto flex flex-col gap-2
        top-14 left-2 md:top-24 md:left-4 md:right-auto md:w-72 md:max-h-[calc(100vh-7rem)]">
        {meterStarted && (
          <DbMeter
            meter={meter}
            bands={METER_BANDS}
            started={meterStarted}
            error={meterError}
            onStart={() => startMeter()}
            onStop={() => { stopMeterStream(); setMeterStarted(false) }}
            devices={meterDevices}
            deviceId={meterDeviceId}
            onPickDevice={(id) => { meterTriedRef.current.clear(); startMeter(id) }}
            noSignal={meterNoSignal}
            splOffset={SPL_OFFSET}
            splGain={SPL_GAIN}
            micInfo={meterMicInfo}
          />
        )}
        {/* Calculated (model) dBA — always visible, even without the mic.
            Sourced entirely from the flight-energy heatmap + user location. */}
        <div className="w-full bg-black/40 backdrop-blur-md rounded-lg p-2.5 border border-sky-400/20">
          <div className="flex items-baseline justify-between">
            <span className="text-[9px] uppercase tracking-wider text-neutral-500">
              Calculated (model)
            </span>
            <span className="font-mono">
              <span className="text-sky-300 text-base">
                {calculatedDba != null ? calculatedDba : '—'}
              </span>
              <span className="text-[10px] text-neutral-500 ml-1">dBA</span>
            </span>
          </div>
          <div className="text-[9px] text-neutral-500 mt-0.5 break-words">
            {calculatedDba != null
              ? (selectedTail
                  ? `from selected aircraft at your location`
                  : trackedTails.size > 0
                    ? `from ${trackedTails.size} tracked aircraft`
                    : 'from flight-energy heatmap at your location')
              : (calculatedError || 'waiting for heatmap + location')}
          </div>
          {/* Wind row — direction degrees with a tiny SVG arrow + speed. */}
          {weather?.windDeg != null && (
            <div className="mt-1.5 flex items-center justify-between text-[10px] border-t border-white/5 pt-1.5">
              <span className="text-neutral-500 uppercase tracking-wider text-[9px]">
                Wind · {weather.icao}
              </span>
              <span className="font-mono text-neutral-300 inline-flex items-center gap-1">
                <svg width="10" height="10" viewBox="0 0 10 10"
                  style={{ transform: `rotate(${(weather.windDeg + 180) % 360}deg)` }}>
                  <path d="M5 1 L8 8 L5 6 L2 8 Z" fill="currentColor" />
                </svg>
                {weather.windDeg}° at {Math.round(weather.windKt)} kt
                {weather.gustKt ? `g${Math.round(weather.gustKt)}` : ''}
              </span>
            </div>
          )}
          {/* Location CTA — Safari iOS won't show the geolocation prompt
              without a user gesture, so we expose an explicit button. */}
          {!rawCoords && (
            <button
              onClick={() => requestLocation()}
              className="mt-2 w-full flex items-center justify-center gap-1.5 rounded-md bg-sky-500/30 hover:bg-sky-500/45 border border-sky-400/40 text-sky-100 text-[10px] py-1.5"
            >
              <IconMapPin size={11} />
              Enable my location
            </button>
          )}
          {/* Show a tiny "enable mic" hint under the model card when the
              user hasn't started the mic yet — they can still submit
              reports without it; mic just adds measured dBA + audio. */}
          {!meterStarted && (
            <button
              onClick={() => startMeter()}
              className="mt-2 w-full flex items-center justify-center gap-1.5 rounded-md bg-rose-500/30 hover:bg-rose-500/45 border border-rose-400/40 text-rose-100 text-[10px] py-1.5"
            >
              <IconMicrophone size={11} />
              Add measured dBA + audio
            </button>
          )}
        </div>
        <div className="hidden md:block">
          <ExcursionList
            activeList={activeList}
            activeStatus={activeStatus}
            selectedTail={selectedTail}
            onSelectTail={setSelectedTail}
            distanceByTail={distanceByTail}
            typePhotos={typePhotos}
          />
        </div>
      </aside>
      {/* Mobile: keep the excursion strip at the bottom of the screen */}
      <aside className="md:hidden absolute z-[1000] pointer-events-auto bottom-14 left-2 right-2">
        <ExcursionList
          activeList={activeList}
          activeStatus={activeStatus}
          selectedTail={selectedTail}
          onSelectTail={setSelectedTail}
          distanceByTail={distanceByTail}
          typePhotos={typePhotos}
        />
      </aside>

      {/* Bottom Action button — single primary CTA on the page.
          Three states: Start dB meter → Report Noise (please select…) → Report N Segments */}
      {!reportOpen && (() => {
        // Mic is OPTIONAL — selection + submission work without it. We only
        // show the "Start dB meter" prompt as the primary CTA when the user
        // has nothing else they could be doing (no mic AND no segment).
        const noMic = !meterStarted
        const fromActive = selectedTail
          ? activeList.find((a) => a.tail === selectedTail) || null
          : null
        const selectedExc = (selectedExcursion?.worst ? selectedExcursion : null) || (fromActive?.worst ? fromActive : null)
        // Three actionable states; mic is no longer required for any of them.
        const fromList = reportSegments.length === 0 && selectedExc
        const ready = reportSegments.length > 0
        // Disabled state: only when there's neither a mic to start nor a
        // segment to report. We keep "Start dB meter" as a useful CTA in
        // that case so the user has something productive to do.
        const noSegOrMic = !ready && !fromList && noMic // → "Start dB meter"
        const noSeg = !ready && !fromList && !noMic    // → "please select"
        const submitFromList = () => {
          // Single segment: whichever one of the selected aircraft's
          // segments has a point closest to the user. Carries the segment's
          // own klass (red/orange/yellow/purple/null) so the report records
          // both proximity and severity.
          const data = segmentsByTail[selectedExc.tail]
          let closeSeg = null, closePt = null, closeDist = Infinity
          if (data?.tracks && rawCoords) {
            for (const tk of data.tracks) {
              for (const seg of tk.segments || []) {
                if (!seg.points?.length) continue
                for (const p of seg.points) {
                  const d = haversine(rawCoords.lat, rawCoords.lng, p[0], p[1])
                  if (d < closeDist) {
                    closeDist = d; closeSeg = seg; closePt = p
                  }
                }
              }
            }
          }
          // Fall back: if we have no location, just grab the first segment.
          if (!closeSeg && data?.tracks?.[0]?.segments?.length) {
            closeSeg = data.tracks[0].segments[0]
            closePt = closeSeg.points?.[0]
          }
          if (closeSeg) {
            addReportSegment({
              tail: selectedExc.tail,
              lastSeenMs: selectedExc.lastSeenMs,
              klass: closeSeg.klass || selectedExc.worst,
              zone: closeSeg.zone || null,
              points: closeSeg.points,
              type: selectedExc.type,
              nearestPt: closePt,
              role: 'closest',
              distMeters: Number.isFinite(closeDist) ? closeDist : null,
            })
          }
          quickSubmit()
        }
        const onClick = noSegOrMic
          ? () => startMeter()
          : fromList
            ? submitFromList
            : ready
              ? () => quickSubmit()
              : undefined
        const label = noSegOrMic
          ? 'Start dB meter'
          : fromList
            ? `Report Noise Excursion · ${labelType(selectedExc.type)}`
            : noSeg
              ? 'Report Noise (please select a segment)'
              : (() => {
                  const uniqueTails = new Set(reportSegments.map((s) => s.tail))
                  const n = reportSegments.length
                  const a = uniqueTails.size
                  const autoCount = reportSegments.filter((s) => s.auto).length
                  const suffix = autoCount === reportSegments.length
                    ? ' (auto)'
                    : autoCount > 0 ? ` (${autoCount} auto)` : ''
                  // Single aircraft → show its type (anonymity-friendly).
                  // Drop the (auto) suffix when the user manually picked
                  // and the segments are role-tagged ('excursion'/'closest').
                  if (a === 1) {
                    const onlyTail = [...uniqueTails][0]
                    const seg = reportSegments.find((s) => s.tail === onlyTail)
                    const t = seg?.type || activeList.find((al) => al.tail === onlyTail)?.type
                    const userPicked = reportSegments.some((s) => s.role)
                    const finalSuffix = userPicked ? '' : suffix
                    if (t) return `Report ${labelType(t)}${finalSuffix}`
                  }
                  return `Report ${n} Segment${n > 1 ? 's' : ''} · ${a} Aircraft${suffix}`
                })()
        const Icon = noSegOrMic ? IconMicrophone : IconAlertTriangle
        // Collect type photos for every aircraft currently in reportSegments
        // (or the side-list-selected aircraft if segments haven't filled yet).
        // De-duped by type — same model from two tails shows once.
        const photoTypes = (() => {
          const types = new Set()
          for (const s of reportSegments) if (s.type) types.add(s.type)
          if (!types.size && fromList && selectedExc?.type) types.add(selectedExc.type)
          return [...types].filter((t) => typePhotos?.[t])
        })()
        const galleryShown = photoTypes.slice(0, 4)
        const galleryExtra = photoTypes.length - galleryShown.length
        return (
          <>
          {perfMode && (
            <div className="absolute bottom-2 right-2 z-[2000] rounded bg-black/85 border border-white/15 text-[10px] font-mono text-emerald-300 p-2 pointer-events-auto select-text leading-tight cursor-text" style={{ minWidth: 180, userSelect: 'text' }}>
              <div className="text-neutral-400 uppercase tracking-wider text-[9px] mb-1">perf · last 1 s</div>
              <div>raf fps: <span className="text-emerald-200">{perfRef.current.rafFpsDisp}</span> {perfRef.current.rafLongDisp > 0 && <span className="text-rose-300">({perfRef.current.rafLongDisp} slow)</span>}</div>
              <div>audio ticks: <span className="text-emerald-200">{perfRef.current.audioDisp}</span></div>
              <div>boot polls: <span className="text-emerald-200">{perfRef.current.bootDisp}</span></div>
              <div>heat computes: <span className="text-emerald-200">{perfRef.current.heatDisp}</span></div>
              <div>track redraws: <span className="text-emerald-200">{perfRef.current.drawsDisp}</span></div>
              <div className="text-neutral-500 mt-1 text-[9px]">tracks: {nearbyTracks.length} · pairs: {Array.from(drawnTracksRef.current.values()).reduce((n, s) => n + (s.pairs?.length || 0), 0)}</div>
              {/* eslint-disable-next-line no-unused-vars */}
              <div className="hidden">{perfTick}</div>
            </div>
          )}
          <div className="absolute bottom-[3.75rem] md:bottom-8 left-0 right-0 z-[1000] flex justify-center pointer-events-none pb-[env(safe-area-inset-bottom)]">
            <button
              onClick={onClick}
              disabled={noSeg}
              className={`pointer-events-auto group relative flex items-center gap-1.5 md:gap-3 rounded-full pl-1.5 md:pl-2 pr-3.5 md:pr-7 py-1.5 md:py-2 text-[11px] md:text-base font-semibold text-white transition-all ${
                noSeg
                  ? 'bg-neutral-700/80 cursor-not-allowed opacity-80'
                  : 'bg-gradient-to-r from-rose-500 to-amber-500 shadow-[0_10px_40px_rgba(244,63,94,0.45)] hover:shadow-[0_10px_50px_rgba(244,63,94,0.65)] hover:scale-[1.02]'
              }`}
              title={!meterStarted && (ready || fromList) ? 'Reporting without measured dBA — model dBA only' : ''}
            >
              {galleryShown.length > 0 ? (
                <div className="flex items-center -space-x-2">
                  {galleryShown.map((t) => (
                    <img
                      key={t}
                      src={typePhotos[t]}
                      alt={t}
                      title={labelType(t)}
                      className="h-7 w-7 md:h-9 md:w-9 rounded-full object-cover border-2 border-white/80 shadow ring-1 ring-black/30 bg-neutral-800"
                    />
                  ))}
                  {galleryExtra > 0 && (
                    <span className="h-7 w-7 md:h-9 md:w-9 rounded-full border-2 border-white/80 bg-black/70 text-[10px] flex items-center justify-center font-semibold">+{galleryExtra}</span>
                  )}
                </div>
              ) : (
                <span className="inline-flex items-center justify-center"><Icon size={14} /></span>
              )}
              <span className="px-1">{label}</span>
              {ready && <IconArrowRight size={14} />}
            </button>
            {ready && (
              <button
                onClick={() => {
                  setReportSegments([])
                  for (const p of selectedOverlaysRef.current) p.remove()
                  selectedOverlaysRef.current = []
                }}
                className="pointer-events-auto rounded-full bg-black/70 backdrop-blur-md border border-white/15 text-neutral-300 hover:text-white text-[11px] px-3 py-2 ml-2"
              >
                <IconX size={12} className="inline mr-1" />
                Clear
              </button>
            )}
            {meterStarted && (() => {
              const colorClass = autoReport
                ? autoActive
                  ? 'bg-amber-500/40 border-amber-400/80 text-amber-50 ring-2 ring-amber-400/50 animate-[autoBreath_1.6s_ease-in-out_infinite]'
                  : 'bg-emerald-500/30 border-emerald-400/60 text-emerald-100'
                : 'bg-black/70 border-white/15 text-neutral-300 hover:text-white'
              const trackedCount = trackedTails.size
              return (
                <button
                  onClick={() => setAutoReport((v) => !v)}
                  title="Auto-Report: every aircraft entering the 4 nm circle is tracked individually; a report fires when it departs past its closest approach"
                  className={`pointer-events-auto rounded-full backdrop-blur-md border text-[11px] px-3 py-2 ml-2 transition-colors ${colorClass}`}
                >
                  <span className={`inline-block h-1.5 w-1.5 rounded-full mr-1.5 align-middle ${
                    autoReport
                      ? autoActive ? 'bg-amber-300 animate-pulse' : 'bg-emerald-300 animate-pulse'
                      : 'bg-neutral-500'
                  }`} />
                  {autoReport ? (
                    <>
                      Auto-Report
                      {autoActive ? (
                        <span className="ml-1 font-semibold">· tracking {trackedCount} aircraft</span>
                      ) : (
                        <span className="ml-1 text-[10px] opacity-80">· armed (4 nm)</span>
                      )}
                      {windowPeakDba != null && (
                        <span className="ml-2 text-[10px] font-mono opacity-90">peak {windowPeakDba} dBA</span>
                      )}
                    </>
                  ) : 'Auto-Report off'}
                </button>
              )
            })()}
          </div>
          </>
        )
      })()}

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
                      meter={meter}
                      meterBands={METER_BANDS}
                      meterStarted={meterStarted}
                      meterError={meterError}
                      startMeter={startMeter}
                      meterDevices={meterDevices}
                      meterDeviceId={meterDeviceId}
                      meterTriedRef={meterTriedRef}
                      meterMicInfo={meterMicInfo}
                      splOffset={SPL_OFFSET}
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
    meter, meterBands, meterStarted, meterError, startMeter, meterDevices, meterDeviceId,
    meterTriedRef, meterMicInfo, splOffset,
  } = props
  return (
    <>
      <Card title="Record the Aircraft" subtitle="Capture 5 seconds of audio, or a short video for stronger evidence.">
        <div className="flex flex-col items-center gap-3">
          {!audioBlob && (
            <>
              <CircularCaptureButton
                recording={recordingAudio}
                progress={audioProgress}
                level={audioLevel}
                onClick={startAudio}
                hasRecording={false}
                icon={IconMicrophone}
                idleLabel="Record audio"
              />
              <div className="text-[11px] text-neutral-500 text-center">
                {recordingAudio
                  ? `Recording… ${Math.max(0, 5 - Math.round(audioProgress * 5))}s`
                  : 'Tap to record 5 seconds'}
              </div>
            </>
          )}
          {audioUrl && !recordingAudio && (
            <>
              <div className="flex items-center gap-1.5 text-[11px] text-emerald-300">
                <IconCheck size={12} stroke={3} /> Loudest 5s captured automatically
              </div>
              <audio controls src={audioUrl} className="w-full" />
              <button
                onClick={startAudio}
                className="text-[10px] text-neutral-500 hover:text-neutral-300 underline underline-offset-2"
              >
                Re-record manually
              </button>
            </>
          )}
          {audioError && <div className="text-xs text-rose-300">{audioError}</div>}
          <DbMeter
            meter={meter}
            bands={meterBands}
            started={meterStarted}
            error={meterError}
            onStart={() => startMeter()}
            devices={meterDevices}
            deviceId={meterDeviceId}
            onPickDevice={(id) => { meterTriedRef?.current?.clear(); startMeter(id) }}
            splOffset={splOffset}
            splGain={1.5}
            micInfo={meterMicInfo}
          />
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

/**
 * dB meter — 5 frequency bands with live level + sustained (5-sec min) floor.
 * Scale: -80 dBFS (quiet) to 0 dBFS (max). Live rendered as filled bar,
 * sustained as a horizontal tick mark.
 */
function DbMeter({ meter, bands = [], started, error, onStart, onStop, devices = [], deviceId, onPickDevice, noSignal, splOffset = 94, splGain = 1, micInfo }) {
  const toSpl = (dbfsA) => dbfsA == null ? null : (dbfsA + splOffset) * splGain
  // Hold the last positive value across re-renders so the meter never
  // visibly blanks — a brief negative computed value just keeps the prior
  // displayed number until the next positive reading arrives.
  const lastPosRef = useRef({ sustained: null, bands: [], sustainedBands: [], floor: null, dominantHz: null })
  const sustainedSpl = (() => {
    const v = toSpl(meter.sustainedDba)
    if (v != null && v > 0) lastPosRef.current.sustained = v
    return lastPosRef.current.sustained
  })()
  const bandSpl = (i) => {
    const v = toSpl(meter.bandsDba?.[i])
    if (v != null && v > 0) lastPosRef.current.bands[i] = v
    return lastPosRef.current.bands[i]
  }
  const sustainedBandSpl = (i) => {
    const v = toSpl(meter.sustainedBandsDba?.[i])
    if (v != null && v > 0) lastPosRef.current.sustainedBands[i] = v
    return lastPosRef.current.sustainedBands[i]
  }
  if (!started) {
    return (
      <div className="w-full bg-black/60 backdrop-blur-md rounded-lg p-2.5 border border-white/10">
        <button
          onClick={onStart}
          className="w-full flex items-center justify-center gap-1.5 rounded-full bg-gradient-to-r from-rose-500 to-amber-500 text-white text-[11px] font-semibold py-2 shadow-[0_8px_24px_rgba(244,63,94,0.45)] hover:shadow-[0_8px_32px_rgba(244,63,94,0.65)] transition-all hover:scale-[1.02]"
        >
          <IconMicrophone size={14} />
          Start dB meter
        </button>
        {error && <div className="mt-1.5 text-[10px] text-rose-300 text-center">{error}</div>}
      </div>
    )
  }
  if (!meter || meter.live == null) {
    return (
      <div className="w-full text-[10px] text-neutral-500 text-center py-2">
        Initializing mic…
      </div>
    )
  }
  // Map dBA SPL 0..100 → 0..100% bar height. The +94 dB SPL offset is
  // a rough estimate for an uncalibrated consumer mic; many laptop mics
  // read low, so we keep the floor at 0 so any signal at all is visible.
  const dbaToPct = (dba) => Math.max(0, Math.min(100, dba))
  return (
    <div className="w-full bg-black/30 rounded-lg p-2.5 border border-white/10 min-h-[208px]">
      {(devices.length > 1 || noSignal) && (
        <>
          {noSignal && (
            <div className="mb-1.5 text-[10px] text-amber-300 text-center">
              No signal — try another mic:
            </div>
          )}
          <select
            value={deviceId || ''}
            onChange={(e) => onPickDevice && onPickDevice(e.target.value)}
            className={`w-full mb-1.5 bg-black/50 border rounded px-1.5 py-1 text-[10px] ${
              noSignal ? 'border-amber-400/60 text-amber-200' : 'border-white/10 text-neutral-300'
            }`}
            title="Switch microphone"
          >
            {devices.length === 0 && <option value="">(default mic)</option>}
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Mic (${d.deviceId.slice(0, 6)})`}
              </option>
            ))}
          </select>
        </>
      )}
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[9px] uppercase tracking-wider text-neutral-500">Sound by frequency</span>
        <span className="font-mono">
          {sustainedSpl != null
            ? <span className="text-amber-300 text-base">{Math.round(sustainedSpl)}</span>
            : <span className="text-neutral-500">—</span>}
          <span className="text-[10px] text-neutral-500 ml-1">dBA</span>
        </span>
      </div>
      {/* Per-band live dBA bars — vertical, clipped from the top so the
          coloured gradient at the bar's tip reflects the current level. */}
      {meter.bandsDba && bands.length > 0 && (
        <div className="flex items-stretch gap-1">
          {bands.map((b, i) => {
            const dba = bandSpl(i)
            const susDba = sustainedBandSpl(i)
            const livePct = dba != null ? dbaToPct(dba) : 0
            const susPct = susDba != null ? dbaToPct(susDba) : 0
            return (
              <div key={b.label} className="flex-1 flex flex-col items-center gap-0.5 min-w-0">
                <div className="w-full text-[9px] font-mono text-amber-300 text-center leading-none">
                  {dba != null ? dba.toFixed(0) : '—'}
                </div>
                <div className="relative w-full h-20 bg-white/5 rounded overflow-hidden">
                  <div
                    className="absolute inset-0 bg-gradient-to-t from-sky-500 via-amber-400 to-rose-500"
                    style={{
                      clipPath: `inset(${100 - livePct}% 0 0 0)`,
                      // Transition slightly longer than the 500 ms tick
                      // so each value glides into the next without a gap.
                      transition: 'clip-path 600ms ease-out',
                    }}
                  />
                  {susDba != null && (
                    <div
                      className="absolute left-0 right-0 h-0.5 bg-white/80"
                      style={{ bottom: `${susPct}%` }}
                      title={`Sustained ${susDba.toFixed(0)} dBA`}
                    />
                  )}
                </div>
                <div className="text-[8px] text-neutral-500 truncate w-full text-center">{b.label}</div>
              </div>
            )
          })}
        </div>
      )}
      {/* Fixed-height info rows so the card never resizes between updates. */}
      <div className="mt-1.5 flex items-baseline justify-between text-[10px] h-[14px]">
        <span className="text-neutral-500 uppercase tracking-wider text-[9px]">Dominant freq</span>
        <span className="font-mono text-amber-200">
          {(() => {
            // Hold the last valid (>0 Hz) reading so the display never
            // flashes "—" when the FFT-bin median momentarily collapses
            // to 0 (silent moment, no dominant peak).
            const v = meter.dominantSustainedHz
            if (v != null && v > 0) lastPosRef.current.dominantHz = v
            const hold = lastPosRef.current.dominantHz
            return hold != null
              ? (hold < 1000 ? `${Math.round(hold)} Hz` : `${(hold / 1000).toFixed(2)} kHz`)
              : '—'
          })()}
        </span>
      </div>
      <div className="mt-1 flex items-baseline justify-between text-[10px] h-[14px]">
        <span className="text-neutral-500 uppercase tracking-wider text-[9px]">Floor</span>
        <span className="font-mono text-neutral-300">
          {(() => {
            const v = toSpl(meter.floorDba)
            if (v != null && v > 0) lastPosRef.current.floor = v
            return lastPosRef.current.floor != null
              ? `${Math.round(lastPosRef.current.floor)} dBA`
              : '—'
          })()}
        </span>
      </div>
      <div className="mt-1 text-[9px] text-neutral-500 truncate h-[12px]" title={micInfo?.label || ''}>
        {micInfo?.label || ''}
      </div>
      <div className="mt-1 text-[9px] text-emerald-300 text-center h-[12px]">
        {meter.peakClipChunks?.length ? '✓ Loudest 1s preserved' : ''}
      </div>
      {onStop && (
        <button
          onClick={onStop}
          className="mt-1 w-full text-[10px] text-neutral-400 hover:text-rose-300 underline underline-offset-2"
          title="Release the microphone — system audio (YouTube, music) plays normally while the mic is off."
        >
          Pause mic
        </button>
      )}
    </div>
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

/**
 * Expanded detail strip for a saved noise report — shows the new meter
 * fields (floor, dominant Hz, calculated dBA, special-use flag) plus
 * playback for the two audio slots stored at /api/noise-reports/:id/audio/:slot.
 */
/**
 * Compact play/pause button for an audio URL. No scrub bar, no time —
 * just a circular button that toggles playback.
 */
function MiniAudio({ src, label }) {
  const ref = useRef(null)
  const [playing, setPlaying] = useState(false)
  if (!src) return null
  const toggle = () => {
    const a = ref.current
    if (!a) return
    if (a.paused) { a.play().catch(() => {}); setPlaying(true) }
    else { a.pause(); setPlaying(false) }
  }
  return (
    <button
      onClick={toggle}
      title={label}
      className="inline-flex items-center justify-center h-7 w-7 rounded-full bg-sky-500/20 hover:bg-sky-500/35 border border-sky-400/30 text-sky-200 transition-colors"
    >
      {playing
        ? <IconPlayerStopFilled size={12} />
        : (<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>)}
      <audio ref={ref} src={src} preload="none" onEnded={() => setPlaying(false)} className="hidden" />
    </button>
  )
}

function SavedReportDetails({ report, localAudio }) {
  if (!report) return null
  const id = report.id
  const isLocal = !id || String(id).startsWith('local-')
  const m = report.noiseMeter || report.meta?.noiseMeter || null
  const calc = report.calculatedNoise || report.meta?.calculatedNoise || null
  const auto = report.auto ?? report.meta?.auto
  const nearest = report.nearestFlightPoint || report.meta?.nearestFlightPoint || null
  // Prefer local object URL (instant play, even before/while upload completes);
  // fall back to server URL once we have a confirmed report id.
  const peakSrc = localAudio?.peakUrl || (!isLocal ? reportAudioUrl(id, 'loudest5s') : null)
  const splicedSrc = localAudio?.splicedUrl || (!isLocal ? reportAudioUrl(id, 'spliced10s') : null)
  // Distance in 100s of feet — show only when we have a real flight point.
  const distFt = nearest?.distMeters != null ? Math.round((nearest.distMeters * 3.28084) / 100) * 100 : null
  return (
    <div className="px-5 py-3 bg-black/40 border-t border-white/5 text-[11px]">
      {auto && (
        <div className="mb-1.5 inline-block rounded-full bg-amber-500/20 border border-amber-400/40 text-amber-200 text-[9px] px-2 py-0.5">
          auto-fired
        </div>
      )}
      {m && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 mb-2">
          {m.sustainedSplEstimate != null && (
            <div className="flex justify-between"><span className="text-neutral-500">sustained</span><span className="font-mono text-amber-200">{m.sustainedSplEstimate} dBA</span></div>
          )}
          {m.floorSplEstimate != null && (
            <div className="flex justify-between"><span className="text-neutral-500">floor</span><span className="font-mono text-neutral-300">{m.floorSplEstimate} dBA</span></div>
          )}
          {m.dominantSustainedHz != null && (
            <div className="flex justify-between col-span-2"><span className="text-neutral-500">dominant freq</span><span className="font-mono text-amber-200">
              {m.dominantSustainedHz < 1000 ? `${m.dominantSustainedHz} Hz` : `${(m.dominantSustainedHz / 1000).toFixed(2)} kHz`}
            </span></div>
          )}
          {calc?.dba != null && (
            <div className="flex justify-between col-span-2"><span className="text-neutral-500">calculated (model)</span><span className="font-mono text-sky-300">{calc.dba} dBA</span></div>
          )}
          {distFt != null && (
            <div className="flex justify-between col-span-2"><span className="text-neutral-500">distance to aircraft</span><span className="font-mono text-neutral-300">{distFt.toLocaleString()} ft</span></div>
          )}
        </div>
      )}
      <div className="flex items-center gap-3">
        {peakSrc && (
          <div className="flex items-center gap-1.5">
            <MiniAudio src={peakSrc} label="Loudest 5 s" />
            <span className="text-[10px] text-neutral-500">peak 5s</span>
          </div>
        )}
        {splicedSrc && (
          <div className="flex items-center gap-1.5">
            <MiniAudio src={splicedSrc} label="Spliced 10 s" />
            <span className="text-[10px] text-neutral-500">spliced 10s</span>
          </div>
        )}
        {!peakSrc && !splicedSrc && (
          <p className="text-[10px] text-neutral-500">No audio captured.</p>
        )}
      </div>
    </div>
  )
}

function MyComplaintsPanel({ identity, complaints, reports, sessionReports, status, activeList, locality, viewingReport, onViewReport, onRefresh, onClose, onSetIdentity, localAudioById = {} }) {
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
        {identity && status === 'ok' && complaints.length === 0 && sessionReports.length === 0 && (reports?.length ?? 0) === 0 && (
          <p className="p-5 text-[11px] text-neutral-500">No reports filed yet.</p>
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
                          {/* Tail intentionally hidden — show aircraft type only for anonymity */}
                          {labelType(c.type || match?.excursion?.type)}
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
                {isViewing && match && <SavedReportDetails report={match} localAudio={localAudioById[match.id]} />}
              </li>
            )
          })}
          {/* Standalone noise-reports (no matching complaint) — fetched
              from /api/noise-reports?reporter=… so they survive refresh. */}
          {(reports || []).filter((r) => !complaints.some((c) => c.tail === r.excursion?.tail)).map((r) => {
            const isViewing = viewingReport === r
            return (
              <li key={r.id}>
                <button
                  onClick={() => onViewReport(isViewing ? null : r)}
                  className={[
                    'w-full text-left px-5 py-3 transition-colors',
                    isViewing ? 'bg-sky-400/10' : 'hover:bg-white/[0.04] cursor-pointer',
                  ].join(' ')}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ background: '#38bdf8' }} />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-neutral-100 truncate">
                          {/* Tail intentionally hidden — show aircraft type only for anonymity */}
                          {labelType(r.excursion?.type || r.reportedSegments?.[0]?.type)}
                          {r.auto && <span className="ml-1.5 text-[9px] text-amber-300">· auto</span>}
                          <span className={`ml-1.5 text-[9px] ${isViewing ? 'text-sky-300' : 'text-neutral-500'}`}>
                            {isViewing ? '(viewing)' : '(tap to view)'}
                          </span>
                        </div>
                        <div className="text-[10px] text-neutral-500 truncate">
                          {(r.reportedSegments || r.meta?.reportedSegments || []).length} segment{(r.reportedSegments?.length || 0) === 1 ? '' : 's'} · {formatAgo(Date.parse(r.submittedAt || r.receivedAt || r.createdAt || ''))}
                        </div>
                      </div>
                    </div>
                  </div>
                </button>
                {isViewing && <SavedReportDetails report={r} localAudio={localAudioById[r.id]} />}
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
                          {/* Tail intentionally hidden — show aircraft type only for anonymity */}
                          {labelType(sr.type) || 'Flight report'}
                          <span className={`ml-1.5 text-[9px] ${isViewing ? 'text-sky-300' : 'text-neutral-500'}`}>
                            {isViewing ? '(viewing)' : '(tap to view)'}
                          </span>
                        </div>
                        <div className="text-[10px] text-neutral-500 truncate">
                          {sr.reportedSegments?.length || 0} segment{(sr.reportedSegments?.length || 0) === 1 ? '' : 's'} · {formatAgo(Date.parse(sr.createdAt))}
                          {sr.auto && <span className="ml-1 text-[9px] text-amber-300">· auto</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                </button>
                {isViewing && <SavedReportDetails report={sr} localAudio={localAudioById[sr.id]} />}
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
      // Anonymity: include aircraft type, not tail.
      lines.push(`  • ${labelType(c.type) || 'aircraft'} — ${c.klass || 'unclassified'} — ${c.zone || 'unknown zone'} — ${when}`)
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
