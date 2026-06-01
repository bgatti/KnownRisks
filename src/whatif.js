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

/* ─── pickEliminated ──────────────────────────────────────────────── */
/**
 * §11-CLIENT V2 §2a: deterministic track-elimination selection for
 * `scope: "track_eliminate"` substitutes (ATPR, SIMX). Slider value
 * is "% of max effect" (0..100); `max_reduction_pct` on the substitute
 * is the policy-realistic cap. Effective reduction = slider × max / 100.
 *
 * Mirrors pickSubstituted's determinism rule — sort eligible tails
 * ascending, take the first floor(N * effectivePct/100). Same input →
 * same Set across re-renders.
 *
 * Returns empty Set when:
 *   - slider <= 0
 *   - code not found in the substitute registry
 *   - substitute's scope is not "track_eliminate"
 *   - no tracks match the substitute's replaces_purposes
 */
export function pickEliminated(tracks, code, sliderPct, substitutes) {
  if (!sliderPct || sliderPct <= 0) return new Set()
  if (!Array.isArray(substitutes)) return new Set()
  const sub = substitutes.find((s) => s?.code === code)
  if (!sub || sub.scope !== 'track_eliminate') return new Set()
  const replaces = sub.replaces_purposes || []
  const eligible = []
  for (const t of tracks || []) {
    if (t?.purpose && replaces.includes(t.purpose) && t.tail) eligible.push(t.tail)
  }
  eligible.sort()
  const maxPct = Number(sub.max_reduction_pct) || 0
  const effectivePct = (sliderPct * maxPct) / 100
  const k = Math.floor((eligible.length * effectivePct) / 100)
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
    mechanism: 'Airframe substitution',
  }
}

/* ─── regulatoryColumn ────────────────────────────────────────────── */
/**
 * §11-CLIENT V2 §4: business-model column for `scope: "track_eliminate"`
 * substitutes. Different shape from airframe subs — these aren't a fleet
 * purchase, they're a regulatory change, so the NPV reads differently:
 *
 *   ATPR — `cap_ex_usd = 0`. NPV is purely the one-time advocacy capex
 *          (`-sub.advocacy_capex_usd`). No per-flight op savings flow
 *          into the noise-abatement ROI — the flights just don't happen.
 *
 *   SIMX — standard NPV but `nAirframes` = `nSchoolsAffected` (one FTD
 *          per school), `annual_hours_typical` is the sim's hours
 *          (~1500, not the displaced flight hours), and the registry's
 *          `op_savings_per_hr_usd` is negative (sim is cheaper than the
 *          plane). We flip the sign so positive = annual savings from
 *          the school's perspective.
 */
export function regulatoryColumn({ sub, scenario, nSchoolsAffected, dbDelta }) {
  if (!sub || sub.scope !== 'track_eliminate' || nSchoolsAffected <= 0) return null
  const years = scenario.horizon_yr ?? 10
  const rate = scenario.rate ?? 0.05
  const fuelMult = scenario.fuel_multiplier ?? 1

  if (sub.code === 'ATPR') {
    const advocacy = Number(sub.advocacy_capex_usd) || 0
    const totalNpv = -advocacy
    const dollarsPerDb = (dbDelta != null && dbDelta > 0 && totalNpv < 0)
      ? Math.round(Math.abs(totalNpv) / dbDelta)
      : null
    return {
      code: sub.code,
      name: sub.name,
      // Header reads "× N". For ATPR we surface the count of tracks the
      // regulatory rollback removed — that's the visible scale of effect.
      nAirframes: nSchoolsAffected,
      capex: advocacy,
      annualSavings: 0,
      opSavingsUndiscounted: 0,
      salvage: 0,
      npv: totalNpv,
      dollarsPerDb,
      breakEvenHours: null,
      hoursPerYr: 0,
      opSavingsPerHr: 0,
      years,
      rate,
      mechanism: 'Regulatory rollback',
      capexNote: 'one-time advocacy campaign',
    }
  }

  if (sub.code === 'SIMX') {
    const capexPerUnit = Number(sub.cap_ex_usd) || 0
    const capex = capexPerUnit * nSchoolsAffected
    // School-perspective savings: registry value is negative (sim is cheaper)
    // — flip sign so positive = annual savings.
    const opSavingsPerHr = -(Number(sub.op_savings_per_hr_usd) || 0) * fuelMult
    const hours = scenario.annual_hours_override?.[sub.code]
      ?? Number(sub.annual_hours_typical) ?? 1500
    const annualSavings = opSavingsPerHr * hours * nSchoolsAffected
    const salvage = capex * (Number(sub.residual_value_pct) || 0)
    const totalNpv = npv({ capex, annualSavings, salvage, rate, years })
    const opSavingsUndiscounted = annualSavings * years
    let breakEvenHours = null
    if (totalNpv < 0 && opSavingsPerHr > 0 && nSchoolsAffected > 0) {
      let pvFactor = 0
      for (let t = 1; t <= years; t++) pvFactor += 1 / Math.pow(1 + rate, t)
      const salvagePv = salvage / Math.pow(1 + rate, years)
      const requiredAnnual = (capex - salvagePv) / pvFactor
      breakEvenHours = Math.round(requiredAnnual / (opSavingsPerHr * nSchoolsAffected))
    }
    const dollarsPerDb = (dbDelta != null && dbDelta > 0 && totalNpv < 0)
      ? Math.round(Math.abs(totalNpv) / dbDelta)
      : null
    return {
      code: sub.code,
      name: sub.name,
      nAirframes: nSchoolsAffected,
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
      mechanism: 'FAA Part 61 rulemaking + per-school FTD',
      capexNote: `${nSchoolsAffected} school${nSchoolsAffected === 1 ? '' : 's'} × $${(capexPerUnit / 1000).toFixed(0)}k FTD`,
    }
  }

  return null
}
