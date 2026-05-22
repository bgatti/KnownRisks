import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import { loadPopulationDensity } from './populationRaster'
import { buildPopulationContours } from './populationContours'
import { ContourLayer } from './KioskMap.jsx'

// ---------------------------------------------------------------------------
// Single-tail population-noise explainer. Renders one aircraft's flight over
// the population-density contours, coloring each path segment by its computed
// contribution (length × people/km² × 1/AGL²) so the leaderboard's impact
// score is visually auditable. Data: GET /api/noise/impact-explain?tail=…
// ---------------------------------------------------------------------------

const KBDU = [40.0394, -105.2258]

// contribution fraction (0..1) → teal → amber → red
function heat(t) {
  const x = Math.max(0, Math.min(1, t)) * 2
  const i = Math.min(1, Math.floor(x)), f = x - i
  const stops = [[26, 112, 112], [250, 204, 21], [220, 38, 38]]
  const a = stops[i], b = stops[i + 1]
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`
}

// AGL pill color: lower over people = louder = redder.
function aglColor(agl) {
  if (agl < 700) return '#dc2626'
  if (agl < 1500) return '#f59e0b'
  return '#475569'
}
function aglLabelIcon(agl, pop) {
  const c = aglColor(agl)
  const pk = pop >= 1000 ? (pop / 1000).toFixed(1) + 'k' : String(pop)
  return L.divIcon({
    className: 'agl-label',
    iconSize: [78, 20], iconAnchor: [39, 10],
    html: `<div style="display:flex;align-items:center;justify-content:center;gap:3px;font:600 11px/1 ui-sans-serif,system-ui;
      color:#fff;background:${c};border:1px solid rgba(255,255,255,.5);border-radius:9px;padding:2px 6px;white-space:nowrap;
      box-shadow:0 1px 4px rgba(0,0,0,.7)"><span>${agl} ft</span><span style="opacity:.7;font-weight:400">${pk}/km²</span></div>`,
  })
}

// Local maxima of population density ALONG the path: each point where the
// people/km² beneath the flight peaks (a neighborhood/town center it crosses),
// labeled with the AGL there. A segment is a peak if its pop is the max within
// ±minSepSeg and ≥ popMin; peaks closer than minSepSeg are collapsed to the
// higher one, so each distinct population hump gets exactly one AGL label.
function localPopMaxima(segments, points, { popMin = 500, minSepSeg = 8, max = 14 } = {}) {
  const peakIdx = []
  for (let i = 0; i < segments.length; i++) {
    const p = segments[i].pop
    if (p < popMin) continue
    let isMax = true
    for (let k = Math.max(0, i - minSepSeg); k <= Math.min(segments.length - 1, i + minSepSeg); k++) {
      if (segments[k].pop > p) { isMax = false; break }
    }
    if (!isMax) continue
    const last = peakIdx[peakIdx.length - 1]
    if (last != null && i - last < minSepSeg) {
      if (segments[i].pop > segments[last].pop) peakIdx[peakIdx.length - 1] = i
    } else peakIdx.push(i)
  }
  return peakIdx.map((i) => {
    const a = points[i], b = points[Math.min(points.length - 1, i + 1)]
    return { lat: (a[0] + b[0]) / 2, lon: (a[1] + b[1]) / 2, agl: segments[i].agl, pop: segments[i].pop }
  }).sort((x, y) => y.pop - x.pop).slice(0, max)
}

function FitBounds({ points }) {
  const map = useMap()
  useEffect(() => {
    if (points && points.length) {
      map.fitBounds(points.map((p) => [p[0], p[1]]), { padding: [50, 50] })
    }
  }, [points, map])
  return null
}

// Group a flight's per-segment contributions into runs of the same heat bucket
// so we draw a handful of polylines instead of one per point.
function heatRuns(points, contributions, maxC) {
  const runs = []
  if (!points || points.length < 2) return runs
  const bucket = (c) => Math.min(9, Math.floor((maxC > 0 ? c / maxC : 0) * 10))
  let i = 0
  while (i < contributions.length) {
    const bk = bucket(contributions[i])
    let j = i
    while (j + 1 < contributions.length && bucket(contributions[j + 1]) === bk) j++
    runs.push({ bk, pts: points.slice(i, j + 2).map((p) => [p[0], p[1]]) })
    i = j + 1
  }
  return runs
}

function readParams() {
  try {
    const p = new URLSearchParams(window.location.search)
    return { tail: (p.get('tail') || '').trim().toUpperCase(), days: p.get('days') || '30' }
  } catch { return { tail: '', days: '30' } }
}

export default function ImpactExplain() {
  const [{ tail: tail0, days }] = useState(readParams)
  const [tail, setTail] = useState(tail0)
  const [tailInput, setTailInput] = useState(tail0)
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [sel, setSel] = useState(0)
  const [popLevels, setPopLevels] = useState([])

  useEffect(() => {
    loadPopulationDensity()
      .then((d) => setPopLevels(buildPopulationContours(d)))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!tail) return
    setErr(null); setData(null); setSel(0)
    fetch(`/api/noise/impact-explain?tail=${encodeURIComponent(tail)}&days=${days}`)
      .then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(j.error || r.status))))
      .then(setData)
      .catch((e) => setErr(String(e)))
  }, [tail, days])

  const flight = data?.flights?.[sel] || null
  const maxC = data?.totals?.max_contribution || 1
  const runs = useMemo(
    () => (flight ? heatRuns(flight.points, flight.contributions, maxC) : []),
    [flight, maxC],
  )
  const topSegs = useMemo(() => {
    if (!flight) return []
    return flight.segments.map((s, i) => ({ ...s, i })).sort((a, b) => b.contribution - a.contribution).slice(0, 8)
  }, [flight])
  const peaks = useMemo(
    () => (flight ? localPopMaxima(flight.segments, flight.points, { popMin: 500, minSepSeg: 8, max: 14 }) : []),
    [flight],
  )

  const submit = (e) => { e.preventDefault(); setTail(tailInput.trim().toUpperCase()) }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black text-neutral-100">
      <style>{`.leaflet-container{background:#050608;outline:none}
        .agl-label{background:transparent !important;border:none !important}`}</style>
      <MapContainer center={KBDU} zoom={11} className="h-full w-full" zoomControl={false} attributionControl={false}>
        <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />
        <ContourLayer levels={popLevels} />
        {flight && <FitBounds points={flight.points} />}
        {runs.map((r, i) => (
          <Polyline key={i} positions={r.pts}
            pathOptions={{ color: heat(r.bk / 9), weight: 3 + r.bk * 0.8, opacity: 0.55 + r.bk * 0.05 }} />
        ))}
        {/* AGL label at each local population maximum the path crosses */}
        {peaks.map((c, i) => (
          <Marker key={`agl-${i}`} position={[c.lat, c.lon]} icon={aglLabelIcon(c.agl, c.pop)} interactive={false} />
        ))}
        {flight && flight.points.length > 0 && (
          <>
            <CircleMarker center={[flight.points[0][0], flight.points[0][1]]} radius={6}
              pathOptions={{ color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.9 }}>
              <Tooltip>start</Tooltip>
            </CircleMarker>
            <CircleMarker center={[flight.points[flight.points.length - 1][0], flight.points[flight.points.length - 1][1]]} radius={6}
              pathOptions={{ color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.9 }}>
              <Tooltip>end</Tooltip>
            </CircleMarker>
          </>
        )}
      </MapContainer>

      {/* Panel */}
      <div className="absolute top-0 right-0 z-[1000] h-full w-[360px] max-w-[88vw] bg-black/70 backdrop-blur-md border-l border-white/10 overflow-y-auto p-4 space-y-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.2em] text-cyan-300/80">Population-noise impact</div>
          <form onSubmit={submit} className="mt-1 flex gap-2">
            <input value={tailInput} onChange={(e) => setTailInput(e.target.value)} placeholder="tail e.g. N3547L"
              className="flex-1 bg-black/40 border border-white/15 rounded px-2 py-1 font-mono text-sm text-cyan-200 uppercase" />
            <button className="px-3 py-1 rounded bg-cyan-500/20 border border-cyan-400/40 text-cyan-200 text-xs">Go</button>
          </form>
        </div>

        {err && <div className="text-rose-300 text-sm bg-rose-500/10 border border-rose-400/30 rounded p-2">{err}</div>}
        {!tail && <div className="text-white/50 text-sm">Enter a tail number to see its flights scored against the population map.</div>}

        {data && (
          <>
            <div className="text-sm">
              <div className="text-2xl font-bold">{data.tail}</div>
              <div className="text-white/60">{flight?.type_desc || flight?.type || '—'} · last {data.days} days</div>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              <Tile label="flights" value={data.totals.flights} />
              <Tile label="path nm" value={(data.totals.len_ft / 6076).toFixed(0)} />
              <Tile label="impact idx" value={data.totals.impact_index} accent />
            </div>

            <div className="text-[11px] text-white/50 leading-relaxed border-t border-white/10 pt-2">
              impact index = (Σ segment ft × people/km² × (1000/AGL)²) ÷ path ft ÷ {data.pop_scale}.
              Brighter path = more noise reaching more people (lower &amp; over denser areas).
              Ground ref {data.kernel.GROUND_REF_FT} ft, AGL floor {data.kernel.MIN_AGL_FT} ft.
            </div>

            {/* heat legend */}
            <div className="flex items-center gap-1 text-[10px] text-white/60">
              <span>low</span>
              {[0, 2, 4, 6, 8, 9].map((b) => <span key={b} className="inline-block w-6 h-2 rounded" style={{ background: heat(b / 9) }} />)}
              <span>high</span>
            </div>

            {/* flight selector */}
            {data.flights.length > 1 && (
              <div className="flex flex-wrap gap-1">
                {data.flights.map((f, i) => (
                  <button key={f.id} onClick={() => setSel(i)}
                    className={`px-2 py-0.5 rounded text-[11px] border ${i === sel ? 'bg-cyan-500/25 border-cyan-400/50 text-cyan-100' : 'border-white/10 text-white/60'}`}>
                    {f.date} · idx {f.impact_index}
                  </button>
                ))}
              </div>
            )}

            {flight && (
              <div className="border-t border-white/10 pt-2">
                <div className="text-xs text-white/70 mb-1">
                  Flight {flight.date} · {(flight.len_ft / 6076).toFixed(0)} nm · impact idx <span className="text-amber-300">{flight.impact_index}</span>
                </div>
                <div className="text-[10px] uppercase tracking-wide text-white/40 mb-1">Top contributing segments</div>
                <table className="w-full text-[11px] tabular-nums">
                  <thead className="text-white/40"><tr><th className="text-left">ft</th><th>AGL</th><th>ppl/km²</th><th>×atten</th><th className="text-right">contrib</th></tr></thead>
                  <tbody>
                    {topSegs.map((s) => (
                      <tr key={s.i} className="text-white/80">
                        <td className="text-left">{s.ft}</td><td className="text-center">{s.agl}</td>
                        <td className="text-center">{s.pop}</td><td className="text-center">{s.atten}</td>
                        <td className="text-right" style={{ color: heat(s.contribution / maxC) }}>{(s.contribution / 1e6).toFixed(1)}M</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Tile({ label, value, accent }) {
  return (
    <div className="bg-white/5 rounded-lg py-2">
      <div className={`text-xl font-bold tabular-nums ${accent ? 'text-amber-300' : 'text-white'}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-white/50">{label}</div>
    </div>
  )
}
