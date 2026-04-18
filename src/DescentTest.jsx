import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, Polyline, CircleMarker, Tooltip } from 'react-leaflet'
import { NOISE_ZONES } from './noiseZones'

// ─── Airport field elevations (MSL ft) ──────────────────────────────────────
const AIRPORTS = [
  { code: 'KBDU', lat: 40.0394, lon: -105.2258, elev: 5288 },
  { code: 'KBJC', lat: 39.9088, lon: -105.1172, elev: 5673 },
  { code: 'KEIK', lat: 40.0098, lon: -105.0488, elev: 5130 },
  { code: 'KLMO', lat: 40.1636, lon: -105.1636, elev: 5055 },
  { code: 'KAPA', lat: 39.5701, lon: -104.8493, elev: 5885 },
  { code: 'KGXY', lat: 40.4348, lon: -104.6331, elev: 4697 },
]
const KBDU = [40.0394, -105.2258]

// Find the nearest airport to a lat/lon and return its field elevation.
function nearestFieldElev(lat, lon) {
  let best = AIRPORTS[0], bestD = Infinity
  for (const ap of AIRPORTS) {
    const d = Math.hypot((lat - ap.lat) * 69, (lon - ap.lon) * 53)
    if (d < bestD) { bestD = d; best = ap }
  }
  return { elev: best.elev, code: best.code, distMi: bestD }
}

// ─── Test tracks — all from 2026, only load that file ───────────────────────
const TEST_TRACKS = [
  { label: 'Pattern C172',   src: 'globe/2026-04-10/a5844a' }, // N4547E
  { label: 'Pattern C172b',  src: 'globe/2026-04-10/a29d3e' }, // N268FM
  { label: 'Arrival DA40',   src: 'globe/2026-04-08/a2ae46' }, // N272DS
  { label: 'Departure C172', src: 'globe/2026-04-08/a4c3b4' }, // N406JA
  { label: 'Overflight A320',src: 'globe/2026-04-08/a533bd' }, // N434UA
  { label: 'Helo pattern',   src: 'globe/2026-04-08/ae0a71' }, // 86-24529 H60
]

// ─── Phase + descent/ascent classifier ──────────────────────────────────────
// Uses the nearest airport's field elevation for AGL, not the track's own min.
// Descent: 800 AGL → below 250 AGL. Ascent: below 250 AGL → above 800 AGL.
function classifyTrack(points) {
  const result = {
    phase: null, nearestAirport: null, fieldElev: 0,
    descents: 0, ascents: 0, touchAndGos: [],
    descentSegments: [], ascentSegments: [],
    aglMin: Infinity, aglMax: -Infinity,
  }
  if (!points || points.length < 5) return result

  // Find nearest airport to the track's lowest point for field elevation.
  let lowestPt = points[0], lowestAlt = points[0][2]
  for (const p of points) { if (p[2] < lowestAlt) { lowestAlt = p[2]; lowestPt = p } }
  const { elev, code } = nearestFieldElev(lowestPt[0], lowestPt[1])
  result.fieldElev = elev
  result.nearestAirport = code
  const LOW_AGL = 250    // must get below this to count
  const HIGH_AGL = 800   // must come from / reach above this
  const lowThresh = elev + LOW_AGL
  const highThresh = elev + HIGH_AGL

  // AGL stats
  for (const p of points) {
    const agl = p[2] - elev
    if (agl < result.aglMin) result.aglMin = agl
    if (agl > result.aglMax) result.aglMax = agl
  }

  // Descent detection: aircraft must drop from above 800 AGL to below
  // 250 AGL. The segment spans from where it passes below 800 to where
  // it bottoms out below 250. Shallow passes that stay above 250 are
  // not flagged.
  {
    let wasHigh = false, descStart = -1
    for (let i = 0; i < points.length; i++) {
      const alt = points[i][2]
      if (alt > highThresh) {
        wasHigh = true
        if (descStart >= 0) {
          // Went back up without getting low enough — discard.
          descStart = -1
        }
      } else if (wasHigh && descStart < 0) {
        descStart = i // started descending through 800
      }
      if (wasHigh && descStart >= 0 && alt < lowThresh) {
        result.descents++
        result.descentSegments.push({ startIdx: descStart, endIdx: i })
        wasHigh = false
        descStart = -1
      }
    }
  }

  // Ascent detection: aircraft must go below 250 AGL, then climb above
  // 800 AGL. The segment spans from the low point to where it passes 800.
  // This filters out shallow excursions that never get truly low.
  let wentLow = false, ascentStart = -1
  for (let i = 0; i < points.length; i++) {
    const alt = points[i][2]
    if (alt < lowThresh) {
      wentLow = true
      ascentStart = ascentStart < 0 ? i : ascentStart
    } else if (wentLow && alt > highThresh) {
      result.ascents++
      result.ascentSegments.push({ startIdx: ascentStart, endIdx: i })
      wentLow = false
      ascentStart = -1
    }
  }

  // Phase classification — "low" = below 250 AGL of nearest airport
  const firstLow = points[0][2] < lowThresh
  const lastLow = points[points.length - 1][2] < lowThresh
  if (firstLow && lastLow && result.descents >= 2) result.phase = 'pattern'
  else if (firstLow && !lastLow) result.phase = 'departure'
  else if (!firstLow && lastLow) result.phase = 'arrival'
  else if (!firstLow && !lastLow) result.phase = 'overflight'
  else result.phase = 'pattern'

  // Touch-and-go detection: a descent segment whose low point is followed
  // by an ascent segment starting within 240 seconds (p90 of observed
  // T&G timing). Uses timestamps (p[3]) when available; falls back to
  // index proximity (< 60 points ≈ ~120 s at 2 s/sample).
  result.touchAndGos = []
  const MAX_TNG_SEC = 240
  const MAX_TNG_IDX = 60
  for (const desc of result.descentSegments) {
    for (const asc of result.ascentSegments) {
      if (asc.startIdx < desc.endIdx) continue // ascent must come after descent
      const hasTs = points[desc.endIdx].length > 3 && points[asc.startIdx].length > 3
      let gap
      if (hasTs) {
        gap = points[asc.startIdx][3] - points[desc.endIdx][3]
        if (gap < 0 || gap > MAX_TNG_SEC) continue
      } else {
        gap = asc.startIdx - desc.endIdx
        if (gap < 0 || gap > MAX_TNG_IDX) continue
      }
      result.touchAndGos.push({
        descentIdx: result.descentSegments.indexOf(desc),
        ascentIdx: result.ascentSegments.indexOf(asc),
        startIdx: desc.startIdx,
        endIdx: asc.endIdx,
        gapSec: hasTs ? gap : null,
        gapPts: asc.startIdx - desc.endIdx,
        bottomAlt: Math.min(...points.slice(desc.endIdx, asc.startIdx + 1).map(p => p[2])),
      })
      break // each descent matches at most one ascent
    }
  }

  return result
}

const PHASE_COLOR = {
  pattern: '#f59e0b',
  arrival: '#3b82f6',
  departure: '#22c55e',
  overflight: '#6b7280',
}

// ─── Component ──────────────────────────────────────────────────────────────
export default function DescentTest() {
  const [data, setData] = useState(null)
  const [selected, setSelected] = useState(new Set(TEST_TRACKS.map(t => t.src)))
  const [showDescents, setShowDescents] = useState(true)
  const [showAscents, setShowAscents] = useState(true)
  const [showTnG, setShowTnG] = useState(true)

  // Only load 2026 — all test tracks are from that year.
  useEffect(() => {
    fetch('/tracks_2026.json')
      .then(r => r.ok ? r.json() : { tracks: [] })
      .then(d => setData(d))
      .catch(() => setData({ tracks: [] }))
  }, [])

  const tracks = useMemo(() => {
    if (!data) return []
    return TEST_TRACKS.map(tt => {
      const t = data.tracks.find(x => x.src === tt.src)
      if (!t) return null
      return { ...tt, track: t, ...classifyTrack(t.points) }
    }).filter(Boolean)
  }, [data])

  return (
    <div className="h-full flex" style={{ background: '#0b1220', color: '#e5e7eb' }}>
      <aside className="w-80 border-r border-white/10 p-3 overflow-y-auto space-y-3 text-sm">
        <h2 className="text-sm font-semibold">Descent / Ascent Test</h2>

        <div className="flex gap-2">
          <label className="flex items-center gap-1 text-xs cursor-pointer">
            <input type="checkbox" checked={showDescents} onChange={e => setShowDescents(e.target.checked)} />
            <span className="text-red-400">Descents</span>
          </label>
          <label className="flex items-center gap-1 text-xs cursor-pointer">
            <input type="checkbox" checked={showAscents} onChange={e => setShowAscents(e.target.checked)} />
            <span className="text-green-400">Ascents</span>
          </label>
          <label className="flex items-center gap-1 text-xs cursor-pointer">
            <input type="checkbox" checked={showTnG} onChange={e => setShowTnG(e.target.checked)} />
            <span className="text-amber-400">Touch & Go</span>
          </label>
        </div>

        <div className="text-[9px] text-white/40 italic">
          Descent: above 800 AGL down to below 250 AGL.
          Ascent: below 250 AGL up to above 800 AGL.
          AGL = altitude above nearest airport field elevation.
        </div>

        {tracks.map(t => (
          <div key={t.src} className="border border-white/10 rounded p-2 space-y-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(t.src)}
                onChange={() => setSelected(s => {
                  const n = new Set(s); n.has(t.src) ? n.delete(t.src) : n.add(t.src); return n
                })}
              />
              <div>
                <span className="text-xs font-semibold" style={{ color: PHASE_COLOR[t.phase] }}>
                  {t.label}
                </span>
                <span className="text-[10px] text-white/50 ml-1">
                  {t.track.call} · {t.track.type}
                </span>
              </div>
            </label>
            <div className="flex gap-3 text-[10px] text-white/60">
              <span>
                phase: <span className="font-semibold" style={{ color: PHASE_COLOR[t.phase] }}>{t.phase}</span>
              </span>
              <span>near: {t.nearestAirport} ({t.fieldElev} ft)</span>
            </div>
            <div className="flex gap-3 text-[10px]">
              <span className="text-red-400">{t.descents} desc</span>
              <span className="text-green-400">{t.ascents} asc</span>
              <span className="text-amber-400">{t.touchAndGos.length} T&G</span>
              <span className="text-white/40">{t.track.points.length} pts</span>
            </div>
            <div className="text-[9px] text-white/40">
              AGL: {Math.round(t.aglMin)}–{Math.round(t.aglMax)} ft ·
              MSL: {Math.min(...t.track.points.map(p => p[2]))}–{Math.max(...t.track.points.map(p => p[2]))} ft
            </div>
          </div>
        ))}
        {!data && <div className="text-xs text-white/50 animate-pulse">Loading 2026 tracks...</div>}
        {data && tracks.length === 0 && <div className="text-xs text-red-400">No test tracks found in data</div>}
      </aside>

      <div className="flex-1 relative">
        <MapContainer center={KBDU} zoom={12} className="h-full w-full">
          <TileLayer
            attribution="&copy; OpenStreetMap"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {/* Airport markers with field elevation */}
          {AIRPORTS.map(ap => (
            <CircleMarker
              key={ap.code}
              center={[ap.lat, ap.lon]}
              radius={5}
              pathOptions={{ color: '#22d3ee', weight: 1, fillOpacity: 0.5 }}
            >
              <Tooltip permanent direction="right" offset={[8, 0]}>
                <span className="text-[9px] font-mono">{ap.code} {ap.elev}ft</span>
              </Tooltip>
            </CircleMarker>
          ))}

          {/* Noise zones */}
          {NOISE_ZONES.map((z, i) => (
            <Polyline
              key={`zone-${i}`}
              positions={z.polygon}
              pathOptions={{ color: '#7e22ce', weight: 1, opacity: 0.3, dashArray: '4 4' }}
            />
          ))}

          {/* Tracks */}
          {tracks.filter(t => selected.has(t.src)).map(t => {
            const pts = t.track.points
            const ll = pts.map(p => [p[0], p[1]])
            const color = PHASE_COLOR[t.phase] || '#888'
            return (
              <span key={t.src}>
                {/* Full track — thin, phase-colored */}
                <Polyline
                  positions={ll}
                  pathOptions={{ color, weight: 2, opacity: 0.4 }}
                >
                  <Tooltip sticky>
                    <div className="text-[10px]">
                      <div className="font-semibold">{t.track.call} · {t.track.type}</div>
                      <div>{t.phase} · {t.descents}↓ {t.ascents}↑ · AGL {Math.round(t.aglMin)}–{Math.round(t.aglMax)}</div>
                    </div>
                  </Tooltip>
                </Polyline>

                {/* Descent segments — red, fat */}
                {showDescents && t.descentSegments.map((seg, si) => {
                  const segPts = pts.slice(seg.startIdx, seg.endIdx + 1)
                  const minAgl = Math.min(...segPts.map(p => p[2] - t.fieldElev))
                  return (
                    <Polyline
                      key={`d-${si}`}
                      positions={segPts.map(p => [p[0], p[1]])}
                      pathOptions={{ color: '#ef4444', weight: 5, opacity: 0.8 }}
                    >
                      <Tooltip sticky>
                        <div className="text-[10px]">
                          <span className="text-red-400 font-semibold">Descent #{si + 1}</span>
                          {' · '}{segPts.length} pts
                          {' · '}{pts[seg.startIdx][2]}→{pts[seg.endIdx][2]} MSL
                          {' · min AGL '}{Math.round(minAgl)} ft
                        </div>
                      </Tooltip>
                    </Polyline>
                  )
                })}

                {/* Ascent segments — green, fat */}
                {showAscents && t.ascentSegments.map((seg, si) => {
                  const segPts = pts.slice(seg.startIdx, seg.endIdx + 1)
                  const maxAgl = Math.max(...segPts.map(p => p[2] - t.fieldElev))
                  return (
                    <Polyline
                      key={`a-${si}`}
                      positions={segPts.map(p => [p[0], p[1]])}
                      pathOptions={{ color: '#22c55e', weight: 5, opacity: 0.7 }}
                    >
                      <Tooltip sticky>
                        <div className="text-[10px]">
                          <span className="text-green-400 font-semibold">Ascent #{si + 1}</span>
                          {' · '}{segPts.length} pts
                          {' · '}{pts[seg.startIdx][2]}→{pts[seg.endIdx][2]} MSL
                          {' · max AGL '}{Math.round(maxAgl)} ft
                        </div>
                      </Tooltip>
                    </Polyline>
                  )
                })}
              {/* Touch-and-go segments — amber, fattest */}
                {showTnG && t.touchAndGos.map((tng, ti) => {
                  const segPts = pts.slice(tng.startIdx, tng.endIdx + 1)
                  return (
                    <Polyline
                      key={`tng-${ti}`}
                      positions={segPts.map(p => [p[0], p[1]])}
                      pathOptions={{ color: '#f59e0b', weight: 7, opacity: 0.7 }}
                    >
                      <Tooltip sticky>
                        <div className="text-[10px]">
                          <span className="text-amber-400 font-semibold">Touch & Go #{ti + 1}</span>
                          {tng.gapSec != null && <span> · {tng.gapSec}s on ground</span>}
                          {' · bottom '}{Math.round(tng.bottomAlt - t.fieldElev)} AGL
                          {' · '}{segPts.length} pts
                        </div>
                      </Tooltip>
                    </Polyline>
                  )
                })}
              </span>
            )
          })}
        </MapContainer>
      </div>
    </div>
  )
}
