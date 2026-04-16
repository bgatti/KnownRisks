import { useEffect, useMemo, useState } from 'react'
import { NOISE_ZONES } from './noiseZones'
import { classifyPoint, trackLengthFt } from './geo'

// Classify a whole track: does it have at least one yellow/orange/red point?
// Returns the worst (most severe) classification observed.
function worstClass(points) {
  let worst = null
  const rank = { yellow: 1, orange: 2, red: 3 }
  for (const p of points) {
    const c = classifyPoint(p[0], p[1], p[2], NOISE_ZONES)
    if (!c) continue
    if (!worst || rank[c] > rank[worst]) worst = c
    if (worst === 'red') return 'red'
  }
  return worst
}

export default function YearOverYear() {
  const [meta, setMeta] = useState(null)
  const [yearlyTracks, setYearlyTracks] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    fetch('/flights_yearly.json')
      .then((r) => r.json()).then(setMeta).catch((e) => setErr(String(e)))
    fetch('/tracks_yearly.json')
      .then((r) => (r.ok ? r.json() : null))
      .then(setYearlyTracks)
      .catch(() => setYearlyTracks(null))
  }, [])

  // Analyze tracks per year: flight-level worst class AND length-based incursion ratios.
  const perYearAnalysis = useMemo(() => {
    if (!yearlyTracks?.tracks) return {}
    const bucket = {}
    for (const t of yearlyTracks.tracks) {
      const y = t.year || String(t.years_back || '?')
      if (!bucket[y]) {
        bucket[y] = {
          year: y,
          sample: 0,
          atLeastOrange: 0,
          atLeastRed: 0,
          totalFt: 0,
          yellowFt: 0,
          orangeFt: 0,
          redFt: 0,
        }
      }
      const b = bucket[y]
      b.sample++
      const w = worstClass(t.points)
      if (w === 'orange') b.atLeastOrange++
      if (w === 'red') { b.atLeastOrange++; b.atLeastRed++ }
      const { total, yellow, orange, red } = trackLengthFt(t.points, NOISE_ZONES)
      b.totalFt += total
      b.yellowFt += yellow
      b.orangeFt += orange
      b.redFt += red
    }
    return bucket
  }, [yearlyTracks])

  const rows = useMemo(() => {
    if (!meta?.years) return []
    return meta.years
      .slice()
      .sort((a, b) => a.years_back - b.years_back)
      .map((y) => {
        const yr = y.window_end.slice(0, 4)
        const a = perYearAnalysis[yr] || {
          sample: 0, atLeastOrange: 0, atLeastRed: 0,
          totalFt: 0, yellowFt: 0, orangeFt: 0, redFt: 0,
        }
        const pct = (n) => (a.totalFt ? (n / a.totalFt) * 100 : null)
        return {
          year: yr,
          yearsBack: y.years_back,
          window: `${y.window_begin} → ${y.window_end}`,
          flights: y.unique_flights,
          aircraft: y.unique_aircraft,
          sample: a.sample,
          pctOrange: a.sample ? (a.atLeastOrange / a.sample) * 100 : null,
          pctRed: a.sample ? (a.atLeastRed / a.sample) * 100 : null,
          totalMi: a.totalFt / 5280,
          pctLenYellow: pct(a.yellowFt),
          pctLenOrange: pct(a.orangeFt),
          pctLenRed: pct(a.redFt),
        }
      })
  }, [meta, perYearAnalysis])

  const maxFlights = Math.max(1, ...rows.map((r) => r.flights || 0))

  if (err) return <div className="p-6 text-red-400">error: {err}</div>
  if (!meta) return <div className="p-6 text-white/60">loading flights_yearly.json…</div>

  const trackCount = yearlyTracks?.tracks?.length ?? 0
  const totalSample = rows.reduce((s, r) => s + r.sample, 0)
  const totalMi = rows.reduce((s, r) => s + (r.totalMi || 0), 0)
  const sumMi = (key) => rows.reduce((s, r) => s + ((r[key] || 0) * (r.totalMi || 0) / 100), 0)
  const lenPctYellow = totalMi ? (sumMi('pctLenYellow') / totalMi) * 100 : 0
  const lenPctOrange = totalMi ? (sumMi('pctLenOrange') / totalMi) * 100 : 0
  const lenPctRed = totalMi ? (sumMi('pctLenRed') / totalMi) * 100 : 0

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">KBDU — Year over Year</h1>
        <div className="text-xs text-white/60 mt-1">
          Same calendar week pulled from OpenSky for each of the last 5 years.
          Sample tracks: {trackCount} total ({totalSample} classified)
          {yearlyTracks ? null : <span className="text-yellow-400"> · tracks_yearly.json not yet available</span>}
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
        <Kpi label="Total KBDU flights (samples)" value={rows.reduce((s, r) => s + (r.flights || 0), 0)} />
        <Kpi label="Path length sampled" value={`${totalMi.toFixed(0)} mi`} sub={`${totalSample} tracks`} />
        <Kpi
          label="% length in yellow"
          value={totalMi ? `${lenPctYellow.toFixed(2)}%` : '—'}
          sub="within 250 ft of boundary"
          accent="text-yellow-300"
        />
        <Kpi
          label="% length in orange"
          value={totalMi ? `${lenPctOrange.toFixed(2)}%` : '—'}
          sub="250–500 ft inside a zone"
          accent="text-orange-400"
        />
        <Kpi
          label="% length in red"
          value={totalMi ? `${lenPctRed.toFixed(2)}%` : '—'}
          sub="> 500 ft inside a zone"
          accent="text-red-400"
        />
      </div>

      {/* Per-year table with inline bars */}
      <div className="border border-white/10 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-white/5 text-white/60 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-2">Year</th>
              <th className="text-left px-3 py-2">Window</th>
              <th className="text-right px-3 py-2">Flights</th>
              <th className="text-right px-3 py-2">Aircraft</th>
              <th className="text-right px-3 py-2">Sample</th>
              <th className="text-right px-3 py-2">Path mi</th>
              <th className="text-right px-3 py-2">% ≥ orange</th>
              <th className="text-right px-3 py-2">% ≥ red</th>
              <th className="text-right px-3 py-2">% len yellow</th>
              <th className="text-right px-3 py-2">% len orange</th>
              <th className="text-right px-3 py-2">% len red</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.year} className="border-t border-white/5">
                <td className="px-3 py-2 font-mono">{r.year}</td>
                <td className="px-3 py-2 text-white/60 text-xs">{r.window}</td>
                <td className="px-3 py-2 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-24 h-2 bg-white/5 rounded overflow-hidden">
                      <div
                        className="h-full bg-cyan-500/70"
                        style={{ width: `${Number.isFinite(r.flights) ? (r.flights / maxFlights) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="tabular-nums w-12 text-right">
                      {Number.isFinite(r.flights) ? r.flights : '—'}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {Number.isFinite(r.aircraft) ? r.aircraft : '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-white/60">{r.sample || '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums text-white/60">
                  {Number.isFinite(r.totalMi) && r.totalMi > 0 ? r.totalMi.toFixed(0) : '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-orange-400">
                  {Number.isFinite(r.pctOrange) ? `${r.pctOrange.toFixed(0)}%` : '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-red-400">
                  {Number.isFinite(r.pctRed) ? `${r.pctRed.toFixed(0)}%` : '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-yellow-300">
                  {Number.isFinite(r.pctLenYellow) ? `${r.pctLenYellow.toFixed(2)}%` : '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-orange-400">
                  {Number.isFinite(r.pctLenOrange) ? `${r.pctLenOrange.toFixed(2)}%` : '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-red-400">
                  {Number.isFinite(r.pctLenRed) ? `${r.pctLenRed.toFixed(2)}%` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-white/40 max-w-2xl">
        KPIs are computed client-side by running each sample track through the point-in-polygon
        test against the 4 official KBDU noise-abatement polygons. Bands step by 250 ft:
        yellow within 250 ft of a boundary, orange 250–500 ft inside, red {'>'} 500 ft inside.
        A flight is counted "≥ orange" if any point lands in the orange or red band;
        "≥ red" if any point lands in the red band.
        Sample size per year reflects the cap passed to <code>fetch_opensky.py --years-tracks N</code>.
      </div>
    </div>
  )
}

function Kpi({ label, value, sub, accent }) {
  return (
    <div className="border border-white/10 rounded-lg p-4">
      <div className="text-xs text-white/50">{label}</div>
      <div className={`text-3xl font-semibold mt-1 ${accent || ''}`}>{value}</div>
      {sub && <div className="text-[10px] text-white/40 mt-1">{sub}</div>}
    </div>
  )
}
