// apiPlugin.js — Vite middleware exposing phaseML over HTTP.
//
// Drop into vite.config.js plugins array:
//
//   import { phaseMLApiPlugin } from './phaseML/apiPlugin.js'
//   ...
//   plugins: [
//     react(),
//     phaseMLApiPlugin(),
//     // …
//   ]
//
// Endpoints (all JSON, all CORS-open):
//
//   POST /api/phase-ml/classify
//     body: {
//       points: [{lat, lon, altMslFt, tsUnix}, ...]      // required
//       typeCode?: string                                 // ICAO type, helps slow_flight / thermalling
//       intentWindowS?: number                            // default 180
//       priorByAirport?: { ICAO: number }                 // optional Bayesian prior
//     }
//     returns: {
//       phases: { phase, airport, distNm, aglFt, trackOffDeg }[]   // one per sample
//       maneuvers: Detection[]                             // see maneuvers.js
//       intent: { top, runnerUp, confidenceGap, allScores } | null
//     }
//
//   POST /api/phase-ml/classify-archive
//     body: {
//       points: [[lat, lon, altMslFt, secsSinceT0], ...]
//       t0Seconds: number       // archive t0 (seconds since epoch)
//       typeCode?: string
//     }
//     Same response as /classify — convenience for the archive format.
//
//   GET  /api/phase-ml/airports
//     returns: { airports: [{icao, name, lat, lon, fieldElevFt, tpaMslFt, runways}] }
//
//   GET  /api/phase-ml/health
//     returns: { ok: true, version: "0.1.0" }
//
// The classifier is pure and stateless — no caches, no DB. Latency on a
// 3-min window is sub-millisecond.

import { allAirports } from './airports.js'
import {
  classifyOneTrack,
  inputToPoints,
} from './service.js'

const VERSION = '0.1.0'

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

export function phaseMLApiPlugin() {
  return {
    name: 'phase-ml-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/phase-ml/')) return next()
        if (req.method === 'OPTIONS') { cors(res); res.statusCode = 204; res.end(); return }

        try {
          if (req.url === '/api/phase-ml/health' && req.method === 'GET') {
            return send(res, 200, { ok: true, version: VERSION })
          }
          if (req.url === '/api/phase-ml/airports' && req.method === 'GET') {
            return send(res, 200, {
              airports: allAirports().map(a => ({
                icao: a.icao, name: a.name, lat: a.lat, lon: a.lon,
                fieldElevFt: a.fieldElevFt, tpaMslFt: a.tpaMslFt,
                runways: a.runways.map(r => ({
                  name: r.name, headingDeg: r.headingDeg,
                  thresholdLat: r.thresholdLat, thresholdLon: r.thresholdLon,
                  lengthFt: r.lengthFt, pattern: r.pattern,
                })),
              })),
            })
          }
          if (req.url === '/api/phase-ml/classify' && req.method === 'POST') {
            const body = await readJson(req)
            const points = inputToPoints(body.points, { archive: false })
            if (!points || points.length < 2) {
              return send(res, 400, { error: 'need at least 2 points' })
            }
            return send(res, 200, classifyOneTrack(points, {
              typeCode: body.typeCode || '',
              intentWindowS: body.intentWindowS || 180,
              priorByAirport: body.priorByAirport || null,
            }))
          }
          if (req.url === '/api/phase-ml/classify-archive' && req.method === 'POST') {
            const body = await readJson(req)
            const t0 = Number(body.t0Seconds)
            if (!Number.isFinite(t0)) return send(res, 400, { error: 'need t0Seconds (epoch seconds)' })
            const points = inputToPoints(body.points, { archive: true, t0Seconds: t0 })
            if (!points || points.length < 2) {
              return send(res, 400, { error: 'need at least 2 points' })
            }
            return send(res, 200, classifyOneTrack(points, {
              typeCode: body.typeCode || '',
              intentWindowS: body.intentWindowS || 180,
              priorByAirport: body.priorByAirport || null,
            }))
          }
          return next()
        } catch (err) {
          return send(res, 500, { error: String((err && err.message) || err) })
        }
      })
    },
  }
}
