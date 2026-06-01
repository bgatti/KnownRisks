// flightCycles.js — small, pure helpers for flight-cycle reasoning that
// live outside vite.config.js so they can be unit-tested without spinning
// up the dev server.
//
// History: extracted from inline at vite.config.js:flightsApiPlugin to
// make the "drops bug" regression net pinnable. The drops bug shipped
// silently from Ask #1 v0 because the test scaffolding for the unified
// /api/flights/current handler was integration-only — a unit-testable
// helper with a regression pin makes the same class of bug visible at
// `npm test`.

// SESSION_GAP_MS — a gap > 30 min in the track ends a "session" so the
// next fix starts a new flight. Mirrors the constant used by
// /api/adsb/current-flights for symmetric behavior. Don't tune for one
// caller without auditing both.
export const SESSION_GAP_MS = 30 * 60_000

// STALE_MAX_S — fix freshness cutoff. Without this, a dormant track
// loaded from the live_tracks day bucket would synthesize an
// in-progress cycle anchored to last night's ferry flight, then put
// that ghost flight into the CURRENT feed forever.
export const STALE_MAX_S = 180

// synthesizeInProgressCycle(pts, groundCeil, nowMs) — when
// extractTowCycles returns 0 (an airborne flight with no completed
// takeoff→landing pair yet), produce a synthetic in-progress cycle so
// the unified handler can still surface the flight.
//
// Returns `{ tMs, lMs: null }` to mirror extractTowCycles's projected
// shape (lMs=null marks the cycle as still open — see
// groupCyclesIntoFlights's hard-split rule).
//
// Returns `null` when synthesis is not warranted:
//   - empty / insufficient point array
//   - latest fix is stale (>STALE_MAX_S)
//   - latest fix altitude is missing or at/below groundCeil (i.e. plane
//     is parked, not airborne)
//
// Takeoff resolution: walk back from the latest fix until either
//   (a) a gap > SESSION_GAP_MS (split point — anchor is the fix after
//       the gap, since the session-start lives on the early side of the
//       new session)
//   (b) the previous fix dropped to/below groundCeil (true takeoff
//       transition — anchor is the climb-out fix)
//   (c) we hit the start of the array (anchor is the earliest fix in
//       the contiguous walk)
//
// The "true takeoff transition" wins over the gap-split because the
// session may legitimately straddle a 10-15 min ADS-B dropout while the
// plane is in cruise — that's still the same flight.
//
// Inputs:
//   pts         — array of points sorted ascending by ts_ms. Each
//                 point is [lat, lon, alt_ft, ts_ms].
//   groundCeil  — altitude (ft MSL) below which the aircraft is on the
//                 ground. Caller: field_elevation_ft + on_ground_alt_agl_ft.
//   nowMs       — "now" epoch ms. Pass-through for testability.
export function synthesizeInProgressCycle(pts, groundCeil, nowMs = Date.now()) {
  if (!Array.isArray(pts) || pts.length < 2) return null
  const lastFix = pts[pts.length - 1]
  if (!lastFix || lastFix[3] == null) return null
  const ageS = (nowMs - lastFix[3]) / 1000
  if (ageS > STALE_MAX_S) return null
  if (lastFix[2] == null || lastFix[2] <= groundCeil) return null

  let takeoffMs = lastFix[3]
  for (let i = pts.length - 1; i > 0; i--) {
    const cur = pts[i]
    const prev = pts[i - 1]
    const gap = (cur[3] || 0) - (prev[3] || 0)
    if (gap > SESSION_GAP_MS) break
    if (prev[2] != null && prev[2] <= groundCeil) {
      takeoffMs = cur[3]
      break
    }
    takeoffMs = prev[3] || takeoffMs
  }
  return { tMs: takeoffMs, lMs: null }
}
