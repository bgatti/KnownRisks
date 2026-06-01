// scenarioSubstitutes.js — Ask #11 What-If helpers.
//
// Pure helpers for matching tracks against the substitute registry
// (public/substitutes.json) and projecting a substitute's dBA at a listener.
// Shared between /api/excursions/segments and the test suite so both run the
// same logic without spinning up vite. See API_REQUEST.md Ask #11.

// A track matches a substitute on EITHER type or purpose — so a C172 training
// flight matches VELE via type, and a glider with no purpose tag still
// matches SINU via type.
function _subMatchesTrack(track, sub) {
  const T = String(track?.type || '').toUpperCase()
  const P = String(track?.purpose || '').toLowerCase()
  if (T) {
    for (const r of sub.replaces_types || []) {
      if (String(r).toUpperCase() === T) return true
    }
  }
  if (P) {
    for (const r of sub.replaces_purposes || []) {
      if (String(r).toLowerCase() === P) return true
    }
  }
  return false
}

// Whole-track substitutes (VELE, EFOX, SINU). WNCH is scope=segment — see
// pickSegmentCandidates.
export function pickTrackCandidates(track, subs) {
  const out = []
  for (const sub of subs || []) {
    if (sub?.scope === 'track' && _subMatchesTrack(track, sub)) out.push(sub.code)
  }
  return out
}

// Sub-segment substitutes (WNCH). Returns the AGL cutoff alongside the code
// so the client can render the slider's "applies below N ft" hint.
export function pickSegmentCandidates(track, subs) {
  const out = []
  for (const sub of subs || []) {
    if (sub?.scope === 'segment' && _subMatchesTrack(track, sub)) {
      out.push({ code: sub.code, applies_to_agl_below_ft: sub.applies_to_agl_below_ft ?? null })
    }
  }
  return out
}

// Peak dBA at a ground listener — identical formula to the client kernel in
// src/PointNoiseReport.jsx → estDbaAtListener so server + client agree.
//   - 6 dB vertical falloff per altitude doubling above 1000 ft AGL
//   - 3 dB lateral falloff per slant-range doubling above 500 ft
//   - AGL floored at 100 ft for engineless / winch cases
export function dbaAtListener(baseDba, altMslFt, listenerElevFt, distFt) {
  if (baseDba <= 0) return 0
  const agl = Math.max((altMslFt ?? 0) - listenerElevFt, 100)
  const vert = agl > 1000 ? 6 * Math.log2(agl / 1000) : 0
  const slantFt = Math.hypot(distFt, agl)
  const lateral = slantFt > 500 ? 3 * Math.log2(slantFt / 500) : 0
  return Math.max(0, baseDba - vert - lateral)
}
