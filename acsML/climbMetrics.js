// climbMetrics.js — initial climb rate (every aircraft) + tow-cycle
// enrichment (release altitudes + per-cycle climb rate) for sorties
// with multiple steep-climb-then-descent peaks.
//
// All metrics consume phaseML's enriched Sample stream so we get
// smoothed VS / GS for free.

import { nearestAirport } from '../phaseML/airports.js'

// Operator brief 2026-06-01:
//   "for tow flights, we want to enrich with avg rate of climb and
//    point of release (highest altitude). for all aircraft we want
//    to capture the initial rate of climb (use phaseML?)"

// ── Initial climb (any aircraft) ────────────────────────────────────────
//
// Window: first INITIAL_CLIMB_WINDOW_S of samples starting at each
// takeoff event (observed OR implied). For each takeoff we report:
//   - mean_fpm:  mean VS over the window
//   - peak_fpm:  max VS in the window
//   - duration_s: actual window length (capped by track end)
//   - sample_count: how many samples contributed
//
// Returned as an ARRAY (one entry per takeoff). The sortie-level
// "initial climb rate" is the FIRST entry — if you want averages
// across takeoffs you can sum/mean yourself.
const INITIAL_CLIMB_WINDOW_S = 60

export function initialClimbMetrics(samples, takeoffs) {
  const out = []
  if (!Array.isArray(samples) || !samples.length || !Array.isArray(takeoffs)) return out
  for (const to of takeoffs) {
    if (to.idx == null) continue
    const t0 = samples[to.idx]?.point.tsUnix
    if (t0 == null) continue
    let meanSum = 0, n = 0, peak = -Infinity, endTs = t0
    for (let i = to.idx; i < samples.length; i++) {
      const s = samples[i]
      if (s.isSessionBreak) break
      if (s.point.tsUnix - t0 > INITIAL_CLIMB_WINDOW_S) break
      meanSum += s.vsFpm
      n++
      if (s.vsFpm > peak) peak = s.vsFpm
      endTs = s.point.tsUnix
    }
    if (n === 0) continue
    out.push({
      ts: t0,
      mean_fpm: Math.round(meanSum / n),
      peak_fpm: Math.round(peak === -Infinity ? 0 : peak),
      duration_s: endTs - t0,
      sample_count: n,
      airport: to.airportIcao || null,
      implied: !!to.implied,
    })
  }
  return out
}

// ── Sortie peak altitude (any aircraft) ─────────────────────────────────
//
// Highest fix in the sortie. Reported as both MSL and AGL above the
// nearest known airport (a rough proxy when no home field is set).
export function sortiePeakAltitude(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return null
  let bestIdx = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].point.altMslFt > samples[bestIdx].point.altMslFt) bestIdx = i
  }
  const p = samples[bestIdx].point
  const { airport } = nearestAirport(p.lat, p.lon, { maxNm: 50 })
  const aglFt = airport ? Math.round(p.altMslFt - airport.fieldElevFt) : null
  return {
    ts: p.tsUnix,
    msl_ft: Math.round(p.altMslFt),
    agl_ft: aglFt,
    nearest_airport: airport?.icao || null,
    lat: +p.lat.toFixed(5),
    lon: +p.lon.toFixed(5),
  }
}

// ── Climb cycles (track-shape based — TOW + PRACTICE both match) ────────
//
// An ALT-CURVE "climb cycle" is the fingerprint: takeoff/low →
// sustained CLIMB → PEAK → sustained DESCENT → low. Operator brief:
// for tow flights we want avg climb rate + release altitude. The
// SAME shape also matches GA practice flights (climb to practice
// area at 2000-3000 AGL → maneuver → descend → repeat).
//
// We surface the cycles HONESTLY as `climb_cycles` — caller can
// classify by type / purposeML to decide whether these are tow ops
// vs practice work vs something else. Consumers wanting tow-only:
//   sortie.sortie_acs.phase_summary.tow_cycles = (sortie.sortie_purpose === 'tow_plane'
//       || /^(PA25|PA18|PIAT|PC6)$/.test(sortie.sortie_type))
//     ? phase_summary.climb_cycles : []
//
// Detection (per cycle):
//   1. Find each local altitude MAXIMUM that has:
//        - climb gain ≥ TOW_MIN_ALT_GAIN_FT leading up (the climb leg)
//        - descent ≥ TOW_MIN_ALT_GAIN_FT following (the descent leg)
//        - mean VS during ACTIVE-climbing samples > TOW_CLIMB_MIN_FPM
//        - leading climb wall-clock duration > TOW_CLIMB_MIN_S
//   2. For that peak, walk backwards along the climb to find the
//      low point that started this climb (cycle_start).
// Tow climbs end at typical release altitude 2000-3500 ft AGL — a
// gain of 1500+ ft from takeoff. Pattern laps gain ~800-1000 ft;
// the higher threshold filters them out.
const TOW_MIN_ALT_GAIN_FT = 1500
// Tow plane climbing with a glider on tow runs ~400-700 fpm.
const TOW_CLIMB_MIN_FPM = 300
// A real tow climb takes 3-9 min. Pattern T&G cycles take ~3 min
// total (~1 min climb out, 2 min lap). 180 s eliminates the
// pattern false-positives without rejecting marginal short-tow days.
const TOW_CLIMB_MIN_S = 180
// Surface even single-cycle days — one tow with the right alt + climb
// shape is itself informative. Consumers can apply their own
// "is this an active tow sortie" threshold.
const TOW_MIN_CYCLES = 1

export function climbCycleMetrics(samples) {
  const out = []
  if (!Array.isArray(samples) || samples.length < 30) return out

  // First, find all local maxima with a meaningful prominence.
  // We use a simple "lookback / lookforward" prominence check.
  // session-break samples are STILL valid peak candidates — the
  // alt is meaningful even when the gap-flagged kinematics aren't.
  // (PA18 N2456J's tow release in the day's data sits right after a
  // 10-min ADS-B coverage gap; skipping break samples loses it.)
  const peaks = []
  for (let i = 5; i < samples.length - 5; i++) {
    const alt = samples[i].point.altMslFt
    let isMax = true
    for (let k = i - 5; k <= i + 5; k++) {
      if (k === i) continue
      if (k < 0 || k >= samples.length) continue
      if (samples[k].point.altMslFt > alt) { isMax = false; break }
    }
    if (!isMax) continue
    peaks.push(i)
  }

  // For each peak, walk backwards to find the climb's starting low,
  // then verify the climb leg meets all the gates. Also walk forward
  // to verify a descent leg.
  for (const peakIdx of peaks) {
    const peakAlt = samples[peakIdx].point.altMslFt

    // Climb leg: walk back while alt is monotonically lower OR within
    // a 50-ft wobble. Stop at session break or when we'd cross a
    // previously-found peak's start.
    let climbStart = peakIdx
    let climbMinAlt = peakAlt
    for (let j = peakIdx - 1; j >= 0; j--) {
      if (samples[j].isSessionBreak) break
      const a = samples[j].point.altMslFt
      // Accept descent (older alt is lower) — that's the climb origin.
      if (a < climbMinAlt) {
        climbMinAlt = a
        climbStart = j
      }
      // Stop if we've climbed back UP after dropping (means we hit
      // a previous cycle's descent leg).
      if (a > climbMinAlt + 100) break
    }
    if (peakAlt - climbMinAlt < TOW_MIN_ALT_GAIN_FT) continue

    const climbDurS = samples[peakIdx].point.tsUnix - samples[climbStart].point.tsUnix
    if (climbDurS < TOW_CLIMB_MIN_S) continue
    // Average rate over the WHOLE leg dilutes through cruise plateaus
    // and ADS-B coverage gaps. Compute it over the CLIMBING portion
    // only (samples where the smoothed VS is positive) for a result
    // that reflects what the tow plane was actually doing while it
    // was climbing.
    let climbActiveS = 0
    for (let j = climbStart + 1; j <= peakIdx; j++) {
      if (samples[j].isSessionBreak) continue
      if (samples[j].vsFpm > 50) climbActiveS += samples[j].dtS
    }
    const effectiveDurS = climbActiveS > 0 ? climbActiveS : climbDurS
    const climbRateFpm = ((peakAlt - climbMinAlt) / effectiveDurS) * 60
    if (climbRateFpm < TOW_CLIMB_MIN_FPM) continue

    // Descent leg verification: walk forward looking for a sustained
    // descent of at least TOW_MIN_ALT_GAIN_FT. If we don't find one,
    // this peak is mid-cruise oscillation, not a tow release.
    let descentEnd = peakIdx
    let descentMinAlt = peakAlt
    for (let j = peakIdx + 1; j < samples.length; j++) {
      if (samples[j].isSessionBreak) break
      const a = samples[j].point.altMslFt
      if (a < descentMinAlt) {
        descentMinAlt = a
        descentEnd = j
      }
      if (a > descentMinAlt + 100) break
    }
    if (peakAlt - descentMinAlt < TOW_MIN_ALT_GAIN_FT) continue

    const p = samples[peakIdx].point
    const { airport } = nearestAirport(p.lat, p.lon, { maxNm: 50 })
    const releaseAglFt = airport ? Math.round(peakAlt - airport.fieldElevFt) : null

    out.push({
      cycle_start_ts: samples[climbStart].point.tsUnix,
      release_ts: p.tsUnix,
      release_msl_ft: Math.round(peakAlt),
      release_agl_ft: releaseAglFt,
      climb_origin_msl_ft: Math.round(climbMinAlt),
      climb_alt_gain_ft: Math.round(peakAlt - climbMinAlt),
      // wall-clock duration of the climb leg (start-of-climb to peak)
      climb_duration_s: Math.round(climbDurS),
      // effective active-climbing duration (samples where VS > 50 fpm)
      // — excludes cruise plateaus and ADS-B coverage gaps
      climb_active_s: Math.round(effectiveDurS),
      // avg climb rate over the ACTIVE climbing portion (not diluted
      // by cruise plateaus / coverage gaps)
      avg_climb_rate_fpm: Math.round(climbRateFpm),
      release_lat: +p.lat.toFixed(5),
      release_lon: +p.lon.toFixed(5),
      nearest_airport: airport?.icao || null,
    })
  }

  // Threshold: we only call this "tow ops" if there are TOW_MIN_CYCLES
  // distinct climb-release-descent cycles.
  if (out.length < TOW_MIN_CYCLES) return []
  return out
}

// ── Composer used by identifier.js ──────────────────────────────────────
export function computeClimbMetrics(samples, takeoffs) {
  return {
    initial_climb: initialClimbMetrics(samples, takeoffs),
    peak_alt: sortiePeakAltitude(samples),
    climb_cycles: climbCycleMetrics(samples),
  }
}
