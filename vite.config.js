import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import crypto from 'crypto'
import * as db from './db.js'

// JSON file-backed ledger store. Each instance owns one file (e.g.
// data/reports.json) and serializes concurrent mutations through a single
// promise chain, so two POSTs that arrive simultaneously can't clobber each
// other's read-modify-write. Atomic writes via unique .tmp + rename.
function makeLedger(filename) {
  let chain = Promise.resolve()
  const load = async (fs, path) => {
    try {
      const buf = await fs.readFile(path.resolve(filename), 'utf8')
      return JSON.parse(buf)
    } catch {
      return null
    }
  }
  const write = async (fs, path, data) => {
    const p = path.resolve(filename)
    const dir = path.dirname(p)
    try { await fs.mkdir(dir, { recursive: true }) } catch {}
    const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2))
    // OneDrive (and AV scanners) can hold transient locks on the destination
    // during sync, making rename fail EPERM/EBUSY. Retry a few times with
    // backoff before giving up; lock is usually released within ~200ms.
    const delays = [25, 50, 100, 200, 400]
    let lastErr = null
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        await fs.rename(tmp, p)
        return
      } catch (e) {
        lastErr = e
        if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') break
        if (attempt === delays.length) break
        await new Promise((r) => setTimeout(r, delays[attempt]))
      }
    }
    try { await fs.unlink(tmp) } catch {}
    throw lastErr
  }
  const mutate = async (fs, path, fn) => {
    const task = async () => {
      const cur = (await load(fs, path)) || { items: [] }
      const next = (await fn(cur)) || cur
      await write(fs, path, next)
      return next
    }
    const queued = chain.then(task, task)
    chain = queued.catch(() => {})
    return queued
  }
  return { load, mutate, write }
}

// HMAC-signed notice token. Embedded in the landing URL from /api/send-notice
// and verified by /api/pilot-response so operator-forwarded pilot replies
// can be tied back to the exact notice that was sent. Secret comes from
// NOISE_NOTICE_SECRET env var; dev fallback is a fixed string so tokens stay
// valid across restarts without extra config.
const NOTICE_SECRET = process.env.NOISE_NOTICE_SECRET || 'dev-notice-secret-change-me'
const signNoticeId = (tail, atMs) => {
  const payload = `${tail}|${atMs}`
  const sig = crypto.createHmac('sha256', NOTICE_SECRET).update(payload).digest('base64url').slice(0, 16)
  return `${Buffer.from(payload).toString('base64url')}.${sig}`
}
const verifyNoticeId = (token) => {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null
  const [payloadB64, sig] = token.split('.')
  let payload
  try { payload = Buffer.from(payloadB64, 'base64url').toString('utf8') } catch { return null }
  const expected = crypto.createHmac('sha256', NOTICE_SECRET).update(payload).digest('base64url').slice(0, 16)
  if (sig !== expected) return null
  const [tail, atMsStr] = payload.split('|')
  const atMs = Number(atMsStr)
  if (!tail || !Number.isFinite(atMs)) return null
  return { tail, atMs }
}

const readJsonBody = async (req) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

// Dev-time middleware for POST /api/send-notice.
// If RESEND_API_KEY is set, forwards to Resend; otherwise dry-run (logs only).
// Configure the FROM address via NOISE_NOTICE_FROM (must be a verified Resend
// sender, e.g. "KBDU FBO <noise@your-verified-domain.com>").
const notificationsLedger = makeLedger('data/notifications.json')

function sendNoticePlugin() {
  return {
    name: 'send-notice',
    configureServer(server) {
      server.middlewares.use('/api/send-notice', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const payload = await readJsonBody(req)
          const { to, subject, body, tail, school, nid } = payload
          if (!to || !subject || !body) {
            res.statusCode = 400
            res.end(JSON.stringify({ ok: false, error: 'missing fields' }))
            return
          }
          const apiKey = process.env.RESEND_API_KEY
          const from = process.env.NOISE_NOTICE_FROM || 'KBDU FBO <onboarding@resend.dev>'
          const logLine = `[send-notice] ${new Date().toISOString()} ${tail} → ${to} (${school})`
          const recordNotification = async (via, ok) => {
            if (!ok || !tail) return
            const notifRecord = {
              kind: 'operator',
              tail,
              via,
              contact: to,
              school: school || null,
              noticeId: nid || null,
              at: new Date().toISOString(),
            }
            if (db.useDb) {
              await db.addNotification(notifRecord)
            } else {
              await notificationsLedger.mutate(fs, path, (cur) => {
                const items = Array.isArray(cur.items) ? cur.items : []
                items.push(notifRecord)
                return { items }
              })
            }
          }
          if (!apiKey) {
            console.log(logLine, '— DRY RUN (no RESEND_API_KEY)')
            await recordNotification('dry-run', true).catch((e) =>
              console.error('[send-notice] ledger write failed', e),
            )
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, dryRun: true }))
            return
          }
          const resp = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ from, to: [to], subject, text: body }),
          })
          const data = await resp.json().catch(() => ({}))
          console.log(logLine, resp.ok ? '— SENT' : `— FAILED ${resp.status}`, data)
          await recordNotification('email', resp.ok).catch((e) =>
            console.error('[send-notice] ledger write failed', e),
          )
          res.statusCode = resp.ok ? 200 : 502
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: resp.ok, dryRun: false, resend: data }))
        } catch (err) {
          console.error('[send-notice] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, error: String(err) }))
        }
      })
    },
  }
}

// GET /api/offenses?tail=N12JA[&from=YYYY-MM-DD][&to=YYYY-MM-DD]
// Returns JSON list of classified offenses for an aircraft within a date
// window, along with a deep link back to the map page pre-selecting the tail.
function offensesApiPlugin() {
  let zonesCache = null
  // mtime-based cache for the big tracks file. Re-read only when the file
  // on disk changes; avoids re-parsing 200 MB on every API hit.
  const fileCache = { tracks: null, schools: null, live: null }
  const FILE_PATHS = {
    tracks: 'public/tracks_yearly.json',
    schools: 'public/flight_schools_fleets.json',
    live: 'public/tracks_live.json',
  }
  const loadCached = async (fs, path, key) => {
    // When DATABASE_URL is set, read from Postgres instead of files
    if (db.useDb) {
      if (key === 'tracks') return db.loadTracksFromDb()
      if (key === 'live') return db.loadLiveFromDb()
      if (key === 'schools') return db.loadSchoolsFromDb()
    }
    const p = path.resolve(FILE_PATHS[key])
    try {
      const stat = await fs.stat(p)
      const cached = fileCache[key]
      if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data
      const buf = await fs.readFile(p, 'utf8')
      const data = JSON.parse(buf)
      // Pre-index tracks by tail for O(1) lookup
      if (key === 'tracks' || key === 'live') {
        const byTail = new Map()
        for (const t of data.tracks || []) {
          const k = (t.call || '').trim()
          if (!k) continue
          let arr = byTail.get(k)
          if (!arr) { arr = []; byTail.set(k, arr) }
          arr.push(t)
        }
        data._byTail = byTail
      }
      fileCache[key] = { mtimeMs: stat.mtimeMs, data }
      return data
    } catch (e) {
      if (key === 'schools') return { schools: [] }
      if (key === 'live') return { tracks: [], _byTail: new Map(), updated_at: null }
      throw e
    }
  }
  return {
    name: 'offenses-api',
    configureServer(server) {
      // Registered BEFORE /api/offenses because connect prefix-matches and
      // would otherwise route /api/offenses/segments into the wrong handler.
      server.middlewares.use('/api/offenses/segments', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const tail = (u.searchParams.get('tail') || '').trim()
          const hours = Number(u.searchParams.get('hours')) || 24
          const latParam = u.searchParams.get('lat')
          const lonParam = u.searchParams.get('lon')
          const center = (latParam != null && lonParam != null && latParam !== '' && lonParam !== '')
            ? { lat: Number(latParam), lon: Number(lonParam) }
            : null
          if (!tail) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'missing required parameter: tail' }))
            return
          }
          if (!zonesCache) {
            const mod = await import('./src/noiseZones.js')
            zonesCache = mod.NOISE_ZONES
          }
          const [tracksData, liveData] = await Promise.all([
            loadCached(fs, path, 'tracks'),
            loadCached(fs, path, 'live'),
          ])
          // hours window → day-level date range (historical tracks are keyed by day)
          const nowMs = Date.now()
          const fromDate = new Date(nowMs - hours * 3600 * 1000).toISOString().slice(0, 10)
          const toDate = new Date(nowMs).toISOString().slice(0, 10)
          // Geo helpers — duplicated from the /api/offenses handler to keep
          // this route self-contained. Any change to classification thresholds
          // must be mirrored in both places.
          const FT_PER_DEG_LAT = 364560
          const RADIUS_FT = 4 * 5280
          const pointInPolygon = (lat, lon, poly) => {
            let inside = false
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
              const [yi, xi] = poly[i]
              const [yj, xj] = poly[j]
              if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) {
                inside = !inside
              }
            }
            return inside
          }
          const distPointToSegFt = (lat, lon, aLat, aLon, bLat, bLon) => {
            const latRef = (aLat + bLat + lat) / 3
            const cos = Math.cos((latRef * Math.PI) / 180)
            const px = (lon - aLon) * FT_PER_DEG_LAT * cos
            const py = (lat - aLat) * FT_PER_DEG_LAT
            const dx = (bLon - aLon) * FT_PER_DEG_LAT * cos
            const dy = (bLat - aLat) * FT_PER_DEG_LAT
            const len2 = dx * dx + dy * dy
            if (len2 === 0) return Math.hypot(px, py)
            let t = (px * dx + py * dy) / len2
            t = Math.max(0, Math.min(1, t))
            return Math.hypot(px - t * dx, py - t * dy)
          }
          const signedDistance = (lat, lon) => {
            let minAbs = Infinity
            let insideAny = false
            let nearestZone = null
            for (const z of zonesCache) {
              const poly = z.polygon
              if (pointInPolygon(lat, lon, poly)) insideAny = true
              let minEdge = Infinity
              for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                const d = distPointToSegFt(lat, lon, poly[i][0], poly[i][1], poly[j][0], poly[j][1])
                if (d < minEdge) minEdge = d
              }
              if (minEdge < minAbs) { minAbs = minEdge; nearestZone = z.name }
            }
            return { d: insideAny ? -minAbs : minAbs, zone: nearestZone }
          }
          const ALT_THRESHOLD_FT = 7500
          const classifyAlt = (alt) => {
            if (alt == null) return null
            const below = ALT_THRESHOLD_FT - alt
            if (below > 500) return 'red'
            if (below > 250) return 'orange'
            if (below > -250) return 'yellow'
            return null
          }
          const classifyZone = (d) => {
            if (d < -500) return 'red'
            if (d < -250) return 'orange'
            if (d < 250) return 'yellow'
            return null
          }
          const SEV = { yellow: 1, orange: 2, red: 3 }
          const classifyPoint = (lat, lon, alt) => {
            const { d, zone } = signedDistance(lat, lon)
            const z = classifyZone(d)
            const a = classifyAlt(alt)
            if (!z || !a) return { klass: null, zone: null }
            return { klass: SEV[z] <= SEV[a] ? z : a, zone }
          }
          const withinRadius = (lat, lon) => {
            if (!center) return true
            const latRef = (lat + center.lat) / 2
            const cos = Math.cos((latRef * Math.PI) / 180)
            const dx = (lon - center.lon) * FT_PER_DEG_LAT * cos
            const dy = (lat - center.lat) * FT_PER_DEG_LAT
            return dx * dx + dy * dy <= RADIUS_FT * RADIUS_FT
          }
          const candidates = tracksData._byTail.get(tail) || []
          const liveCandidates = liveData._byTail.get(tail) || []
          // Historical tracks: filter by date window.
          // Live tracks: src is literally "live", no embedded date — always
          // include them (they are, by definition, "now") and tag them with
          // today's date so downstream consumers see a uniform shape.
          const matches = candidates.filter((t) => {
            const m = (t.src || '').match(/(\d{4}-\d{2}-\d{2})/)
            if (!m) return false
            const d = m[1]
            return d >= fromDate && d <= toDate
          })
          for (const lt of liveCandidates) matches.push(lt)
          const tracksOut = []
          for (const t of matches) {
            const m = (t.src || '').match(/(\d{4}-\d{2}-\d{2})/)
            const date = m ? m[1] : (t.src === 'live' ? toDate : null)
            const isLive = t.src === 'live'
            const segments = []
            let cur = null
            for (let i = 0; i < t.points.length; i++) {
              const p = t.points[i]
              const { klass, zone } = classifyPoint(p[0], p[1], p[2])
              if (cur && cur.klass === klass && cur.zone === zone) {
                cur.points.push(p)
              } else {
                if (cur) {
                  // Bridge: duplicate the transition point into the closing
                  // segment so rendered polylines share an endpoint and have
                  // no visual gap at the class/zone change.
                  cur.points.push(p)
                  segments.push(cur)
                }
                cur = { klass, zone, points: [p] }
              }
            }
            if (cur) segments.push(cur)
            // Derive per-segment timestamps from the 4th element of each
            // point (epoch-ms, written by the live collector). Historical
            // tracks from tracks_yearly.json are 3-element → timestamps
            // are null and callers fall back to the track's date field.
            const stampSegment = (s) => {
              let first = null, last = null
              for (const p of s.points) {
                if (typeof p[3] === 'number') {
                  if (first == null) first = p[3]
                  last = p[3]
                }
              }
              s.startedAt = first != null ? new Date(first).toISOString() : null
              s.endedAt = last != null ? new Date(last).toISOString() : null
              return s
            }
            for (const s of segments) stampSegment(s)
            const filtered = center
              ? segments.filter((s) => s.points.some((p) => withinRadius(p[0], p[1])))
              : segments
            if (filtered.length) tracksOut.push({ src: t.src, date, live: isLive, segments: filtered })
          }
          // Aircraft fields can be blank on some days; pick the first
          // non-empty value across all candidate tracks (historical + live).
          const allCandidates = [...liveCandidates, ...candidates]
          const pickField = (k) => {
            for (const t of allCandidates) if (t[k]) return t[k]
            return ''
          }
          const payload = {
            tail,
            call: pickField('call') || tail,
            type: pickField('type'),
            desc: pickField('desc'),
            ownOp: pickField('ownOp'),
            window: { hours, from: fromDate, to: toDate },
            live: { updated_at: liveData.updated_at || null, tracks: liveCandidates.length },
            center: center ? { lat: center.lat, lon: center.lon, radius_ft: RADIUS_FT } : null,
            tracks: tracksOut,
          }
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify(payload))
        } catch (err) {
          console.error('[offenses-segments-api] error', err)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
      // GET /api/offenses/active[&hours=48][&include=reports,notifications]
      // Returns all tails with at least one classified point within the
      // window, grouped per-tail (worst class, counts, last date, school/type
      // lookup from flight_schools_fleets.json). Registered BEFORE /api/offenses
      // so connect's prefix matcher routes it correctly.
      //
      // include= opt-in joins. The base call stays cheap — the expensive
      // per-tail lookups only run when explicitly asked for:
      //   include=reports         → reportCount (+ reportScoreMax/Avg) from
      //                             the complaints store, filtered to window
      //   include=notifications   → operatorNotified / pilotNotified /
      //                             pilotAction from the notifications ledger
      server.middlewares.use('/api/offenses/active', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const hours = Number(u.searchParams.get('hours')) || 48
          const includeSet = new Set(
            (u.searchParams.get('include') || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          )
          if (!zonesCache) {
            const mod = await import('./src/noiseZones.js')
            zonesCache = mod.NOISE_ZONES
          }
          const [tracksData, liveData, schoolsData] = await Promise.all([
            loadCached(fs, path, 'tracks'),
            loadCached(fs, path, 'live'),
            loadCached(fs, path, 'schools'),
          ])
          // Tail → school/type lookup (schools file is authoritative).
          const tailInfo = new Map()
          for (const s of schoolsData.schools || []) {
            for (const ac of s.aircraft || []) {
              if (ac.tail) {
                tailInfo.set(ac.tail, {
                  type: ac.type || 'Unknown',
                  school: s.name,
                  airport: s.airport,
                })
              }
            }
          }
          // Live tracks carry their own type; fill in tails not in schools.
          for (const lt of liveData.tracks || []) {
            const tail = (lt.call || '').trim()
            if (!tail || tailInfo.has(tail)) continue
            tailInfo.set(tail, { type: lt.type || 'Unknown', school: null, airport: null })
          }
          // Classification helpers (inlined to match the /segments handler).
          const FT_PER_DEG_LAT = 364560
          const pointInPolygon = (lat, lon, poly) => {
            let inside = false
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
              const [yi, xi] = poly[i]
              const [yj, xj] = poly[j]
              if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) {
                inside = !inside
              }
            }
            return inside
          }
          const distPointToSegFt = (lat, lon, aLat, aLon, bLat, bLon) => {
            const latRef = (aLat + bLat + lat) / 3
            const cos = Math.cos((latRef * Math.PI) / 180)
            const px = (lon - aLon) * FT_PER_DEG_LAT * cos
            const py = (lat - aLat) * FT_PER_DEG_LAT
            const dx = (bLon - aLon) * FT_PER_DEG_LAT * cos
            const dy = (bLat - aLat) * FT_PER_DEG_LAT
            const len2 = dx * dx + dy * dy
            if (len2 === 0) return Math.hypot(px, py)
            let t = (px * dx + py * dy) / len2
            t = Math.max(0, Math.min(1, t))
            return Math.hypot(px - t * dx, py - t * dy)
          }
          const signedDistance = (lat, lon) => {
            let minAbs = Infinity
            let insideAny = false
            for (const z of zonesCache) {
              const poly = z.polygon
              if (pointInPolygon(lat, lon, poly)) insideAny = true
              let minEdge = Infinity
              for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                const d = distPointToSegFt(lat, lon, poly[i][0], poly[i][1], poly[j][0], poly[j][1])
                if (d < minEdge) minEdge = d
              }
              if (minEdge < minAbs) minAbs = minEdge
            }
            return insideAny ? -minAbs : minAbs
          }
          const ALT_THRESHOLD_FT = 7500
          const classifyAlt = (alt) => {
            if (alt == null) return null
            const below = ALT_THRESHOLD_FT - alt
            if (below > 500) return 'red'
            if (below > 250) return 'orange'
            if (below > -250) return 'yellow'
            return null
          }
          const classifyZone = (d) => {
            if (d < -500) return 'red'
            if (d < -250) return 'orange'
            if (d < 250) return 'yellow'
            return null
          }
          const SEV = { yellow: 1, orange: 2, red: 3 }
          const classifyPoint = (lat, lon, alt) => {
            const z = classifyZone(signedDistance(lat, lon))
            const a = classifyAlt(alt)
            if (!z || !a) return null
            return SEV[z] <= SEV[a] ? z : a
          }
          // Day-granular window
          const nowMs = Date.now()
          const fromDate = new Date(nowMs - hours * 3600 * 1000).toISOString().slice(0, 10)
          const toDate = new Date(nowMs).toISOString().slice(0, 10)
          // Walk every tail that appears in either historical OR live tracks.
          // Live tracks have src='live' (no embedded date) and are always
          // considered in-window.
          // updated_at is written without a timezone suffix but represents UTC;
          // force UTC parsing so "now" isn't shifted by the server's local offset.
          const parseUtc = (s) => {
            if (!s) return nowMs
            const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z'
            const t = Date.parse(iso)
            return Number.isFinite(t) ? t : nowMs
          }
          const liveUpdatedAtMs = parseUtc(liveData.updated_at)
          const allTails = new Set([
            ...tracksData._byTail.keys(),
            ...liveData._byTail.keys(),
          ])
          const active = []
          for (const tail of allTails) {
            let worst = null
            const counts = { yellow: 0, orange: 0, red: 0 }
            let lastDate = ''
            let lastSeenMs = 0
            let pointsHit = 0
            let isLive = false
            const hist = tracksData._byTail.get(tail) || []
            const live = liveData._byTail.get(tail) || []
            for (const t of [...hist, ...live]) {
              const srcIsLive = t.src === 'live'
              let trackTs = 0
              if (!srcIsLive) {
                const m = (t.src || '').match(/(\d{4}-\d{2}-\d{2})/)
                if (!m) continue
                const d = m[1]
                if (d < fromDate || d > toDate) continue
                if (d > lastDate) lastDate = d
                // Day-granular historical tracks — peg to noon of that day.
                trackTs = Date.parse(d + 'T12:00:00Z') || 0
              } else {
                isLive = true
                if (toDate > lastDate) lastDate = toDate
                // Live tracks: use the live file's updated_at as a proxy.
                trackTs = liveUpdatedAtMs
              }
              let trackHit = false
              let trackMaxPointTs = 0
              for (const p of t.points) {
                const k = classifyPoint(p[0], p[1], p[2])
                if (k) {
                  counts[k]++
                  pointsHit++
                  trackHit = true
                  if (!worst || SEV[k] > SEV[worst]) worst = k
                  // Live collector writes per-point epoch-ms in p[3]. Use it
                  // when present so "last seen" is accurate to the second.
                  if (typeof p[3] === 'number' && p[3] > trackMaxPointTs) {
                    trackMaxPointTs = p[3]
                  }
                }
              }
              if (trackHit) {
                const ts = trackMaxPointTs || trackTs
                if (ts > lastSeenMs) lastSeenMs = ts
              }
            }
            if (worst) {
              const info = tailInfo.get(tail) || {}
              active.push({
                tail,
                type: info.type || 'Unknown',
                school: info.school || null,
                airport: info.airport || null,
                worst,
                counts,
                pointsHit,
                lastDate,
                lastSeenMs,
                live: isLive,
              })
            }
          }
          // Opt-in joins — only resolve what the client asked for. Both
          // stores are small single-file JSON ledgers; we load once and
          // index by tail in-memory.
          const windowFromMs = nowMs - hours * 3600 * 1000
          if (includeSet.has('reports')) {
            let complaintsData = null
            if (db.useDb) {
              const all = await db.getComplaints(null)
              complaintsData = { complaints: all }
            } else {
              try {
                const raw = await fs.readFile(path.resolve('data/complaints.json'), 'utf8')
                complaintsData = JSON.parse(raw)
              } catch {}
            }
            const byTail = new Map()
            for (const c of (complaintsData && complaintsData.complaints) || []) {
              const ts = Date.parse(c.createdAt || '')
              if (!Number.isFinite(ts) || ts < windowFromMs || ts > nowMs) continue
              const k = (c.tail || '').toUpperCase()
              if (!k) continue
              let rec = byTail.get(k)
              if (!rec) { rec = { count: 0, scoreMax: null, scoreSum: 0, scoreN: 0 }; byTail.set(k, rec) }
              rec.count++
              if (typeof c.score === 'number') {
                rec.scoreSum += c.score
                rec.scoreN++
                if (rec.scoreMax == null || c.score > rec.scoreMax) rec.scoreMax = c.score
              }
            }
            for (const entry of active) {
              const rec = byTail.get(entry.tail.toUpperCase())
              entry.reportCount = rec ? rec.count : 0
              entry.reportScoreMax = rec && rec.scoreMax != null ? rec.scoreMax : null
              entry.reportScoreAvg = rec && rec.scoreN > 0 ? rec.scoreSum / rec.scoreN : null
            }
          }
          if (includeSet.has('notifications')) {
            let notifData = null
            if (db.useDb) {
              const all = await db.getNotifications(null, null)
              notifData = { items: all }
            } else {
              try {
                const raw = await fs.readFile(path.resolve('data/notifications.json'), 'utf8')
                notifData = JSON.parse(raw)
              } catch {}
            }
            // Per-tail latest by kind, plus an aggregated pilotAction state
            // machine (completed > reviewed > acknowledged > none). We only
            // consider items whose `at` falls in the window, so stale
            // notifications from before hours= ago don't bleed through.
            const byTail = new Map()
            const STATUS_RANK = { none: 0, acknowledged: 1, reviewed: 2, completed: 3 }
            const actionToStatus = (action) => {
              if (action === 'acknowledge') return 'acknowledged'
              if (action === 'reviewed_flight' || action === 'reviewed_abatement') return 'reviewed'
              if (action === 'completed_training') return 'completed'
              return 'none'
            }
            for (const it of (notifData && notifData.items) || []) {
              const ts = Date.parse(it.at || '')
              if (!Number.isFinite(ts) || ts < windowFromMs || ts > nowMs) continue
              const k = (it.tail || '').toUpperCase()
              if (!k) continue
              let rec = byTail.get(k)
              if (!rec) {
                rec = {
                  operator: null, // latest operator notification
                  pilot: null,    // latest pilot notification
                  responses: [],  // all pilot-response items, any order
                }
                byTail.set(k, rec)
              }
              if (it.kind === 'operator') {
                if (!rec.operator || ts > Date.parse(rec.operator.at)) rec.operator = it
              } else if (it.kind === 'pilot') {
                if (!rec.pilot || ts > Date.parse(rec.pilot.at)) rec.pilot = it
              } else if (it.kind === 'pilot-response') {
                rec.responses.push(it)
              }
            }
            for (const entry of active) {
              const rec = byTail.get(entry.tail.toUpperCase())
              if (!rec) {
                entry.operatorNotified = null
                entry.pilotNotified = null
                entry.pilotAction = { status: 'none', at: null, steps: {
                  acknowledged: false, flight_reviewed: false, abatement_reviewed: false, completed_training: false,
                } }
                continue
              }
              entry.operatorNotified = rec.operator ? {
                at: rec.operator.at,
                via: rec.operator.via || null,
                contact: rec.operator.contact || null,
              } : null
              entry.pilotNotified = rec.pilot ? {
                at: rec.pilot.at,
                via: rec.pilot.via || null,
                channel: rec.pilot.channel || null,
              } : null
              const steps = {
                acknowledged: false,
                flight_reviewed: false,
                abatement_reviewed: false,
                completed_training: false,
              }
              let bestStatus = 'none'
              let bestAt = null
              for (const r of rec.responses) {
                if (r.action === 'acknowledge') steps.acknowledged = true
                else if (r.action === 'reviewed_flight') steps.flight_reviewed = true
                else if (r.action === 'reviewed_abatement') steps.abatement_reviewed = true
                else if (r.action === 'completed_training') steps.completed_training = true
                const s = actionToStatus(r.action)
                if (STATUS_RANK[s] >= STATUS_RANK[bestStatus]) {
                  bestStatus = s
                  bestAt = r.at
                }
              }
              entry.pilotAction = { status: bestStatus, at: bestAt, steps }
            }
          }
          active.sort((a, b) => {
            if (SEV[b.worst] !== SEV[a.worst]) return SEV[b.worst] - SEV[a.worst]
            return (b.lastSeenMs || 0) - (a.lastSeenMs || 0)
          })
          const payload = {
            generated_at: new Date(nowMs).toISOString(),
            window: { hours, from: fromDate, to: toDate },
            include: [...includeSet],
            active,
          }
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify(payload))
        } catch (err) {
          console.error('[offenses-active-api] error', err)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      server.middlewares.use('/api/offenses', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const tail = (u.searchParams.get('tail') || '').trim()
          const from = u.searchParams.get('from')
          const to = u.searchParams.get('to')
          if (!tail) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'missing required parameter: tail' }))
            return
          }
          if (!zonesCache) {
            const mod = await import('./src/noiseZones.js')
            zonesCache = mod.NOISE_ZONES
          }
          const t0 = Date.now()
          const [tracksData, schoolsData] = await Promise.all([
            loadCached(fs, path, 'tracks'),
            loadCached(fs, path, 'schools'),
          ])
          const loadMs = Date.now() - t0
          // Build tail → school lookup
          let schoolInfo = null
          for (const s of schoolsData.schools || []) {
            for (const ac of s.aircraft || []) {
              if (ac.tail === tail) {
                schoolInfo = { school: s.name, airport: s.airport, type: ac.type || '' }
                break
              }
            }
            if (schoolInfo) break
          }
          // Geo helpers — inlined so the plugin is self-contained.
          const FT_PER_DEG_LAT = 364560
          const pointInPolygon = (lat, lon, poly) => {
            let inside = false
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
              const [yi, xi] = poly[i]
              const [yj, xj] = poly[j]
              if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) {
                inside = !inside
              }
            }
            return inside
          }
          const distPointToSegFt = (lat, lon, aLat, aLon, bLat, bLon) => {
            const latRef = (aLat + bLat + lat) / 3
            const cos = Math.cos((latRef * Math.PI) / 180)
            const px = (lon - aLon) * FT_PER_DEG_LAT * cos
            const py = (lat - aLat) * FT_PER_DEG_LAT
            const dx = (bLon - aLon) * FT_PER_DEG_LAT * cos
            const dy = (bLat - aLat) * FT_PER_DEG_LAT
            const len2 = dx * dx + dy * dy
            if (len2 === 0) return Math.hypot(px, py)
            let t = (px * dx + py * dy) / len2
            t = Math.max(0, Math.min(1, t))
            return Math.hypot(px - t * dx, py - t * dy)
          }
          const signedDistance = (lat, lon) => {
            let minAbs = Infinity
            let insideAny = false
            let nearestZone = null
            for (const z of zonesCache) {
              const poly = z.polygon
              if (pointInPolygon(lat, lon, poly)) insideAny = true
              let minEdge = Infinity
              for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                const d = distPointToSegFt(lat, lon, poly[i][0], poly[i][1], poly[j][0], poly[j][1])
                if (d < minEdge) minEdge = d
              }
              if (minEdge < minAbs) { minAbs = minEdge; nearestZone = z.name }
            }
            return { d: insideAny ? -minAbs : minAbs, zone: nearestZone }
          }
          const ALT_THRESHOLD_FT = 7500
          const classifyAlt = (alt) => {
            if (alt == null) return null
            const below = ALT_THRESHOLD_FT - alt
            if (below > 500) return 'red'
            if (below > 250) return 'orange'
            if (below > -250) return 'yellow'
            return null
          }
          const classifyZone = (d) => {
            if (d < -500) return 'red'
            if (d < -250) return 'orange'
            if (d < 250) return 'yellow'
            return null
          }
          const SEV = { yellow: 1, orange: 2, red: 3 }
          const classifyPoint = (lat, lon, alt) => {
            const { d, zone } = signedDistance(lat, lon)
            const z = classifyZone(d)
            const a = classifyAlt(alt)
            if (!z || !a) return { klass: null, zone: null }
            return { klass: SEV[z] <= SEV[a] ? z : a, zone }
          }
          // Look up tracks for this tail via the pre-indexed Map (O(1)),
          // then filter by date window. Search depth is therefore bounded by
          // the number of days that tail was observed — usually < 100.
          const candidates = tracksData._byTail.get(tail) || []
          const matches = candidates.filter((t) => {
            if (!from && !to) return true
            const m = (t.src || '').match(/(\d{4}-\d{2}-\d{2})/)
            if (!m) return false
            const d = m[1]
            if (from && d < from) return false
            if (to && d > to) return false
            return true
          })
          // Walk each track, collect contiguous-violation events
          const offenses = []
          for (const t of matches) {
            const m = (t.src || '').match(/(\d{4}-\d{2}-\d{2})/)
            const date = m ? m[1] : null
            const tags = t.points.map((p) => classifyPoint(p[0], p[1], p[2]))
            let cur = null
            for (let i = 0; i < t.points.length; i++) {
              const tag = tags[i]
              if (tag.klass) {
                if (!cur) cur = {
                  date, worst: tag.klass, zone: tag.zone, points: 1,
                  peakAlt: t.points[i][2],
                }
                else {
                  cur.points++
                  if (SEV[tag.klass] > SEV[cur.worst]) {
                    cur.worst = tag.klass; cur.zone = tag.zone
                    cur.peakAlt = t.points[i][2]
                  }
                }
              } else if (cur) {
                offenses.push(cur); cur = null
              }
            }
            if (cur) offenses.push(cur)
          }
          offenses.sort((a, b) => (a.date || '').localeCompare(b.date || ''))
          // Landing URL — deep link to the NoticePage with tail, timestamp
          // of the worst offense (midnight UTC of that day), and school
          // pre-populated for the compose flow.
          const host = req.headers.host || 'localhost:5174'
          const proto = req.headers['x-forwarded-proto'] || 'http'
          const worstOffense = offenses.length
            ? offenses.reduce((w, o) => (SEV[o.worst] > SEV[w.worst] ? o : w), offenses[0])
            : null
          const atMs = worstOffense
            ? Date.parse(worstOffense.date + 'T12:00:00Z') || Date.now()
            : Date.now()
          const noticeId = signNoticeId(tail, atMs)
          const params = new URLSearchParams()
          params.set('tail', tail)
          params.set('at', String(atMs))
          params.set('nid', noticeId)
          if (schoolInfo?.school) params.set('school', schoolInfo.school)
          const landing = `${proto}://${host}/notice?${params.toString()}`
          const elapsedMs = Date.now() - t0
          const payload = {
            tail,
            type: schoolInfo?.type || '',
            school: schoolInfo?.school || null,
            base: schoolInfo?.airport || null,
            window: { from: from || null, to: to || null },
            tracks_seen: matches.length,
            tracks_in_index: candidates.length,
            total_offenses: offenses.length,
            worst: offenses.length
              ? offenses.reduce((w, o) => (SEV[o.worst] > SEV[w] ? o.worst : w), offenses[0].worst)
              : null,
            offenses,
            landing_url: landing,
            timing_ms: { total: elapsedMs, file_load: loadMs },
          }
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify(payload, null, 2))
        } catch (err) {
          console.error('[offenses-api] error', err)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}

// Server-side live ADS-B collector. Runs inside the dev server (and any
// preview/build-serve invocation): polls adsb.lol (falling back to
// airplanes.live) every POLL_MS, accumulates per-hex tracks in memory, and
// atomically flushes to public/tracks_live.json — the same file the
// /api/offenses/segments endpoint merges with historical data. On UTC day
// rollover the previous day is written to public/tracks_live_YYYY-MM-DD.json
// and in-memory state resets. This replaces the brittle per-tab
// localStorage persistence in App.jsx as the single source of truth for
// "today's" live data, shared across every browser tab hitting the server.
// POST /api/noise-reports
//   body: { mode, submittedAt, reporter, identity, location, score, media, excursion, ... }
//   Persists the full client-side meta blob verbatim to
//   noise/web/data/noise_reports.json, assigns a server-side id and
//   receivedAt, and returns { id, receivedAt }. Concurrent writes are
//   serialized through the shared ledger promise chain.
//
// GET /api/noise-reports[?reporter=...]
//   Read-only dump, optionally filtered by reporter (for a "My Reports"
//   panel). Returns { count, reports }.
function noiseReportsApiPlugin() {
  const ledger = makeLedger('data/noise_reports.json')
  return {
    name: 'noise-reports-api',
    configureServer(server) {
      server.middlewares.use('/api/noise-reports', async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'POST') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          if (req.method === 'GET') {
            const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
            const reporter = (u.searchParams.get('reporter') || '').trim()
            let list
            if (db.useDb) {
              list = await db.getNoiseReports(reporter || null)
            } else {
              const data = (await ledger.load(fs, path)) || { reports: [] }
              list = Array.isArray(data.reports) ? data.reports : []
              if (reporter) {
                list = list.filter((r) => {
                  const rep = r.reporter
                  if (!rep) return false
                  if (typeof rep === 'string') return rep === reporter
                  return rep.email === reporter || rep.id === reporter || rep.name === reporter
                })
              }
            }
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(JSON.stringify({ count: list.length, reports: list }))
            return
          }
          let body
          try {
            body = await readJsonBody(req)
          } catch {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'invalid JSON body' }))
            return
          }
          const receivedAt = new Date().toISOString()
          const id = `nr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          const record = { ...body, id, receivedAt }
          if (db.useDb) {
            await db.addNoiseReport(record)
          } else {
            await ledger.mutate(fs, path, (cur) => {
              const reports = Array.isArray(cur.reports) ? cur.reports : []
              reports.push(record)
              return { reports }
            })
          }
          res.statusCode = 201
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ id, receivedAt }))
        } catch (err) {
          console.error('[noise-reports-api] error', err)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}

// POST /api/notifications/pilot-ack
//   body: { tail, noticeId?, via?, channel?: 'operator-forwarded'|'direct', contact?, notes? }
//   Records that the pilot has been notified (typically by the operator
//   forwarding the notice downstream). Writes to data/notifications.json.
//
// POST /api/pilot-response
//   body: { noticeId | tail, action: 'acknowledge'|'reviewed_flight'|
//           'reviewed_abatement'|'completed_training', notes? }
//   Records a pilot response tied back to a specific notice via HMAC-signed
//   noticeId (from the landing URL). Falls back to bare tail if noticeId is
//   absent — useful for manual back-office entries — but a signed noticeId
//   is the canonical path. Writes to data/notifications.json with
//   kind='pilot-response'.
//
// GET /api/notifications[?tail=...&kind=operator|pilot|pilot-response]
//   Read-only dump for debugging and for the /active endpoint to join
//   per-tail notification state.
function pilotApiPlugin() {
  const PILOT_ACTIONS = new Set([
    'acknowledge',
    'reviewed_flight',
    'reviewed_abatement',
    'completed_training',
  ])
  return {
    name: 'pilot-api',
    configureServer(server) {
      server.middlewares.use('/api/notifications/pilot-ack', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const body = await readJsonBody(req).catch(() => null)
          if (!body) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'invalid JSON body' }))
            return
          }
          const tail = ((body.tail || '') + '').trim().toUpperCase()
          if (!tail) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'missing tail' }))
            return
          }
          const record = {
            kind: 'pilot',
            tail,
            via: body.via || 'api',
            channel: body.channel || 'operator-forwarded',
            contact: body.contact || null,
            noticeId: body.noticeId || null,
            notes: body.notes || null,
            at: new Date().toISOString(),
          }
          if (db.useDb) {
            await db.addNotification(record)
          } else {
            await notificationsLedger.mutate(fs, path, (cur) => {
              const items = Array.isArray(cur.items) ? cur.items : []
              items.push(record)
              return { items }
            })
          }
          res.statusCode = 201
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify(record))
        } catch (err) {
          console.error('[pilot-ack] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
      server.middlewares.use('/api/pilot-response', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const body = await readJsonBody(req).catch(() => null)
          if (!body) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'invalid JSON body' }))
            return
          }
          const action = ((body.action || '') + '').trim()
          if (!PILOT_ACTIONS.has(action)) {
            res.statusCode = 400
            res.end(JSON.stringify({
              error: 'invalid action',
              allowed: [...PILOT_ACTIONS],
            }))
            return
          }
          // Prefer signed noticeId; fall back to bare tail. Reject if
          // neither channel yields a usable tail.
          let tail = null
          let noticeId = null
          if (body.noticeId) {
            const verified = verifyNoticeId(body.noticeId)
            if (!verified) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'invalid or expired noticeId' }))
              return
            }
            tail = verified.tail
            noticeId = body.noticeId
          } else if (body.tail) {
            tail = ((body.tail || '') + '').trim().toUpperCase()
          }
          if (!tail) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'missing noticeId or tail' }))
            return
          }
          const record = {
            kind: 'pilot-response',
            tail,
            action,
            noticeId,
            notes: body.notes || null,
            at: new Date().toISOString(),
          }
          if (db.useDb) {
            await db.addNotification(record)
          } else {
            await notificationsLedger.mutate(fs, path, (cur) => {
              const items = Array.isArray(cur.items) ? cur.items : []
              items.push(record)
              return { items }
            })
          }
          res.statusCode = 201
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify(record))
        } catch (err) {
          console.error('[pilot-response] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
      server.middlewares.use('/api/notifications', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const tail = (u.searchParams.get('tail') || '').trim().toUpperCase()
          const kind = (u.searchParams.get('kind') || '').trim()
          let items
          if (db.useDb) {
            items = await db.getNotifications(tail || null, kind || null)
          } else {
            const data = (await notificationsLedger.load(fs, path)) || { items: [] }
            items = Array.isArray(data.items) ? data.items : []
            if (tail) items = items.filter((i) => (i.tail || '').toUpperCase() === tail)
            if (kind) items = items.filter((i) => i.kind === kind)
          }
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ count: items.length, items }))
        } catch (err) {
          console.error('[notifications-api] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}

// GET  /api/complaints[?tail=...]  → list all or filter by tail
// POST /api/complaints               → lodge a complaint against an excursion
// Storage: noise/web/data/complaints.json (outside public/, not served).
// Multiple complaints per (tail, startedAt) are allowed — different
// reporters can each file their own. Concurrent POSTs are serialized via
// a promise chain so one file write can't clobber another's read-modify-write.
function complaintsApiPlugin() {
  const FILE = 'data/complaints.json'
  let writeChain = Promise.resolve()
  const loadAll = async (fs, path) => {
    try {
      const buf = await fs.readFile(path.resolve(FILE), 'utf8')
      const data = JSON.parse(buf)
      return { complaints: Array.isArray(data.complaints) ? data.complaints : [] }
    } catch {
      return { complaints: [] }
    }
  }
  const saveAll = async (fs, path, data) => {
    const p = path.resolve(FILE)
    const dir = path.dirname(p)
    try { await fs.mkdir(dir, { recursive: true }) } catch {}
    const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2))
    try {
      await fs.rename(tmp, p)
    } catch (e) {
      try { await fs.unlink(tmp) } catch {}
      throw e
    }
  }
  const readBody = async (req) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8')
    return raw ? JSON.parse(raw) : {}
  }
  return {
    name: 'complaints-api',
    configureServer(server) {
      server.middlewares.use('/api/complaints', async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'POST') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          if (req.method === 'GET') {
            const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
            const tail = (u.searchParams.get('tail') || '').trim().toUpperCase()
            let list
            if (db.useDb) {
              list = await db.getComplaints(tail || null)
            } else {
              const data = await loadAll(fs, path)
              list = tail
                ? data.complaints.filter((c) => (c.tail || '').toUpperCase() === tail)
                : data.complaints
            }
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(JSON.stringify({ count: list.length, complaints: list }))
            return
          }
          let body
          try {
            body = await readBody(req)
          } catch {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'invalid JSON body' }))
            return
          }
          const tail = ((body.tail || '') + '').trim().toUpperCase()
          const startedAt = ((body.startedAt || '') + '').trim()
          const klass = ((body.klass || '') + '').trim()
          if (!tail || !startedAt || !klass) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'missing required fields: tail, startedAt, klass' }))
            return
          }
          const record = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: new Date().toISOString(),
            tail,
            startedAt,
            endedAt: body.endedAt || null,
            klass,
            zone: body.zone || null,
            reporter: body.reporter || null,
            notes: body.notes || null,
            type: body.type || null,
            location: body.location || null,
            precision: body.precision || null,
            mediaKind: body.mediaKind || null,
            score: typeof body.score === 'number' ? body.score : null,
          }
          if (db.useDb) {
            await db.addComplaint(record)
          } else {
            const task = async () => {
              const data = await loadAll(fs, path)
              data.complaints.push(record)
              await saveAll(fs, path, data)
            }
            const queued = writeChain.then(task, task)
            writeChain = queued.catch(() => {})
            await queued
          }
          res.statusCode = 201
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify(record))
        } catch (err) {
          console.error('[complaints-api] error', err)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}

function liveCapturePlugin() {
  const CENTER = [40.0394, -105.2258]
  const RADIUS_NM = 15
  const POLL_MS = 2_000
  const ALT_MAX_FT = 10_000
  const LIVE_FILE = 'public/tracks_live.json'
  const archivePathFor = (day) => `public/tracks_live_${day}.json`
  const FEEDS = [
    (lat, lon, nm) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
    (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}`,
  ]
  const todayUTC = () => new Date().toISOString().slice(0, 10)
  const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, '')
  let state = null // { day, startedAt, byHex: Map<hex, {hex,call,type,reg,points}> }
  let timer = null
  let fs = null
  let path = null
  let stopping = false
  let pollInFlight = false // serialize polls — prevents concurrent fetch/flush
  const initState = () => ({ day: todayUTC(), startedAt: nowIso(), byHex: new Map() })
  const serializeTracks = (byHex) => Array.from(byHex.values()).map((t) => ({
    hex: t.hex, call: t.call, type: t.type, reg: t.reg, src: 'live', points: t.points,
  }))
  const writeAtomic = async (p, obj) => {
    // Unique temp name so even if two writes ever race, they don't clobber
    // each other's .tmp source and cause ENOENT on rename. On Windows,
    // fs.rename replaces the destination if it exists (since Node 14).
    // OneDrive/AV scanners hold transient locks on public/*.json during
    // sync — retry rename a few times on EPERM/EBUSY/EACCES before giving
    // up; lock is usually released within ~200ms.
    const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(obj))
    const delays = [25, 50, 100, 200, 400]
    let lastErr = null
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        await fs.rename(tmp, p)
        return
      } catch (e) {
        lastErr = e
        if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') break
        if (attempt === delays.length) break
        await new Promise((r) => setTimeout(r, delays[attempt]))
      }
    }
    try { await fs.unlink(tmp) } catch {}
    throw lastErr
  }
  const flush = async () => {
    if (!state) return
    await writeAtomic(path.resolve(LIVE_FILE), {
      center: CENTER,
      radius_nm: RADIUS_NM,
      alt_max_ft: ALT_MAX_FT,
      started_at: state.startedAt,
      updated_at: nowIso(),
      tracks: serializeTracks(state.byHex),
    })
  }
  const archive = async (day, startedAt, byHex) => {
    const p = path.resolve(archivePathFor(day))
    await writeAtomic(p, {
      center: CENTER,
      radius_nm: RADIUS_NM,
      alt_max_ft: ALT_MAX_FT,
      started_at: startedAt,
      updated_at: nowIso(),
      tracks: serializeTracks(byHex),
    })
  }
  const loadExisting = async () => {
    // On startup, rehydrate today's session from disk if present; otherwise
    // archive whatever stale file we find under its own day and start fresh.
    try {
      const p = path.resolve(LIVE_FILE)
      const buf = await fs.readFile(p, 'utf8')
      const data = JSON.parse(buf)
      const fileDay = (data.updated_at || '').slice(0, 10)
      if (fileDay === todayUTC()) {
        const byHex = new Map()
        for (const t of data.tracks || []) {
          const hex = t.hex || t.call
          if (!hex) continue
          byHex.set(hex, {
            hex,
            call: t.call || hex,
            type: t.type || '',
            reg: t.reg || '',
            points: Array.isArray(t.points) ? t.points : [],
          })
        }
        state = { day: todayUTC(), startedAt: data.started_at || nowIso(), byHex }
        console.log(`[live-capture] resumed ${state.byHex.size} tracks for ${state.day}`)
        return
      }
      if (fileDay) {
        const archPath = path.resolve(archivePathFor(fileDay))
        try {
          await fs.access(archPath)
        } catch {
          await fs.writeFile(archPath, buf)
          console.log(`[live-capture] archived stale ${LIVE_FILE} as tracks_live_${fileDay}.json`)
        }
      }
    } catch {
      // no file yet — fresh start
    }
    state = initState()
  }
  const rotateIfNeeded = async () => {
    if (!state || state.day === todayUTC()) return
    try {
      await archive(state.day, state.startedAt, state.byHex)
      console.log(`[live-capture] rotated ${state.day} → tracks_live_${state.day}.json`)
    } catch (e) {
      console.error('[live-capture] rotate failed', e)
    }
    state = initState()
  }
  const poll = async () => {
    if (stopping) return
    if (pollInFlight) return // previous poll still running; skip this tick
    pollInFlight = true
    try {
    await rotateIfNeeded()
    let d = null
    for (const make of FEEDS) {
      try {
        const r = await fetch(make(CENTER[0], CENTER[1], RADIUS_NM))
        if (!r.ok) continue
        const j = await r.json()
        if (j && Array.isArray(j.ac)) { d = j; break }
      } catch {}
    }
    if (!d) return
    for (const ac of d.ac) {
      if (ac.lat == null || ac.lon == null) continue
      const alt = typeof ac.alt_baro === 'number' ? ac.alt_baro : null
      if (alt == null || alt <= 0 || alt >= ALT_MAX_FT) continue
      const hex = ac.hex
      if (!hex) continue
      const reg = ((ac.r || '') + '').trim()
      // Prefer registration as call so tail-based queries line up with
      // how tracks_yearly.json keys aircraft (call === registration for GA).
      const call = reg || ((ac.flight || '') + '').trim() || hex
      let t = state.byHex.get(hex)
      if (!t) {
        t = { hex, call, type: ((ac.t || '') + '').trim(), reg, points: [] }
        state.byHex.set(hex, t)
      } else if (reg && !t.reg) {
        t.reg = reg
        t.call = reg
      }
      const last = t.points[t.points.length - 1]
      if (!last || last[0] !== ac.lat || last[1] !== ac.lon) {
        // 4th element is epoch-ms timestamp. Historical tracks from
        // tracks_yearly.json are 3-element; segment builder handles both.
        t.points.push([ac.lat, ac.lon, alt, Date.now()])
      }
    }
    try { await flush() } catch (e) { console.error('[live-capture] flush failed', e) }
    } finally {
      pollInFlight = false
    }
  }
  return {
    name: 'live-capture',
    async configureServer(server) {
      // Idempotent — vite re-invokes configureServer on config reloads, and
      // leaking setInterval handles across reloads was one path to OOM.
      if (timer) { clearInterval(timer); timer = null }
      stopping = false
      const fsMod = await import('fs/promises')
      const pathMod = await import('path')
      fs = fsMod.default
      path = pathMod.default
      await loadExisting()
      poll().catch((e) => console.error('[live-capture] poll failed', e))
      timer = setInterval(
        () => poll().catch((e) => console.error('[live-capture] poll failed', e)),
        POLL_MS,
      )
      const stop = () => {
        stopping = true
        if (timer) { clearInterval(timer); timer = null }
      }
      server.httpServer?.on('close', stop)
      console.log(`[live-capture] started, polling every ${POLL_MS / 1000}s`)
    },
    closeBundle() {
      stopping = true
      if (timer) { clearInterval(timer); timer = null }
    },
  }
}

// Paginated API: GET /api/tracks?page=0&size=2000
// Returns { tracks, page, size, total, pages } so the client can fetch
// in chunks and show a progress bar. Queries Postgres with LIMIT/OFFSET.
// Also serves /tracks_yearly.json as a legacy fallback (redirects to
// the paginated API page 0 for backwards compat).
function dbTracksPlugin() {
  let countCache = { n: 0, at: 0 }
  const COUNT_TTL = 60_000
  return {
    name: 'db-tracks',
    configureServer(server) {
      console.log('[db-tracks] plugin registered — /api/tracks (paginated) + /tracks_yearly.json')

      // Paginated endpoint — client fetches chunks from Postgres directly
      server.middlewares.use('/api/tracks', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const page = Math.max(0, parseInt(u.searchParams.get('page') || '0'))
          const size = Math.min(5000, Math.max(100, parseInt(u.searchParams.get('size') || '2000')))
          const offset = page * size

          // Get total count (cached)
          const now = Date.now()
          if (!countCache.n || now - countCache.at > COUNT_TTL) {
            const cr = await db.queryDb('SELECT count(*) FROM tracks')
            countCache = { n: parseInt(cr.rows[0].count), at: now }
          }
          const total = countCache.n
          const pages = Math.ceil(total / size)

          console.log(`[db-tracks] /api/tracks page=${page} size=${size} offset=${offset} total=${total}`)

          // Query just this page from Postgres
          const r = await db.queryDb(
            'SELECT call, hex, type, desc_text, own_op, src, points FROM tracks ORDER BY id LIMIT $1 OFFSET $2',
            [size, offset]
          )
          // Derive year, t0, years_back from src (e.g. "globe/2023-03-15/hex")
          // These fields are expected by the client for filtering and time-of-day.
          const currentYear = new Date().getFullYear()
          const tracks = r.rows.map(row => {
            const m = (row.src || '').match(/(\d{4})-(\d{2})-(\d{2})/)
            const year = m ? m[1] : null
            const t0 = m ? Math.floor(Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`) / 1000) : null
            const yearsBack = year ? currentYear - parseInt(year) : null
            return {
              call: row.call, hex: row.hex, type: row.type, desc: row.desc_text,
              ownOp: row.own_op, src: row.src, points: row.points,
              year, t0, years_back: yearsBack,
            }
          })

          const payload = JSON.stringify({ tracks, page, size, total, pages })
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(payload)
        } catch (e) {
          console.error('[db-tracks] /api/tracks error', e)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(e), tracks: [] }))
        }
      })

      // Legacy /tracks_yearly.json — redirect to page 0 so old clients
      // get something, but real loading uses the paginated API above.
      server.middlewares.use('/tracks_yearly.json', async (_req, res) => {
        console.log('[db-tracks] /tracks_yearly.json requested — returning empty (use /api/tracks)')
        res.setHeader('Content-Type', 'application/json')
        res.end('{"tracks":[],"_use_api":true}')
      })
    },
  }
}

// Pre-aggregated noise stats and filtered tracks from Postgres.
// Replaces the 60MB bulk download + client-side classification with
// lightweight server-side queries against pre-computed columns.
function noiseApiPlugin() {
  if (!db.useDb) return null // only on Railway
  return {
    name: 'noise-api',
    configureServer(server) {
      console.log('[noise-api] registered /api/noise/stats, /api/noise/tracks, /api/noise/years')

      // GET /api/noise/years — distinct years for filter pills
      server.middlewares.use('/api/noise/years', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const r = await db.queryDb('SELECT DISTINCT year FROM tracks WHERE year IS NOT NULL ORDER BY year')
          const years = r.rows.map(row => row.year)
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ years }))
        } catch (e) {
          console.error('[noise-api] /years error', e)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e) }))
        }
      })

      // Shared: parse URL filter params into SQL WHERE + params array.
      // Supports year, base (comma-multi), school, purpose, tod_start/tod_end.
      function buildFilters(u, baseConds = ['seg_total > 0']) {
        const conds = [...baseConds]
        const params = []
        const year = u.searchParams.get('year') || null
        const base = u.searchParams.get('base') || null
        const school = u.searchParams.get('school') || null
        const purpose = u.searchParams.get('purpose') || null
        const todStart = u.searchParams.get('tod_start')
        const todEnd = u.searchParams.get('tod_end')
        if (year) { params.push(year); conds.push(`year = $${params.length}`) }
        if (base) {
          const bases = base.split(',').map(b => b.trim()).filter(Boolean)
          if (bases.length === 1) { params.push(bases[0]); conds.push(`base_airport = $${params.length}`) }
          else { params.push(bases); conds.push(`base_airport = ANY($${params.length})`) }
        }
        if (school) { params.push(school); conds.push(`school = $${params.length}`) }
        if (purpose) { params.push(purpose); conds.push(`purpose = $${params.length}`) }
        if (todStart != null && todEnd != null) {
          const s = parseInt(todStart), e = parseInt(todEnd)
          if (s <= e) {
            params.push(s, e); conds.push(`start_hour >= $${params.length - 1} AND start_hour < $${params.length}`)
          } else {
            params.push(s, e); conds.push(`(start_hour >= $${params.length - 1} OR start_hour < $${params.length})`)
          }
        }
        return { where: conds.join(' AND '), params }
      }

      // GET /api/noise/stats?year=X&base=X&school=X&tod_start=8&tod_end=17
      server.middlewares.use('/api/noise/stats', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const { where, params } = buildFilters(u)

          // Per-tail rankings
          const tailSql = `
            SELECT call AS tail, type, desc_text AS desc, school, base_airport AS base, purpose,
                   SUM(seg_total)::int AS total, SUM(seg_red)::int AS red,
                   SUM(seg_orange)::int AS orange, SUM(seg_yellow)::int AS yellow,
                   SUM(len_total_ft)::real AS total_ft, SUM(len_red_ft)::real AS red_ft,
                   SUM(len_orange_ft)::real AS orange_ft, SUM(len_yellow_ft)::real AS yellow_ft,
                   MAX(CASE worst_class WHEN 'red' THEN 3 WHEN 'orange' THEN 2 WHEN 'yellow' THEN 1 ELSE 0 END) AS worst_rank,
                   COUNT(*)::int AS track_count
            FROM tracks
            WHERE ${where}
            GROUP BY call, type, desc_text, school, base_airport, purpose
            HAVING SUM(seg_total) > 0
            ORDER BY SUM(seg_red)::float / NULLIF(SUM(seg_total), 0) DESC
            LIMIT 200
          `
          const tailRes = await db.queryDb(tailSql, params)
          const worstMap = { 3: 'red', 2: 'orange', 1: 'yellow' }
          const perTail = tailRes.rows.map(r => ({
            ...r, worst: worstMap[r.worst_rank] || null,
          }))

          // Cube: year × base × origin → { total, red }
          const cubeSql = `
            SELECT year, base_airport AS base, origin,
                   SUM(seg_total)::int AS total, SUM(seg_red)::int AS red
            FROM tracks WHERE seg_total > 0
            GROUP BY year, base_airport, origin
          `
          const cubeRes = await db.queryDb(cubeSql)
          const cube = {}
          for (const r of cubeRes.rows) {
            if (!cube[r.year]) cube[r.year] = {}
            if (!cube[r.year][r.base]) cube[r.year][r.base] = {}
            cube[r.year][r.base][r.origin] = { total: r.total, red: r.red }
          }

          // Per-date excursion stats (for the bar chart)
          // Uses % of total flight length in each zone, aggregated per date
          const byDateSql = `
            SELECT date,
                   count(*)::int AS flights,
                   SUM(len_total_ft)::real AS total_ft,
                   SUM(len_yellow_ft)::real AS yellow_ft,
                   SUM(len_orange_ft)::real AS orange_ft,
                   SUM(len_red_ft)::real AS red_ft
            FROM tracks
            WHERE ${where} AND date IS NOT NULL
            GROUP BY date ORDER BY date
          `
          const byDateRes = await db.queryDb(byDateSql, params)
          const byDate = byDateRes.rows.map(r => ({
            date: r.date,
            flights: r.flights,
            totalFt: r.total_ft,
            yellowFt: r.yellow_ft,
            orangeFt: r.orange_ft,
            redFt: r.red_ft,
            // Percentages for easy consumption
            yellowPct: r.total_ft > 0 ? r.yellow_ft / r.total_ft * 100 : 0,
            orangePct: r.total_ft > 0 ? r.orange_ft / r.total_ft * 100 : 0,
            redPct: r.total_ft > 0 ? r.red_ft / r.total_ft * 100 : 0,
          }))

          // Available filters
          const yearsRes = await db.queryDb('SELECT DISTINCT year FROM tracks WHERE year IS NOT NULL ORDER BY year')
          const basesRes = await db.queryDb('SELECT DISTINCT base_airport FROM tracks WHERE base_airport IS NOT NULL ORDER BY base_airport')
          const schoolsRes = await db.queryDb('SELECT DISTINCT school FROM tracks WHERE school IS NOT NULL ORDER BY school')
          const purposesRes = await db.queryDb('SELECT DISTINCT purpose FROM tracks WHERE purpose IS NOT NULL ORDER BY purpose')

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({
            perTail,
            cube,
            byDate,
            years: yearsRes.rows.map(r => r.year),
            bases: basesRes.rows.map(r => r.base_airport),
            schools: schoolsRes.rows.map(r => r.school),
            purposes: purposesRes.rows.map(r => r.purpose),
          }))
        } catch (e) {
          console.error('[noise-api] /stats error', e)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e) }))
        }
      })

      // GET /api/noise/tracks?year=X&base=X&school=X&violations_only=1&limit=500&offset=0
      // Returns pre-banded tracks for map rendering. Each track includes
      // bands (colored polyline segments) — the client just renders them.
      // Payload: ~200-500KB for 500 tracks vs 60MB for all.
      server.middlewares.use('/api/noise/tracks', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const violationsOnly = u.searchParams.get('violations_only') === '1'
          const limit = Math.min(2000, Math.max(1, parseInt(u.searchParams.get('limit') || '500')))
          const offset = Math.max(0, parseInt(u.searchParams.get('offset') || '0'))

          const { where: baseWhere, params } = buildFilters(u, ['bands IS NOT NULL'])
          const extraConds = []
          if (violationsOnly) extraConds.push('worst_class IS NOT NULL')
          const where = extraConds.length ? `${baseWhere} AND ${extraConds.join(' AND ')}` : baseWhere

          // Count total matching
          const countRes = await db.queryDb(`SELECT count(*)::int AS n FROM tracks WHERE ${where}`, params)
          const total = countRes.rows[0].n

          // Fetch tracks ordered by rand_key for equal representation
          // across airports, dates, and aircraft types
          const pIdx = params.length
          params.push(limit, offset)
          const sql = `
            SELECT call, type, desc_text AS desc, own_op AS "ownOp", src,
                   year, date, base_airport AS base, worst_class AS worst,
                   seg_total, seg_red, seg_orange, seg_yellow,
                   len_total_ft, len_red_ft, len_orange_ft, len_yellow_ft,
                   school, purpose, bands
            FROM tracks
            WHERE ${where}
            ORDER BY rand_key
            LIMIT $${pIdx + 1} OFFSET $${pIdx + 2}
          `
          const r = await db.queryDb(sql, params)

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({
            tracks: r.rows,
            total,
            limit,
            offset,
            pages: Math.ceil(total / limit),
          }))
        } catch (e) {
          console.error('[noise-api] /tracks error', e)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e), tracks: [] }))
        }
      })
    },
  }
}

function externalDataPlugin() {
  const DATA_PATH = 'C:\\tmp\\noise_data\\tracks_yearly.json'
  return {
    name: 'external-data',
    configureServer(server) {
      server.middlewares.use('/tracks_yearly.json', async (_req, res) => {
        const fs = await import('fs')
        try {
          const stat = fs.statSync(DATA_PATH)
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Content-Length', stat.size)
          fs.createReadStream(DATA_PATH).pipe(res)
        } catch (e) {
          res.statusCode = 404
          res.end('{"tracks":[]}')
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    // On Railway, serve tracks from Postgres; locally, from C:\tmp\noise_data\
    db.useDb ? dbTracksPlugin() : externalDataPlugin(),
    noiseApiPlugin(),  // pre-aggregated stats + filtered tracks (DB-only)
    sendNoticePlugin(),
    offensesApiPlugin(),
    complaintsApiPlugin(),
    noiseReportsApiPlugin(),
    pilotApiPlugin(),
    !db.useDb && liveCapturePlugin(),
  ].filter(Boolean),
  server: {
    port: parseInt(process.env.PORT || '5174'),
    allowedHosts: true,
    open: process.env.RAILWAY_ENVIRONMENT ? false : '/',
    proxy: {
      // Two live ADS-B feeds. adsb.lol is the preferred primary; the client
      // auto-fails over to airplanes.live when it can't reach the primary.
      // Both are readsb-based; only the URL path differs.
      '/adsblol': {
        target: 'https://api.adsb.lol',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/adsblol/, ''),
      },
      '/airplaneslive': {
        target: 'https://api.airplanes.live',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/airplaneslive/, ''),
      },
    },
  },
})
