// Same-origin in production (noise/web IS the server).
const BASE = ''

export async function fetchActiveExcursions({ hours = 48, include, signal } = {}) {
  const params = new URLSearchParams({ hours: String(hours) })
  if (include) params.set('include', Array.isArray(include) ? include.join(',') : include)
  const res = await fetch(`${BASE}/api/offenses/active?${params}`, { signal })
  if (!res.ok) throw new Error(`active ${res.status}`)
  return res.json()
}

export async function fetchOffenseSegments({ tail, hours = 24, lat, lng, signal } = {}) {
  const params = new URLSearchParams({ tail, hours: String(hours) })
  if (lat != null && lng != null) {
    params.set('lat', String(lat))
    params.set('lon', String(lng))
  }
  const res = await fetch(`${BASE}/api/offenses/segments?${params}`, { signal })
  if (!res.ok) throw new Error(`segments ${res.status}`)
  return res.json()
}

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
  if (reporter) list = list.filter((c) => (c.reporter || '') === reporter)
  return list
}

export const KLASS_COLORS = {
  yellow: '#facc15',
  orange: '#fb923c',
  red:    '#f87171',
}
