#!/usr/bin/env node
// deep_dive.mjs — drill into every private_transport + other_ga tail
// across the 4-day window. For each tail produce:
//   - flight count, total active hours
//   - dept/dest patterns: same-airport rate, dominant routes
//   - direct rate, IFR-cruise rate, common cruise altitudes
//   - cruise speed band (slow GA / fast piston / turbine / jet)
//   - tail "refined purpose" — finer than private_transport / other_ga
//
// Run from `noise/web/`:
//   node purposeML/experiments/deep_dive.mjs
// Override days via env (comma-separated):
//   PURPOSEML_DAYS=public/tracks_live_2026-04-19.json node …
// Override registry CSV via env:
//   AIRCRAFT_REGISTRY_PATH=/path/to/aircraft_registry.csv node …

import fs from 'node:fs'
import path from 'node:path'
import { extractFeatures } from '../features.js'
import { classifyTrack } from '../classifier.js'
import { loadRegistry, classifyOwner } from '../registry.js'

const DAYS = (process.env.PURPOSEML_DAYS || [
  'public/tracks_live_2026-04-18.json',
  'public/tracks_live_2026-04-19.json',
  'public/tracks_live_2026-04-20.json',
  'public/tracks_live_2026-04-24.json',
].join(',')).split(',')

const REGISTRY_PATH = process.env.AIRCRAFT_REGISTRY_PATH
  || 'C:/tmp/noise_data/aircraft_registry.csv'

const OUT_PATH = process.env.PURPOSEML_OUT
  || 'purposeML/experiments/deep_dive_report.json'

const GAP_MIN = 30
const MIN_POINTS_PER_FLIGHT = 30
const MIN_ACTIVE_S = 300

// ── Split tail's points into individual flights ──────────────────────────
function splitIntoFlights(points, gapMin = GAP_MIN) {
  if (!points || points.length === 0) return []
  const gapMs = gapMin * 60 * 1000
  const flights = []
  let cur = [points[0]]
  for (let i = 1; i < points.length; i++) {
    if (points[i][3] - points[i - 1][3] > gapMs) {
      if (cur.length >= 2) flights.push(cur)
      cur = []
    }
    cur.push(points[i])
  }
  if (cur.length >= 2) flights.push(cur)
  return flights
}

function pointsFromLive(rawTuples) {
  return rawTuples.map(([lat, lon, alt, tMs]) => ({
    lat, lon, altMslFt: alt, tsUnix: Math.floor(tMs / 1000),
  }))
}

// ── Cruise-speed band ────────────────────────────────────────────────────
function speedBand(kts) {
  if (kts < 70) return 'very_slow'
  if (kts < 110) return 'slow_piston'        // C152/C172 cruise
  if (kts < 160) return 'fast_piston'        // SR22/C182/Mooney
  if (kts < 220) return 'high_perf_piston'   // P28R/Cirrus turbo
  if (kts < 320) return 'turboprop'          // PC12/TBM
  return 'jet'                                // jets
}

// Type-code regex sets — authoritative when known.
const AIRLINER_RE = /^(A2[01]|A3[12]|A33|A35|A38|B73|B73[5-9]|B738|B739|B73M|B74|B75|B76|B77|B78|E17|E19|E29|E75|MD8|MD9|CRJ|CRJ2|CRJ7|CRJ9|DH8|AT7|AT4)/
const BIZJET_RE = /^(C25|C5[0-6]|C6[89]|C70|C72|C75|CL3|CL6|GL[A-Z]|GLF|G[1-7]|H25|F2T|F9[0-9]|LJ\d|E50|E55|SF50|HDJ|PRM|J32|FA[57])/
const TURBOPROP_RE = /^(PC12|PC24|TBM|TBM7|TBM8|TBM9|TBM10|DH8|DHC|BE9|BE10|BE20|BE40|BE30|BE35|BE36|BE60|BE76|MU2|EXTR|KODI|CC9|EPIC|AC95)/
const HELI_RE = /^(R22|R44|R66|R66T|EC|AS|S76|B06|B40|B47|H50|H125|MD5|H47|UH|MH|CH|S70|S92|A109|A139|R44|R66|MD60|MD90|MD52)/

// Refined tail purpose. Owner from FAA registry comes FIRST, then
// type-regex, then shape.
function refineTailPurpose(agg) {
  const flights = agg.flights
  const reasons = []
  const T = (agg.typeCode || '').toUpperCase()

  // ── Owner-from-registry overrides (most authoritative we have) ───────
  if (agg.ownerClass === 'airline') {
    reasons.push(`owner=${agg.ownerName} (FAA registry) → airline operator`)
    return { refinedPurpose: 'airliner_overflight', reasons }
  }
  if (agg.ownerClass === 'fractional') {
    reasons.push(`owner=${agg.ownerName} (FAA registry) → fractional ops`)
    return { refinedPurpose: 'fractional_jet', reasons }
  }
  if (agg.ownerClass === 'manufacturer_demo') {
    reasons.push(`owner=${agg.ownerName} (FAA registry) → manufacturer demo / sales / test`)
    return { refinedPurpose: 'manufacturer_demo', reasons }
  }
  if (agg.ownerClass === 'government') {
    reasons.push(`owner=${agg.ownerName} (FAA registry) → government / public`)
    return { refinedPurpose: 'government_public', reasons }
  }
  if (agg.ownerClass === 'flight_school') {
    reasons.push(`owner=${agg.ownerName} (FAA registry) → known flight school / club`)
    return { refinedPurpose: 'flight_school_owned', reasons }
  }
  if (agg.ownerClass === 'flight_school_likely') {
    // Pattern + name: AVIATION INC LLC with 5+ flights → call it.
    if (flights.length >= 3 || agg.totalTouchAndGo >= 4) {
      reasons.push(`owner=${agg.ownerName} (FAA registry) suggests aviation business`,
                   `${flights.length} flights, ${agg.totalTouchAndGo} T&G`)
      return { refinedPurpose: 'flight_school_likely', reasons }
    }
  }
  if (agg.ownerClass === 'leasing_trust') {
    reasons.push(`owner=${agg.ownerName} (FAA registry) → trust / leasing entity (true operator opaque)`)
    // Fall through — leasing trusts are common for private aircraft owners
    // who route through a Delaware trust. Continue to shape analysis.
  }

  // ── Type-regex overrides (authoritative for unambiguous airframes) ──
  if (AIRLINER_RE.test(T)) {
    reasons.push(`type=${agg.typeCode} = airliner — captured slice is descent/overflight only`)
    return { refinedPurpose: 'airliner_overflight', reasons }
  }
  if (BIZJET_RE.test(T)) {
    reasons.push(`type=${agg.typeCode} = biz jet — captured slice is descent/overflight only`)
    return { refinedPurpose: 'bizjet_overflight', reasons }
  }
  if (TURBOPROP_RE.test(T)) {
    reasons.push(`type=${agg.typeCode} = turboprop`)
    return { refinedPurpose: 'turboprop_overflight', reasons }
  }
  if (HELI_RE.test(T)) {
    reasons.push(`type=${agg.typeCode} = helicopter`)
    return { refinedPurpose: 'helicopter_ops', reasons }
  }

  // ── Shape-based discriminators ───────────────────────────────────────
  const sameAirportShare = flights.filter(f => f.startIcao && f.startIcao === f.endIcao).length / Math.max(1, flights.length)
  const xcShare = flights.filter(f => f.startIcao && f.endIcao && f.startIcao !== f.endIcao).length / Math.max(1, flights.length)
  const directShare = flights.filter(f => f.tortuosity < 1.5 && f.bboxDiagNm > 15).length / Math.max(1, flights.length)
  const ifrShare = agg.ifrCruiseShareOverall

  // Inferred-endpoint stats: closest airport regardless of distance.
  const inferredSameShare = flights.filter(f =>
    f.inferredOriginIcao && f.inferredDestIcao && f.inferredOriginIcao === f.inferredDestIcao).length / Math.max(1, flights.length)
  const inferredXcShare = flights.filter(f =>
    f.inferredOriginIcao && f.inferredDestIcao && f.inferredOriginIcao !== f.inferredDestIcao).length / Math.max(1, flights.length)

  // Route pairs by INFERRED endpoints (covers the in-radius truncation case).
  const routePairs = {}
  for (const f of flights) {
    if (!f.inferredOriginIcao || !f.inferredDestIcao || f.inferredOriginIcao === f.inferredDestIcao) continue
    const key = [f.inferredOriginIcao, f.inferredDestIcao].sort().join('↔')
    routePairs[key] = (routePairs[key] || 0) + 1
  }
  const topRoute = Object.entries(routePairs).sort(([, a], [, b]) => b - a)[0]

  // Commuter / shuttle.
  if (topRoute && topRoute[1] >= 3 && (topRoute[1] / flights.length) >= 0.5) {
    reasons.push(`route ${topRoute[0]} repeated ${topRoute[1]}/${flights.length} flights`)
    return { refinedPurpose: 'commuter_shuttle', reasons }
  }

  // Owner-proficiency: home field present, 3-9 T&G across multi flights,
  // private piston type, average duration ≥ 20 min.
  if (agg.dominantHome
      && agg.totalTouchAndGo >= 3 && agg.totalTouchAndGo < 10
      && flights.length >= 2
      && agg.totalActiveHours / flights.length >= 0.33) {
    reasons.push(`owner-proficiency: ${agg.totalTouchAndGo} T&G across ${flights.length} flights at ${agg.dominantHome}`,
                 `avg duration ${(60 * agg.totalActiveHours / flights.length).toFixed(0)} min`)
    return { refinedPurpose: 'owner_proficiency', reasons }
  }

  // Personal XC traveller: fast piston, XC dominant by INFERRED endpoints, some IFR.
  if ((inferredXcShare >= 0.5 || xcShare >= 0.5)
      && agg.speedBands.fast_piston + agg.speedBands.high_perf_piston >= flights.length * 0.5) {
    reasons.push(`fast piston, inferred XC share=${(inferredXcShare * 100).toFixed(0)}%, IFR=${(ifrShare * 100).toFixed(0)}%`)
    return { refinedPurpose: 'personal_xc_traveler', reasons }
  }

  // Fly-out recreational (out-and-back).
  if (sameAirportShare >= 0.5 && agg.medianBboxNm >= 30 && agg.medianBboxNm < 150 && flights.length >= 2) {
    reasons.push(`same A=B share=${(sameAirportShare * 100).toFixed(0)}%, median bbox=${agg.medianBboxNm.toFixed(0)} nm`)
    return { refinedPurpose: 'fly_out_recreational', reasons }
  }

  // Local sightseeing.
  if ((sameAirportShare >= 0.5 || inferredSameShare >= 0.5)
      && agg.medianBboxNm < 30 && agg.medianAltAglP50 < 5000) {
    reasons.push(`same A=B share=${Math.max(sameAirportShare, inferredSameShare).toFixed(2)}`,
                 `bbox=${agg.medianBboxNm.toFixed(0)} nm (local)`,
                 `AGL p50=${agg.medianAltAglP50.toFixed(0)} ft`)
    return { refinedPurpose: 'local_sightseeing', reasons }
  }

  // One-way XC / ferry.
  if (inferredXcShare >= 0.5 && sameAirportShare < 0.2 && inferredSameShare < 0.2) {
    reasons.push(`inferred XC ${(inferredXcShare * 100).toFixed(0)}%, no round trips`)
    return { refinedPurpose: 'one_way_xc', reasons }
  }

  // Light pattern mix.
  if (agg.totalTouchAndGo >= 3 && agg.totalTouchAndGo < 10) {
    reasons.push(`light pattern work: ${agg.totalTouchAndGo} T&G across ${flights.length} flights`)
    return { refinedPurpose: 'mixed_pattern_xc', reasons }
  }

  // Split the residual by CAPTURE INTENSITY:
  //   long active per flight  → genuinely operating locally (just opaque purpose)
  //   short active per flight → caught while transiting the capture radius
  //   only 1 flight           → insufficient signal
  const avgMin = (agg.totalActiveHours * 60) / flights.length
  if (flights.length === 1) {
    reasons.push(`single ${avgMin.toFixed(0)}-min capture — insufficient`)
    return { refinedPurpose: 'insufficient_data', reasons }
  }
  if (avgMin < 12) {
    reasons.push(`avg ${avgMin.toFixed(0)} min/flight — transit through capture radius`)
    return { refinedPurpose: 'transient_overflight', reasons }
  }
  if (agg.dominantHome) {
    reasons.push(`home=${agg.dominantHome}, avg ${avgMin.toFixed(0)} min/flight — local but mission opaque`)
    return { refinedPurpose: 'unidentified_local', reasons }
  }
  reasons.push(`avg ${avgMin.toFixed(0)} min/flight, no home centroid, no airport endpoints`)
  return { refinedPurpose: 'unidentified_transient', reasons }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.error(`loading FAA registry …`)
  const REGISTRY = loadRegistry(REGISTRY_PATH)
  console.error(`registry has ${REGISTRY.size} entries`)

  console.error(`loading ${DAYS.length} days`)
  const tailMap = new Map()
  for (const dayPath of DAYS) {
    const j = JSON.parse(fs.readFileSync(dayPath, 'utf8'))
    console.error(`  ${path.basename(dayPath)} → ${j.tracks.length} tails`)
    for (const tr of j.tracks) {
      const key = tr.call || tr.reg || tr.hex
      if (!key) continue
      const flights = splitIntoFlights(tr.points || [], GAP_MIN)
      if (!flights.length) continue
      if (!tailMap.has(key)) tailMap.set(key, { tail: key, type: tr.type || '', flights: [] })
      const entry = tailMap.get(key)
      if (!entry.type && tr.type) entry.type = tr.type
      for (const f of flights) entry.flights.push({ rawPoints: f, day: dayPath })
    }
  }
  console.error(`${tailMap.size} tails across ${DAYS.length} days`)

  // First pass: classify per-flight, then aggregate tail-level base label.
  const tStart = Date.now()
  let nDone = 0
  for (const entry of tailMap.values()) {
    const flightResults = []
    for (const rec of entry.flights) {
      if (rec.rawPoints.length < MIN_POINTS_PER_FLIGHT) continue
      const points = pointsFromLive(rec.rawPoints)
      const features = extractFeatures(points, { typeCode: entry.type })
      if (features.activeWallClockS < MIN_ACTIVE_S) continue
      const verdict = classifyTrack(features, { typeCode: entry.type, tail: entry.tail })
      flightResults.push({
        startIcao: features.startIcao,
        endIcao: features.endIcao,
        inferredOriginIcao: features.inferredOriginIcao,
        inferredOriginDistNm: features.inferredOriginDistNm,
        inferredDestIcao: features.inferredDestIcao,
        inferredDestDistNm: features.inferredDestDistNm,
        homeIcao: features.homeIcao,
        homeTraits: features.homeTraits,
        tortuosity: features.tortuosity,
        bboxDiagNm: features.bboxDiagNm,
        altAglP50: features.altAglP50,
        altAglP90: features.altAglP90,
        cruiseSpeedKts: features.cruiseSpeedKts,
        cruiseAltMslFt: features.cruiseAltMslFt,
        speedBand: speedBand(features.cruiseSpeedKts),
        ifrCruiseS: features.ifrCruiseS,
        vfrCruiseS: features.vfrCruiseS,
        ifrCruiseShare: features.ifrCruiseShare,
        levelFraction: features.levelFraction,
        activeWallClockS: features.activeWallClockS,
        touchAndGo: features.maneuverCounts.touch_and_go,
        landedFullStop: features.maneuverCounts.landed_full_stop,
        practiceManeuvers: features.maneuverCounts.steep_turn
          + features.maneuverCounts.s_turns_across_road
          + features.maneuverCounts.chandelle
          + features.maneuverCounts.lazy_8
          + features.maneuverCounts.slow_flight
          + features.maneuverCounts.stall_recovery,
        flightPurpose: verdict.purpose,
        flightConf: verdict.confidence,
      })
      nDone++
      if (nDone % 200 === 0) console.error(`  ${nDone} flights @ ${(nDone / ((Date.now() - tStart) / 1000)).toFixed(1)}/s`)
    }
    entry.results = flightResults
  }
  console.error(`per-flight pass done in ${((Date.now() - tStart) / 1000).toFixed(1)}s`)

  // Aggregate per tail.
  const tailAggs = []
  for (const entry of tailMap.values()) {
    if (!entry.results || entry.results.length === 0) continue
    const flights = entry.results
    const totalActiveS = flights.reduce((a, f) => a + f.activeWallClockS, 0)
    const purposeShare = {}
    const speedBands = { very_slow: 0, slow_piston: 0, fast_piston: 0, high_perf_piston: 0, turboprop: 0, jet: 0 }
    const cruiseAlts = []
    let totalTouchAndGo = 0
    let totalIfrS = 0, totalVfrS = 0
    let directCount = 0, returnedCount = 0
    const homeCounts = {}
    const bboxes = []
    const altsP50 = []
    for (const f of flights) {
      purposeShare[f.flightPurpose] = (purposeShare[f.flightPurpose] || 0) + 1
      speedBands[f.speedBand]++
      if (f.cruiseAltMslFt > 0) cruiseAlts.push(f.cruiseAltMslFt)
      totalTouchAndGo += f.touchAndGo + f.landedFullStop
      totalIfrS += f.ifrCruiseS
      totalVfrS += f.vfrCruiseS
      if (f.tortuosity < 1.5 && f.bboxDiagNm > 15) directCount++
      if (f.bboxDiagNm < 5 && f.tortuosity > 5) returnedCount++
      if (f.homeIcao) homeCounts[f.homeIcao] = (homeCounts[f.homeIcao] || 0) + 1
      bboxes.push(f.bboxDiagNm)
      altsP50.push(f.altAglP50)
    }
    for (const k of Object.keys(purposeShare)) purposeShare[k] /= flights.length
    bboxes.sort((a, b) => a - b)
    altsP50.sort((a, b) => a - b)
    const medianBboxNm = bboxes[Math.floor(bboxes.length / 2)]
    const medianAltAglP50 = altsP50[Math.floor(altsP50.length / 2)]
    const dominantHome = Object.entries(homeCounts).sort(([, a], [, b]) => b - a)[0]?.[0] || null

    const ifrCruiseShareOverall = (totalIfrS + totalVfrS > 0) ? totalIfrS / (totalIfrS + totalVfrS) : 0

    const regRow = REGISTRY.get(entry.tail.toUpperCase())
    const ownerName = regRow?.owner || ''
    const ownerClass = classifyOwner(ownerName)
    const registryDesc = regRow?.desc || ''
    const registryYears = regRow?.years || ''

    const agg = {
      tail: entry.tail, typeCode: entry.type,
      ownerName, ownerClass, registryDesc, registryYears,
      registryFlights: regRow?.flights || 0,
      registryDaysSeen: regRow?.daysSeen || 0,
      totalFlights: flights.length, totalActiveS, totalActiveHours: totalActiveS / 3600,
      purposeShare, speedBands, cruiseAlts,
      totalTouchAndGo,
      ifrCruiseShareOverall, totalIfrS, totalVfrS,
      directShare: directCount / flights.length,
      medianBboxNm, medianAltAglP50,
      dominantHome,
      flights,
    }
    const refined = refineTailPurpose(agg)
    agg.refinedPurpose = refined.refinedPurpose
    agg.refineReasons = refined.reasons
    tailAggs.push(agg)
  }

  // Distribution of refined purposes.
  const refDist = {}
  for (const t of tailAggs) refDist[t.refinedPurpose] = (refDist[t.refinedPurpose] || 0) + 1

  // Filter to private_transport + other_ga tails by replicating the
  // BASE classifier from the earlier tail breakdown (we need to label
  // each tail as private_transport / flight_school / other_ga etc.
  // to know which ones the user asked about).
  function classifyTailBase(agg) {
    if (agg.totalFlights === 0) return 'unknown'
    const enginelessShare = 0 // we'd need feature, skip; engineless rare here
    if (agg.purposeShare.glider_local + agg.purposeShare.glider_xc > 0.5) return 'glider'
    if (agg.purposeShare.tow_plane >= 0.5) return 'tow_plane'
    if ((agg.purposeShare.training || 0) + (agg.purposeShare.pattern_solo || 0) >= 0.4
        || agg.totalTouchAndGo >= 10) return 'flight_school'
    if ((agg.purposeShare.airline || 0) >= 0.4) return 'airline'
    if ((agg.purposeShare.biz_jet || 0) + (agg.purposeShare.turboprop || 0) >= 0.4) return 'corporate'
    if ((agg.purposeShare.helicopter || 0) >= 0.4
        || (agg.typeCode && /^(R22|R44|R66|EC|AS|S76|B06|B40|B47|H50|H125|MD5)/.test(agg.typeCode.toUpperCase()))) return 'helicopter_ops'
    if (agg.directShare >= 0.5 && agg.totalTouchAndGo <= 1) return 'private_transport'
    if (agg.totalFlights >= 2 && agg.flights.filter(f => f.bboxDiagNm < 5 && f.tortuosity > 5).length / agg.totalFlights >= 0.5) return 'recreational'
    if (agg.totalFlights <= 2) return 'infrequent'
    return 'other_ga'
  }
  for (const t of tailAggs) t.baseLabel = classifyTailBase(t)

  // Filter to private_transport + other_ga.
  const target = tailAggs.filter(t => t.baseLabel === 'private_transport' || t.baseLabel === 'other_ga')
  target.sort((a, b) => b.totalFlights - a.totalFlights)

  console.log(`\n=== ${target.length} private_transport + other_ga tails ===`)
  console.log(`  private_transport: ${target.filter(t => t.baseLabel === 'private_transport').length}`)
  console.log(`  other_ga:          ${target.filter(t => t.baseLabel === 'other_ga').length}`)

  // ── First 15: detailed dump ─────────────────────────────────────────
  console.log(`\n=== First 15 tails — detailed dump ===`)
  for (const t of target.slice(0, 15)) {
    const flights = t.flights
    const sameAirportShare = flights.filter(f => f.startIcao && f.startIcao === f.endIcao).length / flights.length
    const xcShare = flights.filter(f => f.startIcao && f.endIcao && f.startIcao !== f.endIcao).length / flights.length
    const directShare = t.directShare
    const speedBandPretty = Object.entries(t.speedBands).filter(([, c]) => c > 0).map(([k, c]) => `${k}=${c}`).join(',')
    const routes = {}
    for (const f of flights) {
      const o = f.inferredOriginIcao
      const d = f.inferredDestIcao
      if (!o || !d) continue
      const k = o === d ? `${o}↺` : `${o}→${d}`
      routes[k] = (routes[k] || 0) + 1
    }
    const topRoutes = Object.entries(routes).sort(([, a], [, b]) => b - a).slice(0, 3)
      .map(([k, c]) => `${k}×${c}`).join(', ') || '(no airport endpoints)'
    const altsPretty = t.cruiseAlts.length ? t.cruiseAlts.slice(0, 5).map(a => Math.round(a / 100) * 100).join(',') : '-'
    console.log(`\n  ${t.tail.padEnd(10)} ${(t.typeCode || '?').padEnd(5)} base=${t.baseLabel.padEnd(17)} → refined=${t.refinedPurpose}`)
    console.log(`    owner: ${t.ownerName || '(not in registry)'} [${t.ownerClass}]`)
    console.log(`    ${flights.length} flights / ${t.totalActiveHours.toFixed(1)} h | home=${t.dominantHome || '-'}`)
    console.log(`    same-airport=${(sameAirportShare * 100).toFixed(0)}%  XC=${(xcShare * 100).toFixed(0)}%  direct=${(directShare * 100).toFixed(0)}%`)
    console.log(`    IFR-cruise=${(t.ifrCruiseShareOverall * 100).toFixed(0)}% (ifr=${Math.round(t.totalIfrS / 60)}m vfr=${Math.round(t.totalVfrS / 60)}m)`)
    console.log(`    cruise alts (ft): ${altsPretty}   speed bands: ${speedBandPretty}`)
    console.log(`    routes: ${topRoutes}`)
    console.log(`    refined reasons: ${t.refineReasons.join('; ')}`)
  }

  // Group-level stats across all target tails (private_transport + other_ga).
  let totalFlights = 0, sameAirport = 0, xc = 0, direct = 0
  let ifrSAll = 0, vfrSAll = 0
  const speedBandTotals = { very_slow: 0, slow_piston: 0, fast_piston: 0, high_perf_piston: 0, turboprop: 0, jet: 0 }
  const refinedPurposeDist = {}
  const refinedByBase = { private_transport: {}, other_ga: {} }
  for (const t of target) {
    refinedPurposeDist[t.refinedPurpose] = (refinedPurposeDist[t.refinedPurpose] || 0) + 1
    refinedByBase[t.baseLabel][t.refinedPurpose] = (refinedByBase[t.baseLabel][t.refinedPurpose] || 0) + 1
    for (const f of t.flights) {
      totalFlights++
      if (f.startIcao && f.startIcao === f.endIcao) sameAirport++
      if (f.startIcao && f.endIcao && f.startIcao !== f.endIcao) xc++
      if (f.tortuosity < 1.5 && f.bboxDiagNm > 15) direct++
      ifrSAll += f.ifrCruiseS
      vfrSAll += f.vfrCruiseS
      speedBandTotals[f.speedBand]++
    }
  }

  console.log(`\n=== Group stats — ${target.length} tails, ${totalFlights} total flights ===`)
  console.log(`  same-airport (dep=dest):   ${sameAirport}/${totalFlights} = ${(100 * sameAirport / totalFlights).toFixed(1)}%`)
  console.log(`  cross-country (dep≠dest):  ${xc}/${totalFlights} = ${(100 * xc / totalFlights).toFixed(1)}%`)
  console.log(`  no airport endpoints:      ${totalFlights - sameAirport - xc}/${totalFlights} = ${(100 * (totalFlights - sameAirport - xc) / totalFlights).toFixed(1)}%`)
  console.log(`  direct (tort<1.5, bbox>15): ${direct}/${totalFlights} = ${(100 * direct / totalFlights).toFixed(1)}%`)
  console.log(`  IFR cruise share:          ${(100 * ifrSAll / Math.max(1, ifrSAll + vfrSAll)).toFixed(1)}% (ifr=${Math.round(ifrSAll/3600)}h vfr=${Math.round(vfrSAll/3600)}h)`)
  console.log(`\n  Speed-band totals (per flight):`)
  for (const [k, v] of Object.entries(speedBandTotals)) {
    console.log(`    ${k.padEnd(18)} ${String(v).padStart(5)}  ${(100 * v / totalFlights).toFixed(1)}%`)
  }

  const ownerClassDist = {}
  let registryHits = 0
  for (const t of target) {
    ownerClassDist[t.ownerClass] = (ownerClassDist[t.ownerClass] || 0) + 1
    if (t.ownerName) registryHits++
  }
  console.log(`\n=== Owner-class distribution (FAA registry, ${registryHits}/${target.length} hits) ===`)
  for (const [k, v] of Object.entries(ownerClassDist).sort(([, a], [, b]) => b - a)) {
    console.log(`  ${k.padEnd(22)} ${String(v).padStart(4)}  ${(100 * v / target.length).toFixed(1)}%`)
  }

  console.log(`\n=== Refined-purpose distribution across the ${target.length} tails ===`)
  for (const [k, v] of Object.entries(refinedPurposeDist).sort(([, a], [, b]) => b - a)) {
    console.log(`  ${k.padEnd(28)} ${String(v).padStart(4)}  ${(100 * v / target.length).toFixed(1)}%`)
  }
  console.log(`\n=== Refined within base=private_transport ===`)
  for (const [k, v] of Object.entries(refinedByBase.private_transport).sort(([, a], [, b]) => b - a)) {
    console.log(`  ${k.padEnd(28)} ${String(v).padStart(4)}`)
  }
  console.log(`\n=== Refined within base=other_ga ===`)
  for (const [k, v] of Object.entries(refinedByBase.other_ga).sort(([, a], [, b]) => b - a)) {
    console.log(`  ${k.padEnd(28)} ${String(v).padStart(4)}`)
  }

  // Output JSON for the report.
  const reportObj = {
    days: DAYS,
    n_tails_total: tailAggs.length,
    n_target_tails: target.length,
    group_stats: {
      total_flights: totalFlights,
      same_airport_rate: sameAirport / totalFlights,
      xc_rate: xc / totalFlights,
      direct_rate: direct / totalFlights,
      ifr_cruise_share: ifrSAll / Math.max(1, ifrSAll + vfrSAll),
      ifr_hours: ifrSAll / 3600,
      vfr_hours: vfrSAll / 3600,
      speed_band_counts: speedBandTotals,
    },
    refined_distribution: refinedPurposeDist,
    refined_by_base: refinedByBase,
    tails: target,
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(reportObj, null, 2))
  console.log(`\nwrote ${OUT_PATH}`)
}

main().catch(e => { console.error(e); process.exit(1) })
