import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, Polyline, Circle, Tooltip } from 'react-leaflet'
import { NOISE_ZONES } from './noiseZones'

const KBDU = [40.0394, -105.2258]
const KBDU_ELEV = 5288

// Handpicked test tracks — one from each phase category.
const TEST_TRACKS = [
  { label: 'Pattern C172',  src: 'globe/2026-04-10/a5844a' }, // N4547E, 33 descents
  { label: 'Pattern C172b', src: 'globe/2026-04-10/a29d3e' }, // N268FM, 34 descents
  { label: 'Arrival DA40',  src: 'globe/2026-04-08/a2ae46' }, // N272DS, 1 descent
  { label: 'Departure C172',src: 'globe/2026-04-08/a4c3b4' }, // N406JA, starts low
  { label: 'Overflight A320',src:'globe/2026-04-08/a533bd' }, // N434UA, never low
  { label: 'Helo pattern',  src: 'globe/2026-04-08/ae0a71' }, // 86-24529 H60, 35 desc
]

function classifyPhase(points, fieldElev = KBDU_ELEV) {
  if (!points || points.length < 5) return { phase: null, descents: 0, descentSegments: [] }
  const threshold = fieldElev + 300
  let descents = 0
  let wasAbove = false
  const descentSegments = [] // [{startIdx, endIdx}] — each descent event
  let descentStart = -1
  for (let i = 0; i < points.length; i++) {
    if (points[i][2] > threshold) {
      if (descentStart >= 0) {
        descentSegments.push({ startIdx: descentStart, endIdx: i })
        descentStart = -1
      }
      wasAbove = true
    } else if (wasAbove) {
      descents++
      descentStart = i
      wasAbove = false
    }
  }
  if (descentStart >= 0) descentSegments.push({ startIdx: descentStart, endIdx: points.length - 1 })
  const firstLow = points[0][2] < threshold
  const lastLow = points[points.length - 1][2] < threshold
  let phase = 'overflight'
  if (firstLow && lastLow && descents >= 2) phase = 'pattern'
  else if (firstLow && !lastLow) phase = 'departure'
  else if (!firstLow && lastLow) phase = 'arrival'
  else if (firstLow && lastLow) phase = 'pattern'
  return { phase, descents, descentSegments, threshold }
}

const PHASE_COLOR = {
  pattern: '#f59e0b',    // amber
  arrival: '#3b82f6',    // blue
  departure: '#22c55e',  // green
  overflight: '#6b7280', // gray
}

export default function DescentTest() {
  const [data, setData] = useState(null)
  const [selected, setSelected] = useState(new Set(TEST_TRACKS.map(t => t.src)))

  useEffect(() => {
    Promise.all(
      ['2023', '2024', '2025', '2026'].map(y =>
        fetch(`/tracks_${y}.json`).then(r => r.ok ? r.json() : { tracks: [] }).catch(() => ({ tracks: [] }))
      )
    ).then(results => setData({ tracks: results.flatMap(d => d.tracks || []) }))
  }, [])

  const tracks = useMemo(() => {
    if (!data) return []
    return TEST_TRACKS.map(tt => {
      const t = data.tracks.find(x => x.src === tt.src)
      if (!t) return null
      const cls = classifyPhase(t.points)
      return { ...tt, track: t, ...cls }
    }).filter(Boolean)
  }, [data])

  return (
    <div className="h-full flex">
      <aside className="w-80 border-r border-white/10 p-3 overflow-y-auto space-y-3">
        <h2 className="text-sm font-semibold text-white/80">Descent Detection Test</h2>
        <div className="text-[9px] text-white/40 italic">
          Threshold: field elev ({KBDU_ELEV} ft) + 300 ft = {KBDU_ELEV + 300} ft MSL.
          A "descent" = aircraft drops below this after being above it.
        </div>
        {tracks.map(t => (
          <div key={t.src} className="border border-white/10 rounded p-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(t.src)}
                onChange={() => setSelected(s => {
                  const n = new Set(s)
                  if (n.has(t.src)) n.delete(t.src); else n.add(t.src)
                  return n
                })}
              />
              <div>
                <div className="text-xs font-semibold" style={{ color: PHASE_COLOR[t.phase] || '#fff' }}>
                  {t.label}
                </div>
                <div className="text-[10px] text-white/60">
                  {t.track.call} · {t.track.type} · {t.track.points.length} pts
                </div>
              </div>
            </label>
            <div className="mt-1 flex gap-3 text-[10px]">
              <span className="text-white/50">
                phase: <span className="font-semibold" style={{ color: PHASE_COLOR[t.phase] }}>{t.phase}</span>
              </span>
              <span className="text-white/50">
                descents: <span className="font-mono text-amber-300">{t.descents}</span>
              </span>
            </div>
            <div className="text-[9px] text-white/40 mt-0.5">
              alt: {Math.min(...t.track.points.map(p => p[2]))} – {Math.max(...t.track.points.map(p => p[2]))} ft ·
              {' '}{t.descentSegments.length} descent segments
            </div>
          </div>
        ))}
        {!data && <div className="text-xs text-white/50 animate-pulse">Loading tracks...</div>}
      </aside>
      <div className="flex-1 relative">
        <MapContainer center={KBDU} zoom={12} className="h-full w-full">
          <TileLayer
            attribution="&copy; OpenStreetMap"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {/* Threshold circle — 300 ft AGL ring is not geographic but we show
              the field reference point */}
          <Circle
            center={KBDU}
            radius={100}
            pathOptions={{ color: '#ef4444', weight: 2, fill: true, fillOpacity: 0.3 }}
          >
            <Tooltip permanent direction="right" offset={[10, 0]}>
              <span className="text-[10px]">KBDU {KBDU_ELEV} ft</span>
            </Tooltip>
          </Circle>

          {/* Noise zones */}
          {NOISE_ZONES.map((z, i) => (
            <Polyline
              key={`zone-${i}`}
              positions={z.polygon}
              pathOptions={{ color: '#7e22ce', weight: 1, opacity: 0.4, dashArray: '4 4' }}
            />
          ))}

          {/* Track polylines — color by phase, descent segments highlighted */}
          {tracks.filter(t => selected.has(t.src)).map(t => {
            const pts = t.track.points
            const ll = pts.map(p => [p[0], p[1]])
            const phaseColor = PHASE_COLOR[t.phase] || '#888'
            return (
              <div key={t.src}>
                {/* Full track in phase color */}
                <Polyline
                  positions={ll}
                  pathOptions={{ color: phaseColor, weight: 2, opacity: 0.5 }}
                >
                  <Tooltip sticky>
                    <div className="text-[10px]">
                      <div className="font-semibold">{t.track.call} · {t.track.type}</div>
                      <div>phase: {t.phase} · {t.descents} descents</div>
                    </div>
                  </Tooltip>
                </Polyline>
                {/* Descent segments in red, fat */}
                {t.descentSegments.map((seg, si) => (
                  <Polyline
                    key={`desc-${si}`}
                    positions={pts.slice(seg.startIdx, seg.endIdx + 1).map(p => [p[0], p[1]])}
                    pathOptions={{ color: '#ef4444', weight: 5, opacity: 0.8 }}
                  >
                    <Tooltip sticky>
                      <div className="text-[10px]">
                        Descent #{si + 1} · {seg.endIdx - seg.startIdx} pts ·
                        {' '}{pts[seg.startIdx][2]}→{pts[seg.endIdx][2]} ft
                      </div>
                    </Tooltip>
                  </Polyline>
                ))}
              </div>
            )
          })}
        </MapContainer>
      </div>
    </div>
  )
}
