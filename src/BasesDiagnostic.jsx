import { useEffect, useMemo, useState } from 'react'

// Load tracks_yearly.json and produce a tail × year-month × base matrix so we
// can see whether an aircraft's "based at" guess is stable or wandering.
export default function BasesDiagnostic() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [filterTail, setFilterTail] = useState('')
  const [onlyUnstable, setOnlyUnstable] = useState(false)

  useEffect(() => {
    fetch('/tracks_yearly.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then(setData)
      .catch((e) => setErr(String(e)))
  }, [])

  // Same airport lookup as App.jsx — kept inline so this page is self-contained.
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
  function nearest(lat, lon, maxNm = 3) {
    let best = null, bestD = Infinity
    for (const ap of AIRPORTS) {
      const dLat = (lat - ap.lat) * 60
      const dLon = (lon - ap.lon) * 60 * Math.cos(((lat + ap.lat) / 2) * Math.PI / 180)
      const d = Math.hypot(dLat, dLon)
      if (d < bestD) { bestD = d; best = ap }
    }
    return bestD <= maxNm ? best.code : null
  }

  const rows = useMemo(() => {
    if (!data?.tracks) return []
    // Each track has src like "globe/2025-07-15/<hex>". Extract date.
    const byTail = new Map() // tail -> { months: Map(year-month -> {first, last, resolved, src}) }
    for (const t of data.tracks) {
      const tail = t.call || '(unknown)'
      const pts = t.points || []
      if (pts.length < 2) continue
      const srcMatch = (t.src || '').match(/globe\/(\d{4})-(\d{2})-\d{2}/)
      if (!srcMatch) continue
      const ym = `${srcMatch[1]}-${srcMatch[2]}`
      const first = pts[0]
      const last = pts[pts.length - 1]
      const firstBase = nearest(first[0], first[1], 3)
      const lastBase = nearest(last[0], last[1], 3)
      const resolved = firstBase || lastBase
      if (!byTail.has(tail)) byTail.set(tail, { tail, type: t.type || '', months: new Map() })
      const agg = byTail.get(tail)
      if (!agg.type && t.type) agg.type = t.type
      if (!agg.months.has(ym)) agg.months.set(ym, { first: {}, last: {}, resolved: {}, days: 0 })
      const bucket = agg.months.get(ym)
      bucket.days++
      if (firstBase) bucket.first[firstBase] = (bucket.first[firstBase] || 0) + 1
      if (lastBase) bucket.last[lastBase] = (bucket.last[lastBase] || 0) + 1
      if (resolved) bucket.resolved[resolved] = (bucket.resolved[resolved] || 0) + 1
    }
    const pickTop = (obj) => {
      const e = Object.entries(obj).sort((a, b) => b[1] - a[1])
      return e.length ? e[0][0] : null
    }
    const all = Array.from(byTail.values()).map((agg) => {
      const months = Array.from(agg.months.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([ym, b]) => ({
          ym,
          days: b.days,
          first: pickTop(b.first),
          last: pickTop(b.last),
          resolved: pickTop(b.resolved),
        }))
      const resolvedSet = new Set(months.map((m) => m.resolved).filter(Boolean))
      return { ...agg, months, resolvedSet, unstable: resolvedSet.size > 1 }
    })
    return all
  }, [data])

  const shown = useMemo(() => {
    const q = filterTail.trim().toUpperCase()
    let r = rows
    if (q) r = r.filter((a) => a.tail.includes(q))
    if (onlyUnstable) r = r.filter((a) => a.unstable)
    return r.sort((a, b) => {
      if (a.unstable !== b.unstable) return a.unstable ? -1 : 1
      return b.months.length - a.months.length
    })
  }, [rows, filterTail, onlyUnstable])

  const allMonths = useMemo(() => {
    const s = new Set()
    for (const a of rows) for (const m of a.months) s.add(m.ym)
    return Array.from(s).sort()
  }, [rows])

  if (err) return <div className="p-6 text-red-400">error: {err}</div>
  if (!data) return <div className="p-6 text-white/60">loading…</div>

  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      <div className="flex items-center gap-4 flex-wrap">
        <h1 className="text-lg font-semibold">Base diagnosis</h1>
        <div className="text-xs text-white/60">
          {rows.length} aircraft · {rows.filter((a) => a.unstable).length} show multiple bases across months
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={onlyUnstable}
              onChange={(e) => setOnlyUnstable(e.target.checked)}
            />
            <span>only unstable (changed base)</span>
          </label>
          <input
            value={filterTail}
            onChange={(e) => setFilterTail(e.target.value)}
            placeholder="filter by tail…"
            className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs w-32 font-mono"
          />
        </div>
      </div>

      <div className="border border-white/10 rounded-lg overflow-hidden text-[11px]">
        <table className="w-full">
          <thead className="bg-white/5 sticky top-0">
            <tr className="text-white/60 uppercase text-[9px] tracking-wide">
              <th className="text-left px-2 py-1 sticky left-0 bg-white/5 z-10">Tail</th>
              <th className="text-left px-2 py-1">Type</th>
              {allMonths.map((ym) => (
                <th key={ym} className="text-center px-1 py-1 font-mono">{ym.slice(2)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, 200).map((a) => {
              const byMonth = new Map(a.months.map((m) => [m.ym, m]))
              return (
                <tr key={a.tail} className="border-t border-white/5 hover:bg-white/5">
                  <td className="px-2 py-1 font-mono sticky left-0 bg-[#0b1220]">
                    <span className={a.unstable ? 'text-yellow-300' : 'text-white/80'}>
                      {a.tail}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-white/50">{a.type || '—'}</td>
                  {allMonths.map((ym) => {
                    const m = byMonth.get(ym)
                    if (!m) return <td key={ym} className="px-1 py-1 text-white/20 text-center">·</td>
                    const mismatch = m.first && m.last && m.first !== m.last
                    return (
                      <td
                        key={ym}
                        className={`px-1 py-1 text-center font-mono ${
                          mismatch ? 'text-yellow-300' : 'text-white/80'
                        }`}
                        title={`first: ${m.first || '—'} / last: ${m.last || '—'} · ${m.days}d`}
                      >
                        {m.resolved || '—'}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-white/40 max-w-3xl">
        Cell shows the resolved base for that year/month (most-common first-point fallback-to-last-point,
        within 3 nm of an airport). A yellow tail means the aircraft's resolved base is different in at
        least two months. Yellow cells indicate the first and last points disagree within a single month,
        which typically means the aircraft entered from one direction and exited another — not that it
        actually moved. Hover any cell to see first/last bases and day count.
      </div>
    </div>
  )
}
