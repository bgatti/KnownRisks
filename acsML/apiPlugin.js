// apiPlugin.js — Vite middleware exposing acsML over HTTP.
//
// Endpoints (all JSON, all CORS-open):
//
//   GET  /api/acs-ml/health
//     → { ok: true, version }
//
//   GET  /api/acs-ml/standards
//     → { private_pilot_acs: {...}, far_currency: {...} }
//
//   POST /api/acs-ml/identify
//     body: { points, typeCode?, tail? }
//     → identifyOneTrack output (tasks_demonstrated, currency_events,
//        phase_summary, notes)
//
//   POST /api/acs-ml/identify-archive
//     body: { points (4-tuples), t0Seconds, typeCode?, tail? }
//     → same shape

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { identifyOneTrack, inputToPoints, inputToPointsWithStats } from './service.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VERSION = '0.1.0'

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => { data += c })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}
function send(res, status, body) {
  cors(res); res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

let STANDARDS = null
function loadStandards() {
  if (STANDARDS) return STANDARDS
  STANDARDS = {
    private_pilot_acs: JSON.parse(fs.readFileSync(path.join(__dirname, 'standards/private_pilot_acs.json'), 'utf8')),
    far_currency: JSON.parse(fs.readFileSync(path.join(__dirname, 'standards/far_currency.json'), 'utf8')),
  }
  return STANDARDS
}

export function acsMLApiPlugin() {
  return {
    name: 'acs-ml-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/acs-ml/')) return next()
        if (req.method === 'OPTIONS') { cors(res); res.statusCode = 204; res.end(); return }
        try {
          if (req.url === '/api/acs-ml/health' && req.method === 'GET') {
            return send(res, 200, { ok: true, version: VERSION })
          }
          if (req.url === '/api/acs-ml/standards' && req.method === 'GET') {
            return send(res, 200, loadStandards())
          }
          if (req.url === '/api/acs-ml/identify' && req.method === 'POST') {
            const body = await readJson(req)
            const stats = inputToPointsWithStats(body.points, { archive: false })
            if (stats.points.length < 2) {
              return send(res, 400, { error: 'need at least 2 points after quality/sanity filtering', input_filter: stats.dropped })
            }
            const result = identifyOneTrack(stats.points, {
              typeCode: body.typeCode || '', tail: body.tail || '',
            })
            result.input_filter = { kept: stats.points.length, dropped: stats.dropped }
            return send(res, 200, result)
          }
          if (req.url === '/api/acs-ml/identify-archive' && req.method === 'POST') {
            const body = await readJson(req)
            const t0 = Number(body.t0Seconds)
            if (!Number.isFinite(t0)) return send(res, 400, { error: 'need t0Seconds' })
            const stats = inputToPointsWithStats(body.points, { archive: true, t0Seconds: t0 })
            if (stats.points.length < 2) {
              return send(res, 400, { error: 'need at least 2 points after quality/sanity filtering', input_filter: stats.dropped })
            }
            const result = identifyOneTrack(stats.points, {
              typeCode: body.typeCode || '', tail: body.tail || '',
            })
            result.input_filter = { kept: stats.points.length, dropped: stats.dropped }
            return send(res, 200, result)
          }
          return next()
        } catch (err) {
          return send(res, 500, { error: String((err && err.message) || err) })
        }
      })
    },
  }
}
