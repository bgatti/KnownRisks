import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { fetchAllComplaints, fetchAllNoiseReports, fetchActiveExcursions, KLASS_COLORS } from './noiseApi'
import { NOISE_ZONES } from './noiseZones'
import { AIRPORTS } from './airports'

const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png'
const LABEL_URL = 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png'

const KBDU = [40.0394, -105.2258]
const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000

const TIME_RANGES = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
  { label: '90d', hours: 2160 },
  { label: 'All', hours: null },
]

// Quality filter: complaint.score is 0–10
const QUALITY_TIERS = [
  { label: 'Any',  min: 0 },
  { label: '3+',   min: 3,  desc: 'Useful — cross-street' },
  { label: '5+',   min: 5,  desc: 'Good — precise location' },
  { label: '8+',   min: 8,  desc: 'Strong — audio/video + precise' },
]

// Proximity filter: complaint.distanceMiles (reporter-to-aircraft, Fibonacci-rounded)
// These thresholds align with the Fibonacci rounding buckets.
const PROXIMITY_OPTIONS = [
  { label: '0.3 mi', maxMi: 0.3 },
  { label: '0.8 mi', maxMi: 0.8 },
  { label: '1.3 mi', maxMi: 1.3 },
  { label: '3.4 mi', maxMi: 3.4 },
  { label: 'Any',    maxMi: null },
]

// Evidence / credibility filter
const MEDIA_OPTIONS = [
  { label: 'Any',   value: null },
  { label: 'Audio', value: 'audio' },
  { label: 'Video', value: 'video' },
]

const AIRPORT_SUBSET = ['KBDU', 'KBJC', 'KLMO', 'KEIK', 'KFNL']

// ─── Heatmap renderer ────────────────────────────────────────────────────────
// Client-side canvas heatmap: Gaussian splat for each complaint point.
// Weight = complaint score, so high-quality reports produce hotter spots.

const HEATMAP_HALF_KM = 12
const HEATMAP_CELL_M = 80
const SPLAT_RADIUS_M = 600

function computeComplaintHeatmap(points, weights) {
  if (!points.length) return null

  const lat0 = KBDU[0]
  const lon0 = KBDU[1]
  const mPerDegLat = 111320
  const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180)

  const n = Math.max(32, Math.round((2 * HEATMAP_HALF_KM * 1000) / HEATMAP_CELL_M))
  const grid = new Float64Array(n * n)
  const halfIdx = (n - 1) / 2
  const sigma = SPLAT_RADIUS_M / HEATMAP_CELL_M
  const sigma2 = sigma * sigma
  const rCells = Math.ceil(sigma * 3)

  for (let pi = 0; pi < points.length; pi++) {
    const [lat, lon] = points[pi]
    const w = weights[pi]
    const cx = (lon - lon0) * mPerDegLon / HEATMAP_CELL_M + halfIdx
    const cy = (lat - lat0) * mPerDegLat / HEATMAP_CELL_M + halfIdx

    const x0 = Math.max(0, Math.floor(cx - rCells))
    const x1 = Math.min(n, Math.ceil(cx + rCells) + 1)
    const y0 = Math.max(0, Math.floor(cy - rCells))
    const y1 = Math.min(n, Math.ceil(cy + rCells) + 1)

    for (let row = y0; row < y1; row++) {
      const dy = row - cy
      for (let col = x0; col < x1; col++) {
        const dx = col - cx
        const d2 = dx * dx + dy * dy
        if (d2 > rCells * rCells) continue
        grid[row * n + col] += w * Math.exp(-d2 / (2 * sigma2))
      }
    }
  }

  let maxVal = 0
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] > maxVal) maxVal = grid[i]
  }
  if (maxVal <= 0) return null

  const canvas = document.createElement('canvas')
  canvas.width = n
  canvas.height = n
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(n, n)

  for (let row = 0; row < n; row++) {
    const srcRow = n - 1 - row
    for (let col = 0; col < n; col++) {
      const v = grid[srcRow * n + col]
      const idx = (row * n + col) * 4
      if (v <= 0) { img.data[idx + 3] = 0; continue }

      const t = Math.min(1, v / maxVal)
      let r, g, b
      if (t < 0.25) {
        const s = t / 0.25
        r = Math.round(49 + (69 - 49) * s)
        g = Math.round(54 + (173 - 54) * s)
        b = Math.round(149 + (209 - 149) * s)
      } else if (t < 0.5) {
        const s = (t - 0.25) / 0.25
        r = Math.round(69 + (171 - 69) * s)
        g = Math.round(173 + (217 - 173) * s)
        b = Math.round(209 + (233 - 209) * s)
      } else if (t < 0.75) {
        const s = (t - 0.5) / 0.25
        r = Math.round(171 + (254 - 171) * s)
        g = Math.round(217 + (224 - 217) * s)
        b = Math.round(233 + (144 - 233) * s)
      } else {
        const s = (t - 0.75) / 0.25
        r = Math.round(254 + (165 - 254) * s)
        g = Math.round(224 + (0 - 224) * s)
        b = Math.round(144 + (38 - 144) * s)
      }
      img.data[idx] = r
      img.data[idx + 1] = g
      img.data[idx + 2] = b
      img.data[idx + 3] = Math.round(30 + 200 * Math.pow(t, 0.6))
    }
  }
  ctx.putImageData(img, 0, 0)

  const dLat = (HEATMAP_HALF_KM * 1000) / mPerDegLat
  const dLon = (HEATMAP_HALF_KM * 1000) / mPerDegLon

  return {
    url: canvas.toDataURL('image/png'),
    bounds: [[lat0 - dLat, lon0 - dLon], [lat0 + dLat, lon0 + dLon]],
    maxVal,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`)
    if (existing) {
      if (existing.dataset.loaded) return resolve()
      existing.addEventListener('load', resolve)
      existing.addEventListener('error', reject)
      return
    }
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.onload = () => { s.dataset.loaded = '1'; resolve() }
    s.onerror = reject
    document.head.appendChild(s)
  })
}

function loadLeaflet() {
  return new Promise(async (resolve, reject) => {
    try {
      if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = LEAFLET_CSS
        document.head.appendChild(link)
      }
      if (!window.L) await loadScript(LEAFLET_JS)
      resolve(window.L)
    } catch (e) { reject(e) }
  })
}

// Extract flight position from a complaint (new fields) or noise report (fallbacks).
function extractLatLon(item) {
  // New complaint fields: lat/lon = flight segment position
  if (item.lat != null && item.lon != null) return [item.lat, item.lon]
  if (item.lat != null && item.lng != null) return [item.lat, item.lng]
  // Noise report: nearestFlightPoint
  const nfp = item.nearestFlightPoint
  if (nfp && nfp.lat != null && (nfp.lon != null || nfp.lng != null))
    return [nfp.lat, nfp.lon ?? nfp.lng]
  // Noise report: reporter location (fallback for old data)
  const loc = item.location
  if (loc && loc.lat != null && (loc.lon != null || loc.lng != null))
    return [loc.lat, loc.lon ?? loc.lng]
  return null
}

// Resolve complaint score to a 0–10 int.
// New field: complaint.score (int 0–10) — use directly.
// Old complaints: parse "Score N/10" from notes, or infer from klass.
function resolveScore(item) {
  // New field (int 0–10)
  if (typeof item.score === 'number') return item.score
  // Noise report score object {total, max, tier}
  if (item.score && typeof item.score === 'object' && item.score.total != null)
    return item.score.total
  // Legacy: parse notes "Score 8/10 (Strong)"
  if (typeof item.notes === 'string') {
    const m = item.notes.match(/Score\s+(\d+)\/10/)
    if (m) return parseInt(m[1], 10)
  }
  // Fallback: klass severity as proxy
  if (item.klass === 'red') return 7
  if (item.klass === 'orange') return 5
  if (item.klass === 'yellow') return 3
  return 1
}

function timeAgo(dateStr) {
  const ms = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m ago`
}

// ─── Filter pipeline ─────────────────────────────────────────────────────────

function buildFilteredItems(complaints, noiseReports, timeRange, qualityTier, proximityOpt, mediaFilter) {
  const now = Date.now()
  const cutoff = timeRange.hours ? now - timeRange.hours * 3600_000 : 0

  const items = []

  for (const c of complaints) {
    const pos = extractLatLon(c)
    if (!pos) continue
    const t = new Date(c.createdAt).getTime()
    if (t < cutoff) continue

    const score = resolveScore(c)
    if (score < qualityTier.min) continue

    // Proximity: complaint.distanceMiles = reporter-to-aircraft distance
    if (proximityOpt.maxMi != null) {
      if (c.distanceMiles != null && c.distanceMiles > proximityOpt.maxMi) continue
      // Old complaints without distanceMiles: let them through (can't filter)
    }

    // Media credibility filter
    if (mediaFilter.value != null) {
      if ((c.mediaKind || null) !== mediaFilter.value) continue
    }

    // Weight = score / 10 so a score-10 report is 1.0 and score-1 is 0.1
    items.push({ pos, weight: Math.max(0.1, score / 10), score, source: c, type: 'complaint' })
  }

  for (const r of noiseReports) {
    const t = new Date(r.receivedAt || r.submittedAt).getTime()
    if (t < cutoff) continue
    const score = resolveScore(r)
    if (score < qualityTier.min) continue

    // Media filter for noise reports
    if (mediaFilter.value != null) {
      const mk = r.media?.audio ? 'audio' : r.media?.video ? 'video' : null
      if (mk !== mediaFilter.value) continue
    }

    // Segments spread across path
    const segs = r.reportedSegments || []
    let usedSegments = false
    for (const seg of segs) {
      const pts = seg.points || []
      if (pts.length === 0) continue
      const w = Math.max(0.1, score / 10) / Math.max(pts.length, 1)
      for (const p of pts) {
        if (p[0] == null || p[1] == null) continue
        items.push({ pos: [p[0], p[1]], weight: w, score, source: r, type: 'report-seg' })
        usedSegments = true
      }
    }

    if (!usedSegments) {
      const pos = extractLatLon(r)
      if (!pos) continue
      items.push({ pos, weight: Math.max(0.1, score / 10), score, source: r, type: 'report' })
    }
  }

  return items
}

function buildLiveMarkers(complaints, noiseReports) {
  const now = Date.now()
  const cutoff = now - LIVE_WINDOW_MS
  const markers = []

  for (const c of complaints) {
    const pos = extractLatLon(c)
    if (!pos) continue
    if (new Date(c.createdAt).getTime() < cutoff) continue
    markers.push({ ...c, lat: pos[0], lon: pos[1], _score: resolveScore(c) })
  }

  for (const r of noiseReports) {
    const t = new Date(r.receivedAt || r.submittedAt).getTime()
    if (t < cutoff) continue
    const pos = extractLatLon(r)
    if (!pos) continue
    markers.push({
      lat: pos[0], lon: pos[1],
      createdAt: r.receivedAt || r.submittedAt,
      klass: r.excursion?.worst || (typeof r.score === 'object' ? r.score?.tier?.toLowerCase() : null) || 'yellow',
      zone: r.excursion?.zone || r.location?.display || 'Unknown',
      tail: r.excursion?.tail || '?',
      type: r.excursion?.type || null,
      _score: resolveScore(r),
      mediaKind: r.media?.audio ? 'audio' : r.media?.video ? 'video' : null,
      id: r.id,
    })
  }

  return markers
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function NoiseHeatmap() {
  const mapRef = useRef(null)
  const mapElRef = useRef(null)
  const heatOverlayRef = useRef(null)
  const liveLayerRef = useRef(null)
  const zoneLayerRef = useRef(null)
  const airportLayerRef = useRef(null)
  const excursionLayerRef = useRef(null)

  const [complaints, setComplaints] = useState([])
  const [noiseReports, setNoiseReports] = useState([])
  const [activeExcursions, setActiveExcursions] = useState([])

  const [timeRange, setTimeRange] = useState(TIME_RANGES[1])
  const [qualityTier, setQualityTier] = useState(QUALITY_TIERS[0])
  const [proximityOpt, setProximityOpt] = useState(PROXIMITY_OPTIONS[4])
  const [mediaFilter, setMediaFilter] = useState(MEDIA_OPTIONS[0])
  const [layers, setLayers] = useState({
    historic: true,
    live: true,
    zones: false,
    airports: true,
    excursions: false,
  })

  const [mapReady, setMapReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [stats, setStats] = useState(null)

  const toggleLayer = useCallback((key) => {
    setLayers(prev => ({ ...prev, [key]: !prev[key] }))
  }, [])

  // ─── Init map ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    loadLeaflet().then(L => {
      if (cancelled || mapRef.current) return
      const map = L.map(mapElRef.current, {
        center: KBDU,
        zoom: 12,
        zoomControl: false,
        attributionControl: false,
      })
      L.tileLayer(TILE_URL, { maxZoom: 19 }).addTo(map)
      L.tileLayer(LABEL_URL, { maxZoom: 19, pane: 'overlayPane' }).addTo(map)
      L.control.zoom({ position: 'bottomright' }).addTo(map)
      mapRef.current = map
      setMapReady(true)
    })
    return () => { cancelled = true }
  }, [])

  // ─── Fetch data ────────────────────────────────────────────────────────────
  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    setError(null)
    Promise.all([
      fetchAllComplaints({ signal: ac.signal }),
      fetchAllNoiseReports({ signal: ac.signal }),
      fetchActiveExcursions({ hours: 2, include: ['reports', 'notifications'], signal: ac.signal }),
    ])
      .then(([c, r, exc]) => {
        setComplaints(c)
        setNoiseReports(r)
        setActiveExcursions(exc.active || [])
        setLoading(false)
      })
      .catch(e => {
        if (e.name !== 'AbortError') {
          setError(e.message)
          setLoading(false)
        }
      })
    return () => ac.abort()
  }, [])

  // ─── Filtered items (memoized) ─────────────────────────────────────────────
  const filteredItems = useMemo(
    () => buildFilteredItems(complaints, noiseReports, timeRange, qualityTier, proximityOpt, mediaFilter),
    [complaints, noiseReports, timeRange, qualityTier, proximityOpt, mediaFilter],
  )

  // ─── Client-side heatmap overlay ───────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    const L = window.L
    if (!map || !L) return

    if (heatOverlayRef.current) {
      map.removeLayer(heatOverlayRef.current)
      heatOverlayRef.current = null
    }

    if (!layers.historic) {
      setStats(prev => prev ? { ...prev, filteredPoints: 0 } : null)
      return
    }

    const points = filteredItems.map(it => it.pos)
    const weights = filteredItems.map(it => it.weight)

    setStats({
      complaints: complaints.length,
      reports: noiseReports.length,
      filteredPoints: points.length,
    })

    if (points.length === 0) return

    const result = computeComplaintHeatmap(points, weights)
    if (!result) return

    const overlay = L.imageOverlay(result.url, result.bounds, {
      opacity: 0.85,
      interactive: false,
      className: 'heatmap-overlay',
    })
    overlay.addTo(map)
    heatOverlayRef.current = overlay
  }, [mapReady, filteredItems, layers.historic])

  // ─── Live markers ──────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    const L = window.L
    if (!map || !L) return

    if (liveLayerRef.current) {
      map.removeLayer(liveLayerRef.current)
      liveLayerRef.current = null
    }
    if (!layers.live) return

    const liveComplaints = buildLiveMarkers(complaints, noiseReports)
    if (liveComplaints.length === 0) return

    const group = L.layerGroup()
    const now = Date.now()

    for (const c of liveComplaints) {
      const age = (now - new Date(c.createdAt).getTime()) / LIVE_WINDOW_MS
      const opacity = Math.max(0.2, 1 - age * 0.8)
      const color = KLASS_COLORS[c.klass] || '#fb923c'

      L.circleMarker([c.lat, c.lon], {
        radius: 14, color, weight: 2,
        fillColor: 'transparent', fillOpacity: 0,
        opacity: opacity * 0.5, className: 'live-pulse',
      }).addTo(group)

      const dot = L.circleMarker([c.lat, c.lon], {
        radius: 6, color, weight: 2,
        fillColor: color, fillOpacity: opacity * 0.8, opacity,
      })

      // Popup with new fields
      const typeLine = c.type ? `<div>Type: <span style="color:#94a3b8">${c.type}</span></div>` : ''
      const scoreLine = `<div>Score: <span style="color:#a78bfa">${c._score}/10</span></div>`
      const distLine = c.distanceMiles != null
        ? `<div>Distance: <span style="color:#34d399">${c.distanceMiles} mi</span></div>` : ''
      const mediaLine = c.mediaKind
        ? `<div>Evidence: <span style="color:#fbbf24">${c.mediaKind}</span></div>` : ''
      const precLine = c.precision
        ? `<div>Precision: <span style="color:#94a3b8">${c.precision}</span></div>` : ''
      const notesLine = c.notes
        ? `<div style="margin-top:4px;color:#94a3b8;font-size:11px">${c.notes}</div>` : ''

      dot.bindPopup(`
        <div style="font-family:monospace;font-size:12px;color:#e2e8f0;background:#1e293b;padding:8px 12px;border-radius:8px;min-width:200px;">
          <div style="font-weight:600;color:${color};margin-bottom:4px;">${(c.klass || 'unknown').toUpperCase()} — ${c.zone || 'Unknown zone'}</div>
          <div>Tail: <span style="color:#38bdf8">${c.tail || '?'}</span></div>
          ${typeLine}${scoreLine}${distLine}${mediaLine}${precLine}${notesLine}
          <div style="margin-top:4px;color:#64748b;font-size:11px">${timeAgo(c.createdAt)}</div>
        </div>
      `, { className: 'dark-popup', closeButton: false })
      dot.addTo(group)
    }

    group.addTo(map)
    liveLayerRef.current = group
  }, [mapReady, complaints, noiseReports, layers.live])

  // ─── Noise zones ───────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    const L = window.L
    if (!map || !L) return
    if (zoneLayerRef.current) { map.removeLayer(zoneLayerRef.current); zoneLayerRef.current = null }
    if (!layers.zones) return
    const group = L.layerGroup()
    for (const zone of NOISE_ZONES) {
      const poly = L.polygon(zone.polygon, {
        color: '#f59e0b', weight: 1.5, fillColor: '#f59e0b', fillOpacity: 0.08, dashArray: '6 4',
      })
      poly.bindTooltip(`<span style="font-family:monospace;font-size:11px">${zone.name}</span>`, {
        className: 'dark-tooltip', sticky: true,
      })
      group.addLayer(poly)
    }
    group.addTo(map)
    zoneLayerRef.current = group
  }, [mapReady, layers.zones])

  // ─── Airports ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    const L = window.L
    if (!map || !L) return
    if (airportLayerRef.current) { map.removeLayer(airportLayerRef.current); airportLayerRef.current = null }
    if (!layers.airports) return
    const group = L.layerGroup()
    for (const ap of AIRPORTS.filter(a => AIRPORT_SUBSET.includes(a.code))) {
      const icon = L.divIcon({
        className: '',
        html: `<div style="background:#1e293b;border:1.5px solid #475569;border-radius:4px;padding:2px 6px;font-family:monospace;font-size:10px;font-weight:600;color:#94a3b8;white-space:nowrap;text-align:center;">${ap.code}</div>`,
        iconSize: [48, 18], iconAnchor: [24, 9],
      })
      L.marker([ap.lat, ap.lon], { icon, interactive: false }).addTo(group)
    }
    group.addTo(map)
    airportLayerRef.current = group
  }, [mapReady, layers.airports])

  // ─── Excursion traces ──────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    const L = window.L
    if (!map || !L) return
    if (excursionLayerRef.current) { map.removeLayer(excursionLayerRef.current); excursionLayerRef.current = null }
    if (!layers.excursions || activeExcursions.length === 0) return
    const group = L.layerGroup()
    for (const exc of activeExcursions) {
      const segs = exc.segments || exc.offenseSegments || []
      for (const seg of segs) {
        const pts = seg.points || []
        if (pts.length < 2) continue
        const latlngs = pts.map(p => [p[0], p[1]])
        const color = KLASS_COLORS[seg.klass || exc.worst] || '#fb923c'
        L.polyline(latlngs, { color, weight: 2.5, opacity: 0.7 }).addTo(group)
      }
      if (exc.reportCount > 0 && segs.length > 0) {
        const pts = segs[0].points || []
        if (pts.length > 0) {
          const mid = pts[Math.floor(pts.length / 2)]
          const badge = L.divIcon({
            className: '',
            html: `<div style="background:#dc2626;color:#fff;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-family:monospace;font-size:10px;font-weight:700;box-shadow:0 0 6px rgba(220,38,38,0.5);">${exc.reportCount}</div>`,
            iconSize: [20, 20], iconAnchor: [10, 10],
          })
          L.marker([mid[0], mid[1]], { icon: badge, interactive: false }).addTo(group)
        }
      }
    }
    group.addTo(map)
    excursionLayerRef.current = group
  }, [mapReady, activeExcursions, layers.excursions])

  // ─── Render ────────────────────────────────────────────────────────────────
  const panelStyle = {
    background: 'rgba(15,23,42,0.88)', backdropFilter: 'blur(8px)',
    borderRadius: 10, border: '1px solid rgba(71,85,105,0.4)',
  }
  const btnBase = {
    border: 'none', borderRadius: 5, padding: '4px 10px',
    fontFamily: 'monospace', fontSize: 11, fontWeight: 600,
    cursor: 'pointer', transition: 'all 0.15s',
  }
  const labelStyle = {
    fontFamily: 'monospace', fontSize: 9, color: '#64748b',
    marginBottom: 3, textTransform: 'uppercase', letterSpacing: 1,
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0f172a' }}>
      <div ref={mapElRef} style={{ width: '100%', height: '100%' }} />

      {/* Title card — top left */}
      <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 1000, ...panelStyle, padding: '10px 16px' }}>
        <div style={{ fontFamily: 'monospace', fontSize: 15, fontWeight: 700, color: '#e2e8f0' }}>
          Noise Complaint Heatmap
        </div>
        {stats && !loading && (
          <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#64748b', marginTop: 2 }}>
            {stats.filteredPoints} pts &middot; {stats.complaints} complaints &middot; {stats.reports} reports
          </div>
        )}
        {loading && (
          <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#64748b', marginTop: 2 }}>Loading...</div>
        )}
        {error && (
          <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#f87171', marginTop: 2 }}>Error: {error}</div>
        )}
      </div>

      {/* Layer toggles — top right */}
      <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 1000, ...panelStyle, padding: '8px 4px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {[
          { key: 'historic', label: 'Historic' },
          { key: 'live', label: 'Live' },
          { key: 'zones', label: 'Zones' },
          { key: 'airports', label: 'Airports' },
          { key: 'excursions', label: 'Excursions' },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => toggleLayer(key)}
            style={{
              background: layers[key] ? 'rgba(56,189,248,0.15)' : 'transparent',
              border: `1px solid ${layers[key] ? 'rgba(56,189,248,0.4)' : 'rgba(71,85,105,0.3)'}`,
              borderRadius: 6, padding: '4px 12px',
              fontFamily: 'monospace', fontSize: 11, fontWeight: 500,
              color: layers[key] ? '#38bdf8' : '#64748b',
              cursor: 'pointer', transition: 'all 0.15s', textAlign: 'left',
            }}
          >
            {layers[key] ? '\u25C9' : '\u25CB'} {label}
          </button>
        ))}
      </div>

      {/* Filter bar — bottom left */}
      <div style={{ position: 'absolute', bottom: 24, left: 16, zIndex: 1000, ...panelStyle, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 'calc(100vw - 180px)' }}>
        {/* Time */}
        <div>
          <div style={labelStyle}>Time</div>
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            {TIME_RANGES.map(tr => (
              <button key={tr.label} onClick={() => setTimeRange(tr)}
                style={{ ...btnBase, background: timeRange.label === tr.label ? '#38bdf8' : 'transparent', color: timeRange.label === tr.label ? '#0f172a' : '#64748b' }}>
                {tr.label}
              </button>
            ))}
          </div>
        </div>
        {/* Quality (score) */}
        <div>
          <div style={labelStyle}>Quality (score)</div>
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            {QUALITY_TIERS.map(qt => (
              <button key={qt.label} onClick={() => setQualityTier(qt)}
                style={{ ...btnBase, background: qualityTier.label === qt.label ? '#a78bfa' : 'transparent', color: qualityTier.label === qt.label ? '#0f172a' : '#64748b' }}
                title={qt.desc || 'All reports'}>
                {qt.label}
              </button>
            ))}
          </div>
        </div>
        {/* Proximity (reporter distance) */}
        <div>
          <div style={labelStyle}>Proximity (reporter &rarr; aircraft)</div>
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            {PROXIMITY_OPTIONS.map(po => (
              <button key={po.label} onClick={() => setProximityOpt(po)}
                style={{ ...btnBase, background: proximityOpt.label === po.label ? '#34d399' : 'transparent', color: proximityOpt.label === po.label ? '#0f172a' : '#64748b' }}>
                {po.label}
              </button>
            ))}
          </div>
        </div>
        {/* Evidence */}
        <div>
          <div style={labelStyle}>Evidence</div>
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            {MEDIA_OPTIONS.map(mo => (
              <button key={mo.label} onClick={() => setMediaFilter(mo)}
                style={{ ...btnBase, background: mediaFilter.label === mo.label ? '#fbbf24' : 'transparent', color: mediaFilter.label === mo.label ? '#0f172a' : '#64748b' }}>
                {mo.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Legend — bottom right */}
      <div style={{ position: 'absolute', bottom: 24, right: 16, zIndex: 1000, ...panelStyle, padding: '10px 14px', fontFamily: 'monospace', fontSize: 11 }}>
        <div style={{ color: '#94a3b8', fontWeight: 600, marginBottom: 6 }}>Density</div>
        <div style={{
          width: 120, height: 10, borderRadius: 4,
          background: 'linear-gradient(to right, #313695, #45add1, #abe0e9, #fee090, #f46d43, #a50026)',
        }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#64748b', fontSize: 9, marginTop: 2 }}>
          <span>Low</span><span>High</span>
        </div>
        <div style={{ color: '#94a3b8', fontWeight: 600, marginTop: 8, marginBottom: 4 }}>Severity</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {Object.entries(KLASS_COLORS).map(([k, c]) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: c }} />
              <span style={{ color: '#94a3b8', textTransform: 'capitalize' }}>{k}</span>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        .heatmap-overlay { mix-blend-mode: screen; }
        .live-pulse { animation: heatmapPulse 2.4s ease-in-out infinite; }
        @keyframes heatmapPulse {
          0%, 100% { stroke-opacity: 0.3; stroke-width: 2; }
          50% { stroke-opacity: 0.8; stroke-width: 4; }
        }
        .dark-popup .leaflet-popup-content-wrapper { background: transparent !important; box-shadow: none !important; border: none !important; padding: 0 !important; }
        .dark-popup .leaflet-popup-content { margin: 0 !important; }
        .dark-popup .leaflet-popup-tip { background: #1e293b !important; }
        .dark-tooltip { background: rgba(15,23,42,0.92) !important; border: 1px solid rgba(71,85,105,0.4) !important; color: #e2e8f0 !important; border-radius: 6px !important; box-shadow: 0 4px 12px rgba(0,0,0,0.4) !important; }
      `}</style>
    </div>
  )
}
