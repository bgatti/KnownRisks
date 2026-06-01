import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import { isEnginelessType, distFt } from './geo'
// §11-CLIENT helpers live in a leaflet-free module so the test suite can
// import them without bringing in React + leaflet. Re-export here for any
// external consumer that was importing them off PointNoiseReport.jsx.
import {
  pickSubstituted,
  shouldWinchSegment,
  segmentDba,
  npv,
  businessModelColumn,
} from './whatif.js'
export { pickSubstituted, shouldWinchSegment, segmentDba, npv, businessModelColumn }

/* SVG-pin DivIcon for the map pin. Drawn at 26×34 with anchor at base. */
const PIN_ICON = L.divIcon({
  className: 'point-noise-pin',
  iconSize: [26, 34],
  iconAnchor: [13, 32],
  html:
    '<svg viewBox="0 0 26 34" width="26" height="34" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M13 1 C5 1 1 7 1 13 c0 9 12 20 12 20 s12-11 12-20 c0-6-4-12-12-12 z"' +
    ' fill="#0ea5e9" stroke="#0c4a6e" stroke-width="1.5"/>' +
    '<circle cx="13" cy="13" r="4" fill="#fff"/></svg>',
})

/**
 * Hit the segments endpoint same-origin. The shared `noiseApi.fetchExcursionSegments`
 * forces dev-on-localhost over to the prod Railway URL, which doesn't help when the
 * local Vite dev server already serves /api/excursions/segments backed by Railway
 * Postgres — and the extra cross-origin hop is what was throwing "Failed to fetch"
 * in some networks. Same-origin works in both `vite dev` and production builds.
 */
async function fetchSegmentsSameOrigin({ lat, lng, hours, limit, radiusNm, signal } = {}) {
  const params = new URLSearchParams({ hours: String(hours) })
  params.set('lat', String(lat))
  params.set('lon', String(lng))
  if (limit) params.set('limit', String(limit))
  if (radiusNm != null) params.set('radius_nm', String(radiusNm))
  const res = await fetch(`/api/excursions/segments?${params}`, { signal })
  if (!res.ok) throw new Error(`segments ${res.status}`)
  return res.json()
}

/* ───────────────────────── reference data ──────────────────────────── */

const FRONT_RANGE_AIRPORTS = {
  KBDU: { name: 'Boulder Municipal',          lat: 40.0394, lon: -105.2258, elev: 5288 },
  KBJC: { name: 'Rocky Mountain Metro',       lat: 39.9086, lon: -105.1172, elev: 5673 },
  KAPA: { name: 'Centennial',                 lat: 39.5700, lon: -104.8497, elev: 5885 },
  KFNL: { name: 'Northern Colorado Regional', lat: 40.4517, lon: -105.0114, elev: 5016 },
  KEIK: { name: 'Erie Municipal',             lat: 40.0103, lon: -105.0492, elev: 5121 },
  KLMO: { name: 'Vance Brand',                lat: 40.1636, lon: -105.1636, elev: 5055 },
  KGXY: { name: 'Greeley-Weld County',        lat: 40.4348, lon: -104.6331, elev: 4697 },
}

/** Base dBA at 1000-ft AGL / 500-ft slant. From the spec. */
const TYPE_BASE_DBA = {
  PA25: 85, PA18: 82, HUSK: 80,
  C152: 75, C172: 75, C72R: 75, P28A: 75, P28B: 75, PA28: 75, P28R: 76,
  DA20: 73, DV20: 73, DA40: 76,
  C182: 78, C206: 79, SR20: 76, SR22: 78, S22T: 78, M20P: 76, M20J: 76,
  BE33: 77, BE35: 77, BE36: 78, BD7T: 78,
  PA44: 80, BE76: 80, DA42: 80, BE55: 80, BE58: 80,
  PC12: 82, TBM7: 82, TBM8: 82, TBM9: 82, DHC6: 82, BE9L: 82,
  C525: 88, C25A: 88, C25B: 88, C25C: 89, C501: 86, C551: 88,
  C560: 89, C56X: 89, C680: 90, C68A: 90, C750: 92,
  PC24: 88, SF50: 84, E50P: 86, E55P: 88,
  CL30: 90, CL35: 91, CL60: 92, GLF4: 92, G200: 91, GALX: 91,
  H25B: 91, LJ40: 90, LJ60: 91, BE40: 90,
  B738: 94, B739: 94, B38M: 92, B39M: 92, A319: 92, A320: 92, A321: 93,
  A20N: 90, A21N: 91, CRJ2: 92, CRJ7: 91, CRJ9: 92,
  E170: 90, E75L: 90, E190: 90, E195: 90, MD83: 95, MD88: 95,
  R22: 78, R44: 80, R66: 82,
  B06: 84, B407: 85, B429: 86,
  AS50: 84, AS55: 86, AS65: 88,
  EC20: 82, EC30: 84, EC35: 84, EC45: 86,
  H500: 84, S76: 90, S92: 92,
  H60: 92, C130: 96, C30J: 95,
  RV6: 76, RV7: 76, RV8: 76, RV10: 78, RV12: 74, RV14: 76,
}
const DEFAULT_BASE_DBA = 72

/** Human-readable label for an ICAO type code. */
const TYPE_LABEL = {
  C152: 'Cessna 152', C172: 'Cessna 172', C72R: 'Cessna 172R',
  C182: 'Cessna 182', C206: 'Cessna 206',
  P28A: 'Piper PA-28', P28B: 'Piper Cherokee 180', PA28: 'Piper Cherokee',
  P28R: 'Piper Arrow', PA44: 'Piper Seminole',
  PA25: 'Pawnee (tow plane)', PA18: 'Super Cub (tow plane)',
  HUSK: 'Aviat Husky (tow plane)',
  DA20: 'Diamond DA20', DV20: 'Diamond DV20', DA40: 'Diamond Star', DA42: 'Twin Star',
  SR20: 'Cirrus SR20', SR22: 'Cirrus SR22', S22T: 'Cirrus SR22T',
  BE33: 'Bonanza 33', BE35: 'Bonanza V35', BE36: 'Bonanza A36',
  BE58: 'Beech Baron', BE76: 'Beech Duchess',
  PC12: 'Pilatus PC-12', PC24: 'Pilatus PC-24',
  TBM7: 'TBM 700', TBM8: 'TBM 850', TBM9: 'TBM 900',
  C525: 'Citation CJ', C25A: 'Citation CJ2', C25B: 'Citation CJ3', C25C: 'Citation CJ4',
  C560: 'Citation V', C56X: 'Citation Excel', C680: 'Citation Sovereign',
  C750: 'Citation X', SF50: 'Cirrus Vision Jet',
  E50P: 'Phenom 100', E55P: 'Phenom 300',
  R22: 'Robinson R22', R44: 'Robinson R44', R66: 'Robinson R66',
  AS50: 'AS350 Écureuil', EC30: 'EC130', EC35: 'EC135', EC45: 'EC145',
  B06: 'Bell 206', B407: 'Bell 407', B429: 'Bell 429', H500: 'MD 500',
  GLID: 'Glider', VENT: 'Ventus glider', NIMB: 'Nimbus glider',
  DISC: 'Discus glider', AS21: 'ASK-21 glider', ASTR: 'Astir glider',
  DG10: 'DG-100 glider', DG15: 'DG-150 glider', DG80: 'DG-800 glider',
}

const PURPOSE_LABEL = {
  training:        'Training',
  tow_plane:       'Glider tow',
  glider:          'Glider',
  helicopter:      'Helicopter',
  airline:         'Airline',
  biz_jet:         'Business jet',
  turboprop:       'Turboprop',
  experimental:    'Experimental / homebuilt',
  ga_twin:         'GA twin (private)',
  ga_single:       'GA single (private)',
  medevac:         'Medevac',
  firefighting:    'Firefighting',
  law_enforcement: 'Law enforcement',
  military:        'Military',
  government:      'Government',
  patrol:          'Patrol',
  science:         'Science',
  survey:          'Survey',
  search_rescue:   'Search & rescue',
  unknown:         'Unknown',
}

const PURPOSE_COLOR = {
  training:        '#38bdf8', // sky-400
  tow_plane:       '#fb923c', // orange-400
  glider:          '#a78bfa', // violet-400
  helicopter:      '#f472b6', // pink-400
  airline:         '#94a3b8', // slate-400
  biz_jet:         '#facc15', // yellow-400
  turboprop:       '#e879f9', // fuchsia-400
  experimental:    '#86efac', // green-300
  ga_twin:         '#fcd34d', // amber-300
  ga_single:       '#60a5fa', // blue-400
  medevac:         '#f87171', // red-400
  firefighting:    '#fb7185', // rose-400
  law_enforcement: '#475569',
  military:        '#475569',
  government:      '#475569',
  patrol:          '#475569',
  science:         '#22d3ee',
  survey:          '#22d3ee',
  search_rescue:   '#ef4444',
  unknown:         '#6b7280',
}

/** Mirrors purposeOf in vite.config.js. */
function purposeFromType(type) {
  if (!type) return 'unknown'
  const T = String(type).toUpperCase()
  if (/^(PA25|PA18|PIAT|PC6)$/.test(T)) return 'tow_plane'
  if (/GLID|VENT|NIMB|DISC|SGS|ASTR|JS\d|LS\d|PIK|ASW|SZD/.test(T)) return 'glider'
  if (/^AS2\d|^AS3\d|^DG\d/.test(T)) return 'glider'
  if (/R22|R44|R66|AS50|EC\d|B06|B407|H500|S76|H60/.test(T)) return 'helicopter'
  if (/B73|B38|B78|A3[12]|A2[01]|CRJ|E7[05]|E19|MD[89]/.test(T)) return 'airline'
  if (/C25|C5[0-6]|C6[89]|C750|CL[36]|LJ\d|GL[AX]|H25|E55P|E50P|SF50|BE40/.test(T)) return 'biz_jet'
  if (/PC12|TBM|DHC6|BE9L/.test(T)) return 'turboprop'
  if (/RV[6-9]|RV10|LGEZ|VL3|LONG|LANCAIR/.test(T)) return 'experimental'
  if (/PA44|DA42|BE58|BE55|BE76/.test(T)) return 'ga_twin'
  if (/C172|C152|C182|C72R|P28A|P28B|PA28|P28R|DA40|DA20|DV20/.test(T)) return 'ga_single'
  return 'ga_single'
}

/** Reasonable typeBase lookup with engineless override. */
function baseDbaForType(type) {
  if (!type) return DEFAULT_BASE_DBA
  const T = String(type).toUpperCase()
  if (isEnginelessType(T)) return 0
  return TYPE_BASE_DBA[T] ?? DEFAULT_BASE_DBA
}

/** dBA at the listener for a single observation point. From the spec. */
function estDbaAtListener({
  type, altMslFt, listenerElevFt, distFt: dFt,
}) {
  if (isEnginelessType(type)) return 0
  const base = baseDbaForType(type)
  if (base <= 0) return 0
  const agl = Math.max((altMslFt ?? 0) - listenerElevFt, 100)
  const vert = agl > 1000 ? 6 * Math.log2(agl / 1000) : 0
  const slantFt = Math.hypot(dFt, agl)
  const lateral = slantFt > 500 ? 3 * Math.log2(slantFt / 500) : 0
  return Math.max(0, base - vert - lateral)
}

/* ───────────────────────── scenario row projector ──────────────────── */

/**
 * §11-CLIENT §5: Re-compute the per-row peak dBA at the listener under
 * the current scenario. Walks each track's segments, finds the loudest
 * post-substitution segment-level dBA, and returns the scenario row
 * (same shape as the baseline row but with `dba` overridden).
 *
 * Uses estDbaAtListener / distFt from this file (the page's dBA kernel
 * + leaflet-free distance helper). The pure substitution rules live in
 * ./whatif.js → segmentDba.
 */
export function applyScenarioToRow(row, scenario, listener) {
  if (!row) return null
  const tail = row.tail
  const substituted = scenario?.substituted || {}
  const winchTracks = scenario?.winchTracks || new Set()
  const wnchOn = (scenario?.winch_agl_ft || 0) > 0
  const hasAirframeSub = (
    substituted.VELE?.has(tail)
    || substituted.EFOX?.has(tail)
    || substituted.SINU?.has(tail)
  )
  const hasWinchSub = wnchOn && winchTracks.has(tail)
  if (!hasAirframeSub && !hasWinchSub) return row
  // Walk the segments and find the loudest post-substitution dBA at the
  // listener. We approximate each segment's geometry by the closest point
  // within the segment to the listener — that's the per-segment peak.
  let peak = 0
  for (const seg of row.segments || []) {
    const pts = seg?.points || []
    // Closest-approach point inside this segment.
    let bestDistFt = Infinity, bestAlt = null
    for (const p of pts) {
      const d = distFt(listener.lat, listener.lon, p[0], p[1])
      if (d < bestDistFt) { bestDistFt = d; bestAlt = p[2] ?? null }
    }
    if (bestAlt == null) continue
    const baseForSeg = estDbaAtListener({
      type: row.type,
      altMslFt: bestAlt,
      listenerElevFt: listener.elev_ft,
      distFt: bestDistFt,
    })
    const dba = segmentDba(row, seg, scenario, listener.elev_ft, baseForSeg)
    if (dba > peak) peak = dba
  }
  return { ...row, dba: peak }
}

/* ───────────────────────── analysis ────────────────────────────────── */

/** Compute closest approach + dBA for a single track. */
function analyzeTrack(track, listener, fleetIndex) {
  const { lat: lLat, lon: lLon, elev_ft } = listener
  let bestPt = null
  let bestDistFt = Infinity
  let bestTs = null
  for (const seg of track.segments || []) {
    for (const p of seg.points || []) {
      const d = distFt(lLat, lLon, p[0], p[1])
      if (d < bestDistFt) {
        bestDistFt = d
        bestPt = p
        bestTs = p[3] ?? null
      }
    }
  }
  if (!bestPt) return null
  // The server already applies the per-track baro offset to every point
  // before returning them (see noise/web/src/altCorrection.js
  // `applyOffsetToPoints`, called from vite.config.js line ~1369).
  // bestPt[2] is the verified MSL, NOT the raw transponder reading. We
  // still surface `alt_offset_ft` below as informational metadata so
  // we know how much correction has been applied per track.
  const altMslFt = bestPt[2] ?? null
  const altOffsetFt = Number(track.alt_offset_ft) || 0
  // Normalize tail + type once so (a) the fleet-roster lookup never misses
  // because of API whitespace, and (b) the (purpose, type) bucket key used
  // downstream is deterministic for the same logical aircraft.
  const normTail = String(track.tail || '').trim().toUpperCase()
  const normType = String(track.type || '').trim().toUpperCase()
  const dba = altMslFt != null
    ? estDbaAtListener({ type: normType, altMslFt, listenerElevFt: elev_ft, distFt: bestDistFt })
    : 0
  // Trust the server's resolved purpose (landed via the segments-endpoint
  // purpose field). Fall back to a thin type-based classifier only when
  // the server can't resolve one — typically very short live tracks with
  // no calibration history. The server's classifier mirrors the
  // leaderboard / missions so all three views stay in lock-step.
  const purpose = track.purpose || purposeFromType(normType)
  const fleet = normTail && fleetIndex ? fleetIndex.get(normTail) : null
  // Base airport: prefer the server's authoritative field (landed
  // 2026-06-01, derived from observed takeoff/landing patterns).
  // Fall back to the static fleet-roster airport only when the server
  // can't resolve one — covers transients/live-only windows with no
  // prior `tracks` row to project from.
  const baseAirport = track.base_airport || fleet?.airport || null
  return {
    tail: normTail || track.tail,
    type: normType,
    purpose,
    school: fleet?.school || null,
    baseAirport,
    schoolAirport: fleet?.airport || null,
    altOffsetFt,
    phase: track.phase || null,
    closestTs: bestTs,
    closestLat: bestPt[0],
    closestLon: bestPt[1],
    altMslFt,
    altAglFt: altMslFt != null ? altMslFt - elev_ft : null,
    distFt: bestDistFt,
    distNm: bestDistFt / 6076,
    dba,
    // §11-CLIENT §2: pass the new What-If fields through verbatim so the
    // scenario layer can sub in alternative-airframe dBA without needing
    // a second roundtrip. Optional chaining + array defaults keep this
    // safe against older deployments that don't ship them yet.
    altAirframeCandidates: Array.isArray(track.alt_airframe_candidates)
      ? track.alt_airframe_candidates : [],
    altSegmentCandidates: Array.isArray(track.alt_segment_candidates)
      ? track.alt_segment_candidates : [],
    // Carry the raw segments through too — the scenario re-aggregator
    // walks them per-point with shouldWinchSegment() and reads each
    // segment's alt_dba_by_substitute map.
    segments: Array.isArray(track.segments) ? track.segments : [],
  }
}

function groupBy(rows, key) {
  const out = new Map()
  for (const r of rows) {
    const k = r[key] || 'unknown'
    if (!out.has(k)) out.set(k, [])
    out.get(k).push(r)
  }
  return out
}

function summarize(rows) {
  if (!rows.length) {
    return { count: 0, peakDba: 0, meanDba: 0, minAlt: null, peakRow: null }
  }
  let peak = -Infinity, sum = 0, minAlt = Infinity, peakRow = null
  for (const r of rows) {
    if (r.dba > peak) { peak = r.dba; peakRow = r }
    sum += r.dba
    if (r.altAglFt != null && r.altAglFt < minAlt) minAlt = r.altAglFt
  }
  return {
    count: rows.length,
    peakDba: peak,
    meanDba: sum / rows.length,
    minAlt: Number.isFinite(minAlt) ? minAlt : null,
    peakRow,
  }
}

/* ───────────────────────── UI helpers ──────────────────────────────── */

function fmtNm(n) { return Number.isFinite(n) ? n.toFixed(2) : '—' }
function fmtFt(n) { return Number.isFinite(n) ? Math.round(n).toLocaleString() : '—' }
function fmtDba(n) { return Number.isFinite(n) ? n.toFixed(0) : '—' }
function fmtLocalTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function fmtDay(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/* ───────────────────────── SVG charts ──────────────────────────────── */

function PurposeBars({ counts, total, onSelect, selected }) {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  if (!sorted.length) return <Empty>No flights match the current filters.</Empty>
  const max = sorted[0][1]
  return (
    <div className="space-y-1.5">
      {sorted.map(([p, n]) => {
        const pct = total ? (n / total) * 100 : 0
        const isSel = selected.has(p)
        return (
          <button
            key={p}
            type="button"
            onClick={() => onSelect(p)}
            className={
              'group flex items-center gap-3 w-full text-left px-2 py-1 rounded ' +
              (isSel ? 'bg-white/15' : 'hover:bg-white/5')
            }
          >
            <div className="w-40 text-sm shrink-0">
              {PURPOSE_LABEL[p] || p}
            </div>
            <div className="flex-1 h-5 bg-white/5 rounded relative overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 rounded"
                style={{ width: `${(n / max) * 100}%`, background: PURPOSE_COLOR[p] || '#888' }}
              />
            </div>
            <div className="w-20 text-right text-sm tabular-nums">
              {n} <span className="text-white/40 text-xs">({pct.toFixed(0)}%)</span>
            </div>
          </button>
        )
      })}
    </div>
  )
}

/** Compact 12-hour-clock label for the hourly axis: "12am", "9am", "12pm", "3pm". */
function formatHour12(h) {
  const ap = h < 12 ? 'am' : 'pm'
  const hr = h % 12 || 12
  return `${hr}${ap}`
}

/** dBA → bucket color: red (loud) / orange / yellow / blue (quiet). Same
 *  thresholds the dBA histogram uses so the colour key stays consistent
 *  across charts. */
function dbaBandColor(d) {
  if (d >= 75) return '#f87171'
  if (d >= 65) return '#fb923c'
  if (d >= 55) return '#facc15'
  return '#38bdf8'
}

/**
 * Hourly histogram of audible passes (bar height = count). `colorBy` picks
 * which per-hour dBA statistic drives bar colour:
 *   'peak' — bar reflects the LOUDEST single pass in that hour
 *   'mean' — bar reflects the AVERAGE pass in that hour (lower = a busy hour
 *            of mostly-quiet passes vs. a busy hour with a couple of jets)
 *
 * `highlightHour` (optional) dims every other bar so the peak hour stands out.
 */
function HourlyChart({ buckets, highlightHour, colorBy = 'peak', caption, scenarioBuckets }) {
  // Font sizes are in viewBox units; the SVG scales down to fit its container
  // (typically ~480 px wide for the 720-unit viewBox = 0.67× scale). Tick
  // font 18 → ~12 px rendered, which is the readable floor.
  //
  // §11-CLIENT §6: when `scenarioBuckets` is supplied, the baseline bars
  // drop to 40% opacity grey and the scenario bars are overlaid in the
  // colour the bucket's dBA would land in. Tooltips on each pair carry
  // both values per bin so the user can compare.
  const scenarioOn = Array.isArray(scenarioBuckets) && scenarioBuckets.length === 24
  const max = Math.max(
    1,
    ...buckets.map((b) => b.count),
    ...(scenarioOn ? scenarioBuckets.map((b) => b.count) : []),
  )
  const W = 720, H = 200, padBottom = 44, padTop = 32, padX = 24
  const colW = (W - padX * 2) / 24
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {buckets.map((b, h) => {
        const x = padX + h * colW
        const barH = (b.count / max) * (H - padBottom - padTop)
        const dba = colorBy === 'mean'
          ? (b.count > 0 ? b.sumDba / b.count : 0)
          : b.peakDba
        const color = scenarioOn ? '#94a3b8' : dbaBandColor(dba)
        // Scenario layer: drawn on top of the baseline at full opacity.
        const sb = scenarioOn ? scenarioBuckets[h] : null
        const sbH = sb ? (sb.count / max) * (H - padBottom - padTop) : 0
        const sDba = sb
          ? (colorBy === 'mean'
              ? (sb.count > 0 ? sb.sumDba / sb.count : 0)
              : sb.peakDba)
          : 0
        const sColor = sb ? dbaBandColor(sDba) : '#000'
        return (
          <g key={h}>
            <rect
              x={x + 1}
              y={H - padBottom - barH}
              width={colW - 2}
              height={barH || 0.5}
              fill={color}
              opacity={(scenarioOn ? 0.4 : 1) * (highlightHour != null && highlightHour !== h ? 0.4 : 1)}
            >
              <title>
                {`baseline ${formatHour12(h)}: ${b.count} flights, ${colorBy === 'mean' ? 'mean' : 'peak'} ${Math.round(dba)} dBA`}
              </title>
            </rect>
            {scenarioOn && (
              <rect
                x={x + 1}
                y={H - padBottom - sbH}
                width={colW - 2}
                height={sbH || 0.5}
                fill={sColor}
                opacity={highlightHour != null && highlightHour !== h ? 0.5 : 1}
              >
                <title>
                  {`scenario ${formatHour12(h)}: ${sb.count} flights, ${colorBy === 'mean' ? 'mean' : 'peak'} ${Math.round(sDba)} dBA`}
                </title>
              </rect>
            )}
            {h % 3 === 0 && (
              <text
                x={x + colW / 2}
                y={H - 14}
                textAnchor="middle"
                fill="rgba(255,255,255,0.7)"
                fontSize="18"
                fontFamily="ui-monospace, monospace"
              >
                {formatHour12(h)}
              </text>
            )}
            {b.count > 0 && barH > 20 && (
              <text
                x={x + colW / 2}
                y={H - padBottom - barH - 5}
                textAnchor="middle"
                fill="rgba(255,255,255,0.85)"
                fontSize="14"
                fontFamily="ui-monospace, monospace"
              >
                {b.count}
              </text>
            )}
          </g>
        )
      })}
      <line x1={padX} y1={H - padBottom} x2={W - padX} y2={H - padBottom} stroke="rgba(255,255,255,0.15)" />
      <text x={padX} y={20} fill="rgba(255,255,255,0.6)" fontSize="16">
        {caption}
      </text>
    </svg>
  )
}

function DbaHistogram({ rows, floor, scenarioRows }) {
  // 10 bins from floor → 100 dBA. Same viewBox-font sizing as HourlyChart so
  // they stay legible when rendered side-by-side in the 2-column grid.
  // §11-CLIENT §6: when scenarioRows is supplied, baseline drops to 40%
  // grey and the scenario layer is overlaid in the bin's accent colour.
  const lo = floor, hi = 100
  const nBins = 10
  const step = (hi - lo) / nBins
  const bins = Array.from({ length: nBins }, () => 0)
  for (const r of rows) {
    if (r.dba < lo) continue
    const i = Math.min(nBins - 1, Math.floor((r.dba - lo) / step))
    bins[i]++
  }
  const scenarioOn = Array.isArray(scenarioRows)
  const sBins = Array.from({ length: nBins }, () => 0)
  if (scenarioOn) {
    for (const r of scenarioRows) {
      if (r.dba < lo) continue
      const i = Math.min(nBins - 1, Math.floor((r.dba - lo) / step))
      sBins[i]++
    }
  }
  const max = Math.max(1, ...bins, ...(scenarioOn ? sBins : []))
  const W = 720, H = 200, padBottom = 44, padTop = 32, padX = 24
  const colW = (W - padX * 2) / nBins
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {bins.map((c, i) => {
        const x = padX + i * colW
        const barH = (c / max) * (H - padBottom - padTop)
        const labelLo = Math.round(lo + i * step)
        const labelHi = Math.round(lo + (i + 1) * step)
        const colorAccent = labelLo >= 75 ? '#f87171'
          : labelLo >= 65 ? '#fb923c'
          : labelLo >= 55 ? '#facc15'
          : '#38bdf8'
        const baseColor = scenarioOn ? '#94a3b8' : colorAccent
        const sC = scenarioOn ? sBins[i] : 0
        const sBarH = (sC / max) * (H - padBottom - padTop)
        return (
          <g key={i}>
            <rect
              x={x + 2}
              y={H - padBottom - barH}
              width={colW - 4}
              height={barH || 0.5}
              fill={baseColor}
              opacity={scenarioOn ? 0.4 : 1}
            >
              <title>{`baseline ${labelLo}–${labelHi} dBA: ${c} flights`}</title>
            </rect>
            {scenarioOn && (
              <rect
                x={x + 2}
                y={H - padBottom - sBarH}
                width={colW - 4}
                height={sBarH || 0.5}
                fill={colorAccent}
              >
                <title>{`scenario ${labelLo}–${labelHi} dBA: ${sC} flights`}</title>
              </rect>
            )}
            <text
              x={x + colW / 2}
              y={H - 14}
              textAnchor="middle"
              fill="rgba(255,255,255,0.7)"
              fontSize="16"
              fontFamily="ui-monospace, monospace"
            >
              {labelLo}–{labelHi}
            </text>
            {c > 0 && (
              <text
                x={x + colW / 2}
                y={H - padBottom - barH - 5}
                textAnchor="middle"
                fill="rgba(255,255,255,0.85)"
                fontSize="14"
                fontFamily="ui-monospace, monospace"
              >
                {c}
              </text>
            )}
          </g>
        )
      })}
      <line x1={padX} y1={H - padBottom} x2={W - padX} y2={H - padBottom} stroke="rgba(255,255,255,0.15)" />
      <text x={padX} y={20} fill="rgba(255,255,255,0.6)" fontSize="16">
        {scenarioOn
          ? 'flights by est. peak dBA — grey = baseline, colour = scenario'
          : 'flights by estimated peak dBA at listener'}
      </text>
    </svg>
  )
}

function TimelineScatter({ rows, windowFromMs, windowToMs }) {
  // Bigger padding + larger viewBox font for the same readability target as
  // the other charts. Single-day windows show "9am" / "3pm"; multi-day
  // windows include a "M/D" prefix so the date change is obvious.
  const W = 720, H = 280, padL = 52, padR = 14, padB = 44, padT = 28
  const innerW = W - padL - padR
  const innerH = H - padT - padB
  const span = Math.max(1, windowToMs - windowFromMs)
  const multiDay = span > 26 * 3600 * 1000
  const yLo = 40, yHi = 100
  const yFor = (db) => padT + innerH - ((db - yLo) / (yHi - yLo)) * innerH
  const formatTick = (t) => {
    const d = new Date(t)
    const h = d.getHours()
    const hr12 = `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`
    return multiDay ? `${d.getMonth() + 1}/${d.getDate()} ${hr12}` : hr12
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {[50, 60, 70, 80, 90].map((db) => (
        <g key={db}>
          <line
            x1={padL} x2={W - padR}
            y1={yFor(db)} y2={yFor(db)}
            stroke="rgba(255,255,255,0.06)"
          />
          <text x={padL - 8} y={yFor(db) + 6} textAnchor="end" fill="rgba(255,255,255,0.7)" fontSize="16">
            {db}
          </text>
        </g>
      ))}
      {rows.map((r) => {
        if (r.closestTs == null) return null
        const x = padL + ((r.closestTs - windowFromMs) / span) * innerW
        const y = yFor(Math.min(yHi, Math.max(yLo, r.dba)))
        return (
          <circle
            key={`${r.tail}-${r.closestTs}`}
            cx={x} cy={y} r={4}
            fill={PURPOSE_COLOR[r.purpose] || '#999'}
            opacity={0.85}
          >
            <title>{`${r.tail} ${r.type} — ${fmtDba(r.dba)} dBA @ ${fmtFt(r.altAglFt)} ft AGL, ${fmtNm(r.distNm)} nm`}</title>
          </circle>
        )
      })}
      {/* x-axis: 6 ticks */}
      {Array.from({ length: 7 }, (_, i) => {
        const t = windowFromMs + (span * i) / 6
        const x = padL + (innerW * i) / 6
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={padT + innerH} y2={padT + innerH + 6} stroke="rgba(255,255,255,0.2)" />
            <text x={x} y={H - 14} textAnchor="middle" fill="rgba(255,255,255,0.7)" fontSize="16">
              {formatTick(t)}
            </text>
          </g>
        )
      })}
      <line x1={padL} x2={W - padR} y1={padT + innerH} y2={padT + innerH} stroke="rgba(255,255,255,0.2)" />
      <text x={padL} y={20} fill="rgba(255,255,255,0.6)" fontSize="16">
        every audible pass — y = est. dBA at listener, color = purpose
      </text>
    </svg>
  )
}

/* ───────────────────────── reusable bits ───────────────────────────── */

function Kpi({ label, value, sub, accent }) {
  return (
    <div className="border border-white/10 rounded-lg p-4 bg-white/[0.02]">
      <div className="text-xs text-white/50">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${accent || ''}`}>{value}</div>
      {sub && <div className="text-[10px] text-white/40 mt-1">{sub}</div>}
    </div>
  )
}

function Slider({ label, value, min, max, step, onChange, fmt }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between text-xs text-white/60 mb-1">
        <span>{label}</span>
        <span className="text-white/80 font-mono">{fmt ? fmt(value) : value}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-sky-400"
      />
    </label>
  )
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-sky-400"
      />
      <span>{label}</span>
    </label>
  )
}

function Section({ title, hint, children, right }) {
  return (
    <section className="border border-white/10 rounded-lg p-4 bg-white/[0.02]">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-white/90">{title}</h2>
          {hint && <div className="text-xs text-white/40 mt-0.5">{hint}</div>}
        </div>
        {right}
      </div>
      {children}
    </section>
  )
}

function Empty({ children }) {
  return <div className="text-sm text-white/40 py-6 text-center">{children}</div>
}

/* ───────────────────────── what-if panel ───────────────────────────── */

/** Lookup a substitute config by code. Returns null if the registry hasn't
 *  loaded yet or the code isn't in the published table. */
function findSub(subs, code) {
  if (!Array.isArray(subs)) return null
  return subs.find((s) => s?.code === code) || null
}

function Disclosure({ open, onToggle, label, children }) {
  return (
    <div className="border border-white/10 rounded-md bg-white/[0.015]">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2 text-left text-xs uppercase tracking-wide text-white/60 hover:text-white/90"
      >
        <span>{label}</span>
        <span className="text-white/40 font-mono">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="border-t border-white/10 px-3 py-3 space-y-3">
          {children}
        </div>
      )}
    </div>
  )
}

/** §11-CLIENT §7: format USD amounts in a board-meeting-friendly way:
 *  $2.4M, $57k, −$2.0M. Compact enough to fit table cells. */
function fmtUsd(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const sign = n < 0 ? '−' : ''
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(abs >= 10e6 ? 1 : 2)}M`
  if (abs >= 1e3) return `${sign}$${Math.round(abs / 1e3)}k`
  return `${sign}$${Math.round(abs)}`
}

/** §11-CLIENT §7: mini business-model table — one column per active
 *  substitute, rows for CapEx / op savings / salvage / NPV / break-even.
 *  Hidden entirely when nothing is active (every slider at default). */
function BusinessModelTable({ cols, dbDelta }) {
  if (!cols || cols.length === 0) return null
  return (
    <div className="border border-white/10 rounded-md bg-white/[0.015] overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs uppercase text-white/50">
          <tr>
            <th className="text-left py-2 px-3">Line</th>
            {cols.map((c) => (
              <th key={c.code} className="text-right px-3">
                {c.code} × {c.nAirframes}
                <div className="text-[10px] normal-case text-white/40 font-normal">
                  {c.name}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-white/10">
            <td className="py-1.5 px-3 text-white/70">CapEx</td>
            {cols.map((c) => (
              <td key={c.code} className="text-right px-3 tabular-nums">
                {fmtUsd(-c.capex)}
              </td>
            ))}
          </tr>
          <tr className="border-t border-white/5">
            <td className="py-1.5 px-3 text-white/70">
              Op savings ({cols[0]?.years ?? 10} yr, undiscounted)
            </td>
            {cols.map((c) => (
              <td key={c.code} className="text-right px-3 tabular-nums">
                {fmtUsd(c.opSavingsUndiscounted)}
              </td>
            ))}
          </tr>
          <tr className="border-t border-white/5">
            <td className="py-1.5 px-3 text-white/70">Salvage @ EoL</td>
            {cols.map((c) => (
              <td key={c.code} className="text-right px-3 tabular-nums text-white/70">
                {fmtUsd(c.salvage)}
              </td>
            ))}
          </tr>
          <tr className="border-t-2 border-white/30 bg-white/[0.04]">
            <td className="py-1.5 px-3 text-sm font-semibold uppercase tracking-wide">
              NPV @ {((cols[0]?.rate ?? 0.05) * 100).toFixed(1)}% / {cols[0]?.years ?? 10} yr
            </td>
            {cols.map((c) => (
              <td
                key={c.code}
                className={`text-right px-3 tabular-nums font-semibold ${c.npv >= 0 ? 'text-emerald-300' : 'text-red-300'}`}
              >
                {fmtUsd(c.npv)}
              </td>
            ))}
          </tr>
          <tr className="border-t border-white/10">
            <td className="py-1.5 px-3 text-white/70">Peak dB reduction @ listener</td>
            {cols.map((c) => (
              <td key={c.code} className="text-right px-3 tabular-nums">
                {dbDelta > 0 ? `−${dbDelta.toFixed(1)} dB` : '—'}
              </td>
            ))}
          </tr>
          <tr className="border-t border-white/5">
            <td className="py-1.5 px-3 text-white/70">$/dB-reduction</td>
            {cols.map((c) => (
              <td key={c.code} className="text-right px-3 tabular-nums text-white/70">
                {c.npv >= 0
                  ? <span className="text-emerald-300/80">pays for itself</span>
                  : (c.dollarsPerDb != null ? fmtUsd(c.dollarsPerDb) : '—')}
              </td>
            ))}
          </tr>
          <tr className="border-t border-white/5">
            <td className="py-1.5 px-3 text-white/70">Break-even hr/yr</td>
            {cols.map((c) => (
              <td key={c.code} className="text-right px-3 tabular-nums text-white/70">
                {c.npv >= 0
                  ? <span className="text-emerald-300/80">already</span>
                  : (c.breakEvenHours != null ? `${c.breakEvenHours.toLocaleString()} h` : '—')}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <div className="px-3 py-2 text-[10px] text-white/40 border-t border-white/5">
        N airframes = distinct tails picked at the current slider position
        (or 1 shared winch system). Op savings use the substitute's default
        annual hours unless overridden in Advanced. NPV negative = the
        program costs money on net even before counting noise reduction.
      </div>
    </div>
  )
}

/** §11-CLIENT §3: the four what-if sliders + the Advanced disclosure.
 *  Scenario state itself lives in the parent (the rest of the page reads
 *  it for the overlay histogram + business-model table), but the
 *  Advanced disclosure's open/closed state is purely local. */
function WhatIfPanel({ scenario, setScenario, substitutes, businessModelCols, dbDelta }) {
  // Kept as a single back-compat shell that renders sliders + financials
  // stacked, for any caller still using the original API. New callers
  // should use `WhatIfSliders` (the four headline sliders, suitable for
  // the docked panel) and `WhatIfFinancials` (advanced knobs + business-
  // model table) separately so the sliders can be locked at the bottom
  // of the viewport while the financials scroll with the page.
  return (
    <div className="space-y-4">
      <WhatIfSliders scenario={scenario} setScenario={setScenario} substitutes={substitutes} />
      <WhatIfFinancials scenario={scenario} setScenario={setScenario} substitutes={substitutes} businessModelCols={businessModelCols} dbDelta={dbDelta} />
    </div>
  )
}

/** §11-CLIENT §11: Just the four headline what-if sliders.
 *  This is what the docked bottom panel renders. Compact 2×2 grid so the
 *  panel stays short (~140 px tall) even on narrow screens.
 */
function WhatIfSliders({ scenario, setScenario, substitutes }) {
  const update = (patch) => setScenario((s) => ({ ...s, ...patch }))
  const subVele = findSub(substitutes, 'VELE')
  const subEfox = findSub(substitutes, 'EFOX')
  const subSinu = findSub(substitutes, 'SINU')
  const subWnch = findSub(substitutes, 'WNCH')
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
      <Slider
        label={`Electric trainer % (${subVele?.name || 'VELE'})`}
        value={scenario.electric_pct}
        min={0} max={100} step={5}
        onChange={(v) => update({ electric_pct: v })}
        fmt={(v) => `${v}%`}
      />
      <Slider
        label={`Eurofox tow % (${subEfox?.name || 'EFOX'})`}
        value={scenario.eurofox_pct}
        min={0} max={100} step={5}
        onChange={(v) => update({ eurofox_pct: v })}
        fmt={(v) => `${v}%`}
      />
      <Slider
        label={`Sinus glider % (${subSinu?.name || 'SINU'})`}
        value={scenario.sinus_pct}
        min={0} max={100} step={5}
        onChange={(v) => update({ sinus_pct: v })}
        fmt={(v) => `${v}%`}
      />
      <Slider
        label={`Winch under N ft AGL (${subWnch?.name || 'WNCH'})`}
        value={scenario.winch_agl_ft}
        min={0} max={3000} step={100}
        onChange={(v) => update({ winch_agl_ft: v })}
        fmt={(v) => (v === 0 ? 'off' : `${v.toLocaleString()} ft`)}
      />
    </div>
  )
}

/** §11-CLIENT §11: financial knobs (advanced disclosure) + business-model
 *  table. Renders inline below the noise graphs, where reading capex /
 *  NPV / break-even numbers benefits from scrolling and a stable layout.
 */
function WhatIfFinancials({ scenario, setScenario, substitutes, businessModelCols, dbDelta }) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const update = (patch) => setScenario((s) => ({ ...s, ...patch }))
  const updateHours = (code, hours) => setScenario((s) => ({
    ...s,
    annual_hours_override: { ...s.annual_hours_override, [code]: hours },
  }))
  const subVele = findSub(substitutes, 'VELE')
  const subEfox = findSub(substitutes, 'EFOX')
  const subSinu = findSub(substitutes, 'SINU')
  const subWnch = findSub(substitutes, 'WNCH')
  return (
    <div className="space-y-4">
      <Disclosure
        open={advancedOpen}
        onToggle={() => setAdvancedOpen((x) => !x)}
        label="Advanced — financial knobs (NPV inputs)"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Slider
            label="Discount rate"
            value={scenario.rate * 100}
            min={3} max={12} step={0.5}
            onChange={(v) => update({ rate: v / 100 })}
            fmt={(v) => `${v.toFixed(1)}%`}
          />
          <Slider
            label="Time horizon"
            value={scenario.horizon_yr}
            min={5} max={20} step={1}
            onChange={(v) => update({ horizon_yr: v })}
            fmt={(v) => `${v} yr`}
          />
          <Slider
            label="Fuel / electricity multiplier"
            value={scenario.fuel_multiplier}
            min={0.5} max={2.0} step={0.05}
            onChange={(v) => update({ fuel_multiplier: v })}
            fmt={(v) => `${v.toFixed(2)}×`}
          />
        </div>
        <div className="text-[10px] text-white/40 leading-snug">
          Op-savings multiplier sensitivity test — set to 0.5× to ask "what if
          fuel halves?", 2.0× to ask "what if it doubles?". Discount rate +
          time horizon feed the NPV formula.
        </div>
        <div className="space-y-3 pt-2 border-t border-white/5">
          <div className="text-[10px] uppercase tracking-wide text-white/40">
            Annual hours per airframe (override per substitute)
          </div>
          {[subVele, subEfox, subSinu, subWnch].map((sub) => {
            if (!sub) return null
            const dflt = sub.annual_hours_typical ?? 400
            const value = scenario.annual_hours_override[sub.code] ?? dflt
            return (
              <Slider
                key={sub.code}
                label={`${sub.code} — ${sub.name}`}
                value={value}
                min={100} max={1000} step={50}
                onChange={(v) => updateHours(sub.code, v)}
                fmt={(v) => `${v} h/yr${v === dflt ? ' (default)' : ''}`}
              />
            )
          })}
        </div>
      </Disclosure>
      {businessModelCols && businessModelCols.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-white/60">
            Business model — NPV per active substitute
          </div>
          <BusinessModelTable cols={businessModelCols} dbDelta={dbDelta} />
        </div>
      )}
    </div>
  )
}

/* ───────────────────────── mini map pin picker ─────────────────────── */

function MapClickHandler({ onSet }) {
  useMapEvents({
    click(e) { onSet(e.latlng.lat, e.latlng.lng) },
  })
  return null
}

function RecenterOn({ lat, lon }) {
  const map = useMap()
  useEffect(() => {
    map.setView([lat, lon], map.getZoom())
  }, [lat, lon, map])
  return null
}

function MiniMap({ lat, lon, onChange, radiusNm }) {
  return (
    <div className="rounded-md overflow-hidden border border-white/15 relative" style={{ height: 240 }}>
      <MapContainer
        center={[lat, lon]}
        zoom={12}
        style={{ height: '100%', width: '100%', background: '#0a0a0a' }}
        scrollWheelZoom
        attributionControl={false}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png"
          maxZoom={18}
        />
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png"
          maxZoom={18}
        />
        <Marker position={[lat, lon]} icon={PIN_ICON} />
        <MapClickHandler onSet={onChange} />
        <RecenterOn lat={lat} lon={lon} />
      </MapContainer>
      <div className="absolute bottom-1 left-2 right-2 flex items-center justify-between text-[10px] text-white/60 bg-black/40 rounded px-2 py-0.5 pointer-events-none">
        <span>click map to move pin</span>
        <span className="font-mono">{lat.toFixed(4)}, {lon.toFixed(4)} · r={radiusNm.toFixed(1)} nm</span>
      </div>
    </div>
  )
}

/* ───────────────────────── time-window chips ───────────────────────── */

const WINDOW_PRESETS = [
  { hours: 1,   label: '1 h'  },
  { hours: 6,   label: '6 h'  },
  { hours: 24,  label: '24 h' },
  { hours: 72,  label: '3 d'  },
  { hours: 168, label: '7 d'  },
]

function TimeWindowChips({ value, onChange, disabled }) {
  return (
    <div className="flex items-center gap-1">
      {WINDOW_PRESETS.map((p) => {
        const sel = value === p.hours
        return (
          <button
            key={p.hours}
            type="button"
            disabled={disabled}
            onClick={() => onChange(p.hours)}
            className={
              'px-2.5 py-1 rounded text-xs font-medium ' +
              (sel
                ? 'bg-sky-500 text-black'
                : 'bg-white/5 hover:bg-white/15 text-white/80 disabled:opacity-40')
            }
          >
            {p.label}
          </button>
        )
      })}
    </div>
  )
}

/* ───────────────────────── loading skeleton ────────────────────────── */

function LoadingSkeleton({ hours, radiusNm, stage }) {
  const isRetry = stage === 'retry'
  return (
    <div className="border border-white/10 rounded-lg p-8 bg-white/[0.02] text-center space-y-4">
      <div className="inline-block">
        <svg width="36" height="36" viewBox="0 0 36 36" className={'animate-spin ' + (isRetry ? 'text-amber-400' : 'text-sky-400')}>
          <circle cx="18" cy="18" r="14" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
            fill="none" strokeDasharray="60" strokeDashoffset="20" opacity="0.8" />
        </svg>
      </div>
      <div className="text-sm text-white/80">
        {isRetry
          ? <>First call timed out (cold cache). Retrying automatically…</>
          : <>Pulling {hours}&nbsp;h of tracks within {radiusNm.toFixed(1)}&nbsp;nm of the pin…</>}
      </div>
      <div className="text-xs text-white/40 max-w-md mx-auto leading-snug">
        {isRetry
          ? <>The second hit usually lands in 5–7 s once the table cache is warm. See API_REQUEST.md § 1 for the server-side fix.</>
          : <>Cold queries against Railway Postgres take 5–30&nbsp;s today (see API_REQUEST.md § 1). On a cold-cache 500 the page auto-retries once before surfacing an error.</>}
      </div>
    </div>
  )
}

function ErrorBox({ message, onRetry }) {
  const isTimeout = /timeout|503|gateway|500/i.test(message || '')
  return (
    <div className="bg-red-500/10 border border-red-500/30 rounded p-4 text-sm text-red-200 space-y-2">
      <div className="font-semibold">Couldn't load tracks: {message}</div>
      {isTimeout && (
        <div className="text-xs text-red-300/80">
          The segments endpoint timed out against the database. Try a smaller
          time window (1&nbsp;h or 6&nbsp;h) or a smaller radius (2–3&nbsp;nm).
          See <code>API_REQUEST.md</code> for the open performance ask.
        </div>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="bg-red-500/30 hover:bg-red-500/50 text-white rounded px-3 py-1 text-xs font-medium"
        >
          Retry
        </button>
      )}
    </div>
  )
}

/* ───────────────────────── main page ───────────────────────────────── */

const DEFAULT_LAT = 40.005
const DEFAULT_LON = -105.205

function readQuery() {
  if (typeof window === 'undefined') return {}
  const p = new URLSearchParams(window.location.search)
  const lat = Number(p.get('lat'))
  const lon = Number(p.get('lon'))
  return {
    lat: Number.isFinite(lat) ? lat : DEFAULT_LAT,
    lon: Number.isFinite(lon) ? lon : DEFAULT_LON,
    elev: Number(p.get('elev')) || null,
    hours: Number(p.get('hours')) || 6,
    radiusNm: Number(p.get('radius_nm')) || 3,
  }
}

/** Find the nearest Front Range airport to a lat/lon. Used to auto-fill
 *  terrain elev when the user drops a new pin. */
function nearestAirport(lat, lon) {
  let best = null, bestD = Infinity
  for (const [code, a] of Object.entries(FRONT_RANGE_AIRPORTS)) {
    const d = distFt(lat, lon, a.lat, a.lon)
    if (d < bestD) { bestD = d; best = { code, ...a, distFt: d } }
  }
  return best
}

export default function PointNoiseReport() {
  const q = useMemo(readQuery, [])
  const [lat, setLat] = useState(q.lat)
  const [lon, setLon] = useState(q.lon)
  const [elevFt, setElevFt] = useState(q.elev ?? FRONT_RANGE_AIRPORTS.KBDU.elev)
  const [windowHours, setWindowHours] = useState(q.hours)
  const [radiusNm, setRadiusNm] = useState(q.radiusNm)

  // filters
  const [dbaFloor, setDbaFloor] = useState(50)
  const [minPerHour, setMinPerHour] = useState(0)

  // §11-CLIENT §3: What-If scenario state. Four "what fraction" sliders +
  // four financial knobs (collapsed by default behind "Advanced"). Pure
  // client-side math — no API roundtrip when these change.
  //
  // `annual_hours_override` is keyed by substitute code; an entry means
  // "user has tuned this away from the substitute's default", absence
  // means "use sub.annual_hours_typical". An empty object on initial
  // mount = pristine defaults.
  const [scenario, setScenario] = useState({
    electric_pct: 0,
    eurofox_pct: 0,
    sinus_pct: 0,
    winch_agl_ft: 0,
    rate: 0.05,
    horizon_yr: 10,
    fuel_multiplier: 1.0,
    annual_hours_override: {},
  })
  const [excludeGliders, setExcludeGliders] = useState(true)
  const [purposeSelected, setPurposeSelected] = useState(new Set())

  // Browser geolocation. Permission-prompted; resolves quickly on success,
  // surfaces a short error string on denial / timeout.
  const [geoStatus, setGeoStatus] = useState(null) // 'asking' | 'ok' | string error
  const useMyLocation = () => {
    if (!('geolocation' in navigator)) {
      setGeoStatus('not supported by this browser')
      return
    }
    setGeoStatus('asking')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const nLat = pos.coords.latitude
        const nLon = pos.coords.longitude
        setLat(nLat); setLon(nLon)
        const a = nearestAirport(nLat, nLon)
        if (a) setElevFt(a.elev)
        setGeoStatus('ok')
      },
      (err) => setGeoStatus(err.message || 'permission denied'),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60 * 1000 },
    )
  }

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [raw, setRaw] = useState(null)
  const abortRef = useRef(null)

  // resolved-listener for current fetch (decoupled from inputs so they can edit freely).
  const [listener, setListener] = useState({ lat: q.lat, lon: q.lon, elev_ft: q.elev ?? FRONT_RANGE_AIRPORTS.KBDU.elev })
  const [appliedHours, setAppliedHours] = useState(q.hours)
  const [appliedRadius, setAppliedRadius] = useState(q.radiusNm)

  const [loadingStage, setLoadingStage] = useState(null) // null | 'first' | 'retry'
  const runReport = () => {
    if (abortRef.current) abortRef.current.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true); setError(null); setLoadingStage('first')
    setListener({ lat, lon, elev_ft: elevFt })
    setAppliedHours(windowHours); setAppliedRadius(radiusNm)
    const params = { lat, lng: lon, hours: windowHours, limit: 500, radiusNm: radiusNm, signal: ctrl.signal }
    const succeed = (data) => { setRaw(data); setLoading(false); setLoadingStage(null) }
    const fail = (e) => {
      if (e.name === 'AbortError') return
      setError(String(e.message || e))
      setLoading(false); setLoadingStage(null)
    }
    // Cold-cache 500s on this endpoint are the rule, not the exception —
    // see API_REQUEST.md § 1 (`pg-pool Query read timeout` on first hit;
    // the second call lands in 5–7 s once the table cache is warm). Auto-
    // retry once on 500/504/timeout-shaped errors before surfacing the
    // failure to the user. A non-5xx error (404/400/network) skips the
    // retry — those won't recover.
    const isRetryableErr = (e) => /\b(500|502|503|504|timeout|failed to fetch)\b/i.test(String(e.message || e))
    fetchSegmentsSameOrigin(params).then(succeed).catch((e) => {
      if (e.name === 'AbortError' || ctrl.signal.aborted) return
      if (!isRetryableErr(e)) return fail(e)
      setLoadingStage('retry')
      // Brief delay so the pool's in-flight query has a chance to drain
      // before we slam it again — also lets the cache start populating.
      setTimeout(() => {
        if (ctrl.signal.aborted) return
        fetchSegmentsSameOrigin({ ...params, signal: ctrl.signal })
          .then(succeed)
          .catch((err) => { if (err.name !== 'AbortError') fail(err) })
      }, 1500)
    })
  }

  // auto-fetch on initial mount
  useEffect(() => { runReport() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [])

  // Load the school-fleet roster once. Purpose classification now lives
  // on the server (`track.purpose`), so the only remaining use for this
  // index is the base-airport fall-back when the server can't resolve
  // `track.base_airport` for a given tail (typically very short live
  // tracks with no history). Cached forever by the browser since it's a
  // static asset.
  const [fleetIndex, setFleetIndex] = useState(null)
  useEffect(() => {
    let aborted = false
    fetch('/flight_schools_fleets.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (aborted || !data?.schools) return
        const idx = new Map()
        for (const s of data.schools) {
          for (const a of s.aircraft || []) {
            if (!a.tail) continue
            idx.set(String(a.tail).toUpperCase(), {
              school: s.name,
              airport: s.airport,
              category: a.category || null,
            })
          }
        }
        setFleetIndex(idx)
      })
      .catch(() => { /* fall back to type-only classification */ })
    return () => { aborted = true }
  }, [])

  // §11-CLIENT §1: Fetch the substitute registry once on mount and cache it
  // for the page lifetime. `null` = still loading (don't render the What-If
  // section yet); `[]` = either no subs configured or the fetch 404'd — the
  // panel stays hidden (fail-open) so the rest of the report still renders.
  const [substitutes, setSubstitutes] = useState(null)
  useEffect(() => {
    let aborted = false
    fetch('/substitutes.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`substitutes ${r.status}`))))
      .then((d) => { if (!aborted) setSubstitutes(Array.isArray(d?.substitutes) ? d.substitutes : []) })
      .catch(() => { if (!aborted) setSubstitutes([]) })
    return () => { aborted = true }
  }, [])

  // §11-CLIENT §8: URL hash serialization. Parse the existing hash on mount
  // and seed the scenario state from it (one-shot — `[]` deps). Subsequent
  // slider changes write back into the hash via history.replaceState so the
  // URL stays shareable without polluting the back/forward stack.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const raw = window.location.hash?.replace(/^#/, '')
    if (!raw) return
    const p = new URLSearchParams(raw)
    const next = {}
    const num = (k, fallback) => {
      const v = Number(p.get(k))
      return Number.isFinite(v) ? v : fallback
    }
    if (p.has('electric'))  next.electric_pct    = num('electric', 0)
    if (p.has('eurofox'))   next.eurofox_pct     = num('eurofox', 0)
    if (p.has('sinus'))     next.sinus_pct       = num('sinus', 0)
    if (p.has('winch_agl')) next.winch_agl_ft    = num('winch_agl', 0)
    if (p.has('disc'))      next.rate            = num('disc', 5) / 100
    if (p.has('horizon'))   next.horizon_yr      = num('horizon', 10)
    if (p.has('fuel'))      next.fuel_multiplier = num('fuel', 1)
    if (Object.keys(next).length) {
      setScenario((s) => ({ ...s, ...next }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Push current scenario back into the URL hash on every change.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams({
      electric:  String(scenario.electric_pct),
      eurofox:   String(scenario.eurofox_pct),
      sinus:     String(scenario.sinus_pct),
      winch_agl: String(scenario.winch_agl_ft),
      disc:      (scenario.rate * 100).toFixed(1),
      horizon:   String(scenario.horizon_yr),
      fuel:      scenario.fuel_multiplier.toFixed(2),
    })
    try {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${params}`)
    } catch {}
  }, [
    scenario.electric_pct,
    scenario.eurofox_pct,
    scenario.sinus_pct,
    scenario.winch_agl_ft,
    scenario.rate,
    scenario.horizon_yr,
    scenario.fuel_multiplier,
  ])

  /** Convert the raw track payload into per-flight rows at the listener. */
  const allRows = useMemo(() => {
    if (!raw?.tracks) return []
    const out = []
    for (const t of raw.tracks) {
      const r = analyzeTrack(t, listener, fleetIndex)
      if (r) out.push(r)
    }
    return out
  }, [raw, listener, fleetIndex])

  // Stage 1 — apply the geometric / dBA / glider / purpose filters.
  const baseFilteredRows = useMemo(() => {
    const within = (r) => r.distNm <= appliedRadius
    return allRows.filter((r) => {
      if (!within(r)) return false
      if (excludeGliders && (r.purpose === 'glider' || r.dba === 0)) return false
      if (r.dba < dbaFloor) return false
      if (purposeSelected.size && !purposeSelected.has(r.purpose)) return false
      return true
    })
  }, [allRows, appliedRadius, excludeGliders, dbaFloor, purposeSelected])

  // Stage 2 — drop purposes whose busiest hour is below the slider threshold.
  // Built per-purpose (not per-type) so a "morning training rush" purpose
  // stays visible even when its 24 h average rate is small. Applied to EVERY
  // chart below so the rollups stay coherent.
  //
  // peakHourByPurpose[purpose] = the max count of that purpose observed in
  // any single local-hour bucket of the current dataset. The slider compares
  // against that peak: minPerHour=2 means "show purposes that hit ≥ 2 flights
  // in their busiest hour".
  const peakHourByPurpose = useMemo(() => {
    const grid = new Map() // purpose -> Array(24)
    for (const r of baseFilteredRows) {
      if (r.closestTs == null) continue
      const h = new Date(r.closestTs).getHours()
      let arr = grid.get(r.purpose)
      if (!arr) { arr = new Array(24).fill(0); grid.set(r.purpose, arr) }
      arr[h]++
    }
    const peaks = new Map()
    for (const [p, arr] of grid) peaks.set(p, Math.max(0, ...arr))
    return peaks
  }, [baseFilteredRows])

  const purposeRateAcceptable = useMemo(() => {
    const ok = new Set()
    for (const [p, peak] of peakHourByPurpose) {
      if (peak >= minPerHour) ok.add(p)
    }
    return ok
  }, [peakHourByPurpose, minPerHour])

  const filteredRows = useMemo(
    () => minPerHour > 0
      ? baseFilteredRows.filter((r) => purposeRateAcceptable.has(r.purpose))
      : baseFilteredRows,
    [baseFilteredRows, purposeRateAcceptable, minPerHour],
  )

  // ── rollups ──────────────────────────────────────────────────────────
  const purposeCounts = useMemo(() => {
    const m = new Map()
    for (const r of filteredRows) m.set(r.purpose, (m.get(r.purpose) || 0) + 1)
    return m
  }, [filteredRows])

  const byType = useMemo(() => groupBy(filteredRows, 'type'), [filteredRows])

  // Base-airport breakdown. Each row carries `schoolAirport` from the
  // fleet-roster join (analyzeTrack); when a tail isn't in the roster
  // there's no authoritative base, so we bucket those as 'unknown'.
  // Tracked separately at the end so it sits below the known airports.
  const byBase = useMemo(() => {
    const m = new Map()
    for (const r of filteredRows) {
      const key = r.baseAirport || '__unknown'
      let list = m.get(key)
      if (!list) { list = []; m.set(key, list) }
      list.push(r)
    }
    return m
  }, [filteredRows])

  const baseRows = useMemo(() => {
    const rows = []
    for (const [key, list] of byBase) {
      if (key === '__unknown') continue
      const summ = summarize(list)
      rows.push({
        base: key,
        count: list.length,
        perHour: list.length / Math.max(1, appliedHours),
        peakDba: summ.peakDba,
        meanDba: summ.meanDba,
        minAlt: summ.minAlt,
      })
    }
    rows.sort((a, b) => b.count - a.count)
    const unk = byBase.get('__unknown')
    if (unk?.length) {
      const summ = summarize(unk)
      rows.push({
        base: '__unknown',
        count: unk.length,
        perHour: unk.length / Math.max(1, appliedHours),
        peakDba: summ.peakDba,
        meanDba: summ.meanDba,
        minAlt: summ.minAlt,
      })
    }
    return rows
  }, [byBase, appliedHours])

  const hourlyBuckets = useMemo(() => {
    const buckets = Array.from({ length: 24 }, () => ({ count: 0, peakDba: 0, sumDba: 0 }))
    for (const r of filteredRows) {
      if (r.closestTs == null) continue
      const h = new Date(r.closestTs).getHours()
      const b = buckets[h]
      b.count++
      b.sumDba += r.dba
      if (r.dba > b.peakDba) b.peakDba = r.dba
    }
    return buckets
  }, [filteredRows])

  // §11-CLIENT §6: scenario overlay. Pick the substituted tail Sets from
  // the slider state, then re-aggregate the histogram using the scenario-
  // world per-row dBA. When every slider is at default this is a no-op
  // and `scenarioActive` stays false (the overlay layer is hidden).
  const scenarioActive = (
    scenario.electric_pct > 0
    || scenario.eurofox_pct > 0
    || scenario.sinus_pct > 0
    || scenario.winch_agl_ft > 0
  )
  const scenarioPicks = useMemo(() => {
    // Use the full row set (not filteredRows) as the substitution pool so
    // the picked tails are stable when the user nudges the dBA-floor or
    // purpose-peak-hour filter. The overlay still respects the active
    // filters via filteredRows; only the deterministic pick is global.
    return {
      VELE: pickSubstituted(allRows, 'VELE', scenario.electric_pct),
      EFOX: pickSubstituted(allRows, 'EFOX', scenario.eurofox_pct),
      SINU: pickSubstituted(allRows, 'SINU', scenario.sinus_pct),
    }
  }, [allRows, scenario.electric_pct, scenario.eurofox_pct, scenario.sinus_pct])

  // Tail Set for winch — every track that lists WNCH as a segment candidate
  // becomes a winch participant once the slider is above 0. Per-segment
  // gating still happens via shouldWinchSegment().
  const winchTracks = useMemo(() => {
    if ((scenario.winch_agl_ft || 0) <= 0) return new Set()
    const s = new Set()
    for (const r of allRows) {
      for (const c of r.altSegmentCandidates || []) {
        if (c?.code === 'WNCH' && r.tail) { s.add(r.tail); break }
      }
    }
    return s
  }, [allRows, scenario.winch_agl_ft])

  // Bundle the scenario for the per-row projector.
  const scenarioCtx = useMemo(() => ({
    ...scenario,
    substituted: scenarioPicks,
    winchTracks,
  }), [scenario, scenarioPicks, winchTracks])

  // Scenario rows — same filters as filteredRows but with per-row dBA
  // replaced by applyScenarioToRow(). When scenarioActive=false this is
  // a thin pass-through (the helper short-circuits unsubstituted rows).
  const scenarioRows = useMemo(() => {
    if (!scenarioActive) return filteredRows
    return filteredRows.map((r) => applyScenarioToRow(r, scenarioCtx, listener))
  }, [filteredRows, scenarioCtx, listener, scenarioActive])

  const scenarioHourly = useMemo(() => {
    const buckets = Array.from({ length: 24 }, () => ({ count: 0, peakDba: 0, sumDba: 0 }))
    if (!scenarioActive) return buckets
    for (const r of scenarioRows) {
      if (r.closestTs == null) continue
      const h = new Date(r.closestTs).getHours()
      const b = buckets[h]
      b.count++
      b.sumDba += r.dba
      if (r.dba > b.peakDba) b.peakDba = r.dba
    }
    return buckets
  }, [scenarioRows, scenarioActive])

  // §11-CLIENT §7: listener-side peak drop — baseline peak minus scenario
  // peak across the filtered window. Used by both the business-model table
  // (NPV $/dB column) and the WhatIfPanel header.
  const dbDelta = useMemo(() => {
    if (!scenarioActive) return 0
    let basePeak = 0, scnPeak = 0
    for (const r of filteredRows) if (r.dba > basePeak) basePeak = r.dba
    for (const r of scenarioRows) if (r.dba > scnPeak) scnPeak = r.dba
    return Math.max(0, basePeak - scnPeak)
  }, [scenarioActive, filteredRows, scenarioRows])

  // §11-CLIENT §7: business-model table. One column per active substitute
  // (slider > 0).
  const businessModelCols = useMemo(() => {
    if (!scenarioActive || !substitutes?.length) return []
    const cols = []
    const slot = (code, pct, isWinch = false) => {
      if (!pct || pct <= 0) return
      const sub = findSub(substitutes, code)
      if (!sub) return
      const n = isWinch
        ? (winchTracks.size > 0 ? 1 : 0)  // single shared winch system
        : scenarioPicks[code]?.size || 0
      if (n <= 0) return
      const col = businessModelColumn({ sub, scenario, nAirframes: n, dbDelta })
      if (col) cols.push(col)
    }
    slot('VELE', scenario.electric_pct)
    slot('EFOX', scenario.eurofox_pct)
    slot('SINU', scenario.sinus_pct)
    slot('WNCH', scenario.winch_agl_ft, true)
    return cols
  }, [scenarioActive, substitutes, scenarioPicks, winchTracks, scenario, dbDelta])

  const peakHour = useMemo(() => {
    let h = -1, best = -Infinity
    for (let i = 0; i < hourlyBuckets.length; i++) {
      const score = hourlyBuckets[i].peakDba * 0.7 + hourlyBuckets[i].count * 2
      if (score > best && hourlyBuckets[i].count > 0) { best = score; h = i }
    }
    return h
  }, [hourlyBuckets])

  // Purpose-and-Type breakdown, built as ordered GROUPS rather than a flat
  // row list. Each purpose appears exactly once; its types sit underneath
  // it in count-desc order. Rendering iterates groups → types, so no sort
  // tie-break can ever re-print the same purpose header mid-table.
  //
  // A C172 owned by a flight school resolves to `training` at the row
  // level; a C172 owned by a private operator resolves to `ga_single`.
  // Both are C172 but belong to different purpose groups, so the same
  // type code can appear once per purpose.
  const purposeGroups = useMemo(() => {
    // purpose -> Map(type -> rows[])
    const byPurpose = new Map()
    for (const r of filteredRows) {
      let typeMap = byPurpose.get(r.purpose)
      if (!typeMap) { typeMap = new Map(); byPurpose.set(r.purpose, typeMap) }
      let list = typeMap.get(r.type)
      if (!list) { list = []; typeMap.set(r.type, list) }
      list.push(r)
    }
    const groups = []
    for (const [purpose, typeMap] of byPurpose) {
      const types = []
      const allRowsForPurpose = []
      for (const [type, list] of typeMap) {
        const summ = summarize(list)
        types.push({
          type, label: TYPE_LABEL[type] || type,
          count: list.length,
          perHour: list.length / Math.max(1, appliedHours),
          peakDba: summ.peakDba,
          meanDba: summ.meanDba,
          minAlt: summ.minAlt,
        })
        for (const r of list) allRowsForPurpose.push(r)
      }
      types.sort((a, b) => b.count - a.count)
      // Roll-up row for the cross-tab: the purpose totals across all
      // its types. Peak/mean/minAlt computed from the raw rows (not
      // from the per-type aggregates) so the mean is weighted correctly
      // by flight count, not by type bucket.
      const rollup = summarize(allRowsForPurpose)
      groups.push({
        purpose,
        total: allRowsForPurpose.length,
        perHour: allRowsForPurpose.length / Math.max(1, appliedHours),
        peakDba: rollup.peakDba,
        meanDba: rollup.meanDba,
        minAlt: rollup.minAlt,
        types,
      })
    }
    groups.sort((a, b) => b.total - a.total)
    return groups
  }, [filteredRows, appliedHours])

  // Diagnostic — fires once when the rendered purpose labels collide on
  // different underlying purpose keys (would mean we're attributing two
  // logical groups to the same heading and the user sees duplicate
  // headers). Drops to the console as a single warn line we can grep.
  useEffect(() => {
    const seen = new Map()
    for (const g of purposeGroups) {
      const label = PURPOSE_LABEL[g.purpose] || g.purpose
      const prior = seen.get(label)
      if (prior && prior !== g.purpose) {
        console.warn(
          `[PointNoiseReport] duplicate purpose label "${label}" maps to multiple keys: ${prior} and ${g.purpose}`,
        )
      } else {
        seen.set(label, g.purpose)
      }
    }
  }, [purposeGroups])

  // Top-N events
  const loudest = useMemo(() => {
    return [...filteredRows].sort((a, b) => b.dba - a.dba).slice(0, 8)
  }, [filteredRows])

  const lowest = useMemo(() => {
    return [...filteredRows]
      .filter((r) => r.altAglFt != null)
      .sort((a, b) => a.altAglFt - b.altAglFt)
      .slice(0, 8)
  }, [filteredRows])

  // Summary numbers
  const summary = useMemo(() => summarize(filteredRows), [filteredRows])
  const flightsPerHour = filteredRows.length / Math.max(1, appliedHours)
  const dominantPurpose = useMemo(() => {
    let best = null, n = 0
    for (const [p, c] of purposeCounts) if (c > n) { n = c; best = p }
    return best
  }, [purposeCounts])

  // window bounds for the timeline
  const windowToMs = raw?.window?.to ? Date.parse(raw.window.to) : Date.now()
  const windowFromMs = raw?.window?.from ? Date.parse(raw.window.from) : (windowToMs - appliedHours * 3600 * 1000)

  /* ───────────────────────── render ─────────────────────────────────── */

  const togglePurpose = (p) => {
    setPurposeSelected((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p); else next.add(p)
      return next
    })
  }

  // §11-CLIENT §11: docked slider panel can be collapsed to a thin strip
  // so it doesn't hide the bottom of the page when the user is reading
  // the methodology / footer. Default open when scenario is active so the
  // user can see what they're tweaking; default open generally too —
  // collapsing is opt-in.
  const [dockOpen, setDockOpen] = useState(true)

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* Bottom padding leaves room for the docked slider panel so the
          final section isn't covered. ~190 px = open panel height; ~36 px
          when collapsed. */}
      <div
        className="max-w-6xl mx-auto px-4 py-5 space-y-4"
        style={{ paddingBottom: dockOpen ? 200 : 56 }}
      >
        <header>
          <h1 className="text-2xl font-semibold">Point noise report</h1>
          <p className="text-sm text-white/50 mt-1">
            Every aircraft that passed within audible range of a single point —
            estimated dBA, why each was there, and who was operating it.
          </p>
        </header>

        {/* Controls — map pin + time window chips + radius slider */}
        <div className="border border-white/10 rounded-lg p-4 bg-white/[0.02] grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Left: mini-map */}
          <div className="lg:col-span-5">
            <div className="text-xs text-white/60 mb-2">Listener location — click map or pick an airport</div>
            <MiniMap
              lat={lat}
              lon={lon}
              radiusNm={radiusNm}
              onChange={(nLat, nLon) => {
                setLat(nLat); setLon(nLon)
                const a = nearestAirport(nLat, nLon)
                if (a) setElevFt(a.elev)
              }}
            />
            <div className="flex flex-wrap items-center gap-1 mt-2">
              <button
                type="button"
                onClick={useMyLocation}
                disabled={geoStatus === 'asking'}
                className="text-[11px] px-2 py-0.5 rounded bg-sky-500/20 hover:bg-sky-500/40 text-sky-200 disabled:opacity-50"
                title="Use the browser's geolocation to set the pin"
              >
                {geoStatus === 'asking' ? '…locating' : '📍 Use my location'}
              </button>
              <span className="mx-1 text-white/20">|</span>
              {Object.entries(FRONT_RANGE_AIRPORTS).map(([code, a]) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => { setLat(a.lat); setLon(a.lon); setElevFt(a.elev) }}
                  className="text-[11px] px-2 py-0.5 rounded bg-white/5 hover:bg-white/15 text-white/80"
                  title={a.name}
                >
                  {code}
                </button>
              ))}
            </div>
            {geoStatus && geoStatus !== 'asking' && geoStatus !== 'ok' && (
              <div className="text-[10px] text-red-300/80 mt-1">
                Location unavailable: {geoStatus}
              </div>
            )}
          </div>

          {/* Right: time window + radius + terrain + run */}
          <div className="lg:col-span-7 space-y-4">
            <div>
              <div className="text-xs text-white/60 mb-2">Time window — how far back to look</div>
              <TimeWindowChips value={windowHours} onChange={setWindowHours} disabled={loading} />
              <div className="text-[10px] text-white/40 mt-1">
                Wider windows are slower (24 h ≈ 16 s on dev today). Start narrow, expand.
              </div>
            </div>

            <Slider
              label="Audible radius around the pin"
              value={radiusNm}
              min={0.5} max={10} step={0.5}
              onChange={setRadiusNm}
              fmt={(v) => `${v.toFixed(1)} nm`}
            />

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <div className="text-xs text-white/60 mb-1">Terrain elev at pin (ft MSL)</div>
                <input
                  type="number" step="1" value={elevFt}
                  onChange={(e) => setElevFt(Number(e.target.value))}
                  className="w-full bg-neutral-900 border border-white/15 rounded px-2 py-1 text-sm font-mono"
                />
                <div className="text-[10px] text-white/40 mt-1">
                  Auto-filled from nearest airport. Used for AGL calc.
                </div>
              </label>
              <div className="flex flex-col justify-end">
                <button
                  type="button" onClick={runReport}
                  disabled={loading}
                  className="bg-sky-500 hover:bg-sky-400 disabled:bg-sky-700 disabled:opacity-60 text-black font-semibold rounded px-3 py-2 text-sm"
                >
                  {loading ? 'Loading…' : 'Run report'}
                </button>
                {raw?.window && !loading && (
                  <div className="text-[10px] text-white/40 mt-2 text-center">
                    {new Date(raw.window.from).toLocaleString()} → {new Date(raw.window.to).toLocaleTimeString()}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Live-filter strip */}
        <div className="border border-white/10 rounded-lg p-4 bg-white/[0.02] grid grid-cols-1 md:grid-cols-4 gap-4">
          <Slider
            label={'Ignore below'}
            value={dbaFloor}
            min={0} max={90} step={1}
            onChange={setDbaFloor}
            fmt={(v) => `${v} dBA`}
          />
          <Slider
            label="Ignore purposes whose busiest hour is below"
            value={minPerHour}
            min={0} max={10} step={1}
            onChange={setMinPerHour}
            fmt={(v) => `${v} / peak h`}
          />
          <div className="space-y-2 text-sm">
            <Toggle
              label="Exclude gliders (engineless)"
              checked={excludeGliders}
              onChange={setExcludeGliders}
            />
            {purposeSelected.size > 0 && (
              <button
                type="button"
                onClick={() => setPurposeSelected(new Set())}
                className="text-xs text-sky-400 hover:underline"
              >
                Clear purpose filter ({purposeSelected.size} selected)
              </button>
            )}
          </div>
          <div className="text-xs text-white/40 leading-snug">
            All filters apply live to every chart below — KPIs, rollups, hourly,
            scatter, tables. Click a purpose bar to focus on it; click again to
            unfocus. Gliders are engineless (0 dBA) and dropped by default.
          </div>
        </div>

        {/* Status: error first, then loading skeleton replacing all results. */}
        {error && <ErrorBox message={error} onRetry={runReport} />}

        {loading && !error && <LoadingSkeleton hours={windowHours} radiusNm={radiusNm} stage={loadingStage} />}

        {!loading && !error && (
        <>
        {/* KPI strip */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Kpi
            label="Audible flights"
            value={summary.count}
            sub={`${flightsPerHour.toFixed(1)} / h · radius ${appliedRadius.toFixed(1)} nm`}
          />
          <Kpi
            label="Peak dBA"
            value={summary.count ? `${fmtDba(summary.peakDba)} dBA` : '—'}
            sub={summary.peakRow
              ? `${summary.peakRow.tail} ${summary.peakRow.type} · ${fmtFt(summary.peakRow.altAglFt)} ft AGL`
              : 'no flights'}
            accent={summary.peakDba >= 80 ? 'text-red-400' : summary.peakDba >= 70 ? 'text-orange-400' : 'text-white'}
          />
          <Kpi
            label="Mean dBA"
            value={summary.count ? `${fmtDba(summary.meanDba)} dBA` : '—'}
            sub="across all audible passes"
          />
          <Kpi
            label="Peak hour"
            value={peakHour >= 0 ? `${String(peakHour).padStart(2, '0')}:00` : '—'}
            sub={peakHour >= 0 ? `${hourlyBuckets[peakHour].count} flights · peak ${fmtDba(hourlyBuckets[peakHour].peakDba)} dBA` : 'no events'}
          />
          <Kpi
            label="Dominant purpose"
            value={dominantPurpose ? (PURPOSE_LABEL[dominantPurpose] || dominantPurpose) : '—'}
            sub={dominantPurpose ? `${purposeCounts.get(dominantPurpose)} flights` : ''}
            accent={dominantPurpose ? '' : ''}
          />
        </div>

        {/* Purpose rollup — the headline */}
        <Section
          title="Why was this noise here? — by purpose"
          hint="Click a row to focus the rest of the report on that category. This is the most-asked question of a noise report: who's flying, why?"
        >
          <PurposeBars
            counts={purposeCounts}
            total={summary.count}
            onSelect={togglePurpose}
            selected={purposeSelected}
          />
        </Section>

        {/* Hourly (peak-coloured) + dBA distribution side by side */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Section
            title={scenarioActive ? 'When does the noise happen? — peak dBA (scenario overlay)' : 'When does the noise happen? — peak dBA'}
            hint={scenarioActive
              ? (() => {
                // §11-CLIENT §12: show whether the PEAK chart actually
                // responded to the scenario sliders, and explain it when
                // it didn't. Peak in each hour is driven by the loudest
                // pass — if that pass is a non-substituted aircraft
                // (typical when only training is being swapped), the
                // colour stays put. Compute the per-hour peak delta to
                // surface the response (or honest lack thereof).
                let movedHours = 0, totalPeakDrop = 0, hoursWithPasses = 0
                for (let h = 0; h < 24; h++) {
                  const b = hourlyBuckets[h]; const sb = scenarioHourly[h]
                  if (!b || b.count === 0) continue
                  hoursWithPasses++
                  const drop = b.peakDba - (sb?.peakDba || 0)
                  if (drop > 0.5) { movedHours++; totalPeakDrop += drop }
                }
                if (movedHours === 0) {
                  return 'Grey = baseline. No hour\'s peak changed — the loudest pass each hour is a non-substituted aircraft. Look at the avg-dBA chart below for the typical-pass impact.'
                }
                const avgDrop = (totalPeakDrop / movedHours).toFixed(1)
                return `Grey = baseline. Coloured = scenario. ${movedHours} of ${hoursWithPasses} hours got a quieter peak (avg −${avgDrop} dBA).`
              })()
              : 'Bar = passes that hour · colour = LOUDEST single pass in that hour'}
          >
            <HourlyChart
              buckets={hourlyBuckets}
              scenarioBuckets={scenarioActive ? scenarioHourly : null}
              highlightHour={peakHour}
              colorBy="peak"
              caption="flights / hour (local) — bar color = peak dBA in that hour"
            />
          </Section>
          <Section
            title={scenarioActive ? 'How loud were the passes? (scenario overlay)' : 'How loud were the passes?'}
            hint={scenarioActive
              ? 'Grey = baseline. Coloured = what-if scenario.'
              : 'Estimated peak dBA at the listener for each audible flight'}
          >
            <DbaHistogram
              rows={filteredRows}
              floor={dbaFloor}
              scenarioRows={scenarioActive ? scenarioRows : null}
            />
          </Section>
        </div>

        {/* §11-CLIENT §11: What-If FINANCIALS (NPV inputs + business-model
            table) renders inline here, right under the overlay charts.
            The four headline sliders that drive the overlay live in a
            FIXED-BOTTOM docked panel (rendered at the end of this
            component) so they remain in view while the user scrolls the
            graphs. The two parts are deliberately decoupled — slider
            scrubs feel instant; financial reading wants a stable layout. */}
        {(() => {
          if (substitutes == null) return null
          const anyCandidate = allRows.some(
            (r) => (r.altAirframeCandidates?.length || 0) > 0
              || (r.altSegmentCandidates?.length || 0) > 0,
          )
          if (!substitutes.length || !anyCandidate) {
            if (allRows.length === 0) return null
            return (
              <Section title="What-If: quieter fleets">
                <div className="text-xs text-white/40 leading-snug">
                  Scenario substitution data isn't in this segments response
                  yet — available after the next API deploy. The rest of the
                  noise report is unaffected.
                </div>
              </Section>
            )
          }
          return (
            <Section
              title="What-If: financial impact"
              hint="Drag the sliders in the docked panel at the bottom of the page. NPV / $-per-dB updates live below."
            >
              <WhatIfFinancials
                scenario={scenario}
                setScenario={setScenario}
                substitutes={substitutes}
                businessModelCols={businessModelCols}
                dbDelta={dbDelta}
              />
            </Section>
          )
        })()}

        {/* Hourly mean — same shape, but the colour answers a different
            question: "how loud was the typical pass during that hour?" A
            busy hour of training C172s reads quiet; one biz-jet arrival
            in an otherwise empty hour spikes the peak chart but not this
            one. */}
        <Section
          title={scenarioActive ? 'When does the noise happen? — average dBA (scenario overlay)' : 'When does the noise happen? — average dBA'}
          hint={scenarioActive
            ? (() => {
              // §11-CLIENT §12: average pulls down whenever any pass in
              // an hour gets quieter, so this chart is much more
              // responsive to training-purpose substitutions than the
              // peak chart above. Surface the avg drop so the user sees
              // the substitution working here even when the peak chart
              // looks frozen.
              let movedHours = 0, totalDrop = 0, hoursWithPasses = 0
              for (let h = 0; h < 24; h++) {
                const b = hourlyBuckets[h]; const sb = scenarioHourly[h]
                if (!b || b.count === 0) continue
                hoursWithPasses++
                const baseMean = b.count > 0 ? b.sumDba / b.count : 0
                const scnMean = sb && sb.count > 0 ? sb.sumDba / sb.count : 0
                const drop = baseMean - scnMean
                if (drop > 0.5) { movedHours++; totalDrop += drop }
              }
              if (movedHours === 0) return 'Grey = baseline. No hour\'s average changed materially.'
              const avgDrop = (totalDrop / movedHours).toFixed(1)
              return `Grey = baseline. Coloured = scenario. ${movedHours} of ${hoursWithPasses} hours got a quieter mean (avg −${avgDrop} dBA across all passes).`
            })()
            : 'Same bars (passes per local hour) but colour = AVERAGE dBA of those passes, so a busy quiet hour looks different from a single-loud-pass hour'}
        >
          <HourlyChart
            buckets={hourlyBuckets}
            scenarioBuckets={scenarioActive ? scenarioHourly : null}
            colorBy="mean"
            caption="flights / hour (local) — bar color = mean dBA across passes that hour"
          />
        </Section>

        {/* Timeline scatter */}
        <Section title="Every audible pass over the window" hint="Hover a dot for tail / type / closest-approach AGL.">
          {filteredRows.length
            ? <TimelineScatter rows={filteredRows} windowFromMs={windowFromMs} windowToMs={windowToMs} />
            : <Empty>No flights match the current filters.</Empty>}
        </Section>

        {/* Purpose and Type breakdown */}
        <Section
          title="Purpose and Type breakdown"
          hint={minPerHour > 0
            ? `Grouped by purpose magnitude → type. Purposes whose busiest hour was < ${minPerHour} flights are hidden by the live filter.`
            : 'Grouped by purpose magnitude → type within each group. Use the purpose-peak-hour slider above to hide quiet purposes.'}
        >
          {purposeGroups.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-white/50 border-b border-white/10">
                  <tr>
                    <th className="text-left py-2 pr-3" colSpan={2}>Purpose / Type</th>
                    <th className="text-right pr-3">Flights</th>
                    <th className="text-right pr-3">/ h</th>
                    <th className="text-right pr-3">Peak dBA</th>
                    <th className="text-right pr-3">Mean dBA</th>
                    <th className="text-right pr-3">Min AGL</th>
                  </tr>
                </thead>
                <tbody>
                  {purposeGroups.map((g) => (
                    <Fragment key={g.purpose}>
                      {/* Roll-up row: purpose totals across all its types. */}
                      <tr className="border-t border-white/15 bg-white/[0.025]">
                        <td className="py-2 pr-3" colSpan={2}>
                          <span
                            className="inline-flex items-center gap-2 text-sm font-semibold"
                            style={{ color: PURPOSE_COLOR[g.purpose] || '#999' }}
                          >
                            <span
                              className="inline-block w-2.5 h-2.5 rounded-full"
                              style={{ background: PURPOSE_COLOR[g.purpose] || '#999' }}
                            />
                            {PURPOSE_LABEL[g.purpose] || g.purpose}
                            <span className="text-white/40 text-xs font-normal">
                              ({g.types.length} {g.types.length === 1 ? 'type' : 'types'})
                            </span>
                          </span>
                        </td>
                        <td className="text-right pr-3 tabular-nums font-semibold">{g.total}</td>
                        <td className="text-right pr-3 tabular-nums font-semibold text-white/70">
                          {g.perHour.toFixed(2)}
                        </td>
                        <td className="text-right pr-3 tabular-nums font-semibold">
                          {fmtDba(g.peakDba)}
                        </td>
                        <td className="text-right pr-3 tabular-nums font-semibold text-white/70">
                          {fmtDba(g.meanDba)}
                        </td>
                        <td className="text-right pr-3 tabular-nums font-semibold text-white/70">
                          {fmtFt(g.minAlt)}
                        </td>
                      </tr>
                      {/* Indented per-type detail rows. */}
                      {g.types.map((t) => (
                        <tr key={`${g.purpose}|${t.type}`} className="border-b border-white/5">
                          <td className="py-1 pr-1 w-6">
                            <span className="block w-3 ml-3 border-l border-b border-white/15 h-3 -mt-1" />
                          </td>
                          <td className="py-1 pr-3 font-mono">
                            <span className="text-white/80">{t.type}</span>
                            <span className="text-white/40 ml-2 text-xs">{t.label}</span>
                          </td>
                          <td className="text-right pr-3 tabular-nums text-white/80">{t.count}</td>
                          <td className="text-right pr-3 tabular-nums text-white/50">{t.perHour.toFixed(2)}</td>
                          <td className="text-right pr-3 tabular-nums text-white/80">{fmtDba(t.peakDba)}</td>
                          <td className="text-right pr-3 tabular-nums text-white/50">{fmtDba(t.meanDba)}</td>
                          <td className="text-right pr-3 tabular-nums text-white/50">{fmtFt(t.minAlt)}</td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                  {/* Grand total — sums and listener-wide max/mean. */}
                  <tr className="border-t-2 border-white/30 bg-white/[0.04]">
                    <td className="py-2 pr-3 text-sm font-semibold uppercase tracking-wide text-white/70" colSpan={2}>
                      Total
                    </td>
                    {(() => {
                      const grand = summarize(filteredRows)
                      return (
                        <>
                          <td className="text-right pr-3 tabular-nums font-semibold">{grand.count}</td>
                          <td className="text-right pr-3 tabular-nums font-semibold text-white/70">
                            {(grand.count / Math.max(1, appliedHours)).toFixed(2)}
                          </td>
                          <td className="text-right pr-3 tabular-nums font-semibold">{fmtDba(grand.peakDba)}</td>
                          <td className="text-right pr-3 tabular-nums font-semibold text-white/70">{fmtDba(grand.meanDba)}</td>
                          <td className="text-right pr-3 tabular-nums font-semibold text-white/70">{fmtFt(grand.minAlt)}</td>
                        </>
                      )
                    })()}
                  </tr>
                </tbody>
              </table>
            </div>
          ) : <Empty>No purposes pass the peak-hour threshold. Lower it to see more.</Empty>}
        </Section>

        {/* By based airport — `base_airport` now comes from the server's
            authoritative join against the `tracks` table (landed
            2026-06-01, see API_REQUEST.md § 3a). Falls back to the
            school-fleet roster's airport only when the server can't
            resolve one (live-only windows with no historical row). */}
        <Section
          title="By based airport"
          hint="Where each aircraft lives, derived from observed takeoff / landing history on the tracks table."
        >
          {baseRows.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-white/50 border-b border-white/10">
                  <tr>
                    <th className="text-left py-2 pr-3">Base</th>
                    <th className="text-left pr-3">Share</th>
                    <th className="text-right pr-3">Flights</th>
                    <th className="text-right pr-3">/ h</th>
                    <th className="text-right pr-3">Peak dBA</th>
                    <th className="text-right pr-3">Mean dBA</th>
                    <th className="text-right pr-3">Min AGL</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const totalKnown = baseRows
                      .filter((r) => r.base !== '__unknown')
                      .reduce((s, r) => s + r.count, 0)
                    const knownMax = Math.max(1, ...baseRows
                      .filter((r) => r.base !== '__unknown')
                      .map((r) => r.count))
                    return baseRows.map((r) => {
                      const isUnknown = r.base === '__unknown'
                      const ap = !isUnknown ? FRONT_RANGE_AIRPORTS[r.base] : null
                      const widthPct = isUnknown ? 0 : (r.count / knownMax) * 100
                      const sharePct = !isUnknown && totalKnown
                        ? (r.count / totalKnown) * 100 : null
                      return (
                        <tr key={r.base} className="border-b border-white/5">
                          <td className="py-1.5 pr-3">
                            {isUnknown ? (
                              <span className="text-white/40 text-xs italic">Unknown base</span>
                            ) : (
                              <>
                                <span className="font-mono text-white/90">{r.base}</span>
                                {ap && <span className="text-white/40 ml-2 text-xs">{ap.name}</span>}
                              </>
                            )}
                          </td>
                          <td className="pr-3 w-48">
                            {!isUnknown && (
                              <div className="flex items-center gap-2">
                                <div className="flex-1 h-2 bg-white/5 rounded overflow-hidden">
                                  <div className="h-full bg-sky-400/70 rounded" style={{ width: `${widthPct}%` }} />
                                </div>
                                <span className="text-[10px] text-white/40 tabular-nums w-9 text-right">
                                  {sharePct != null ? `${sharePct.toFixed(0)}%` : ''}
                                </span>
                              </div>
                            )}
                          </td>
                          <td className="text-right pr-3 tabular-nums">{r.count}</td>
                          <td className="text-right pr-3 tabular-nums text-white/60">{r.perHour.toFixed(2)}</td>
                          <td className="text-right pr-3 tabular-nums">{fmtDba(r.peakDba)}</td>
                          <td className="text-right pr-3 tabular-nums text-white/60">{fmtDba(r.meanDba)}</td>
                          <td className="text-right pr-3 tabular-nums text-white/60">{fmtFt(r.minAlt)}</td>
                        </tr>
                      )
                    })
                  })()}
                </tbody>
              </table>
              {baseRows.some((r) => r.base === '__unknown') && (
                <div className="text-[10px] text-white/40 mt-2 leading-snug">
                  "Unknown base" = tails with no observed takeoff / landing
                  history at any Front Range airport on file. These are
                  typically true transients (overflight only) — confirmed
                  base attribution would require a wider history window
                  than this query pulls.
                </div>
              )}
            </div>
          ) : <Empty>No flights match.</Empty>}
        </Section>

        {/* Notable events — loudest & lowest */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Section title="Loudest events" hint="Highest estimated dBA at the listener">
            {loudest.length
              ? <EventTable rows={loudest} sortHint="dba" />
              : <Empty>Nothing audible above {dbaFloor} dBA.</Empty>}
          </Section>
          <Section title="Lowest overflights" hint="Closest AGL clearance at closest approach">
            {lowest.length
              ? <EventTable rows={lowest} sortHint="agl" />
              : <Empty>No altitude data in the current set.</Empty>}
          </Section>
        </div>

        {/* Methodology */}
        <Section title="Methodology" hint="What the numbers mean and where they came from">
          <ul className="text-xs text-white/60 space-y-1.5 list-disc pl-5">
            <li>
              Source: <code>/api/excursions/segments</code> against
              {' '}<code>{listener.lat.toFixed(4)}, {listener.lon.toFixed(4)}</code> with a
              {' '}<code>radius_nm={appliedRadius.toFixed(1)}</code> filter and the picked time window.
              ADS-B tracks are returned with per-point lat / lon / MSL alt / timestamp.
            </li>
            <li>
              Per-flight peak dBA at the listener uses the published proxy:
              base type-dBA at 1000-ft AGL / 500-ft slant, then −6 dB per altitude
              doubling above 1000 ft AGL and −3 dB per distance doubling beyond
              500 ft slant. Default base when type unknown: {DEFAULT_BASE_DBA} dBA.
            </li>
            <li>
              Engineless aircraft (gliders, balloons) contribute 0 dBA — the noise
              of an aerotow shows up under the tow plane (PA25 / PA18), not the
              glider it pulled.
            </li>
            <li>
              "Audible" = closest-approach slant range ≤ {appliedRadius.toFixed(1)} nm AND
              estimated dBA ≥ {dbaFloor}. Higher floor = stricter audibility threshold.
              The "ignore purposes whose busiest hour is below {minPerHour}" filter
              drops a whole purpose from <em>every</em> chart on this page when its
              peak local-hour count in the pulled data is below the threshold —
              so a quiet but evenly-distributed purpose can still pass when a
              bursty one would too.
            </li>
            <li>
              Listener terrain elevation = {fmtFt(listener.elev_ft)} ft MSL (used for
              AGL). Auto-filled from the nearest Front Range airport when you move
              the pin; override the number to use precise terrain.
            </li>
            <li>
              Altitudes are <strong>verified MSL</strong>, not raw ADS-B baro.
              The server applies a per-flight regional-smoothed correction
              (<code>alt_offset_ft</code>) to every point before returning it,
              which materially changes which passes count as low overflights —
              transponder drift on a single tail can run ±300 ft. {(() => {
                const withOffset = allRows.filter((r) => r.altOffsetFt && r.altOffsetFt !== 0).length
                const total = allRows.length
                if (!total) return null
                return `${withOffset} of ${total} tracks in this window had a non-zero correction applied.`
              })()}
            </li>
            <li>
              Purpose attribution comes straight from the server's
              <code>track.purpose</code> field — the same classifier the
              leaderboard and missions use, so all three views are
              guaranteed to agree. The server resolves it from a curated
              hierarchy: type-unambiguous airframes (PA25/PA18 → tow plane,
              GLID/AS&hellip;/DG&hellip; → glider) win first, then the
              tracks-table school join attributes <em>training</em>, then
              the type-code classifier handles the rest.
              {(() => {
                const total = allRows.length
                if (!total) return null
                // Mark rows that came from the type-fallback by stamping
                // an internal flag, but it's expensive to plumb that
                // through; instead show the simpler "all resolved" view
                // until we add a coverage column to the API response.
                return ` (${total} tracks classified in this window.)`
              })()}
            </li>
          </ul>
        </Section>

        <footer className="text-xs text-white/30 pt-6">
          {raw && (
            <>
              {raw.tracks?.length || 0} tracks in window · {allRows.length} unique passes ·
              {' '}{filteredRows.length} after filters
              {raw.candidates_considered != null
                ? ` · ${raw.candidates_considered} candidates considered server-side`
                : ''}
            </>
          )}
        </footer>
        </>
        )}
      </div>

      {/* §11-CLIENT §11: docked What-If sliders.
          Fixed at the bottom of the viewport so the user can drag any
          slider while watching the hourly + dBA-histogram charts respond
          live. Rendered only when substitutes are loaded AND the current
          window has at least one substitutable track — otherwise the
          panel has nothing to swap. */}
      {(() => {
        if (substitutes == null || substitutes.length === 0) return null
        const anyCandidate = allRows.some(
          (r) => (r.altAirframeCandidates?.length || 0) > 0
            || (r.altSegmentCandidates?.length || 0) > 0,
        )
        if (!anyCandidate) return null
        const activeCount =
          (scenario.electric_pct > 0 ? 1 : 0)
          + (scenario.eurofox_pct > 0 ? 1 : 0)
          + (scenario.sinus_pct > 0 ? 1 : 0)
          + (scenario.winch_agl_ft > 0 ? 1 : 0)
        return (
          <div
            className="fixed bottom-0 inset-x-0 z-[1500] border-t border-white/15 bg-neutral-950/95 backdrop-blur shadow-[0_-8px_24px_rgba(0,0,0,0.6)]"
          >
            <div className="max-w-6xl mx-auto px-4 py-2">
              <button
                type="button"
                onClick={() => setDockOpen((o) => !o)}
                className="w-full flex items-center justify-between text-left text-xs uppercase tracking-wide text-white/60 hover:text-white"
              >
                <span className="flex items-center gap-2">
                  <span className={dockOpen ? '' : 'opacity-60'}>What-If sliders</span>
                  {activeCount > 0 && (
                    <span className="text-[10px] bg-sky-500/30 text-sky-200 rounded px-1.5 py-0.5 normal-case">
                      {activeCount} active · Δ peak {dbDelta > 0 ? `−${Math.round(dbDelta)}` : '0'} dBA
                    </span>
                  )}
                </span>
                <span className="text-white/40">{dockOpen ? '▾' : '▴'}</span>
              </button>
              {dockOpen && (
                <div className="pt-2 pb-1">
                  <WhatIfSliders
                    scenario={scenario}
                    setScenario={setScenario}
                    substitutes={substitutes}
                  />
                </div>
              )}
            </div>
          </div>
        )
      })()}
    </div>
  )
}

function EventTable({ rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs uppercase text-white/50 border-b border-white/10">
          <tr>
            <th className="text-left py-2 pr-3">Time</th>
            <th className="text-left pr-3">Tail</th>
            <th className="text-left pr-3">Type</th>
            <th className="text-left pr-3">Purpose</th>
            <th className="text-right pr-3">dBA</th>
            <th className="text-right pr-3">AGL ft</th>
            <th className="text-right pr-3">Dist nm</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.tail}-${r.closestTs}-${i}`} className="border-b border-white/5">
              <td className="py-1.5 pr-3 text-xs text-white/70 font-mono">
                {fmtDay(r.closestTs)} {fmtLocalTime(r.closestTs)}
              </td>
              <td className="pr-3 font-mono">{r.tail}</td>
              <td className="pr-3 font-mono text-white/70">{r.type || '?'}</td>
              <td className="pr-3 text-xs" style={{ color: PURPOSE_COLOR[r.purpose] || '#999' }}>
                {PURPOSE_LABEL[r.purpose] || r.purpose}
              </td>
              <td className="text-right pr-3 tabular-nums font-semibold">{fmtDba(r.dba)}</td>
              <td className="text-right pr-3 tabular-nums text-white/60">{fmtFt(r.altAglFt)}</td>
              <td className="text-right pr-3 tabular-nums text-white/60">{fmtNm(r.distNm)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
