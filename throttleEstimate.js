// throttleEstimate.js — per-fix throttle setting estimator (0..1).
//
// Operator brief 2026-06-03: "we need throttle estimate for each
// node in flight path. assume full throttle at takeoff — this tells
// us what the engine can do at max (climb and speed). use some
// aeronautical tables to figure out how much power is required to
// climb at vs and to maintain level flight at various speeds
// relative to climbout (usually VY) — might need a trained ML based
// on type etc... but aircraft should already have an estimate for HP."
//
// Model (v0, table-anchored, no ML yet):
//
//   throttle ≈ climb_fraction + level_flight_fraction
//
// where
//
//   climb_fraction         = max(0, vs_fpm / vs_max_fpm)
//   level_flight_fraction  = (gs_kts / cruise_kts)^3 × cruise_throttle
//
// The cubic on speed reflects the parasitic-drag dominance at higher
// speeds (≈ v^3 power required for level flight). The cruise_throttle
// constant (~ 0.72 piston, 0.85 turbine) anchors "at this speed,
// flying level, this is how much power is needed."
//
// Calibration at takeoff: the operator's intuition — at the first
// real airborne fix, the aircraft was at full throttle. We record
// the model's prediction at that fix as `throttle_at_takeoff` so
// operators can spot when the table is off (table's vs_max underread
// → takeoff estimate > 1.0 before clipping; over-read → < 0.9).
//
// What this CAN'T tell you without more inputs:
//   - Wind. GS is used as a TAS proxy; a 25-kt headwind makes a
//     cruise-throttle aircraft look like it's at 50% throttle.
//   - Density altitude. Engine power drops ~ 3% per 1,000 ft above
//     standard density alt. At KBDU (5,288 ft) on a hot day, an NA
//     piston has ~ 70% of sea-level power. We compensate roughly with
//     a per-airport altitude derate when called with `densityAlt`.
//   - Pilot pulling power without descending (e.g., on the downwind
//     leg of a pattern). The model will read level + slow as low
//     throttle, which is correct in this case.
//   - Boosted / turbocharged engines compensating for altitude. Their
//     vs_max stays near sea-level until critical altitude.
//
// The estimate is intended as an *indicator* (color a track by
// throttle, find the "loudest moments" by sustained high throttle),
// not as a number for litigation.

const CLIMB_FRAC_CAP = 1.0
const LEVEL_FRAC_CAP = 1.0
const IDLE_FLOOR = 0.05  // engines never go to 0 in flight — idle keeps
                          // cooling and prop-driven instruments alive

// Optional: simple density-altitude derate. Returns multiplier in
// [0..1] for `vs_max_fpm` and `cruise_kts` at the given alt vs sea
// level. NA pistons: ~3% per 1000 ft; turbocharged / turbine: flat
// until critical altitude.
function altitudeDerate(altMslFt, isTurboOrTurbine = false) {
  if (altMslFt == null || altMslFt < 0) return 1.0
  if (isTurboOrTurbine) {
    // Roughly flat to FL200 (critical alt assumption); modest fall above.
    return altMslFt < 20000 ? 1.0 : Math.max(0.6, 1.0 - (altMslFt - 20000) / 30000)
  }
  // NA piston: ~3% / 1000 ft above sea level
  return Math.max(0.5, 1.0 - 0.03 * (altMslFt / 1000))
}

function isTurbineOrTurboType(perf) {
  // Crude — table cruise_throttle ≥ 0.85 currently flags
  // turbine/turbo-anchored entries.
  return perf && perf.cruise_throttle >= 0.85
}

// estimateThrottle — main entry point.
//
//   gsKts:      ground speed at this fix (kts)
//   vsFpm:      vertical speed at this fix (fpm)
//   altMslFt:   altitude (ft MSL)
//   perf:       output of aircraftPerf.perfForType(type)
//
// Returns: { throttle: 0..1, climb_frac, level_frac, derate }
export function estimateThrottle(gsKts, vsFpm, altMslFt, perf) {
  if (!perf || perf.vs_max_fpm <= 0) {
    // Engineless (glider/balloon) → no throttle to estimate. Honest null.
    return null
  }
  // Derate the CLIMB ceiling only. Power-required at constant TAS
  // scales with air density, so it falls off with altitude in lockstep
  // with engine power — meaning the cruise-throttle setting at a
  // published cruise TAS is roughly altitude-independent. We do NOT
  // derate cruise_kts (doing so was producing > 1.0 throttle for level
  // cruise at altitude, which is the opposite of reality).
  const derate = altitudeDerate(altMslFt, isTurbineOrTurboType(perf))
  const vsMax = perf.vs_max_fpm * derate
  const cruiseRefKts = perf.cruise_kts

  const climbFrac = vsMax > 0 ? Math.min(CLIMB_FRAC_CAP, Math.max(0, (vsFpm || 0) / vsMax)) : 0
  let levelFrac = 0
  if (cruiseRefKts > 0 && gsKts != null) {
    const speedRatio = Math.max(0, gsKts) / cruiseRefKts
    levelFrac = Math.min(LEVEL_FRAC_CAP, Math.pow(speedRatio, 3) * perf.cruise_throttle)
  }
  let throttle = climbFrac + levelFrac
  // Clip 0..1 and apply idle floor when airborne (alt > 200 ft AGL is
  // a rough surrogate; we don't have field elev here so use 1000 MSL).
  if (throttle > 1.0) throttle = 1.0
  if (throttle < IDLE_FLOOR && altMslFt != null && altMslFt > 1000) throttle = IDLE_FLOOR

  return {
    throttle: Math.round(throttle * 1000) / 1000,
    climb_frac: Math.round(climbFrac * 1000) / 1000,
    level_frac: Math.round(levelFrac * 1000) / 1000,
    derate: Math.round(derate * 1000) / 1000,
  }
}

// Compute gs (kts) and vs (fpm) from two consecutive fixes.
//   a, b: [lat, lon, alt_msl_ft, ts_ms, ...]
// Returns { gs_kts, vs_fpm } or nulls when the fixes are too far apart in time.
export function gsVsFromPair(a, b, distNmFn) {
  if (!a || !b || a[3] == null || b[3] == null) return { gs_kts: null, vs_fpm: null }
  const dtS = (b[3] - a[3]) / 1000
  if (dtS <= 0 || dtS > 60) return { gs_kts: null, vs_fpm: null }
  const distNm = distNmFn(a[0], a[1], b[0], b[1])
  const gs = (distNm / dtS) * 3600
  let vs = null
  if (a[2] != null && b[2] != null) {
    vs = ((b[2] - a[2]) / dtS) * 60
  }
  return { gs_kts: gs, vs_fpm: vs }
}
