// phaseML.test.js — vitest suite for the phaseML/ package.
//
// Mirrors phase-ml/tests/test_geometry.py and test_maneuvers.py. Synthetic
// trajectories are built in pure JS so no archive data is required.
//
// Run:  npx vitest run phaseML.test.js

import { describe, it, expect } from 'vitest'
import {
  AIRPORTS,
  angleDiffDeg,
  bankAngleDegFromTurnRate,
  bearingDeg,
  buildWindow,
  classifyOneTrack,
  classifyTrack,
  DEG_TO_RAD,
  detectEmergencyDescent,
  detectAll,
  detectSTurns,
  detectSteepTurn,
  detectTouchAndGo,
  enrich,
  getAirport,
  haversineNm,
  KT_TO_FPS,
  makeRunwayFrame,
  nearestAirport,
  orbitRadiusNm,
  predictIntent,
  summarise,
  xyNmToLatLon,
  classifyTrack,
  secondsToNearestHourMarker,
  SORTIE_PROFILES,
} from './phaseML/index.js'

// ─── Synthetic trajectory generators ────────────────────────────────────

function straightTrack({
  lat0 = 40, lon0 = -105, altFt = 7000,
  headingDeg = 90, speedKt = 120, durationS = 60,
  sampleS = 2, t0 = 0,
} = {}) {
  const n = Math.floor(durationS / sampleS) + 1
  const out = []
  const speedNmPerS = speedKt / 3600
  const theta = headingDeg * DEG_TO_RAD
  const sinT = Math.sin(theta), cosT = Math.cos(theta)
  for (let i = 0; i < n; i++) {
    const t = i * sampleS
    const d = t * speedNmPerS
    const x = sinT * d, y = cosT * d
    const { lat, lon } = xyNmToLatLon(x, y, lat0, lon0)
    out.push({ lat, lon, altMslFt: altFt, tsUnix: t0 + t })
  }
  return out
}

function steepTurnTrack({
  lat0 = 40, lon0 = -105, altFt = 7000,
  speedKt = 100, bankDeg = 50, turnTotalDeg = 360,
  sampleS = 2, t0 = 0, direction = 1,
} = {}) {
  const vFps = speedKt * KT_TO_FPS
  const omegaRadS = 32.174 * Math.tan(bankDeg * DEG_TO_RAD) / vFps
  const turnRateDps = (omegaRadS * 180 / Math.PI) * direction
  const durationS = Math.abs(turnTotalDeg / turnRateDps)
  const n = Math.floor(durationS / sampleS) + 1
  const radiusNm = (speedKt / 3600) / omegaRadS
  const cx = radiusNm * direction, cy = 0
  const out = []
  const theta0 = direction > 0 ? Math.PI : 0
  for (let i = 0; i < n; i++) {
    const t = i * sampleS
    const angleSwept = turnRateDps * t
    const theta = theta0 + (angleSwept * Math.PI / 180) * direction
    const x = cx + radiusNm * Math.cos(theta) * direction
    const y = cy + radiusNm * Math.sin(theta) * direction
    const { lat, lon } = xyNmToLatLon(x, y, lat0, lon0)
    out.push({ lat, lon, altMslFt: altFt, tsUnix: t0 + t })
  }
  return out
}

function sTurnsTrack({
  lat0 = 40, lon0 = -105, altFt = 6000,
  speedKt = 100, nLegs = 4, legTurnDeg = 180, bankDeg = 30,
  sampleS = 2, t0 = 0,
} = {}) {
  const points = []
  let currentT = t0
  let currentXy = { x: 0, y: 0 }
  let currentHeading = 90
  const vFps = speedKt * KT_TO_FPS
  const omegaRadS = 32.174 * Math.tan(bankDeg * DEG_TO_RAD) / vFps
  const radiusNm = (speedKt / 3600) / omegaRadS

  for (let legI = 0; legI < nLegs; legI++) {
    const direction = legI % 2 === 0 ? 1 : -1
    const turnRateDps = (omegaRadS * 180 / Math.PI) * direction
    const durationS = Math.abs(legTurnDeg / turnRateDps)
    const n = Math.floor(durationS / sampleS) + 1
    const perp = currentHeading + (90 * direction)
    const perpRad = perp * DEG_TO_RAD
    const cx = currentXy.x + radiusNm * Math.sin(perpRad)
    const cy = currentXy.y + radiusNm * Math.cos(perpRad)
    const startAngle = Math.atan2(currentXy.x - cx, currentXy.y - cy)
    for (let i = 0; i < n; i++) {
      const t = i * sampleS
      const swept = (turnRateDps * t) * Math.PI / 180
      const ang = startAngle + swept
      const x = cx + radiusNm * Math.sin(ang)
      const y = cy + radiusNm * Math.cos(ang)
      const { lat, lon } = xyNmToLatLon(x, y, lat0, lon0)
      points.push({ lat, lon, altMslFt: altFt, tsUnix: currentT + t })
    }
    const finalSwept = (turnRateDps * durationS) * Math.PI / 180
    currentXy = {
      x: cx + radiusNm * Math.sin(startAngle + finalSwept),
      y: cy + radiusNm * Math.cos(startAngle + finalSwept),
    }
    currentHeading = (currentHeading + legTurnDeg * direction) % 360
    if (currentHeading < 0) currentHeading += 360
    currentT += durationS
  }
  return points
}

function emergencyDescentTrack({
  lat0 = 40, lon0 = -105, altStartFt = 12000,
  speedKt = 130, vsFpm = -2500, durationS = 90, spiral = true,
  bankDeg = 40, sampleS = 2, t0 = 0,
  // ACS IX.A requires recovery — pilot levels off after the rapid
  // descent. Append a level-flight tail so the detector sees it.
  recoveryS = 60,
} = {}) {
  const vFps = speedKt * KT_TO_FPS
  const omegaRadS = spiral ? (32.174 * Math.tan(bankDeg * DEG_TO_RAD) / vFps) : 0
  const radiusNm = omegaRadS > 0 ? ((speedKt / 3600) / omegaRadS) : 0
  const cx = radiusNm, cy = 0
  const n = Math.floor(durationS / sampleS) + 1
  const out = []
  for (let i = 0; i < n; i++) {
    const t = i * sampleS
    const alt = altStartFt + vsFpm * (t / 60)
    let x, y
    if (spiral) {
      const theta = Math.PI + omegaRadS * t
      x = cx + radiusNm * Math.cos(theta)
      y = cy + radiusNm * Math.sin(theta)
    } else {
      x = 0
      y = -(speedKt / 3600) * t
    }
    const { lat, lon } = xyNmToLatLon(x, y, lat0, lon0)
    out.push({ lat, lon, altMslFt: alt, tsUnix: t0 + t })
  }
  // Recovery tail: level cruise at the post-descent altitude.
  const endAlt = altStartFt + vsFpm * (durationS / 60)
  const endLast = out[out.length - 1]
  const recN = Math.floor(recoveryS / sampleS)
  for (let i = 1; i <= recN; i++) {
    const t = durationS + i * sampleS
    const x = 0    // continue level-flight heading
    const y = -(speedKt / 3600) * (i * sampleS)
    const { lat, lon } = xyNmToLatLon(x, y, endLast.lat, endLast.lon)
    out.push({ lat, lon, altMslFt: endAlt, tsUnix: t0 + t })
  }
  return out
}

function inboundApproachTrack({
  airportLat = 40.0394, airportLon = -105.2258, fieldElevFt = 5288,
  runwayHeadingDeg = 260, startDistNm = 8, startAltMslFt = 8000, speedKt = 100,
  sampleS = 2, t0 = 0,
} = {}) {
  const approachHeading = (runwayHeadingDeg + 180) % 360
  const theta = approachHeading * DEG_TO_RAD
  const startX = -Math.sin(theta) * startDistNm
  const startY = -Math.cos(theta) * startDistNm
  const durationS = (startDistNm / speedKt) * 3600
  const n = Math.floor(durationS / sampleS) + 1
  const vsFpm = -(startAltMslFt - fieldElevFt) / (durationS / 60)
  const out = []
  for (let i = 0; i < n; i++) {
    const t = i * sampleS
    const frac = t / durationS
    const x = startX * (1 - frac)
    const y = startY * (1 - frac)
    const alt = startAltMslFt + vsFpm * (t / 60)
    const { lat, lon } = xyNmToLatLon(x, y, airportLat, airportLon)
    out.push({ lat, lon, altMslFt: alt, tsUnix: t0 + t })
  }
  return out
}

// ─── Geometry ────────────────────────────────────────────────────────────

describe('geometry', () => {
  it('haversine: identical points = 0', () => {
    expect(haversineNm(40, -105, 40, -105)).toBe(0)
  })

  it('haversine: KBDU to KBJC ~9 nm', () => {
    const d = haversineNm(40.0394, -105.2258, 39.9088, -105.1172)
    expect(d).toBeGreaterThan(8)
    expect(d).toBeLessThan(11)
  })

  it('bearing east is ~90', () => {
    expect(Math.abs(bearingDeg(40, -105, 40, -104) - 90)).toBeLessThan(1)
  })

  it('angle diff: signs and 180 boundary', () => {
    expect(angleDiffDeg(10, 350)).toBe(20)
    expect(angleDiffDeg(350, 10)).toBe(-20)
    expect(angleDiffDeg(180, 0)).toBe(180)
  })

  it('bank from turn rate: 3°/s at 100 kt ~ 15°, 11°/s at 100 kt ~ 45°', () => {
    expect(bankAngleDegFromTurnRate(3, 100)).toBeGreaterThan(14)
    expect(bankAngleDegFromTurnRate(3, 100)).toBeLessThan(17)
    expect(bankAngleDegFromTurnRate(11, 100)).toBeGreaterThan(42)
    expect(bankAngleDegFromTurnRate(11, 100)).toBeLessThan(48)
  })

  it('orbit radius: 3°/s at 100 kt ~ 0.5 nm', () => {
    const r = orbitRadiusNm(3, 100)
    expect(r).toBeGreaterThan(0.4)
    expect(r).toBeLessThan(0.7)
  })

  it('runway frame: 1 nm ahead = along +1, cross 0', () => {
    const rf = makeRunwayFrame({ thresholdLat: 40, thresholdLon: -105, headingDeg: 90, fieldElevFt: 5000 })
    const { lat, lon } = xyNmToLatLon(1, 0, 40, -105)
    const { alongNm, crossNm } = rf.project(lat, lon)
    expect(Math.abs(alongNm - 1)).toBeLessThan(0.01)
    expect(Math.abs(crossNm)).toBeLessThan(0.01)
  })
})

// ─── Airports ────────────────────────────────────────────────────────────

describe('airports', () => {
  it('KBDU present with two runways', () => {
    expect(AIRPORTS.KBDU).toBeDefined()
    expect(getAirport('KBDU').fieldElevFt).toBe(5288)
    expect(getAirport('KBDU').runways.length).toBe(2)
  })
  it('nearest airport finds KBDU from its own coords', () => {
    const { airport, distanceNm } = nearestAirport(40.0394, -105.2258)
    expect(airport).not.toBeNull()
    expect(airport.icao).toBe('KBDU')
    expect(distanceNm).toBeLessThan(0.01)
  })
})

// ─── Maneuvers ───────────────────────────────────────────────────────────

describe('maneuvers', () => {
  it('straight cruise produces no maneuvers', () => {
    const samples = enrich(straightTrack({ durationS: 180, speedKt: 120 }))
    const all = detectAll(samples)
    const types = new Set(all.map(d => d.type))
    expect(types.has('steep_turn')).toBe(false)
    expect(types.has('s_turns_across_road')).toBe(false)
    expect(types.has('emergency_descent')).toBe(false)
  })

  it('detects a steep turn', () => {
    const samples = enrich(steepTurnTrack({ turnTotalDeg: 360, bankDeg: 50, speedKt: 100 }))
    const detections = detectSteepTurn(samples)
    expect(detections.length).toBeGreaterThan(0)
    expect(detections[0].confidence).toBeGreaterThan(0.55)
    expect(detections[0].explanation).toMatch(/turn/)
  })

  it('detects S-turns', () => {
    const samples = enrich(sTurnsTrack({ nLegs: 4, legTurnDeg: 180, bankDeg: 30 }))
    const detections = detectSTurns(samples)
    expect(detections.length).toBeGreaterThan(0)
    expect(detections[0].confidence).toBeGreaterThan(0.5)
  })

  it('detects emergency descent with spiral', () => {
    const samples = enrich(emergencyDescentTrack({ vsFpm: -2500, durationS: 80, spiral: true }))
    const detections = detectEmergencyDescent(samples)
    expect(detections.length).toBeGreaterThan(0)
    expect(detections[0].evidence.spiraling).toBe(true)
    expect(detections[0].evidence.altLostFt).toBeGreaterThan(1500)
    expect(detections[0].confidence).toBeGreaterThan(0.6)
  })

  it('full_stop after sustained taxi at airport', () => {
    let pre = inboundApproachTrack({
      airportLat: 40.0394, airportLon: -105.2258, fieldElevFt: 5288,
      runwayHeadingDeg: 260, startDistNm: 3, startAltMslFt: 6500, speedKt: 90,
    })
    pre = pre.filter(p => p.altMslFt - 5288 > 50)
    const lastT = pre[pre.length - 1].tsUnix
    const lastLat = pre[pre.length - 1].lat
    const lastLon = pre[pre.length - 1].lon
    const taxi = []
    for (let i = 1; i <= 15; i++) {
      taxi.push({
        lat: lastLat + i * 1e-5, lon: lastLon,
        altMslFt: 5288 + 5,
        tsUnix: lastT + i * 2,
      })
    }
    const samples = enrich([...pre, ...taxi])
    const dets = detectTouchAndGo(samples)
    const landed = dets.filter(d => d.type === 'landed_full_stop')
    expect(landed.length).toBeGreaterThan(0)
    expect(landed[0].evidence.airport).toBe('KBDU')
    expect(landed[0].evidence.decisionCue).toBe('sustained_taxi')
  })

  it('full_stop when track ends at airport', () => {
    let pre = inboundApproachTrack({
      airportLat: 40.0394, airportLon: -105.2258, fieldElevFt: 5288,
      runwayHeadingDeg: 260, startDistNm: 3, startAltMslFt: 6500, speedKt: 90,
    })
    pre = pre.filter(p => p.altMslFt - 5288 >= -10)
    const samples = enrich(pre)
    const dets = detectTouchAndGo(samples)
    const landed = dets.filter(d => d.type === 'landed_full_stop')
    expect(landed.length).toBeGreaterThan(0)
    const cue = landed[0].evidence.decisionCue
    expect(['track_ended_at_airport', 'long_silence_no_climbout']).toContain(cue)
  })

  it('implied touch_and_go across an ADS-B gap', () => {
    let pre = inboundApproachTrack({
      airportLat: 40.0394, airportLon: -105.2258, fieldElevFt: 5288,
      runwayHeadingDeg: 260, startDistNm: 3, startAltMslFt: 6500, speedKt: 90,
    })
    pre = pre.filter(p => p.altMslFt - 5288 > 400).slice(0, 60)
    const tGapStart = pre[pre.length - 1].tsUnix
    const tGapEnd = tGapStart + 90
    const post = []
    for (let i = 0; i < 15; i++) {
      const t = tGapEnd + i * 2
      const alt = 5288 + 300 + i * 25
      post.push({
        lat: 40.0394 + i * 0.0003,
        lon: -105.2258 + i * 0.0003,
        altMslFt: alt,
        tsUnix: t,
      })
    }
    const samples = enrich([...pre, ...post])
    const dets = detectTouchAndGo(samples)
    const implied = dets.filter(d => d.evidence.implied)
    expect(implied.length).toBeGreaterThan(0)
    expect(implied[0].evidence.airport).toBe('KBDU')
    expect(implied[0].confidence).toBeGreaterThan(0.5)
  })
})

// ─── Intent ──────────────────────────────────────────────────────────────

describe('intent', () => {
  it('predicts KBDU inbound from a synthetic approach', () => {
    const points = inboundApproachTrack({
      airportLat: 40.0394, airportLon: -105.2258, fieldElevFt: 5288,
      runwayHeadingDeg: 260, startDistNm: 8, startAltMslFt: 8000, speedKt: 100,
    })
    const samples = enrich(points)
    // Evaluate a 90 s window ending 30 s before touchdown.
    const endTs = samples[samples.length - 1].point.tsUnix - 30
    let endIdx = samples.length - 1
    for (let i = samples.length - 1; i >= 0; i--) {
      if (samples[i].point.tsUnix <= endTs) { endIdx = i; break }
    }
    const startTs = samples[endIdx].point.tsUnix - 90
    let startIdx = 0
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].point.tsUnix >= startTs) { startIdx = i; break }
    }
    const window = buildWindow(samples.slice(startIdx, endIdx + 1))
    const sum = summarise(window)
    expect(sum.top.airport).toBe('KBDU')
    expect(['08', '26']).toContain(sum.top.runway)
    expect(sum.top.probability).toBeGreaterThan(0.4)
  })

  it('straight cruise far from airports is transit', () => {
    const samples = enrich(straightTrack({
      lat0: 40.5, lon0: -103.5, altFt: 10000,
      headingDeg: 90, speedKt: 180, durationS: 180,
    }))
    const sum = summarise(samples)
    // Either flat-out transit, or some airport with very low confidence.
    expect(sum.confidenceGap < 0.6 || sum.top.airport === null).toBe(true)
  })
})

// ─── Sortie (landed_full_stop) overlay ──────────────────────────────────

function tsAt(hh, mm = 0, ss = 0) {
  return Date.UTC(2026, 5, 1, hh, mm, ss) / 1000   // June 1, 2026 UTC
}

function buildSortieFlight({
  airport, takeoffTs, landTs, dwellEndTs,
  secondTakeoffTs = null, secondLandTs = null,
}) {
  const SAMPLE_S = 2.0
  const pts = []
  const latField = airport.lat, lonField = airport.lon
  const cruise = xyNmToLatLon(3.0, 0.0, latField, lonField)
  const addRun = (startTs, endTs, lat, lon, alt) => {
    for (let t = startTs; t <= endTs; t += SAMPLE_S) {
      pts.push({ lat, lon, altMslFt: alt, tsUnix: t })
    }
  }
  addRun(takeoffTs, takeoffTs + 30, latField, lonField, airport.fieldElevFt + 20)
  addRun(takeoffTs + 60, landTs - 10, cruise.lat, cruise.lon, airport.fieldElevFt + 2000)
  addRun(landTs, dwellEndTs, latField, lonField, airport.fieldElevFt + 20)
  if (secondTakeoffTs != null && secondLandTs != null) {
    addRun(secondTakeoffTs, secondLandTs, cruise.lat, cruise.lon, airport.fieldElevFt + 2000)
  }
  return pts
}

function sortieCues(labels) {
  const out = []
  for (const L of labels) {
    if (L.phase === 'landed_full_stop' && L.sortieCue && !out.includes(L.sortieCue)) {
      out.push(L.sortieCue)
    }
  }
  return out
}

describe('sortie / landed_full_stop overlay', () => {
  it('hour marker helper returns 0 at :00 and :30', () => {
    expect(secondsToNearestHourMarker(tsAt(10, 0))).toBe(0)
    expect(secondsToNearestHourMarker(tsAt(10, 30))).toBe(0)
    expect(secondsToNearestHourMarker(tsAt(10, 32))).toBe(120)
  })

  it('KBDU: 6-min dwell with no takeoff in window → no_new_takeoff', () => {
    const ap = getAirport('KBDU')
    const pts = buildSortieFlight({
      airport: ap,
      takeoffTs: tsAt(14, 0), landTs: tsAt(14, 30),
      dwellEndTs: tsAt(14, 36),
      secondTakeoffTs: tsAt(14, 38), secondLandTs: tsAt(15, 0),
    })
    expect(sortieCues(classifyTrack(pts, ap))).toEqual(['no_new_takeoff'])
  })

  it('KBDU: 5-min dwell + takeoff at :30 → crew_swap_hour_marker', () => {
    const ap = getAirport('KBDU')
    const pts = buildSortieFlight({
      airport: ap,
      takeoffTs: tsAt(14, 0), landTs: tsAt(14, 25),
      dwellEndTs: tsAt(14, 29, 58),
      secondTakeoffTs: tsAt(14, 30), secondLandTs: tsAt(15, 0),
    })
    expect(sortieCues(classifyTrack(pts, ap))).toEqual(['crew_swap_hour_marker'])
  })

  it('KBDU: real taxi-back at :17 → no fire', () => {
    const ap = getAirport('KBDU')
    const pts = buildSortieFlight({
      airport: ap,
      takeoffTs: tsAt(14, 0), landTs: tsAt(14, 14),
      dwellEndTs: tsAt(14, 16, 58),
      secondTakeoffTs: tsAt(14, 17), secondLandTs: tsAt(14, 40),
    })
    expect(sortieCues(classifyTrack(pts, ap))).toEqual([])
  })

  it('KDEN slow profile rejects what KBDU would accept', () => {
    const ap = getAirport('KDEN')
    const pts = buildSortieFlight({
      airport: ap,
      takeoffTs: tsAt(14, 0), landTs: tsAt(14, 7),
      dwellEndTs: tsAt(14, 13),
      secondTakeoffTs: tsAt(14, 13, 30), secondLandTs: tsAt(14, 40),
    })
    expect(sortieCues(classifyTrack(pts, ap))).toEqual([])
  })

  it('track ending on the ground fires track_ended', () => {
    const ap = getAirport('KBDU')
    const pts = buildSortieFlight({
      airport: ap,
      takeoffTs: tsAt(14, 0), landTs: tsAt(14, 30),
      dwellEndTs: tsAt(14, 31, 30),
    })
    expect(sortieCues(classifyTrack(pts, ap))).toEqual(['track_ended'])
  })

  it('sortieProfileOverrides via cfg swaps thresholds', () => {
    const ap = getAirport('KBDU')
    const pts = buildSortieFlight({
      airport: ap,
      takeoffTs: tsAt(14, 0), landTs: tsAt(14, 30),
      dwellEndTs: tsAt(14, 36),
      secondTakeoffTs: tsAt(14, 38), secondLandTs: tsAt(15, 0),
    })
    // Default KBDU profile → fires no_new_takeoff
    expect(sortieCues(classifyTrack(pts, ap))).toEqual(['no_new_takeoff'])
    // Override to a 10-min profile → takeoff is now inside the window and not
    // near a marker, so nothing fires.
    const cfg = {
      onGroundAglFt: 200, taxiAglFt: 150, patternDistNm: 2.5,
      patternMinAgl: 100, patternMaxAgl: 1500,
      practiceDistNm: [2, 8], practiceAgl: [200, 3000],
      departTrackOffsetDeg: 60, inboundTrackOffsetDeg: 40,
      inboundRangeNm: [1.5, 50], enRouteDistNm: 8,
      sortieProfileOverrides: {
        KBDU: { minGroundS: 30, minDwellS: 10 * 60, noNewTakeoffS: 10 * 60,
                hourMarkerToleranceS: 240, hourMarkerMinDwellS: 240 },
      },
    }
    expect(sortieCues(classifyTrack(pts, ap, cfg))).toEqual([])
  })

  it('built-in profiles cover the Front Range fields', () => {
    for (const icao of ['KBDU', 'KBJC', 'KEIK', 'KLMO', 'KGXY', 'KFNL', 'KAPA', 'KDEN']) {
      expect(SORTIE_PROFILES[icao]).toBeDefined()
    }
  })
})

// ─── End-to-end service ─────────────────────────────────────────────────

describe('classifyOneTrack (service)', () => {
  it('returns phases, maneuvers, intent for a synthetic approach', () => {
    const points = inboundApproachTrack({
      airportLat: 40.0394, airportLon: -105.2258, fieldElevFt: 5288,
      runwayHeadingDeg: 260, startDistNm: 5, startAltMslFt: 7500, speedKt: 100,
    })
    const result = classifyOneTrack(points, { typeCode: 'C172', intentWindowS: 90 })
    expect(result.phases.length).toBe(points.length)
    expect(Array.isArray(result.maneuvers)).toBe(true)
    expect(result.intent).not.toBeNull()
    expect(result.intent.top).toBeDefined()
  })
})
