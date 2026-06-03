// apiPlugin.js — Vite middleware exposing purposeML over HTTP.
//
// Wired into vite.config.js (optional load — failures don't break the
// build). See ADOPTING_PURPOSE_ML_API.md for full endpoint contract.

import { extractFeatures } from './features.js'
import { classifyOneTrack, inputToPoints, inputToPointsWithStats } from './service.js'

const VERSION = '0.2.0'

const BUCKETS = [
  'glider_local', 'glider_xc', 'tow_plane',
  'training', 'pattern_solo',
  'survey', 'patrol',
  'airline', 'biz_jet', 'turboprop',
  'ga_xc', 'ga_local', 'helicopter',
  'unknown',
]

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      if (!data) return resolve({})
      try { resolve(JSON.parse(data)) }
      catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function send(res, status, body) {
  cors(res)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

export function purposeMLApiPlugin() {
  return {
    name: 'purpose-ml-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/purpose-ml/')) return next()
        if (req.method === 'OPTIONS') { cors(res); res.statusCode = 204; res.end(); return }

        try {
          if (req.url === '/api/purpose-ml/health' && req.method === 'GET') {
            return send(res, 200, { ok: true, version: VERSION })
          }
          if (req.url === '/api/purpose-ml/buckets' && req.method === 'GET') {
            return send(res, 200, { buckets: BUCKETS })
          }
          if (req.url === '/api/purpose-ml/classify' && req.method === 'POST') {
            const body = await readJson(req)
            const stats = inputToPointsWithStats(body.points, { archive: false })
            if (stats.points.length < 2) {
              return send(res, 400, { error: 'need at least 2 points after quality/sanity filtering', input_filter: stats.dropped })
            }
            const result = classifyOneTrack(stats.points, {
              typeCode: body.typeCode || '',
              tail: body.tail || '',
              isSchoolFleet: !!body.isSchoolFleet,
              includeFeatures: !!body.includeFeatures,
            })
            result.input_filter = { kept: stats.points.length, dropped: stats.dropped }
            return send(res, 200, result)
          }
          if (req.url === '/api/purpose-ml/classify-archive' && req.method === 'POST') {
            const body = await readJson(req)
            const t0 = Number(body.t0Seconds)
            if (!Number.isFinite(t0)) return send(res, 400, { error: 'need t0Seconds (epoch seconds)' })
            const stats = inputToPointsWithStats(body.points, { archive: true, t0Seconds: t0 })
            if (stats.points.length < 2) {
              return send(res, 400, { error: 'need at least 2 points after quality/sanity filtering', input_filter: stats.dropped })
            }
            const result = classifyOneTrack(stats.points, {
              typeCode: body.typeCode || '',
              tail: body.tail || '',
              isSchoolFleet: !!body.isSchoolFleet,
              includeFeatures: !!body.includeFeatures,
            })
            result.input_filter = { kept: stats.points.length, dropped: stats.dropped }
            return send(res, 200, result)
          }
          if (req.url === '/api/purpose-ml/extract' && req.method === 'POST') {
            const body = await readJson(req)
            const points = inputToPoints(body.points, { archive: false })
            if (!points || points.length < 2) {
              return send(res, 400, { error: 'need at least 2 points' })
            }
            return send(res, 200, { features: extractFeatures(points, { typeCode: body.typeCode || '' }) })
          }
          return next()
        } catch (err) {
          return send(res, 500, { error: String((err && err.message) || err) })
        }
      })
    },
  }
}
