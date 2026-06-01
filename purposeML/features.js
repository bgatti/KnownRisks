// features.js — composes phaseML phases + maneuvers + shape features.

import { enrich, MAX_SAMPLE_GAP_S } from '../phaseML/features.js'
import { classifyTrack as phaseClassifyTrack } from '../phaseML/oracle.js'
import { detectAll as phaseDetectAll } from '../phaseML/maneuvers.js'
import {
  haversineNm, haversinePathLengthNm, percentile, std, angleDiffAbs,
} from '../phaseML/geometry.js'
import {
  airportTraits, endpointAirports, inferredEndpoints, homeFieldFor,
  candidateAirports, nearestAirport,
} from './airports.js'

function p(values, q) { return values.length ? percentile(values, q) : 0 }
function median(values) { return p(values, 0.5) }

function aglFor(point) {
  const { airport } = nearestAirport(point.lat, point.lon, { maxNm: 100 })
  if (!airport) return point.altMslFt
  return point.altMslFt - airport.fieldElevFt
}

function countSharpTurns(samples, thresholdDeg = 30) {
  let count = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].isSessionBreak) continue
    if (angleDiffAbs(samples[i].trackDeg, samples[i - 1].trackDeg) > thresholdDeg) count++
  }
  return count
}

function headingDeltaStd(samples) {
  const deltas = []
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].isSessionBreak) continue
    deltas.push(angleDiffAbs(samples[i].trackDeg, samples[i - 1].trackDeg))
  }
  return std(deltas)
}

function levelFlightFraction(samples) {
  let levelS = 0, totalS = 0, i = 0
  const n = samples.length
  while (i < n) {
    if (samples[i].isSessionBreak) { i++; continue }
    let j = i + 1
    const startAlt = samples[i].point.altMslFt
    while (j < n
      && !samples[j].isSessionBreak
      && Math.abs(samples[j].point.altMslFt - startAlt) <= 100) j++
    const segS = samples[j - 1].point.tsUnix - samples[i].point.tsUnix
    if (segS >= 30) levelS += segS
    if (segS > 0) totalS += segS
    i = Math.max(j, i + 1)
  }
  return totalS > 0 ? levelS / totalS : 0
}

// IFR vs VFR cruise: below FL180, IFR cruises at exact thousands,
// VFR at thousands+500. Returns seconds in each + the IFR share.
// Only counts sustained level segments above 5000 ft MSL AND ONLY
// when the simultaneous phaseML phase is en_route / inbound /
// departing — NOT pattern or practice_area (where pattern altitudes
// near KAPA's 7385-ft TPA could spuriously round to "IFR"
// thousands).
export function detectIfrVfrCruise(samples, phaseLabels = null, { minSegmentS = 60, minAltFt = 5000 } = {}) {
  let ifrS = 0, vfrS = 0, otherLevelS = 0, i = 0
  const n = samples.length
  const CRUISE_PHASES = new Set(['en_route', 'inbound', 'departing'])
  while (i < n) {
    if (samples[i].isSessionBreak) { i++; continue }
    let j = i + 1
    const startAlt = samples[i].point.altMslFt
    while (j < n
      && !samples[j].isSessionBreak
      && Math.abs(samples[j].point.altMslFt - startAlt) <= 100) j++
    const segS = samples[j - 1].point.tsUnix - samples[i].point.tsUnix
    if (segS >= minSegmentS) {
      const avgAlt = (startAlt + samples[j - 1].point.altMslFt) / 2
      // Phase guard: midpoint must be in cruise phase (when labels available).
      const midPhase = phaseLabels ? phaseLabels[Math.floor((i + j) / 2)]?.phase : null
      const phaseOk = !phaseLabels || CRUISE_PHASES.has(midPhase)
      if (avgAlt >= minAltFt && phaseOk) {
        const distToThousand = Math.abs(avgAlt - Math.round(avgAlt / 1000) * 1000)
        const distToThousandPlus500 = Math.abs((avgAlt - Math.round((avgAlt - 500) / 1000) * 1000 - 500))
        if (distToThousand < 100) ifrS += segS
        else if (distToThousandPlus500 < 100) vfrS += segS
        else otherLevelS += segS
      }
    }
    i = Math.max(j, i + 1)
  }
  const cls = ifrS + vfrS
  return {
    ifrCruiseS: ifrS,
    vfrCruiseS: vfrS,
    otherLevelS,
    ifrCruiseShare: cls > 0 ? ifrS / cls : 0,
  }
}

function tightestLoiterRadiusNm(samples, windowS = 300) {
  if (samples.length < 5) return Infinity
  let best = Infinity, lo = 0
  for (let hi = 0; hi < samples.length; hi++) {
    while (samples[hi].point.tsUnix - samples[lo].point.tsUnix > windowS) lo++
    const span = hi - lo
    if (span < 5) continue
    let lat = 0, lon = 0
    for (let k = lo; k <= hi; k++) { lat += samples[k].point.lat; lon += samples[k].point.lon }
    const cLat = lat / (span + 1)
    const cLon = lon / (span + 1)
    const dists = []
    for (let k = lo; k <= hi; k++) {
      dists.push(haversineNm(cLat, cLon, samples[k].point.lat, samples[k].point.lon))
    }
    const r80 = p(dists, 0.8)
    if (r80 < best) best = r80
  }
  return best
}

function gridScore(samples) {
  if (samples.length < 5) return 0
  const bins = new Array(36).fill(0)
  let total = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].isSessionBreak) continue
    const dNm = haversineNm(
      samples[i - 1].point.lat, samples[i - 1].point.lon,
      samples[i].point.lat, samples[i].point.lon,
    )
    if (dNm < 0.01) continue
    const heading = ((samples[i].trackDeg % 360) + 360) % 360
    const bin = Math.floor(heading / 10) % 36
    bins[bin] += dNm
    total += dNm
  }
  if (total === 0) return 0
  let bestBin = 0
  for (let i = 1; i < 36; i++) if (bins[i] > bins[bestBin]) bestBin = i
  const forwardShare = (bins[(bestBin + 35) % 36] + bins[bestBin] + bins[(bestBin + 1) % 36]) / total
  const oppBin = (bestBin + 18) % 36
  const reverseShare = (bins[(oppBin + 35) % 36] + bins[oppBin] + bins[(oppBin + 1) % 36]) / total
  return Math.min(forwardShare, reverseShare) * 2
}

function activeWallClockS(samples) {
  let s = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].isSessionBreak) continue
    s += samples[i].dtS
  }
  return s
}

function rollupPhaseDurations(samples, phaseLabels) {
  const out = {
    on_ground: 0, taxiing: 0, pattern: 0, practice_area: 0,
    departing: 0, inbound: 0, en_route: 0, nearby: 0, landed_full_stop: 0,
  }
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].isSessionBreak) continue
    const dt = samples[i].dtS
    const ph = phaseLabels[i]?.phase || 'nearby'
    if (out[ph] !== undefined) out[ph] += dt
  }
  return out
}

function rollupManeuverCounts(maneuvers) {
  const out = {
    touch_and_go: 0, landed_full_stop: 0, thermalling: 0, holding_pattern: 0,
    sightseeing_orbit: 0, steep_turn: 0, s_turns_across_road: 0,
    turn_around_a_point: 0, chandelle: 0, lazy_8: 0, slow_flight: 0,
    stall_recovery: 0, emergency_descent: 0,
  }
  for (const m of maneuvers) {
    if (out[m.type] !== undefined) out[m.type]++
  }
  return out
}

export function extractFeatures(points, { typeCode = '' } = {}) {
  const f = {
    nPoints: points.length, durationS: 0, activeWallClockS: 0,
    pathLengthNm: 0, straightLineNm: 0, tortuosity: 1, bboxDiagNm: 0,
    headingDeltaStd: 0, turnCount: 0, returnedToOrigin: false,
    altAglP50: 0, altAglP90: 0, altMaxFt: 0,
    maxClimbFpm: 0, maxDescentFpm: 0,
    cruiseSpeedKts: 0, gsP90Kts: 0,
    levelFraction: 0, enginelessShare: 0,
    phaseSeconds: {
      on_ground: 0, taxiing: 0, pattern: 0, practice_area: 0,
      departing: 0, inbound: 0, en_route: 0, nearby: 0, landed_full_stop: 0,
    },
    maneuverCounts: {
      touch_and_go: 0, landed_full_stop: 0, thermalling: 0, holding_pattern: 0,
      sightseeing_orbit: 0, steep_turn: 0, s_turns_across_road: 0,
      turn_around_a_point: 0, chandelle: 0, lazy_8: 0, slow_flight: 0,
      stall_recovery: 0, emergency_descent: 0,
    },
    gridScore: 0, loiterRadiusNm: Infinity,
    ifrCruiseS: 0, vfrCruiseS: 0, ifrCruiseShare: 0,
    cruiseAltMslFt: 0,
    startIcao: null, endIcao: null, homeIcao: null,
    inferredOriginIcao: null, inferredOriginDistNm: Infinity,
    inferredDestIcao: null, inferredDestDistNm: Infinity,
    homeTraits: airportTraits(null), homeFieldDwell: 0, airportsVisited: [],
  }
  if (points.length < 2) return f

  const T = String(typeCode || '').toUpperCase()
  if (/^(GLID|VENT|NIMB|DISC|SGS|ASTR|JS\d|LS\d|PIK|ASW|SZD|BALL)/.test(T)
      || /^AS\d/.test(T) || /^DG\d/.test(T)) {
    f.enginelessShare = 1
  }

  const samples = enrich(points)
  const phaseLabels = phaseClassifyTrack(points)
  const maneuvers = phaseDetectAll(samples, typeCode)
  f.phaseSeconds = rollupPhaseDurations(samples, phaseLabels)
  f.maneuverCounts = rollupManeuverCounts(maneuvers)

  f.durationS = points[points.length - 1].tsUnix - points[0].tsUnix
  f.activeWallClockS = activeWallClockS(samples)

  f.pathLengthNm = haversinePathLengthNm(points)
  f.straightLineNm = haversineNm(points[0].lat, points[0].lon,
                                 points[points.length - 1].lat, points[points.length - 1].lon)
  f.tortuosity = f.straightLineNm > 0.01 ? f.pathLengthNm / f.straightLineNm : Infinity

  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity
  for (const pt of points) {
    if (pt.lat < latMin) latMin = pt.lat
    if (pt.lat > latMax) latMax = pt.lat
    if (pt.lon < lonMin) lonMin = pt.lon
    if (pt.lon > lonMax) lonMax = pt.lon
  }
  f.bboxDiagNm = haversineNm(latMin, lonMin, latMax, lonMax)

  f.headingDeltaStd = headingDeltaStd(samples)
  f.turnCount = countSharpTurns(samples)
  f.returnedToOrigin = f.straightLineNm < 2 && f.pathLengthNm > 5

  const agls = points.map(aglFor)
  f.altAglP50 = median(agls)
  f.altAglP90 = p(agls, 0.9)
  f.altMaxFt = Math.max(...points.map(pt => pt.altMslFt))

  const vsPositive = samples.map(s => s.vsFpm).filter(v => v > 0)
  const vsNegative = samples.map(s => s.vsFpm).filter(v => v < 0)
  f.maxClimbFpm = vsPositive.length ? Math.max(...vsPositive) : 0
  f.maxDescentFpm = vsNegative.length ? Math.min(...vsNegative) : 0

  const gs = samples.map(s => s.gsKts).filter(v => v > 0)
  f.cruiseSpeedKts = median(gs)
  f.gsP90Kts = p(gs, 0.9)
  f.levelFraction = levelFlightFraction(samples)

  // Cruise altitude (median MSL during level segments above 3000 ft).
  const levelAlts = []
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].isSessionBreak) continue
    if (Math.abs(samples[i].vsFpm) < 200 && samples[i].point.altMslFt > 3000) {
      levelAlts.push(samples[i].point.altMslFt)
    }
  }
  f.cruiseAltMslFt = levelAlts.length ? Math.round(median(levelAlts)) : 0

  const ifrVfr = detectIfrVfrCruise(samples, phaseLabels)
  f.ifrCruiseS = ifrVfr.ifrCruiseS
  f.vfrCruiseS = ifrVfr.vfrCruiseS
  f.ifrCruiseShare = ifrVfr.ifrCruiseShare

  f.gridScore = gridScore(samples)
  f.loiterRadiusNm = tightestLoiterRadiusNm(samples)

  const endpoints = endpointAirports(points)
  f.startIcao = endpoints.startIcao
  f.endIcao = endpoints.endIcao
  const inferred = inferredEndpoints(points, { maxNm: 50 })
  f.inferredOriginIcao = inferred.originIcao
  f.inferredOriginDistNm = inferred.originDistNm
  f.inferredDestIcao = inferred.destIcao
  f.inferredDestDistNm = inferred.destDistNm
  const home = homeFieldFor(points)
  f.homeIcao = home?.icao || null
  f.homeTraits = home?.traits || airportTraits(null)
  f.homeFieldDwell = (f.startIcao && f.startIcao === f.endIcao) ? 1 : 0

  const visited = new Set()
  for (const pt of points) {
    const cands = candidateAirports(pt.lat, pt.lon, { maxNm: 2 })
    for (const c of cands) visited.add(c.airport.icao)
  }
  f.airportsVisited = [...visited]

  return f
}
