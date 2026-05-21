// noiseReports.test.js — End-to-end tests for noise report persistence,
// per-reporter retrieval, and audio attachment round-trip.
//
// All tests require a running server. By default hits production; override
// with NOISE_BASE for local dev:
//
//   npx vitest run noiseReports.test.js
//   NOISE_BASE=http://localhost:5174 npx vitest run noiseReports.test.js

import { describe, it, expect, beforeAll } from 'vitest'

const BASE = process.env.NOISE_BASE || 'https://web-app-production-fedf.up.railway.app'

// Unique reporter per test run so we don't accumulate noise in the DB.
const REPORTER = `vitest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`

async function postReport(body) {
  const res = await fetch(`${BASE}/api/noise-reports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(201)
  return res.json()
}

async function listReports(reporter) {
  const params = new URLSearchParams()
  if (reporter) params.set('reporter', reporter)
  const res = await fetch(`${BASE}/api/noise-reports?${params}`)
  expect(res.status).toBe(200)
  return res.json()
}

// Minimal valid MP3-shaped payload (ID3 header + zeros). Server doesn't
// validate the actual codec — just the Content-Type.
function fakeMp3(extraBytes = 22) {
  const header = Buffer.from([0x49, 0x44, 0x33, 0x03, 0, 0, 0, 0, 0, 0])
  const body = Buffer.alloc(extraBytes, 0)
  return Buffer.concat([header, body])
}

describe('noise reports — persistence + per-reporter retrieval', () => {
  let id1, id2

  it('POST creates a report and returns id + receivedAt', async () => {
    const r = await postReport({
      reporter: REPORTER,
      score: 7,
      location: { lat: 40.04, lng: -105.22 },
      note: 'first report',
    })
    expect(r.id).toMatch(/^nr-/)
    expect(r.receivedAt).toMatch(/\d{4}-\d{2}-\d{2}T/)
    id1 = r.id
  })

  it('POST a second report under the same reporter', async () => {
    const r = await postReport({
      reporter: REPORTER,
      score: 3,
      location: { lat: 40.05, lng: -105.21 },
      note: 'second report',
    })
    expect(r.id).toMatch(/^nr-/)
    expect(r.id).not.toBe(id1)
    id2 = r.id
  })

  it('GET ?reporter= returns only that reporter\'s reports', async () => {
    const data = await listReports(REPORTER)
    const ids = data.reports.map(r => r.id)
    expect(ids).toContain(id1)
    expect(ids).toContain(id2)
    // All returned reports should belong to our reporter
    for (const r of data.reports) {
      const rep = typeof r.reporter === 'string' ? r.reporter : r.reporter?.email
      expect(rep).toBe(REPORTER)
    }
  })

  it('persisted reports preserve their submitted fields', async () => {
    const data = await listReports(REPORTER)
    const r1 = data.reports.find(r => r.id === id1)
    const r2 = data.reports.find(r => r.id === id2)
    expect(r1.note).toBe('first report')
    expect(r1.score).toBe(7)
    expect(r1.location).toEqual({ lat: 40.04, lng: -105.22 })
    expect(r2.note).toBe('second report')
    expect(r2.score).toBe(3)
  })

  it('GET ?reporter=<other> excludes our reports', async () => {
    const otherReporter = `vitest-other-${Date.now()}@example.invalid`
    const data = await listReports(otherReporter)
    const ids = data.reports.map(r => r.id)
    expect(ids).not.toContain(id1)
    expect(ids).not.toContain(id2)
  })
})

describe('noise reports — audio attachments', () => {
  let reportId

  beforeAll(async () => {
    const r = await postReport({
      reporter: REPORTER,
      score: 5,
      note: 'audio test report',
    })
    reportId = r.id
  })

  it('POST audio returns 201 with byte count', async () => {
    const buf = fakeMp3()
    const res = await fetch(`${BASE}/api/noise-reports/${reportId}/audio/spliced10s`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: buf,
    })
    expect(res.status).toBe(201)
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.slot).toBe('spliced10s')
    expect(j.bytes).toBe(buf.length)
  })

  it('GET audio returns the same bytes back', async () => {
    const buf = fakeMp3()
    const res = await fetch(`${BASE}/api/noise-reports/${reportId}/audio/spliced10s`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    const got = Buffer.from(await res.arrayBuffer())
    expect(got.equals(buf)).toBe(true)
  })

  it('supports a second slot independently', async () => {
    const buf = Buffer.from(Array.from({ length: 400 }, (_, i) => i % 256))
    const post = await fetch(`${BASE}/api/noise-reports/${reportId}/audio/loudest5s`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: buf,
    })
    expect(post.status).toBe(201)
    const get = await fetch(`${BASE}/api/noise-reports/${reportId}/audio/loudest5s`)
    expect(get.status).toBe(200)
    const got = Buffer.from(await get.arrayBuffer())
    expect(got.equals(buf)).toBe(true)
    // Other slot still independent
    const otherGet = await fetch(`${BASE}/api/noise-reports/${reportId}/audio/spliced10s`)
    expect(otherGet.status).toBe(200)
    const otherBuf = Buffer.from(await otherGet.arrayBuffer())
    expect(otherBuf.length).toBe(fakeMp3().length)
  })

  it('rejects invalid slot with 400', async () => {
    const res = await fetch(`${BASE}/api/noise-reports/${reportId}/audio/badslot`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: fakeMp3(),
    })
    expect(res.status).toBe(400)
  })

  it('rejects wrong Content-Type with 415', async () => {
    const res = await fetch(`${BASE}/api/noise-reports/${reportId}/audio/spliced10s`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    })
    expect(res.status).toBe(415)
  })

  it('returns 404 for missing audio', async () => {
    const res = await fetch(`${BASE}/api/noise-reports/nope-no-such-id/audio/loudest5s`)
    expect(res.status).toBe(404)
  })

  it('GET audio sets long immutable cache', async () => {
    const res = await fetch(`${BASE}/api/noise-reports/${reportId}/audio/spliced10s`)
    expect(res.status).toBe(200)
    const cache = res.headers.get('cache-control') || ''
    expect(cache).toMatch(/immutable/)
    expect(cache).toMatch(/max-age=\d+/)
  })

  it('re-uploading same slot replaces bytes', async () => {
    const buf1 = fakeMp3(50)
    const buf2 = Buffer.from(Array.from({ length: 80 }, (_, i) => (i * 7) % 256))
    await fetch(`${BASE}/api/noise-reports/${reportId}/audio/spliced10s`, {
      method: 'POST', headers: { 'Content-Type': 'audio/mpeg' }, body: buf1,
    })
    await fetch(`${BASE}/api/noise-reports/${reportId}/audio/spliced10s`, {
      method: 'POST', headers: { 'Content-Type': 'audio/mpeg' }, body: buf2,
    })
    const res = await fetch(`${BASE}/api/noise-reports/${reportId}/audio/spliced10s`)
    const got = Buffer.from(await res.arrayBuffer())
    expect(got.equals(buf2)).toBe(true)
    expect(got.equals(buf1)).toBe(false)
  })
})
