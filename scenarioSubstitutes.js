// scenarioSubstitutes.js — Ask #11 What-If helpers.
//
// Pure helpers for matching tracks against the substitute registry
// (public/substitutes.json) and projecting a substitute's dBA at a listener.
// Lives in its own module so /api/excursions/segments AND the test suite can
// share the exact same logic. See API_REQUEST.md Ask #11 for the spec.

// Internal: a track matches a substitute when its TYPE is in replaces_types
// OR its PURPOSE is in replaces_purposes. Either — not both. A C172 training
// flight matches VELE via type; a glider with no purpose tag still matches
// SINU via type.
function _subMatchesTrack(track, sub) {
  const T = String(track?.type || '').toUpperCase()
  const P = String(track?.purpose || '').toLowerCase()
  const types = (sub.replaces_types || []).map((s) => String(s).toUpperCase())
  const purposes = (sub.replaces_purposes || []).map((s) => String(s).toLowerCase())
  if (T && types.includes(T)) return true
  if (P && purposes.includes(P)) return true
  return false
}

// Whole-track substitutes (scope=track) — VELE, EFOX, SINU. WNCH (scope=segment)
// is excluded by design; use pickSegmentCandidates for that.
export function pickTrackCandidates(track, subs) {
  const out = []
  for (const sub of subs || []) {
    if (sub?.scope !== 'track') continue
    if (_subMatchesTrack(track, sub)) out.push(sub.code)
  }
  return out
}

// Sub-segment substitutes (scope=segment) — WNCH. Returns a record per match
// so the client knows the AGL cutoff the substitute applies below.
export function pickSegmentCandidates(track, subs) {
  const out = []
  for (const sub of subs || []) {
    if (sub?.scope !== 'segment') continue
    if (_subMatchesTrack(track, sub)) {
      out.push({ code: sub.code, applies_to_agl_below_ft: sub.applies_to_agl_below_ft ?? null })
    }
  }
  return out
}

// Peak dBA at a ground listener from an aircraft passing at the given altitude
// (MSL ft) and lateral distance (ft). Identical formula to the client kernel
// in src/PointNoiseReport.jsx → estDbaAtListener so server + client agree on
// what each scenario substitute would sound like.
//   - baseDba = source dBA reference (substitute's base_dba)
//   - 6 dB vertical falloff per altitude doubling above 1000 ft AGL
//   - 3 dB lateral falloff per slant-range doubling above 500 ft
//   - AGL floored at 100 ft for the engineless/winch case
export function dbaAtListener(baseDba, altMslFt, listenerElevFt, distFt) {
  if (baseDba <= 0) return 0
  const agl = Math.max((altMslFt ?? 0) - listenerElevFt, 100)
  const vert = agl > 1000 ? 6 * Math.log2(agl / 1000) : 0
  const slantFt = Math.hypot(distFt, agl)
  const lateral = slantFt > 500 ? 3 * Math.log2(slantFt / 500) : 0
  return Math.max(0, baseDba - vert - lateral)
}
