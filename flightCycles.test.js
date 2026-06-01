// flightCycles.test.js — regression net for the drops-bug class.
//
// Pins the contract that an airborne flight with no completed cycle is
// surfaced via a synthesized in-progress cycle. The pre-fix code path
// returned an empty cycle array and silently dropped the flight from
// /api/flights/current — KBJC operators saw 5 flights while raw ADS-B
// showed 7+ airborne (kiosk bug report 2026-06-01).
//
// Run:  cd noise/web && npx vitest run flightCycles.test.js

import { describe, it, expect } from 'vitest'
import {
  synthesizeInProgressCycle,
  SESSION_GAP_MS,
  STALE_MAX_S,
} from './flightCycles.js'

// KBJC field elev + 150 ft AGL = 5823 ft MSL ground ceiling. Used by the
// real handler; reused here for fidelity.
const GROUND_CEIL = 5823

// Build a [lat, lon, alt, ts] point. Lat/lon don't matter to the helper.
const p = (alt, ts) => [40.0, -105.0, alt, ts]

describe('synthesizeInProgressCycle', () => {
  it('returns null for empty point arrays', () => {
    expect(synthesizeInProgressCycle([], GROUND_CEIL, 0)).toBeNull()
    expect(synthesizeInProgressCycle(null, GROUND_CEIL, 0)).toBeNull()
    expect(synthesizeInProgressCycle([p(7000, 0)], GROUND_CEIL, 0)).toBeNull()
  })

  it('returns null when the latest fix is stale', () => {
    // 4 min stale — past the 3-min freshness cutoff. A stale row from
    // yesterday's ferry flight must NOT synthesize today.
    const now = 1_000_000_000_000
    const pts = [
      p(7000, now - 5 * 60_000),
      p(7000, now - 4 * 60_000),
    ]
    expect(synthesizeInProgressCycle(pts, GROUND_CEIL, now)).toBeNull()
  })

  it('returns null when the latest fix is on the ground', () => {
    // The plane is parked — no in-progress flight to synthesize.
    const now = 1_000_000_000_000
    const pts = [
      p(GROUND_CEIL + 1000, now - 60_000),
      p(GROUND_CEIL - 50, now - 5_000), // below ceiling = parked
    ]
    expect(synthesizeInProgressCycle(pts, GROUND_CEIL, now)).toBeNull()
  })

  it('returns null when the latest fix has no altitude', () => {
    const now = 1_000_000_000_000
    const pts = [p(7000, now - 30_000), p(null, now - 5_000)]
    expect(synthesizeInProgressCycle(pts, GROUND_CEIL, now)).toBeNull()
  })

  it('synthesizes a cycle anchored at the climb-out fix', () => {
    // The exact "drops bug" scenario: a flight took off, is in cruise,
    // hasn't landed yet. extractTowCycles returns []. We must synthesize.
    const now = 1_000_000_000_000
    const pts = [
      p(GROUND_CEIL - 100, now - 600_000), // on the ground 10 min ago
      p(GROUND_CEIL + 200, now - 540_000), // climb-out — THIS is takeoff
      p(7000, now - 300_000),
      p(7500, now - 30_000),               // latest fix, airborne
    ]
    const cyc = synthesizeInProgressCycle(pts, GROUND_CEIL, now)
    expect(cyc).toEqual({ tMs: now - 540_000, lMs: null })
  })

  it('lMs is always null (marks the cycle as still open)', () => {
    // groupCyclesIntoFlights hard-splits on null lMs, so this invariant
    // is load-bearing for the downstream membership rule.
    const now = 1_000_000_000_000
    const pts = [
      p(GROUND_CEIL - 50, now - 300_000),
      p(7000, now - 30_000),
    ]
    const cyc = synthesizeInProgressCycle(pts, GROUND_CEIL, now)
    expect(cyc.lMs).toBeNull()
  })

  it('walks back through the latest contiguous airborne session only', () => {
    // Two distinct sessions in one tail's track: a flight 90 min ago
    // that landed, and the current airborne session that started 8 min
    // ago. Synthesis must anchor on TODAY's takeoff, not the earlier
    // session.
    const now = 1_000_000_000_000
    const pts = [
      // Earlier session (already landed):
      p(GROUND_CEIL - 100, now - 95 * 60_000),
      p(7000, now - 92 * 60_000),
      p(GROUND_CEIL - 50, now - 85 * 60_000),
      // 85 min gap >> SESSION_GAP_MS — session boundary here.
      p(GROUND_CEIL - 80, now - 9 * 60_000),  // taxi
      p(GROUND_CEIL + 300, now - 8 * 60_000), // climb-out
      p(7500, now - 30_000),                  // latest, airborne
    ]
    const cyc = synthesizeInProgressCycle(pts, GROUND_CEIL, now)
    expect(cyc.tMs).toBe(now - 8 * 60_000)
  })

  it('breaks at a SESSION_GAP_MS gap with no ground fix between', () => {
    // No takeoff transition is visible (track started mid-air); the
    // walk-back must still terminate at the session-gap boundary
    // rather than scrolling all the way to a prior session. The
    // current session needs multiple post-gap fixes so the walk-back
    // has somewhere to land — a one-fix session anchors trivially.
    const now = 1_000_000_000_000
    const sessionStartMs = now - 5 * 60_000
    const pts = [
      // Earlier session, two fixes:
      p(7000, now - 90 * 60_000),
      p(7100, now - 89 * 60_000),
      // Big gap — session boundary, no ground fix in or after the gap.
      p(7200, sessionStartMs),     // start of current session
      p(7300, now - 60_000),
      p(7350, now - 30_000),       // latest, airborne
    ]
    const cyc = synthesizeInProgressCycle(pts, GROUND_CEIL, now)
    // Anchor is the fix after the gap (start of the current session).
    expect(cyc.tMs).toBe(sessionStartMs)
  })

  it('exposes STALE_MAX_S = 180 and SESSION_GAP_MS = 30 min', () => {
    // Pinning the constants so a refactor that "tightens" them up gets
    // an explicit failure. Both numbers are tuned against operator
    // experience; don't change them in a drive-by edit.
    expect(STALE_MAX_S).toBe(180)
    expect(SESSION_GAP_MS).toBe(30 * 60_000)
  })

  it('boundary at STALE_MAX_S — exactly 180 s stale is still fresh', () => {
    const now = 1_000_000_000_000
    const pts = [p(7000, now - 200_000), p(7000, now - STALE_MAX_S * 1000)]
    const cyc = synthesizeInProgressCycle(pts, GROUND_CEIL, now)
    expect(cyc).not.toBeNull()
  })

  it('boundary at STALE_MAX_S + 1 s — just over is stale', () => {
    const now = 1_000_000_000_000
    const pts = [
      p(7000, now - 200_000),
      p(7000, now - (STALE_MAX_S + 1) * 1000),
    ]
    expect(synthesizeInProgressCycle(pts, GROUND_CEIL, now)).toBeNull()
  })
})
