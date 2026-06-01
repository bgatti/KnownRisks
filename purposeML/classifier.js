// classifier.js — per-flight purpose heuristic.
const MIN_FEATURES = { nPoints: 30, durationS: 300 }

export function classifyTrack(features, ctx = {}) {
  const { typeCode = '', tail = '', isSchoolFleet = false } = ctx
  const reasons = []
  const mc = features.maneuverCounts
  const ps = features.phaseSeconds
  const totalLandings = (mc.touch_and_go || 0) + (mc.landed_full_stop || 0)
  const patternS = ps.pattern || 0
  const practiceS = ps.practice_area || 0

  const effectiveS = features.activeWallClockS || features.durationS
  if (features.nPoints < MIN_FEATURES.nPoints || effectiveS < MIN_FEATURES.durationS) {
    return { purpose: 'unknown', confidence: 0.0,
             reasons: [`track too short (n=${features.nPoints}, active=${Math.round(effectiveS)}s)`] }
  }

  if (features.enginelessShare === 1) {
    if (mc.thermalling >= 1 && features.loiterRadiusNm < 5) {
      return { purpose: 'glider_local', confidence: 0.95, reasons: [`engineless thermalling`] }
    }
    if (features.bboxDiagNm > 30 && features.maxDescentFpm > -500) {
      return { purpose: 'glider_xc', confidence: 0.9, reasons: [`engineless XC`] }
    }
    if (features.tortuosity > 5 && features.loiterRadiusNm < 5) {
      return { purpose: 'glider_local', confidence: 0.85, reasons: [`engineless local`] }
    }
  }

  if (totalLandings >= 3
      && features.altAglP90 < 4500
      && features.maxClimbFpm > 700
      && features.homeTraits.gliderPort) {
    return { purpose: 'tow_plane', confidence: 0.92, reasons: [`tow cycles at glider port`] }
  }

  if (totalLandings >= 3 && patternS >= 300 && features.altAglP90 < 2500) {
    if (isSchoolFleet) return { purpose: 'training', confidence: 0.92, reasons: [`school T&G`] }
    if (features.homeTraits.primaryTrainer) return { purpose: 'pattern_solo', confidence: 0.8, reasons: [`T&G at trainer field`] }
    return { purpose: 'pattern_solo', confidence: 0.72, reasons: [`T&G generic`] }
  }

  const practiceManeuverCount = (mc.steep_turn + mc.s_turns_across_road
    + mc.turn_around_a_point + mc.chandelle + mc.lazy_8
    + mc.slow_flight + mc.stall_recovery)
  if ((practiceManeuverCount >= 2 || (practiceS >= 300 && features.bboxDiagNm < 8))
      && features.altAglP90 < 6000) {
    if (isSchoolFleet) return { purpose: 'training', confidence: 0.92, reasons: [`school practice`] }
    return { purpose: 'pattern_solo', confidence: 0.78, reasons: [`practice area`] }
  }

  if (features.gridScore > 0.5
      && features.tortuosity > 3
      && features.altAglP50 < 5000
      && features.bboxDiagNm > 8
      && totalLandings < 2
      && features.levelFraction > 0.5
      && features.cruiseSpeedKts > 60
      && features.cruiseSpeedKts < 200) {
    return { purpose: 'survey', confidence: 0.82, reasons: [`grid pattern`] }
  }

  const orbitCount = (mc.sightseeing_orbit || 0) + (mc.holding_pattern || 0)
  if (orbitCount >= 1 && features.loiterRadiusNm < 3 && features.bboxDiagNm < 8
      && features.activeWallClockS > 1200 && totalLandings === 0) {
    return { purpose: 'patrol', confidence: 0.75, reasons: [`orbit/holding`] }
  }

  if (features.tortuosity < 1.2 && features.altAglP50 > 22000 && features.cruiseSpeedKts > 350) {
    return { purpose: 'airline', confidence: 0.95, reasons: [`FL220+ direct`] }
  }
  if (features.tortuosity < 1.4 && features.altAglP50 > 16000 && features.cruiseSpeedKts > 280) {
    return { purpose: 'biz_jet', confidence: 0.85, reasons: [`high cruise`] }
  }
  if (features.tortuosity < 1.5 && features.altAglP50 > 12000 && features.altAglP50 <= 22000
      && features.cruiseSpeedKts > 180 && features.cruiseSpeedKts <= 320
      && features.levelFraction > 0.4) {
    return { purpose: 'turboprop', confidence: 0.78, reasons: [`turboprop profile`] }
  }

  if (features.tortuosity < 1.5
      && features.airportsVisited.length >= 2
      && features.startIcao && features.endIcao
      && features.startIcao !== features.endIcao
      && features.cruiseSpeedKts > 90 && features.cruiseSpeedKts < 200
      && features.bboxDiagNm > 15) {
    return { purpose: 'ga_xc', confidence: 0.78, reasons: [`A→B GA XC`] }
  }

  if (features.returnedToOrigin && features.bboxDiagNm < 30 && features.bboxDiagNm > 2
      && features.cruiseSpeedKts > 60 && features.cruiseSpeedKts < 250 && totalLandings <= 2) {
    return { purpose: 'ga_local', confidence: 0.7, reasons: [`local round trip`] }
  }

  if (features.cruiseSpeedKts > 25 && features.cruiseSpeedKts < 90
      && features.altAglP50 < 3000 && features.bboxDiagNm < 15) {
    if (/^(R22|R44|R66|EC|AS|S76|B06|B40|B47|H50|H125|MD5)/.test(typeCode.toUpperCase())) {
      return { purpose: 'helicopter', confidence: 0.85, reasons: [`heli type + slow/low`] }
    }
    return { purpose: 'ga_local', confidence: 0.55, reasons: [`slow/low GA`] }
  }

  if (features.cruiseSpeedKts > 60 && features.cruiseSpeedKts < 250 && features.altAglP50 < 12000) {
    return { purpose: 'ga_local', confidence: 0.5, reasons: [`GA-band fallback`] }
  }

  return { purpose: 'unknown', confidence: 0.3, reasons: [`no rule matched`] }
}
