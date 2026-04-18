// Same-origin — noise/web IS the API server.
const BASE = ''

/**
 * GET /api/noise/leaderboard
 * @param {Object}  opts
 * @param {number}  opts.days   Lookback window (1–3650, default 90)
 * @param {number}  opts.limit  Number of entries (1–100, default 20)
 * @param {string}  opts.by     Group by: 'tail' | 'base' | 'school'
 * @param {AbortSignal} opts.signal
 */
export async function fetchLeaderboard({ days = 90, limit = 20, by = 'tail', signal } = {}) {
  const params = new URLSearchParams({ days: String(days), limit: String(limit), by })
  const res = await fetch(`${BASE}/api/noise/leaderboard?${params}`, { signal })
  if (!res.ok) throw new Error(`leaderboard ${res.status}`)
  const data = await res.json()
  // Server returns numeric strings for nm fields — coerce to numbers
  if (data.entries) {
    for (const e of data.entries) {
      for (const k of ['total_nm', 'clean_nm', 'excursion_nm', 'red_nm', 'orange_nm', 'yellow_nm']) {
        if (typeof e[k] === 'string') e[k] = parseFloat(e[k])
      }
    }
  }
  return data
}

/**
 * GET /api/noise/missions — today's interesting flights by category.
 */
export async function fetchMissions({ signal } = {}) {
  const res = await fetch(`${BASE}/api/noise/missions`, { signal })
  if (!res.ok) throw new Error(`missions ${res.status}`)
  return res.json()
}

export async function fetchActiveExcursions({ hours = 48, include, signal } = {}) {
  const params = new URLSearchParams({ hours: String(hours) })
  if (include) params.set('include', Array.isArray(include) ? include.join(',') : include)
  const res = await fetch(`${BASE}/api/offenses/active?${params}`, { signal })
  if (!res.ok) throw new Error(`active ${res.status}`)
  return res.json()
}

export async function fetchOffenseSegments({ tail, hours = 24, lat, lng, limit, signal } = {}) {
  const params = new URLSearchParams({ hours: String(hours) })
  if (tail) params.set('tail', tail)
  if (lat != null && lng != null) {
    params.set('lat', String(lat))
    params.set('lon', String(lng))
  }
  if (limit) params.set('limit', String(limit))
  const res = await fetch(`${BASE}/api/offenses/segments?${params}`, { signal })
  if (!res.ok) throw new Error(`segments ${res.status}`)
  return res.json()
}

/** Fetch ALL tracks near a point (offenses + clean overflights). */
export async function fetchNearbyTracks({ lat, lng, hours = 2, limit = 50, signal } = {}) {
  return fetchOffenseSegments({ lat, lng, hours, limit, signal })
}

/**
 * POST the full noise report (metadata) to the noise/web archive store.
 * Lives alongside /api/complaints so all noise-related persistence is in
 * one place. Media blob sizes/types are captured in `meta.media`; raw
 * bytes stay client-side for now.
 */
export async function postFullReport({ meta } = {}, { signal } = {}) {
  const res = await fetch(`${BASE}/api/noise-reports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`noise-report ${res.status} ${text}`.trim())
  }
  return res.json().catch(() => ({}))
}

export async function postComplaint(payload, { signal } = {}) {
  const res = await fetch(`${BASE}/api/complaints`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`complaint ${res.status} ${text}`.trim())
  }
  return res.json()
}

export async function fetchMyReports({ reporter, signal } = {}) {
  const params = new URLSearchParams()
  if (reporter) params.set('reporter', reporter)
  const res = await fetch(`${BASE}/api/noise-reports?${params}`, { signal })
  if (!res.ok) return []
  const data = await res.json()
  let list = data.reports || []
  if (reporter) list = list.filter((r) => {
    const rep = r.reporter
    if (typeof rep === 'string') return rep === reporter
    if (typeof rep === 'object' && rep) return rep.email === reporter || rep.id === reporter || rep.name === reporter
    return false
  })
  return list
}

export async function fetchMyComplaints({ reporter, signal } = {}) {
  const params = new URLSearchParams()
  if (reporter) params.set('reporter', reporter)
  const res = await fetch(`${BASE}/api/complaints?${params}`, { signal })
  if (!res.ok) throw new Error(`complaints ${res.status}`)
  const data = await res.json()
  let list = data.complaints || []
  // Server may not filter by reporter yet — enforce client-side as a safety.
  if (reporter) list = list.filter((c) => (c.reporter || '') === reporter)
  return list
}

export const KLASS_COLORS = {
  yellow: '#facc15',
  orange: '#fb923c',
  red:    '#f87171',
}
