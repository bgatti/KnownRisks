// whatif.js — §11-CLIENT pure helpers for the What-If panel.
//
// Extracted from PointNoiseReport.jsx so the test suite can import them
// without dragging in React + leaflet. The page re-imports + re-exports
// these so the public API still lives on PointNoiseReport.jsx for
// backwards compatibility with any external consumer.
//
// Everything here is dependency-free pure JS. The page wires these
// against the dBA kernel in PointNoiseReport.jsx
// (estDbaAtListener + distFt from ./geo) to project per-segment dBA;
// for tests we accept a baseline dBA directly so the helpers stay
// kernel-agnostic.

/* ─── pickSubstituted ─────────────────────────────────────────────── */
/**
 * §11-CLIENT §4: deterministic substitute selection.
 *
 * Sort eligible tails ascending and take the first floor(N * pct/100)
 * — same input → same Set across re-renders (no flicker on slider tick
 * repeats, no random seed needed).
 */
export function pickSubstituted(tracks, code, pct) {
  if (!pct || pct <= 0) return new Set()
  const eligible = []
  for (const t of tracks || []) {
    const cands = t?.altAirframeCandidates || []
    if (cands.includes(code) && t.tail) eligible.push(t.tail)
  }
  eligible.sort()
  const k = Math.floor((eligible.length * pct) / 100)
  return new Set(eligible.slice(0, k))
}

/* ─── shouldWinchSegment ──────────────────────────────────────────── */
/**
 * §11-CLIENT §4: Winch is an AGL threshold rather than a fraction. A
 * segment qualifies when its lowest AGL point falls below the slider
 * value. Threshold <= 0 means winch is off entirely.
 */
export function shouldWinchSegment(seg, threshold_ft, listenerElevFt) {
  if (!threshold_ft || threshold_ft <= 0) return false
  const pts = seg?.points
  if (!Array.isArray(pts) || pts.length === 0) return false
  let lowest = Infinity
  for (const p of pts) {
    const altMsl = p?.[2]
    if (altMsl == null) continue
    const agl = altMsl - listenerElevFt
    if (agl < lowest) lowest = agl
  }
  if (!Number.isFinite(lowest)) return false
  return lowest < threshold_ft
}

/* ─── segmentDba ──────────────────────────────────────────────────── */
// Airframe substitutes in priority order. Hoisted out of segmentDba so a
// hot-path call (one per segment × one per track) doesn't allocate this
// array each invocation.
const AIRFRAME_SUB_CODES = ['VELE', 'EFOX', 'SINU']

/**
 * §11-CLIENT §5: per-segment dBA in the scenario world.
 *
 * 1. Winch wins (it's a launch system, not an airframe swap).
 * 2. VELE / EFOX / SINU — first match wins; null entries fall through
 *    to baseline (substitute is a track candidate but doesn't apply
 *    to this individual segment).
 * 3. Otherwise the caller's baseline dBA.
 */
export function segmentDba(track, seg, scenario, listenerElevFt, baseDbaForSeg) {
  const tail = track?.tail
  if (!tail) return baseDbaForSeg
  if (scenario?.winchTracks?.has(tail)
      && shouldWinchSegment(seg, scenario.winch_agl_ft, listenerElevFt)) {
    return 0
  }
  const map = seg?.alt_dba_by_substitute
  if (map && scenario?.substituted) {
    for (const code of AIRFRAME_SUB_CODES) {
      if (scenario.substituted[code]?.has(tail)) {
        const v = map[code]
        if (v != null) return v
      }
    }
  }
  return baseDbaForSeg
}

/* ─── npv ─────────────────────────────────────────────────────────── */
/**
 * §11-CLIENT §7: standard discounted-cash-flow NPV.
 *   NPV = −CapEx + Σ (annualSavings / (1+r)^t) for t = 1..years
 *       + salvage / (1+r)^years
 */
export function npv({ capex, annualSavings, salvage, rate, years }) {
  let pv = -capex
  for (let t = 1; t <= years; t++) pv += annualSavings / Math.pow(1 + rate, t)
  pv += salvage / Math.pow(1 + rate, years)
  return Math.round(pv)
}

/* ─── businessModelColumn ─────────────────────────────────────────── */
/**
 * §11-CLIENT §7: build one column of the business-model table for an
 * active substitute. Returns the rolled-up inputs + NPV + the inverse
 * (break-even hours / $-per-dB).
 *
 * nAirframes is the distinct count of substituted tails for airframe
 * subs, or 1 for the shared-system winch.
 */
export function businessModelColumn({ sub, scenario, nAirframes, dbDelta }) {
  if (!sub || nAirframes <= 0) return null
  const hours = scenario.annual_hours_override?.[sub.code]
    ?? sub.annual_hours_typical ?? 400
  const opSavingsPerHr = (sub.op_savings_per_hr_usd ?? 0) * (scenario.fuel_multiplier ?? 1)
  const annualSavings = opSavingsPerHr * hours * nAirframes
  const capexPerUnit = sub.cap_ex_usd ?? 0
  const capex = capexPerUnit * nAirframes
  const salvage = capex * (sub.residual_value_pct ?? 0)
  const years = scenario.horizon_yr ?? 10
  const rate = scenario.rate ?? 0.05
  const totalNpv = npv({ capex, annualSavings, salvage, rate, years })
  const opSavingsUndiscounted = annualSavings * years
  // Break-even hours/year per airframe: solve annualSavings = capex −
  // salvagePV divided by the PV-of-annuity factor.
  let breakEvenHours = null
  if (totalNpv < 0 && opSavingsPerHr > 0 && nAirframes > 0) {
    let pvFactor = 0
    for (let t = 1; t <= years; t++) pvFactor += 1 / Math.pow(1 + rate, t)
    const salvagePv = salvage / Math.pow(1 + rate, years)
    const requiredAnnual = (capex - salvagePv) / pvFactor
    breakEvenHours = Math.round(requiredAnnual / (opSavingsPerHr * nAirframes))
  }
  const dollarsPerDb = (dbDelta != null && dbDelta > 0 && totalNpv < 0)
    ? Math.round(Math.abs(totalNpv) / dbDelta)
    : null
  return {
    code: sub.code,
    name: sub.name,
    nAirframes,
    capex,
    annualSavings,
    opSavingsUndiscounted,
    salvage,
    npv: totalNpv,
    dollarsPerDb,
    breakEvenHours,
    hoursPerYr: hours,
    opSavingsPerHr,
    years,
    rate,
  }
}
