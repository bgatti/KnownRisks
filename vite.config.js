import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import crypto from 'crypto'
import * as db from './db.js'
import * as adsb from './adsb.js'

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

// GET /api/excursions?tail=N12JA[&from=YYYY-MM-DD][&to=YYYY-MM-DD]
// Returns JSON list of classified excursions for an aircraft within a date
// window, along with a deep link back to the map page pre-selecting the tail.
function excursionsApiPlugin() {
  let zonesCache = null
  // mtime-based cache for the big tracks file. Re-read only when the file
  // on disk changes; avoids re-parsing 200 MB on every API hit.
  const fileCache = { tracks: null, schools: null, live: null }
  const TRACKS_DIR = 'C:\\tmp\\noise_data'
  const TRACK_YEARS = ['2023', '2024', '2025', '2026']
  const FILE_PATHS = {
    schools: 'public/flight_schools_fleets.json',
    live: 'public/tracks_live.json',
  }
  const buildIndex = (data) => {
    const byTail = new Map()
    for (const t of data.tracks || []) {
      const k = (t.call || '').trim()
      if (!k) continue
      let arr = byTail.get(k)
      if (!arr) { arr = []; byTail.set(k, arr) }
      arr.push(t)
    }
    data._byTail = byTail
    return data
  }
  const loadCached = async (fs, path, key) => {
    if (db.useDb) {
      if (key === 'tracks') return db.loadTracksFromDb()
      if (key === 'live') return db.loadLiveFromDb()
      if (key === 'schools') return db.loadSchoolsFromDb()
    }
    // Per-year track files — merge them, cache based on combined mtime.
    if (key === 'tracks') {
      try {
        let latestMtime = 0
        for (const y of TRACK_YEARS) {
          try {
            const st = await fs.stat(TRACKS_DIR + '\\tracks_' + y + '.json')
            if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs
          } catch {}
        }
        const cached = fileCache[key]
        if (cached && cached.mtimeMs === latestMtime) return cached.data
        const allTracks = []
        for (const y of TRACK_YEARS) {
          try {
            const buf = await fs.readFile(TRACKS_DIR + '\\tracks_' + y + '.json', 'utf8')
            const d = JSON.parse(buf)
            if (d.tracks) allTracks.push(...d.tracks)
          } catch {}
        }
        const data = buildIndex({ tracks: allTracks })
        fileCache[key] = { mtimeMs: latestMtime, data }
        return data
      } catch (e) {
        return buildIndex({ tracks: [] })
      }
    }
    const p = path.resolve(FILE_PATHS[key])
    try {
      const stat = await fs.stat(p)
      const cached = fileCache[key]
      if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data
      const buf = await fs.readFile(p, 'utf8')
      const data = JSON.parse(buf)
      if (key === 'live') buildIndex(data)
      fileCache[key] = { mtimeMs: stat.mtimeMs, data }
      return data
    } catch (e) {
      if (key === 'schools') return { schools: [] }
      if (key === 'live') return { tracks: [], _byTail: new Map(), updated_at: null }
      throw e
    }
  }
  return {
    name: 'excursions-api',
    configureServer(server) {
      console.log('[excursions-api] registering endpoints...')
      // /api/excursions/flight-ops — intent model with intermediaries.
      // Registered first within excursionsApiPlugin so it matches before
      // the /api/excursions catch-all.
      server.middlewares.use('/api/excursions/flight-ops', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        const u = new URL(req.originalUrl || req.url, `http://${req.headers.host || 'localhost'}`)
        const baseParam = (u.searchParams.get('base') || '').toUpperCase()
        const radiusNm = Number(u.searchParams.get('radius')) || (baseParam ? 15 : 999)
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const liveData = await loadCached(fs, path, 'live')
          const schoolsData = await loadCached(fs, path, 'schools')
          const schoolMap = new Map()
          for (const s of schoolsData.schools || []) {
            for (const ac of s.aircraft || []) schoolMap.set(ac.tail, s.name)
          }
          const AP = [
            { code: 'KBDU', lat: 40.0394, lon: -105.2258, elev: 5288, tpa: 6300 },
            { code: 'KBJC', lat: 39.9088, lon: -105.1172, elev: 5673, tpa: 6700 },
            { code: 'KEIK', lat: 40.0098, lon: -105.0488, elev: 5130, tpa: 6100 },
            { code: 'KLMO', lat: 40.1636, lon: -105.1636, elev: 5055, tpa: 6100 },
            { code: 'KAPA', lat: 39.5701, lon: -104.8493, elev: 5885, tpa: 6900 },
            { code: 'KGXY', lat: 40.4348, lon: -104.6331, elev: 4697, tpa: 5700 },
          ]
          // Runway headings for pattern leg detection
          const RUNWAYS = {
            KBDU: [{ hdg: 80, name: '08' }, { hdg: 260, name: '26' }],
            KBJC: [{ hdg: 119, name: '12' }, { hdg: 299, name: '30' }],
            KEIK: [{ hdg: 152, name: '15' }, { hdg: 332, name: '33' }],
            KLMO: [{ hdg: 113, name: '11' }, { hdg: 293, name: '29' }],
            KAPA: [{ hdg: 174, name: '17' }, { hdg: 354, name: '35' }],
          }
          const distNm = (lat1, lon1, lat2, lon2) => {
            const dLat = (lat1 - lat2) * 60
            const dLon = (lon1 - lon2) * 60 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180)
            return Math.hypot(dLat, dLon)
          }
          // When ?base=KBDU is set, ALL distances/intent are relative to that
          // airport. Without it, each aircraft uses its nearest airport.
          const fixedBase = baseParam ? AP.find(a => a.code === baseParam) : null
          const nearAp = (lat, lon) => {
            if (fixedBase) return { ...fixedBase, dist: distNm(lat, lon, fixedBase.lat, fixedBase.lon) }
            let best = AP[0], bestD = Infinity
            for (const ap of AP) {
              const d = distNm(lat, lon, ap.lat, ap.lon)
              if (d < bestD) { bestD = d; best = ap }
            }
            return { ...best, dist: bestD }
          }
          const normAngle = (a) => ((a % 360) + 540) % 360 - 180 // ±180
          const purposeOf = (type) => {
            if (!type) return 'unknown'
            if (/PA25|PA18/.test(type)) return 'tow_plane'
            if (/GLID|VENT|AS2|DG\d|NIMB|DISC|SGS/.test(type)) return 'glider'
            if (/R22|R44|R66|AS50|EC\d|B06|B407|H500|S76/.test(type)) return 'helicopter'
            if (/B73|B38|B78|A3[12]|A2[01]|CRJ|E7[05]|E19|MD[89]/.test(type)) return 'airline'
            if (/C25|C5[0-6]|C6[89]|C750|CL[36]|LJ\d|GL[AX]|H25|E55P|E50P|SF50/.test(type)) return 'biz_jet'
            if (/PC12|TBM|DHC6/.test(type)) return 'turboprop'
            if (/RV[78]|LGEZ|VL3|LONG|LANCAIR/.test(type)) return 'experimental'
            if (/PA44|DA42|BE58|BE55|BE76/.test(type)) return 'ga_twin'
            return 'ga_single'
          }

          const aircraft = []
          for (const t of liveData.tracks || []) {
            const pts = t.points || []
            if (pts.length < 5) continue
            const tail = t.call || t.reg || t.hex || '?'
            const type = t.type || ''
            const school = schoolMap.get(tail) || null
            const purpose = purposeOf(type)
            const lastPt = pts[pts.length - 1]
            const ap = nearAp(lastPt[0], lastPt[1])

            // ─── 3-min window (last 90 pts at 2s, or whatever we have) ───
            const WINDOW = 90
            const recent = pts.slice(-WINDOW)
            const first = recent[0], last = recent[recent.length - 1]
            const hasTs = first.length > 3 && last.length > 3
            const dtMin = hasTs ? (last[3] - first[3]) / 60000 : (recent.length * 2) / 60
            const flightTimeMin = hasTs ? (last[3] - pts[0][3]) / 60000 : (pts.length * 2) / 60

            // Distance to nearest airport at start and end of window
            const distStart = distNm(first[0], first[1], ap.lat, ap.lon)
            const distEnd = distNm(last[0], last[1], ap.lat, ap.lon)

            // Groundspeed estimate (kt) from last few points
            const gs = recent.length >= 3
              ? distNm(recent[recent.length-3][0], recent[recent.length-3][1], last[0], last[1]) * 60 / ((hasTs ? (last[3] - recent[recent.length-3][3]) / 60000 : 6/60) || 1)
              : 0

            // ─── Intermediary 1: closure_pct ───
            const closureRate = dtMin > 0 ? (distStart - distEnd) / dtMin : 0 // nm/min, positive = closing
            const closure_pct = gs > 10 ? (closureRate * 60) / gs * 100 : 0

            // ─── Intermediary 2: angular_accumulation ───
            let totalTurn = 0
            for (let i = 1; i < recent.length; i++) {
              // Compute heading between consecutive points
              const dLon = (recent[i][1] - recent[i-1][1]) * Math.cos(((recent[i][0] + recent[i-1][0]) / 2) * Math.PI / 180)
              const dLat = recent[i][0] - recent[i-1][0]
              if (Math.abs(dLon) < 1e-7 && Math.abs(dLat) < 1e-7) continue
              const hdg = Math.atan2(dLon, dLat) * 180 / Math.PI
              if (i >= 2) {
                const dLon2 = (recent[i-1][1] - recent[i-2][1]) * Math.cos(((recent[i-1][0] + recent[i-2][0]) / 2) * Math.PI / 180)
                const dLat2 = recent[i-1][0] - recent[i-2][0]
                if (Math.abs(dLon2) > 1e-7 || Math.abs(dLat2) > 1e-7) {
                  const prevHdg = Math.atan2(dLon2, dLat2) * 180 / Math.PI
                  totalTurn += Math.abs(normAngle(hdg - prevHdg))
                }
              }
            }
            const trackDistNm = dtMin > 0 ? gs * dtMin / 60 : 0.1
            const angular_accumulation = trackDistNm > 0.01 ? totalTurn / trackDistNm : 0

            // ─── Intermediary 3: climb_energy (fpm averaged over window) ───
            const climb_energy = dtMin > 0 ? (last[2] - first[2]) / dtMin : 0

            // ─── Intermediary 4: vertical_stability ───
            const meanAlt = recent.reduce((s, p) => s + p[2], 0) / recent.length
            const altVar = recent.reduce((s, p) => s + (p[2] - meanAlt) ** 2, 0) / recent.length
            const vertical_stability = Math.sqrt(altVar)

            // ─── Intermediary 5: at_pattern_altitude ───
            const at_pattern_altitude = Math.abs(last[2] - ap.tpa) < 200

            // ─── Intermediary 6: orbit_radius_nm ───
            const turnRateDegMin = dtMin > 0 ? totalTurn / dtMin : 0
            const orbit_radius_nm = turnRateDegMin > 10 ? (gs / 60) / (turnRateDegMin * Math.PI / 180) : 99

            // ─── Intermediary 7: directness ───
            const displacement = distNm(first[0], first[1], last[0], last[1])
            let pathLen = 0
            for (let i = 1; i < recent.length; i++) pathLen += distNm(recent[i-1][0], recent[i-1][1], recent[i][0], recent[i][1])
            const directness = pathLen > 0.01 ? displacement / pathLen : 1

            // ─── Intermediary 8: heading_to_runway ───
            const lastHdg = recent.length >= 2
              ? Math.atan2(
                  (last[1] - recent[recent.length-2][1]) * Math.cos(last[0] * Math.PI / 180),
                  last[0] - recent[recent.length-2][0]
                ) * 180 / Math.PI
              : 0
            const rwys = RUNWAYS[ap.code] || []
            let bestRwyAlign = 180, bestRwy = null
            for (const rwy of rwys) {
              const align = Math.abs(normAngle(lastHdg - rwy.hdg))
              if (align < bestRwyAlign) { bestRwyAlign = align; bestRwy = rwy.name }
            }
            const heading_to_runway = bestRwyAlign

            // ─── Intent classification ───
            const agl = last[2] - ap.elev
            let intent, leg = null, confidence = 0.5

            if (purpose === 'tow_plane' && angular_accumulation > 200) {
              intent = 'towing'; confidence = 0.9
            } else if (purpose === 'glider' && distEnd > 3) {
              intent = 'soaring'; confidence = 0.8
            } else if (purpose === 'glider') {
              intent = 'local_soaring'; confidence = 0.7
            } else if (distEnd < 3 && angular_accumulation > 150 && at_pattern_altitude) {
              intent = 'pattern'; confidence = 0.85
            } else if (distEnd < 3 && angular_accumulation > 100) {
              intent = 'pattern'; confidence = 0.7
            } else if (closure_pct > 60 && distEnd < 12 && climb_energy < 0) {
              intent = 'inbound'; confidence = 0.8
            } else if (closure_pct > 40 && distEnd < 15) {
              intent = 'inbound'; confidence = 0.6
            } else if (closure_pct < -60 && distEnd < 5) {
              intent = 'outbound'; confidence = 0.8
            } else if (closure_pct < -30 && distEnd < 8 && climb_energy > 200) {
              intent = 'outbound'; confidence = 0.7
            } else if (distEnd > 5 && directness < 0.4 && vertical_stability > 100) {
              intent = 'practicing'; confidence = 0.75
            } else if (distEnd > 5 && closure_pct > 20) {
              intent = 'returning'; confidence = 0.6
            } else if (distEnd > 5 && closure_pct < -20) {
              intent = 'to_practice'; confidence = 0.6
            } else if (purpose === 'airline') {
              intent = climb_energy > 100 ? 'outbound' : 'inbound'; confidence = 0.6
            } else {
              intent = 'transit'; confidence = 0.4
            }

            // ─── Pattern leg (when intent = pattern) ───
            if (intent === 'pattern' && rwys.length) {
              // Find which runway direction is closest to our heading
              let rwyHdg = rwys[0].hdg
              for (const rwy of rwys) {
                if (Math.abs(normAngle(lastHdg - rwy.hdg)) < Math.abs(normAngle(lastHdg - rwyHdg))) {
                  rwyHdg = rwy.hdg
                }
              }
              const relHdg = normAngle(lastHdg - rwyHdg)
              if (agl < 50) leg = 'on_runway'
              else if (agl < 200 && Math.abs(relHdg) < 30 && closureRate > 0) leg = 'short_final'
              else if (Math.abs(relHdg) < 30 && climb_energy < -200) leg = 'final'
              else if (Math.abs(normAngle(relHdg - 90)) < 40 && climb_energy < -100) leg = 'base'
              else if (Math.abs(relHdg - 180) < 40 || Math.abs(relHdg + 180) < 40) leg = 'downwind'
              else if (Math.abs(normAngle(relHdg - 90)) < 40 && climb_energy > 100) leg = 'crosswind'
              else if (Math.abs(relHdg) < 30 && climb_energy > 100) leg = 'upwind'
              else if (closureRate > 0 && distEnd > 1.5) leg = 'entering'
              else leg = 'maneuvering'
            }

            aircraft.push({
              tail, type, purpose, school,
              intent, leg, confidence: +confidence.toFixed(2),
              airport: ap.code, dist_nm: +distEnd.toFixed(1),
              alt: last[2], agl: Math.round(agl),
              groundspeed: Math.round(gs),
              flight_time_min: Math.round(flightTimeMin),
              intermediaries: {
                closure_pct: Math.round(closure_pct),
                angular_accumulation: Math.round(angular_accumulation),
                climb_energy: Math.round(climb_energy),
                vertical_stability: Math.round(vertical_stability),
                at_pattern_altitude,
                orbit_radius_nm: +orbit_radius_nm.toFixed(1),
                directness: +directness.toFixed(2),
                heading_to_runway: Math.round(heading_to_runway),
              },
            })
          }

          // Filter by radius when base is specified
          const filtered = baseParam
            ? aircraft.filter(ac => ac.dist_nm <= radiusNm)
            : aircraft

          // Group by intent
          const groups = {}
          for (const ac of filtered) {
            if (!groups[ac.intent]) groups[ac.intent] = []
            groups[ac.intent].push(ac)
          }
          const summary = Object.entries(groups)
            .sort((a, b) => b[1].length - a[1].length)
            .map(([intent, list]) => ({ intent, count: list.length }))

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({
            timestamp: new Date().toISOString(),
            base: fixedBase ? { code: fixedBase.code, lat: fixedBase.lat, lon: fixedBase.lon, elev: fixedBase.elev, radius_nm: radiusNm } : null,
            total: filtered.length,
            summary,
            aircraft: filtered,
          }, null, 2))
        } catch (e) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(e) }))
        }
      })

      // Registered BEFORE /api/excursions because connect prefix-matches and
      // would otherwise route /api/excursions/segments into the wrong handler.
      server.middlewares.use('/api/excursions/segments', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const tail = (u.searchParams.get('tail') || '').trim()
          const hours = Number(u.searchParams.get('hours')) || 24
          const limit = Number(u.searchParams.get('limit')) || 200
          const latParam = u.searchParams.get('lat')
          const lonParam = u.searchParams.get('lon')
          const center = (latParam != null && lonParam != null && latParam !== '' && lonParam !== '')
            ? { lat: Number(latParam), lon: Number(lonParam) }
            : null
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
          // Geo helpers — duplicated from the /api/excursions handler to keep
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
          // When tail is provided, use the O(1) index. When omitted, scan
          // all tracks in the time window — capped by `limit` to avoid
          // returning the entire dataset.
          let candidates, liveCandidates
          if (tail) {
            candidates = tracksData._byTail.get(tail) || []
            liveCandidates = liveData._byTail.get(tail) || []
          } else {
            candidates = tracksData.tracks || []
            liveCandidates = (liveData.tracks || [])
          }
          const matches = candidates.filter((t) => {
            const m = (t.src || '').match(/(\d{4}-\d{2}-\d{2})/)
            if (!m) return false
            const d = m[1]
            return d >= fromDate && d <= toDate
          })
          for (const lt of liveCandidates) matches.push(lt)
          // Cap to prevent OOM on wide queries.
          if (matches.length > limit) matches.length = limit
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
            if (filtered.length) {
              // Detect descents: count times the track drops below field elev + 300 ft
              const fieldElev = 5288 // KBDU default; good enough for classification
              const descThreshold = fieldElev + 300
              let descents = 0, wasHigh = false
              for (const p of t.points) {
                if (p[2] > descThreshold) wasHigh = true
                else if (wasHigh) { descents++; wasHigh = false }
              }
              const firstLow = t.points[0] && t.points[0][2] < descThreshold
              const lastLow = t.points[t.points.length - 1] && t.points[t.points.length - 1][2] < descThreshold
              let phase = 'overflight'
              if (firstLow && lastLow && descents >= 2) phase = 'pattern'
              else if (firstLow && !lastLow) phase = 'departure'
              else if (!firstLow && lastLow) phase = 'arrival'
              else if (firstLow && lastLow) phase = 'pattern'
              tracksOut.push({
                tail: t.call || t.reg || tail || '?',
                type: t.type || '',
                src: t.src, date, live: isLive,
                phase, descents, hasDescents: descents > 0,
                segments: filtered,
              })
            }
          }
          const payload = {
            query: tail || 'all',
            window: { hours, from: fromDate, to: toDate, limit },
            matched: matches.length,
            center: center ? { lat: center.lat, lon: center.lon, radius_ft: RADIUS_FT } : null,
            live: { updated_at: liveData.updated_at || null, tracks: liveCandidates.length },
            tracks: tracksOut,
          }
          // When querying a specific tail, add aircraft metadata.
          if (tail) {
            const allCandidates = [...liveCandidates, ...candidates]
            const pickField = (k) => {
              for (const t of allCandidates) if (t[k]) return t[k]
              return ''
            }
            payload.tail = tail
            payload.call = pickField('call') || tail
            payload.type = pickField('type')
            payload.desc = pickField('desc')
            payload.ownOp = pickField('ownOp')
          }
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify(payload))
        } catch (err) {
          console.error('[excursions-segments-api] error', err)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
      // GET /api/excursions/boot — Returns tracks with pre-computed bands
      // and per-tail active summaries from Postgres. Optionally joins
      // reports and notifications.
      server.middlewares.use('/api/excursions/boot', async (req, res, next) => {
        console.log('[excursions-boot] hit:', req.method, req.url)
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const hours = Number(u.searchParams.get('hours')) || 1
          const limit = Math.min(500, Number(u.searchParams.get('limit')) || 100)
          const includeSet = new Set(
            (u.searchParams.get('include') || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          )
          const SEV = { yellow: 1, orange: 2, red: 3, purple: 4 }
          const nowMs = Date.now()
          const fromDate = new Date(nowMs - hours * 3600 * 1000).toISOString().slice(0, 10)
          const toDate = new Date(nowMs).toISOString().slice(0, 10)

          // ── Tracks from Postgres (pre-computed by backfill) ──
          const tracksSql = `
            SELECT call, type, desc_text AS desc, own_op AS "ownOp", src,
                   date, base_airport AS base, worst_class AS worst, school,
                   seg_total, seg_red, seg_orange, seg_yellow, seg_purple,
                   len_total_ft, len_red_ft, len_orange_ft, len_yellow_ft, len_purple_ft,
                   bands
            FROM tracks
            WHERE date >= $1 AND date <= $2
              AND worst_class IS NOT NULL
              AND bands IS NOT NULL
            ORDER BY
              CASE WHEN seg_purple > 0 THEN 0
                   WHEN worst_class = 'red' THEN 1
                   WHEN worst_class = 'orange' THEN 2
                   ELSE 3 END,
              rand_key
            LIMIT $3
          `
          const tracksRes = await db.queryDb(tracksSql, [fromDate, toDate, limit])

          // ── Per-tail active summary ──
          const activeSql = `
            SELECT call AS tail, type,
                   MAX(worst_class) AS worst,
                   SUM(seg_yellow)::int AS yellow,
                   SUM(seg_orange)::int AS orange,
                   SUM(seg_red)::int AS red,
                   SUM(seg_purple)::int AS purple,
                   SUM(seg_red + seg_orange + seg_yellow + seg_purple)::int AS points_hit,
                   MAX(date) AS last_date,
                   school, base_airport AS airport
            FROM tracks
            WHERE date >= $1 AND date <= $2
              AND worst_class IS NOT NULL
            GROUP BY call, type, school, base_airport
            ORDER BY
              CASE MAX(worst_class)
                WHEN 'purple' THEN 4 WHEN 'red' THEN 3
                WHEN 'orange' THEN 2 WHEN 'yellow' THEN 1
                ELSE 0 END DESC,
              SUM(seg_red) DESC
          `
          const activeRes = await db.queryDb(activeSql, [fromDate, toDate])
          const active = activeRes.rows.map(r => ({
            tail: r.tail, type: r.type || 'Unknown',
            school: r.school || null, airport: r.airport || null,
            worst: r.worst,
            counts: { yellow: r.yellow, orange: r.orange, red: r.red, purple: r.purple },
            pointsHit: r.points_hit,
            lastDate: r.last_date,
          }))

          // ── Live tracks: classify on the fly into bands ──
          let liveCount = 0, liveUpdatedAt = null
          const liveTracks = []
          try {
            if (!zonesCache) {
              const mod = await import('./src/noiseZones.js')
              zonesCache = mod.NOISE_ZONES
            }
            const { classifyPoint } = await import('./src/geo.js')
            const liveRes = await db.queryDb(
              'SELECT tracks, updated_at FROM live_tracks WHERE day = CURRENT_DATE ORDER BY id DESC LIMIT 1'
            )
            if (liveRes.rows.length) {
              const rawLive = liveRes.rows[0].tracks || []
              liveCount = rawLive.length
              liveUpdatedAt = liveRes.rows[0].updated_at || null
              for (const t of rawLive) {
                const pts = t.points || []
                if (pts.length < 2) continue
                // Build bands by classifying each point
                const bands = []
                let cur = null
                for (const p of pts) {
                  const klass = classifyPoint(p[0], p[1], p[2], zonesCache)
                  if (cur && cur.klass === klass) {
                    cur.points.push([p[0], p[1], p[2]])
                  } else {
                    if (cur) { cur.points.push([p[0], p[1], p[2]]); bands.push(cur) }
                    cur = { klass, points: [[p[0], p[1], p[2]]] }
                  }
                }
                if (cur) bands.push(cur)
                const worst = bands.reduce((w, b) => {
                  if (!b.klass) return w
                  if (!w || (SEV[b.klass] || 0) > (SEV[w] || 0)) return b.klass
                  return w
                }, null)
                liveTracks.push({
                  call: t.call || t.reg || '?',
                  type: t.type || '',
                  src: 'live',
                  date: toDate,
                  base: null,
                  worst,
                  school: null,
                  bands,
                  live: true,
                })
              }
            }
          } catch (e) { console.error('[excursions-boot] live error:', e.message) }

          // ── Opt-in joins: reports, notifications ──
          const windowFromMs = nowMs - hours * 3600 * 1000
          if (includeSet.has('reports')) {
            const complaints = await db.getComplaints(null)
            const byTail = new Map()
            for (const c of complaints || []) {
              const ts = Date.parse(c.createdAt || '')
              if (!Number.isFinite(ts) || ts < windowFromMs || ts > nowMs) continue
              const k = (c.tail || '').toUpperCase()
              if (!k) continue
              let rec = byTail.get(k)
              if (!rec) { rec = { count: 0, scoreMax: null, scoreSum: 0, scoreN: 0 }; byTail.set(k, rec) }
              rec.count++
              if (typeof c.score === 'number') { rec.scoreSum += c.score; rec.scoreN++; if (rec.scoreMax == null || c.score > rec.scoreMax) rec.scoreMax = c.score }
            }
            for (const entry of active) {
              const rec = byTail.get(entry.tail.toUpperCase())
              entry.reportCount = rec ? rec.count : 0
              entry.reportScoreMax = rec?.scoreMax ?? null
              entry.reportScoreAvg = rec && rec.scoreN > 0 ? rec.scoreSum / rec.scoreN : null
            }
          }
          if (includeSet.has('notifications')) {
            const items = await db.getNotifications(null, null)
            const STATUS_RANK = { none: 0, acknowledged: 1, reviewed: 2, completed: 3 }
            const actionToStatus = (action) => {
              if (action === 'acknowledge') return 'acknowledged'
              if (action === 'reviewed_flight' || action === 'reviewed_abatement') return 'reviewed'
              if (action === 'completed_training') return 'completed'
              return 'none'
            }
            const byTail = new Map()
            for (const it of items || []) {
              const ts = Date.parse(it.at || '')
              if (!Number.isFinite(ts) || ts < windowFromMs || ts > nowMs) continue
              const k = (it.tail || '').toUpperCase()
              if (!k) continue
              let rec = byTail.get(k)
              if (!rec) { rec = { operator: null, pilot: null, responses: [] }; byTail.set(k, rec) }
              if (it.kind === 'operator') { if (!rec.operator || ts > Date.parse(rec.operator.at)) rec.operator = it }
              else if (it.kind === 'pilot') { if (!rec.pilot || ts > Date.parse(rec.pilot.at)) rec.pilot = it }
              else if (it.kind === 'pilot-response') rec.responses.push(it)
            }
            for (const entry of active) {
              const rec = byTail.get(entry.tail.toUpperCase())
              if (!rec) {
                entry.operatorNotified = null; entry.pilotNotified = null
                entry.pilotAction = { status: 'none', at: null, steps: { acknowledged: false, flight_reviewed: false, abatement_reviewed: false, completed_training: false } }
                continue
              }
              entry.operatorNotified = rec.operator ? { at: rec.operator.at, via: rec.operator.via || null, contact: rec.operator.contact || null } : null
              entry.pilotNotified = rec.pilot ? { at: rec.pilot.at, via: rec.pilot.via || null, channel: rec.pilot.channel || null } : null
              const steps = { acknowledged: false, flight_reviewed: false, abatement_reviewed: false, completed_training: false }
              let bestStatus = 'none', bestAt = null
              for (const r of rec.responses) {
                if (r.action === 'acknowledge') steps.acknowledged = true
                else if (r.action === 'reviewed_flight') steps.flight_reviewed = true
                else if (r.action === 'reviewed_abatement') steps.abatement_reviewed = true
                else if (r.action === 'completed_training') steps.completed_training = true
                const s = actionToStatus(r.action)
                if (STATUS_RANK[s] >= STATUS_RANK[bestStatus]) { bestStatus = s; bestAt = r.at }
              }
              entry.pilotAction = { status: bestStatus, at: bestAt, steps }
            }
          }

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({
            generated_at: new Date(nowMs).toISOString(),
            window: { hours, from: fromDate, to: toDate, limit },
            include: [...includeSet],
            render: {
              format: 'bands',
              colors: { red: '#dc2626', orange: '#f97316', yellow: '#facc15', purple: '#a855f7' },
              clean_color: '#1a7070',
              weight: 1.5,
              opacity: 0.7,
              blend: 'multiply',
              note: 'Each track.bands[] is an array of {klass, points} runs. Render each run as a Polyline colored by klass (null = clean_color). Points are [lat, lon, alt_ft]. Adjacent runs share their boundary point for continuity.',
            },
            active,
            tracks: [...tracksRes.rows, ...liveTracks],
            live: { updated_at: liveUpdatedAt, tracks: liveCount },
          }))
        } catch (err) {
          console.error('[excursions-boot] error', err)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // GET /api/excursions/active[&hours=48][&include=reports,notifications]
      // Returns all tails with at least one classified point within the
      // window, grouped per-tail (worst class, counts, last date, school/type
      // lookup from flight_schools_fleets.json). Registered BEFORE /api/excursions
      // so connect's prefix matcher routes it correctly.
      //
      // include= opt-in joins. The base call stays cheap — the expensive
      // per-tail lookups only run when explicitly asked for:
      //   include=reports         → reportCount (+ reportScoreMax/Avg) from
      //                             the complaints store, filtered to window
      //   include=notifications   → operatorNotified / pilotNotified /
      //                             pilotAction from the notifications ledger
      server.middlewares.use('/api/excursions/active', async (req, res, next) => {
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
          console.error('[excursions-active-api] error', err)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      server.middlewares.use('/api/excursions', async (req, res, next) => {
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
          const excursions = []
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
                excursions.push(cur); cur = null
              }
            }
            if (cur) excursions.push(cur)
          }
          excursions.sort((a, b) => (a.date || '').localeCompare(b.date || ''))
          // Landing URL — deep link to the NoticePage with tail, timestamp
          // of the worst offense (midnight UTC of that day), and school
          // pre-populated for the compose flow.
          const host = req.headers.host || 'localhost:5174'
          const proto = req.headers['x-forwarded-proto'] || 'http'
          const worstOffense = excursions.length
            ? excursions.reduce((w, o) => (SEV[o.worst] > SEV[w.worst] ? o : w), excursions[0])
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
            total_excursions: excursions.length,
            worst: excursions.length
              ? excursions.reduce((w, o) => (SEV[o.worst] > SEV[w] ? o.worst : w), excursions[0].worst)
              : null,
            excursions,
            landing_url: landing,
            timing_ms: { total: elapsedMs, file_load: loadMs },
          }
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify(payload, null, 2))
        } catch (err) {
          console.error('[excursions-api] error', err)
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
// /api/excursions/segments endpoint merges with historical data. On UTC day
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
            lat: typeof body.lat === 'number' ? body.lat : null,
            lon: typeof body.lon === 'number' ? body.lon : null,
            location: body.location || null,
            precision: body.precision || null,
            mediaKind: body.mediaKind || null,
            score: typeof body.score === 'number' ? body.score : null,
            distanceMiles: typeof body.distanceMiles === 'number' ? body.distanceMiles : null,
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
  // Front Range corridor center — covers KBDU, KLMO, KEIK, KBJC, KAPA, KGXY
  // with a 36 nm radius from the geographic mean of all 6 airports.
  const CENTER = [40.0211, -105.0063]
  const RADIUS_NM = 36
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

      // GET /api/noise/leaderboard?days=90&limit=20&by=tail|base|school
      //
      // Public leaderboard API. Returns top entities ranked by clean flight
      // miles (total miles minus excursion miles) over the last N days.
      //
      // Response shape:
      //   { generated_at, window: {days, from, to}, by, entries: [{
      //       name, flights, total_nm, clean_nm, excursion_nm,
      //       clean_pct, red_pct, orange_pct, yellow_pct
      //   }] }
      server.middlewares.use('/api/noise/leaderboard', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const days = Math.min(3650, Math.max(1, parseInt(u.searchParams.get('days') || '90')))
          const limit = Math.min(100, Math.max(1, parseInt(u.searchParams.get('limit') || '20')))
          const by = u.searchParams.get('by') || 'tail' // tail | base | school

          const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
          const FT_PER_NM = 6076

          let sql, groupLabel
          if (by === 'base') {
            groupLabel = 'base_airport'
            sql = `
              SELECT base_airport AS name,
                     count(*)::int AS flights,
                     round((SUM(len_total_ft) / ${FT_PER_NM})::numeric, 1) AS total_nm,
                     round((SUM(len_total_ft - len_red_ft - len_orange_ft - len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS clean_nm,
                     round((SUM(len_red_ft + len_orange_ft + len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS excursion_nm,
                     round((SUM(len_red_ft) / ${FT_PER_NM})::numeric, 1) AS red_nm,
                     round((SUM(len_orange_ft) / ${FT_PER_NM})::numeric, 1) AS orange_nm,
                     round((SUM(len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS yellow_nm
              FROM tracks
              WHERE date >= $1 AND len_total_ft > 0 AND base_airport IS NOT NULL
              GROUP BY base_airport
              HAVING SUM(len_total_ft) > 0
              ORDER BY SUM(len_total_ft - len_red_ft - len_orange_ft - len_yellow_ft) DESC
              LIMIT $2
            `
          } else if (by === 'school') {
            sql = `
              SELECT school AS name,
                     count(*)::int AS flights,
                     round((SUM(len_total_ft) / ${FT_PER_NM})::numeric, 1) AS total_nm,
                     round((SUM(len_total_ft - len_red_ft - len_orange_ft - len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS clean_nm,
                     round((SUM(len_red_ft + len_orange_ft + len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS excursion_nm,
                     round((SUM(len_red_ft) / ${FT_PER_NM})::numeric, 1) AS red_nm,
                     round((SUM(len_orange_ft) / ${FT_PER_NM})::numeric, 1) AS orange_nm,
                     round((SUM(len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS yellow_nm
              FROM tracks
              WHERE date >= $1 AND len_total_ft > 0 AND school IS NOT NULL
              GROUP BY school
              HAVING SUM(len_total_ft) > 0
              ORDER BY SUM(len_total_ft - len_red_ft - len_orange_ft - len_yellow_ft) DESC
              LIMIT $2
            `
          } else {
            // by tail (default)
            sql = `
              SELECT call AS name, MAX(type) AS type, MAX(school) AS school,
                     MAX(base_airport) AS base, MAX(purpose) AS purpose,
                     count(*)::int AS flights,
                     round((SUM(len_total_ft) / ${FT_PER_NM})::numeric, 1) AS total_nm,
                     round((SUM(len_total_ft - len_red_ft - len_orange_ft - len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS clean_nm,
                     round((SUM(len_red_ft + len_orange_ft + len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS excursion_nm,
                     round((SUM(len_red_ft) / ${FT_PER_NM})::numeric, 1) AS red_nm,
                     round((SUM(len_orange_ft) / ${FT_PER_NM})::numeric, 1) AS orange_nm,
                     round((SUM(len_yellow_ft) / ${FT_PER_NM})::numeric, 1) AS yellow_nm
              FROM tracks
              WHERE date >= $1 AND len_total_ft > 0
              GROUP BY call
              HAVING SUM(len_total_ft) > 0
              ORDER BY SUM(len_total_ft - len_red_ft - len_orange_ft - len_yellow_ft) DESC
              LIMIT $2
            `
          }

          const r = await db.queryDb(sql, [cutoff, limit])
          const entries = r.rows.map(row => ({
            ...row,
            clean_pct: row.total_nm > 0 ? Math.round(row.clean_nm / row.total_nm * 1000) / 10 : 0,
            red_pct: row.total_nm > 0 ? Math.round(row.red_nm / row.total_nm * 1000) / 10 : 0,
            orange_pct: row.total_nm > 0 ? Math.round(row.orange_nm / row.total_nm * 1000) / 10 : 0,
            yellow_pct: row.total_nm > 0 ? Math.round(row.yellow_nm / row.total_nm * 1000) / 10 : 0,
          }))

          const now = new Date()
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Cache-Control', 'public, max-age=300') // 5 min cache
          res.end(JSON.stringify({
            generated_at: now.toISOString(),
            window: { days, from: cutoff, to: now.toISOString().slice(0, 10) },
            by,
            entries,
          }))
        } catch (e) {
          console.error('[noise-api] /leaderboard error', e)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(e) }))
        }
      })

      // GET /api/noise/missions
      // Today's flights from live capture, categorized by purpose.
      // Counts all aircraft seen since midnight UTC, looks up purpose
      // from the tracks table (historical classification) and the
      // special_use + flight_schools data.
      server.middlewares.use('/api/noise/missions', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          // Get today's live tracks
          const liveRes = await db.queryDb(
            'SELECT tracks FROM live_tracks WHERE day = CURRENT_DATE ORDER BY id DESC LIMIT 1'
          )
          if (!liveRes.rows.length || !liveRes.rows[0].tracks) {
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(JSON.stringify({ date: new Date().toISOString().slice(0, 10), total: 0, categories: {} }))
            return
          }

          const liveTracks = liveRes.rows[0].tracks
          const tails = liveTracks.map(t => t.call || t.reg || '').filter(Boolean)

          // Look up purpose for each tail from the historical tracks table
          // (most recent record wins)
          const purposeRes = tails.length ? await db.queryDb(
            `SELECT DISTINCT ON (call) call, purpose, school, type, base_airport
             FROM tracks WHERE call = ANY($1) AND purpose IS NOT NULL
             ORDER BY call, id DESC`,
            [tails]
          ) : { rows: [] }

          const purposeMap = new Map()
          for (const r of purposeRes.rows) {
            purposeMap.set(r.call, { purpose: r.purpose, school: r.school, type: r.type, base: r.base_airport })
          }

          // Categorize
          const categories = {}
          for (const t of liveTracks) {
            const tail = t.call || t.reg || ''
            const info = purposeMap.get(tail)
            const purpose = info?.purpose || 'unknown'
            if (!categories[purpose]) categories[purpose] = { count: 0, aircraft: [] }
            categories[purpose].count++
            categories[purpose].aircraft.push({
              tail,
              type: t.type || info?.type || '',
              school: info?.school || null,
              base: info?.base || null,
              points: t.points?.length || 0,
            })
          }

          // Remove empty categories and sort by count desc
          const sorted = Object.entries(categories)
            .filter(([, v]) => v.count > 0)
            .sort((a, b) => b[1].count - a[1].count)
          const result = {}
          for (const [k, v] of sorted) result[k] = v

          const now = new Date()
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Cache-Control', 'public, max-age=60')
          res.end(JSON.stringify({
            date: now.toISOString().slice(0, 10),
            updated_at: now.toISOString(),
            total: liveTracks.length,
            categories: result,
          }))
        } catch (e) {
          console.error('[noise-api] /missions error', e)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
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
                   SUM(seg_purple)::int AS purple,
                   SUM(len_total_ft)::real AS total_ft, SUM(len_red_ft)::real AS red_ft,
                   SUM(len_orange_ft)::real AS orange_ft, SUM(len_yellow_ft)::real AS yellow_ft,
                   SUM(len_purple_ft)::real AS purple_ft,
                   MAX(CASE worst_class WHEN 'purple' THEN 4 WHEN 'red' THEN 3 WHEN 'orange' THEN 2 WHEN 'yellow' THEN 1 ELSE 0 END) AS worst_rank,
                   COUNT(*)::int AS track_count
            FROM tracks
            WHERE ${where}
            GROUP BY call, type, desc_text, school, base_airport, purpose
            HAVING SUM(seg_total) > 0
            ORDER BY SUM(seg_red)::float / NULLIF(SUM(seg_total), 0) DESC
            LIMIT 200
          `
          const tailRes = await db.queryDb(tailSql, params)
          const worstMap = { 4: 'purple', 3: 'red', 2: 'orange', 1: 'yellow' }
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
                   SUM(len_red_ft)::real AS red_ft,
                   SUM(len_purple_ft)::real AS purple_ft
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
            purpleFt: r.purple_ft,
            yellowPct: r.total_ft > 0 ? r.yellow_ft / r.total_ft * 100 : 0,
            orangePct: r.total_ft > 0 ? r.orange_ft / r.total_ft * 100 : 0,
            redPct: r.total_ft > 0 ? r.red_ft / r.total_ft * 100 : 0,
            purplePct: r.total_ft > 0 ? r.purple_ft / r.total_ft * 100 : 0,
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

      // GET /api/noise/tracks?year=X&base=X&school=X&violations_only=1&tng_only=1&limit=500&offset=0
      // Returns pre-banded tracks for map rendering. Each track includes
      // bands (colored polyline segments) — the client just renders them.
      // Payload: ~200-500KB for 500 tracks vs 60MB for all.
      server.middlewares.use('/api/noise/tracks', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const violationsOnly = u.searchParams.get('violations_only') === '1'
          const tngOnly = u.searchParams.get('tng_only') === '1'
          const limit = Math.min(2000, Math.max(1, parseInt(u.searchParams.get('limit') || '500')))
          const offset = Math.max(0, parseInt(u.searchParams.get('offset') || '0'))

          const { where: baseWhere, params } = buildFilters(u, ['bands IS NOT NULL'])
          const extraConds = []
          if (tngOnly) extraConds.push('seg_purple > 0')
          else if (violationsOnly) extraConds.push('worst_class IS NOT NULL')
          const where = extraConds.length ? `${baseWhere} AND ${extraConds.join(' AND ')}` : baseWhere

          // Count total matching
          const countRes = await db.queryDb(`SELECT count(*)::int AS n FROM tracks WHERE ${where}`, params)
          const total = countRes.rows[0].n

          // Prioritize purple (rare) and red tracks, then fill with random.
          // This ensures quiet-hour T&G violations always appear on the map.
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
            ORDER BY
              ${violationsOnly ? `CASE WHEN seg_purple > 0 THEN 0
                   WHEN worst_class = 'red' THEN 1
                   WHEN worst_class = 'orange' THEN 2
                   ELSE 3 END,` : ''}
              rand_key
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
  const DATA_DIR = 'C:\\tmp\\noise_data'
  return {
    name: 'external-data',
    configureServer(server) {
      let fsModule = null
      server.middlewares.use(async (req, res, next) => {
        const m = req.url.match(/^\/(tracks_\d{4}\.json)$/)
        if (!m) return next()
        if (!fsModule) fsModule = (await import('fs')).default
        const filePath = DATA_DIR + '\\' + m[1]
        try {
          const stat = fsModule.statSync(filePath)
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Content-Length', stat.size)
          fsModule.createReadStream(filePath).pipe(res)
        } catch (e) {
          res.statusCode = 404
          res.end('{"tracks":[]}')
        }
      })
    },
  }
}

// GET /api/live/positions — lightweight current positions for all live aircraft.
// Returns just the last point per track with computed heading. 5s cache via loadLive.
function livePositionsPlugin() {
  const loadLive = async (fs, path) => {
    if (db.useDb) return db.loadLiveFromDb()
    try {
      const buf = await fs.readFile(path.resolve('public/tracks_live.json'), 'utf8')
      return JSON.parse(buf)
    } catch { return { tracks: [], updated_at: null } }
  }
  const bearing = (lat1, lon1, lat2, lon2) => {
    const toRad = (d) => d * Math.PI / 180
    const toDeg = (r) => r * 180 / Math.PI
    const dLon = toRad(lon2 - lon1)
    const y = Math.sin(dLon) * Math.cos(toRad(lat2))
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
              Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon)
    return (toDeg(Math.atan2(y, x)) + 360) % 360
  }
  return {
    name: 'live-positions',
    configureServer(server) {
      server.middlewares.use('/api/live/positions', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const { default: fs } = await import('fs/promises')
          const { default: path } = await import('path')
          const live = await loadLive(fs, path)
          const positions = []
          for (const t of live.tracks || []) {
            if (!t.points?.length) continue
            const last = t.points[t.points.length - 1]
            let hdg = null
            if (t.points.length >= 2) {
              const prev = t.points[t.points.length - 2]
              hdg = Math.round(bearing(prev[0], prev[1], last[0], last[1]))
            }
            positions.push({
              tail: t.call || t.hex,
              hex: t.hex,
              type: t.type || '',
              lat: last[0],
              lon: last[1],
              alt: last[2] || null,
              track: hdg,
              updated: last[3] || null,
            })
          }
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ at: live.updated_at, count: positions.length, positions }))
        } catch (err) {
          console.error('[live-positions] error', err)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}

// ── ADS-B API ──────────────────────────────────────────────────────────
// Endpoints: /api/adsb/live, /api/adsb/track/:icao, /api/adsb/flights,
// /api/adsb/flights/:id/track, /api/adsb/stats, /api/adsb/active-tow,
// /api/adsb/config/fleet, /api/adsb/config/zones, WS /api/adsb/stream
function adsbApiPlugin() {
  // Cache extracted flights so we don't re-process on every request
  let flightsCache = { ts: 0, flights: [], byId: new Map() }
  const FLIGHTS_TTL = 10_000

  const loadLive = async () => {
    if (db.useDb) return db.loadLiveFromDb()
    const fs = await import('fs/promises')
    const path = await import('path')
    try {
      const buf = await fs.default.readFile(path.default.resolve('public/tracks_live.json'), 'utf8')
      return JSON.parse(buf)
    } catch { return { tracks: [], updated_at: null } }
  }

  const buildFlights = async (zoneConfig, fleet, filterTail, filterFrom, filterTo) => {
    const now = Date.now()
    if (now - flightsCache.ts < FLIGHTS_TTL && !filterTail && !filterFrom) {
      return flightsCache
    }

    const live = await loadLive()
    const allFlights = []
    const byId = new Map()

    for (const t of live.tracks || []) {
      const hex = t.hex || ''
      const tail = t.call || hex
      const fleetEntry = fleet[hex]

      // Only process fleet aircraft, or filter by tail
      if (filterTail && tail !== filterTail && hex !== filterTail) continue
      if (!filterTail && !fleetEntry) continue

      if (!t.points?.length) continue
      const cycles = adsb.extractTowCycles(hex, tail, t.points, zoneConfig)
      for (const f of cycles) {
        if (fleetEntry) {
          f.operator = fleetEntry.operator
          f.role = fleetEntry.role
        }
        // Date filtering
        if (filterFrom && f.date && f.date < filterFrom) continue
        if (filterTo && f.date && f.date > filterTo) continue
        allFlights.push(f)
        byId.set(f.id, { flight: f, points: t.points })
      }
    }

    const cache = { ts: now, flights: allFlights, byId }
    if (!filterTail && !filterFrom) flightsCache = cache
    return cache
  }

  // WebSocket clients for /api/adsb/stream
  const wsClients = new Set()
  let wsBroadcastTimer = null

  return {
    name: 'adsb-api',
    async configureServer(server) {
      // ── GET /api/adsb/live ──────────────────────────────────────────
      server.middlewares.use('/api/adsb/live', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const icaoFilter = u.searchParams.get('icao')
          const filterSet = icaoFilter ? new Set(icaoFilter.split(',').map(s => s.trim().toLowerCase())) : null

          const fleet = await adsb.loadFleet()
          const live = await loadLive()
          const aircraft = []

          for (const t of live.tracks || []) {
            const hex = (t.hex || '').toLowerCase()
            if (filterSet && !filterSet.has(hex)) continue

            if (!t.points?.length) continue
            const last = t.points[t.points.length - 1]
            const fleetEntry = fleet[hex]

            // Compute groundspeed from last two points
            let gs = null, track_deg = null, vs = null
            if (t.points.length >= 2) {
              const prev = t.points[t.points.length - 2]
              const dtSec = ((last[3] || 0) - (prev[3] || 0)) / 1000
              if (dtSec > 0) {
                const cos = Math.cos(((prev[0] + last[0]) / 2) * Math.PI / 180)
                const dx = (last[1] - prev[1]) * 364560 * cos
                const dy = (last[0] - prev[0]) * 364560
                const dFt = Math.hypot(dx, dy)
                gs = Math.round((dFt / 6076.12) / (dtSec / 3600))
                track_deg = Math.round((Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360)
                if (prev[2] != null && last[2] != null) {
                  vs = Math.round((last[2] - prev[2]) / (dtSec / 60))
                }
              }
            }

            const lastSeenS = last[3] ? Math.round((Date.now() - last[3]) / 1000) : null

            aircraft.push({
              icao: hex,
              tail: fleetEntry?.tail || t.call || hex,
              lat: last[0],
              lon: last[1],
              alt_ft: last[2] || null,
              gs_kts: gs,
              track_deg,
              vs_fpm: vs,
              squawk: null, // not in our data yet
              last_seen_s: lastSeenS,
            })
          }

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ aircraft }))
        } catch (err) {
          console.error('[adsb/live] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // ── GET /api/adsb/track/:icao ──────────────────────────────────
      server.middlewares.use('/api/adsb/track/', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          // Extract icao from path: /api/adsb/track/a59663 → url is /a59663
          const icao = u.pathname.replace(/^\//, '').toLowerCase()
          if (!icao) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'icao required' }))
            return
          }

          const sinceParam = u.searchParams.get('since')
          const since = sinceParam ? new Date(sinceParam).getTime() : Date.now() - 4 * 3600 * 1000

          const fleet = await adsb.loadFleet()
          const zoneConfig = await adsb.loadZones()
          const live = await loadLive()

          let track = null
          for (const t of live.tracks || []) {
            if ((t.hex || '').toLowerCase() === icao) {
              track = t
              break
            }
          }

          if (!track) {
            res.statusCode = 404
            res.end(JSON.stringify({ error: 'icao not found' }))
            return
          }

          // Filter points by since timestamp
          const filtered = (track.points || []).filter(p =>
            !p[3] || p[3] >= since
          )

          const phases = adsb.detectPhases(filtered, zoneConfig)
          const tail = fleet[icao]?.tail || track.call || icao

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({
            icao,
            tail,
            points: filtered.map(p => ({
              ts: p[3] ? new Date(p[3]).toISOString() : null,
              lat: p[0], lon: p[1], alt: p[2],
              gs: null, vs: null,
            })),
            phases: phases.map(p => ({
              type: p.type,
              start_ts: p.start_ts ? new Date(p.start_ts).toISOString() : null,
              end_ts: p.end_ts ? new Date(p.end_ts).toISOString() : null,
              alt_start: p.alt_start,
              alt_end: p.alt_end,
            })),
          }))
        } catch (err) {
          console.error('[adsb/track] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // ── GET /api/adsb/flights/:id/track (must register BEFORE /api/adsb/flights)
      server.middlewares.use('/api/adsb/flights/', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
        const pathParts = u.pathname.replace(/^\//, '').split('/')

        // /api/adsb/flights/:id/track → pathParts = [":id", "track"]
        if (pathParts.length === 2 && pathParts[1] === 'track') {
          try {
            const flightId = pathParts[0]
            const fleet = await adsb.loadFleet()
            const zoneConfig = await adsb.loadZones()
            const { byId } = await buildFlights(zoneConfig, fleet)

            const entry = byId.get(flightId)
            if (!entry) {
              res.statusCode = 404
              res.end(JSON.stringify({ error: 'flight not found' }))
              return
            }

            const { flight, points } = entry
            const startIdx = flight._startIdx || 0
            const endIdx = flight._endIdx || points.length - 1
            const slice = points.slice(startIdx, endIdx + 1)

            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(JSON.stringify({
              id: flight.id,
              icao: flight.icao,
              tail: flight.tail,
              points: slice.map(p => ({
                ts: p[3] ? new Date(p[3]).toISOString() : null,
                lat: p[0], lon: p[1], alt: p[2],
              })),
            }))
          } catch (err) {
            console.error('[adsb/flights/track] error', err)
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(err) }))
          }
          return
        }

        // Fall through to /api/adsb/flights list handler
        return next()
      })

      // ── GET /api/adsb/flights ──────────────────────────────────────
      server.middlewares.use('/api/adsb/flights', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const tail = u.searchParams.get('tail')
          const from = u.searchParams.get('from')
          const to = u.searchParams.get('to')

          const fleet = await adsb.loadFleet()
          const zoneConfig = await adsb.loadZones()
          const { flights } = await buildFlights(zoneConfig, fleet, tail, from, to)

          // Strip internal fields
          const clean = flights.map(({ _startIdx, _endIdx, ...rest }) => rest)

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ flights: clean }))
        } catch (err) {
          console.error('[adsb/flights] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // ── GET /api/adsb/stats ────────────────────────────────────────
      server.middlewares.use('/api/adsb/stats', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const tail = u.searchParams.get('tail')
          const from = u.searchParams.get('from')
          const to = u.searchParams.get('to')
          const groupBy = u.searchParams.get('group_by') || 'all'

          const fleet = await adsb.loadFleet()
          const zoneConfig = await adsb.loadZones()
          const { flights } = await buildFlights(zoneConfig, fleet, tail, from, to)
          const groups = adsb.aggregateStats(flights, groupBy)

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ groups }))
        } catch (err) {
          console.error('[adsb/stats] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // ── GET /api/adsb/active-tow ───────────────────────────────────
      server.middlewares.use('/api/adsb/active-tow', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const fleet = await adsb.loadFleet()
          const zoneConfig = await adsb.loadZones()
          const live = await loadLive()

          // Pair tow planes with gliders via ADS-B proximity
          const gliderPairs = adsb.pairTowWithGliders(live.tracks || [], fleet, zoneConfig)

          const towPlanes = []
          for (const t of live.tracks || []) {
            const hex = (t.hex || '').toLowerCase()
            const entry = fleet[hex]
            if (!entry || entry.role !== 'tow') continue
            if (!t.points?.length) continue

            const state = adsb.currentPhase(t.points, zoneConfig)
            if (!state) continue

            const eta = adsb.predictEta(
              state.phase, state.current_alt_ft || 0, state.climb_rate_fpm || 0, zoneConfig
            )

            // Find current cycle start
            const phases = adsb.detectPhases(t.points, zoneConfig)
            let cycleStart = null
            for (let i = phases.length - 1; i >= 0; i--) {
              if (phases[i].type === 'on_ground' || phases[i].type === 'taxiing') {
                cycleStart = phases[i].end_ts ? new Date(phases[i].end_ts).toISOString() : null
                break
              }
            }

            const pair = gliderPairs.get(hex)
            towPlanes.push({
              tail: entry.tail,
              icao: hex,
              phase: state.phase,
              current_alt_ft: state.current_alt_ft,
              climb_rate_fpm: state.climb_rate_fpm,
              est_release_ts: eta.est_release_s != null
                ? new Date(Date.now() + eta.est_release_s * 1000).toISOString()
                : null,
              est_available_ts: eta.est_available_s != null
                ? new Date(Date.now() + eta.est_available_s * 1000).toISOString()
                : null,
              current_cycle_start_ts: cycleStart,
              paired_glider_tail: pair?.glider_tail || null,
              paired_glider_icao: pair?.glider_hex || null,
            })
          }

          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ tow_planes: towPlanes }))
        } catch (err) {
          console.error('[adsb/active-tow] error', err)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })

      // ── GET/PUT /api/adsb/config/fleet ─────────────────────────────
      server.middlewares.use('/api/adsb/config/fleet', async (req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }

        if (req.method === 'GET') {
          const fleet = await adsb.loadFleet()
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(fleet))
          return
        }
        if (req.method === 'PUT') {
          try {
            const body = await readJsonBody(req)
            await adsb.saveFleet(body)
            flightsCache = { ts: 0, flights: [], byId: new Map() }
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true }))
          } catch (err) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: String(err) }))
          }
          return
        }
        next()
      })

      // ── GET/PUT /api/adsb/config/zones ─────────────────────────────
      server.middlewares.use('/api/adsb/config/zones', async (req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }

        if (req.method === 'GET') {
          const zones = await adsb.loadZones()
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(zones))
          return
        }
        if (req.method === 'PUT') {
          try {
            const body = await readJsonBody(req)
            await adsb.saveZones(body)
            flightsCache = { ts: 0, flights: [], byId: new Map() }
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true }))
          } catch (err) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: String(err) }))
          }
          return
        }
        next()
      })

      // ── WebSocket /api/adsb/stream ─────────────────────────────────
      // Piggybacks on the Vite HMR WebSocket server. Clients connect to
      // ws://host:port/api/adsb/stream and receive JSON messages.
      if (server.httpServer) {
        const { WebSocketServer } = await import('ws')
        const wss = new WebSocketServer({ noServer: true })

        server.httpServer.on('upgrade', (req, socket, head) => {
          if (req.url === '/api/adsb/stream') {
            wss.handleUpgrade(req, socket, head, (ws) => {
              wsClients.add(ws)
              ws.on('close', () => wsClients.delete(ws))
              ws.on('error', () => wsClients.delete(ws))
            })
          }
          // Let other upgrade requests (Vite HMR) pass through
        })

        // Broadcast position updates every 2s
        const broadcast = async () => {
          if (wsClients.size === 0) return
          try {
            const fleet = await adsb.loadFleet()
            const zoneConfig = await adsb.loadZones()
            const live = await loadLive()

            for (const t of live.tracks || []) {
              const hex = (t.hex || '').toLowerCase()
              const entry = fleet[hex]
              if (!entry) continue
              if (!t.points?.length) continue

              const last = t.points[t.points.length - 1]
              const state = adsb.currentPhase(t.points, zoneConfig)

              const msg = JSON.stringify({
                type: 'position',
                icao: hex,
                tail: entry.tail,
                lat: last[0],
                lon: last[1],
                alt: last[2] || null,
                vs: state?.climb_rate_fpm || null,
                gs: null,
              })

              for (const ws of wsClients) {
                try { ws.send(msg) } catch {}
              }
            }
          } catch (err) {
            console.error('[adsb/stream] broadcast error', err)
          }
        }

        if (wsBroadcastTimer) clearInterval(wsBroadcastTimer)
        wsBroadcastTimer = setInterval(broadcast, 2000)
        server.httpServer.on('close', () => {
          if (wsBroadcastTimer) { clearInterval(wsBroadcastTimer); wsBroadcastTimer = null }
          for (const ws of wsClients) try { ws.close() } catch {}
          wsClients.clear()
        })
        console.log('[adsb-api] WebSocket stream registered at /api/adsb/stream')
      }

      console.log('[adsb-api] endpoints registered: /api/adsb/{live,track,flights,stats,active-tow,config/*,stream}')
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
    excursionsApiPlugin(),
    complaintsApiPlugin(),
    noiseReportsApiPlugin(),
    pilotApiPlugin(),
    !db.useDb && liveCapturePlugin(),
    livePositionsPlugin(),
    adsbApiPlugin(),
    // On Railway, strip the @vite/client HMR script from HTML to prevent
    // reload loops (the dev server WebSocket is unreachable via the proxy).
    process.env.RAILWAY_ENVIRONMENT && {
      name: 'strip-hmr-client',
      transformIndexHtml(html) {
        return html.replace(/<script[^>]*\/@vite\/client[^>]*><\/script>\s*/g, '')
      },
    },
  ].filter(Boolean),
  server: {
    port: parseInt(process.env.PORT || '5174'),
    allowedHosts: true,
    open: process.env.RAILWAY_ENVIRONMENT ? false : '/',
    // Disable HMR + warm-up on Railway — the WebSocket URL doesn't match
    // the public domain, causing connect → fail → reload loops.
    hmr: process.env.RAILWAY_ENVIRONMENT ? false : undefined,
    warmup: process.env.RAILWAY_ENVIRONMENT ? { clientFiles: [] } : undefined,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    },
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
