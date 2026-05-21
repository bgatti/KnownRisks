// Same-origin in production (noise/web IS the API server). When running
// the Vite dev server on localhost, fall back to the deployed API so we
// don't need a local DATABASE_URL.
const BASE =
  typeof window !== 'undefined' &&
  /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)
    ? 'https://web-app-production-fedf.up.railway.app'
    : ''

/** Direct URL to a noise-report audio clip — for use in <audio src=…>. */
export function reportAudioUrl(reportId, slot) {
  return `${BASE}/api/noise-reports/${reportId}/audio/${slot}`
}

/**
 * GET /api/noise-zones — voluntary noise-abatement polygons. Each zone:
 *   { name, airport, note, ceiling_ft, polygon: [[lat,lng], ...] }
 */
export async function fetchNoiseZones({ signal } = {}) {
  const res = await fetch(`${BASE}/api/noise-zones`, { signal })
  if (!res.ok) throw new Error(`noise-zones ${res.status}`)
  const data = await res.json()
  return data.zones || []
}

/**
 * GET /api/noise/leaderboard
 * @param {Object}  opts
 * @param {number}  opts.days   Lookback window (1–3650, default 90)
 * @param {number}  opts.limit  Number of entries (1–100, default 20)
 * @param {string}  opts.by     Group by: 'tail' | 'base' | 'school'
 * @param {string}  opts.homeBase  Restrict to aircraft based at this airport (home field), e.g. 'KBDU'
 * @param {string}  opts.origin    'local' | 'transient' — per-flight geometric class
 * @param {AbortSignal} opts.signal
 */
export async function fetchLeaderboard({ days = 90, limit = 20, by = 'tail', homeBase, origin, signal } = {}) {
  const params = new URLSearchParams({ days: String(days), limit: String(limit), by })
  if (homeBase) params.set('homeBase', homeBase)
  if (origin) params.set('origin', origin)
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
 * GET /api/noise/missions — completed flights (takeoff→landing cycles, with
 * touch-and-go / taxi-back merged) categorized by purpose. `days` widens the
 * window to the last N UTC days (default 1 = today, max 90).
 */
export async function fetchMissions({ days = 1, signal } = {}) {
  const params = new URLSearchParams()
  if (days && days !== 1) params.set('days', String(days))
  const qs = params.toString()
  const res = await fetch(`${BASE}/api/noise/missions${qs ? `?${qs}` : ''}`, { signal })
  if (!res.ok) throw new Error(`missions ${res.status}`)
  return res.json()
}

export async function fetchActiveExcursions({ hours = 48, include, signal } = {}) {
  const params = new URLSearchParams({ hours: String(hours) })
  if (include) params.set('include', Array.isArray(include) ? include.join(',') : include)
  const res = await fetch(`${BASE}/api/excursions/active?${params}`, { signal })
  if (!res.ok) throw new Error(`active ${res.status}`)
  return res.json()
}

export async function fetchExcursionSegments({ tail, hours = 24, lat, lng, limit, signal } = {}) {
  const params = new URLSearchParams({ hours: String(hours) })
  if (tail) params.set('tail', tail)
  if (lat != null && lng != null) {
    params.set('lat', String(lat))
    params.set('lon', String(lng))
  }
  if (limit) params.set('limit', String(limit))
  const res = await fetch(`${BASE}/api/excursions/segments?${params}`, { signal })
  if (!res.ok) throw new Error(`segments ${res.status}`)
  return res.json()
}

/** Fetch ALL tracks near a point (excursions + clean overflights). */
export async function fetchNearbyTracks({ lat, lng, hours = 2, limit = 50, signal } = {}) {
  return fetchExcursionSegments({ lat, lng, hours, limit, signal })
}

/** Single combined boot call — active excursions + tracks in one request. */
export async function fetchBoot({ hours = 1, limit = 100, include, signal } = {}) {
  const params = new URLSearchParams({ hours: String(hours) })
  if (limit) params.set('limit', String(limit))
  if (include) params.set('include', Array.isArray(include) ? include.join(',') : include)
  const res = await fetch(`${BASE}/api/excursions/boot?${params}`, { signal })
  if (!res.ok) throw new Error(`boot ${res.status}`)
  return res.json()
}

/** Lightweight current positions for all live aircraft. */
export async function fetchLivePositions({ signal } = {}) {
  const res = await fetch(`${BASE}/api/live/positions`, { signal })
  if (!res.ok) throw new Error(`positions ${res.status}`)
  return res.json()
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

export async function fetchMyReports({ reporter, signal, limit = 10 } = {}) {
  const params = new URLSearchParams()
  if (reporter) params.set('reporter', reporter)
  if (limit) params.set('limit', String(limit))
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
  // Server may or may not honor `limit` — sort newest-first and cap client-side.
  list.sort((a, b) => Date.parse(b.submittedAt || b.receivedAt || b.createdAt || 0) - Date.parse(a.submittedAt || a.receivedAt || a.createdAt || 0))
  return list.slice(0, limit)
}

export async function fetchMyComplaints({ reporter, signal, limit = 10 } = {}) {
  const params = new URLSearchParams()
  if (reporter) params.set('reporter', reporter)
  if (limit) params.set('limit', String(limit))
  const res = await fetch(`${BASE}/api/complaints?${params}`, { signal })
  if (!res.ok) throw new Error(`complaints ${res.status}`)
  const data = await res.json()
  let list = data.complaints || []
  // Server may not filter by reporter yet — enforce client-side as a safety.
  if (reporter) list = list.filter((c) => (c.reporter || '') === reporter)
  list.sort((a, b) => Date.parse(b.createdAt || b.startedAt || 0) - Date.parse(a.createdAt || a.startedAt || 0))
  return list.slice(0, limit)
}

export async function fetchAllComplaints({ signal } = {}) {
  const res = await fetch(`${BASE}/api/complaints`, { signal })
  if (!res.ok) throw new Error(`complaints ${res.status}`)
  const data = await res.json()
  return data.complaints || []
}

export async function fetchAllNoiseReports({ signal } = {}) {
  const res = await fetch(`${BASE}/api/noise-reports`, { signal })
  if (!res.ok) throw new Error(`noise-reports ${res.status}`)
  const data = await res.json()
  return data.reports || []
}

/**
 * POST raw audio bytes for a noise report.
 * @param {string} reportId  ID returned by postFullReport
 * @param {string} slot      'spliced10s' | 'loudest5s'
 * @param {Blob}   blob      Audio bytes (WAV or MP3)
 * @param {string} mime      Content-Type (defaults to blob.type or audio/wav)
 */
export async function postReportAudio(reportId, slot, blob, mime) {
  const ct = mime || blob.type || 'audio/wav'
  const res = await fetch(`${BASE}/api/noise-reports/${reportId}/audio/${slot}`, {
    method: 'POST',
    headers: { 'Content-Type': ct },
    body: blob,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`audio ${slot} ${res.status} ${text}`.trim())
  }
  return res.json().catch(() => ({}))
}

export const KLASS_COLORS = {
  yellow: '#facc15',
  orange: '#fb923c',
  red:    '#f87171',
}
