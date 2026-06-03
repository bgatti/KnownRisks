// aircraftPerf.js — per-ICAO performance table for the throttle
// estimator. Values are POH-rough, sufficient for the operator's
// "show me when the throttle's high" question. When the type isn't in
// the table, we fall through to an HP-derived heuristic (see
// `perfForType`). HP table extends noise/aircraft_hp.py — same numbers
// where they overlap.
//
// vy_kts          — best rate of climb speed (full throttle climb)
// vs_max_fpm      — published max climb rate at sea level, Vy
// cruise_kts      — typical cruise TAS (75% power-ish)
// cruise_throttle — fraction of max power for that cruise (0..1)
// max_kts         — typical maximum cruise / Vne
// hp              — total horsepower (all engines)

export const DEFAULT_HP = 180
export const DEFAULT_CRUISE_THROTTLE = 0.72

// Minimum lookup — extend as the test page surfaces gaps.
const AIRCRAFT_PERF = {
  // ── Piston singles, common trainers ──
  C140: { vy_kts: 65,  vs_max_fpm: 580,  cruise_kts: 105, max_kts: 124, hp: 90,  cruise_throttle: 0.72 },
  C150: { vy_kts: 67,  vs_max_fpm: 670,  cruise_kts: 100, max_kts: 123, hp: 100, cruise_throttle: 0.72 },
  C152: { vy_kts: 67,  vs_max_fpm: 715,  cruise_kts: 107, max_kts: 123, hp: 110, cruise_throttle: 0.72 },
  C162: { vy_kts: 67,  vs_max_fpm: 700,  cruise_kts: 110, max_kts: 120, hp: 100, cruise_throttle: 0.72 },
  C172: { vy_kts: 73,  vs_max_fpm: 720,  cruise_kts: 122, max_kts: 140, hp: 180, cruise_throttle: 0.72 },
  C72R: { vy_kts: 73,  vs_max_fpm: 720,  cruise_kts: 122, max_kts: 140, hp: 180, cruise_throttle: 0.72 },
  C177: { vy_kts: 80,  vs_max_fpm: 840,  cruise_kts: 133, max_kts: 150, hp: 180, cruise_throttle: 0.72 },
  C182: { vy_kts: 80,  vs_max_fpm: 925,  cruise_kts: 145, max_kts: 165, hp: 230, cruise_throttle: 0.72 },
  C82R: { vy_kts: 80,  vs_max_fpm: 925,  cruise_kts: 145, max_kts: 165, hp: 230, cruise_throttle: 0.72 },
  C206: { vy_kts: 80,  vs_max_fpm: 990,  cruise_kts: 150, max_kts: 175, hp: 300, cruise_throttle: 0.72 },
  C210: { vy_kts: 91,  vs_max_fpm: 1010, cruise_kts: 174, max_kts: 200, hp: 300, cruise_throttle: 0.72 },
  DA40: { vy_kts: 67,  vs_max_fpm: 800,  cruise_kts: 137, max_kts: 178, hp: 180, cruise_throttle: 0.72 },
  P28A: { vy_kts: 76,  vs_max_fpm: 750,  cruise_kts: 109, max_kts: 144, hp: 160, cruise_throttle: 0.72 },
  P28B: { vy_kts: 76,  vs_max_fpm: 770,  cruise_kts: 116, max_kts: 148, hp: 180, cruise_throttle: 0.72 },
  P28R: { vy_kts: 80,  vs_max_fpm: 800,  cruise_kts: 130, max_kts: 165, hp: 200, cruise_throttle: 0.72 },
  PA28: { vy_kts: 76,  vs_max_fpm: 750,  cruise_kts: 109, max_kts: 144, hp: 160, cruise_throttle: 0.72 },
  SR20: { vy_kts: 96,  vs_max_fpm: 815,  cruise_kts: 156, max_kts: 200, hp: 215, cruise_throttle: 0.72 },
  SR22: { vy_kts: 101, vs_max_fpm: 1270, cruise_kts: 183, max_kts: 200, hp: 310, cruise_throttle: 0.72 },
  S22T: { vy_kts: 101, vs_max_fpm: 1400, cruise_kts: 213, max_kts: 230, hp: 315, cruise_throttle: 0.72 },
  M20P: { vy_kts: 92,  vs_max_fpm: 1100, cruise_kts: 165, max_kts: 196, hp: 200, cruise_throttle: 0.72 },
  M20T: { vy_kts: 95,  vs_max_fpm: 1300, cruise_kts: 220, max_kts: 242, hp: 280, cruise_throttle: 0.72 },
  BE35: { vy_kts: 100, vs_max_fpm: 1136, cruise_kts: 175, max_kts: 200, hp: 285, cruise_throttle: 0.72 },
  BE36: { vy_kts: 100, vs_max_fpm: 1230, cruise_kts: 176, max_kts: 200, hp: 300, cruise_throttle: 0.72 },
  RV6:  { vy_kts: 96,  vs_max_fpm: 1900, cruise_kts: 165, max_kts: 200, hp: 180, cruise_throttle: 0.72 },
  RV7:  { vy_kts: 96,  vs_max_fpm: 1900, cruise_kts: 165, max_kts: 200, hp: 180, cruise_throttle: 0.72 },
  RV8:  { vy_kts: 96,  vs_max_fpm: 1900, cruise_kts: 175, max_kts: 200, hp: 180, cruise_throttle: 0.72 },
  // ── Tow planes ──
  PA18: { vy_kts: 70,  vs_max_fpm: 960,  cruise_kts: 95,  max_kts: 115, hp: 150, cruise_throttle: 0.70 },
  PA25: { vy_kts: 80,  vs_max_fpm: 1100, cruise_kts: 115, max_kts: 130, hp: 235, cruise_throttle: 0.72 },
  PIAT: { vy_kts: 88,  vs_max_fpm: 1500, cruise_kts: 145, max_kts: 175, hp: 550, cruise_throttle: 0.72 },
  PC6:  { vy_kts: 75,  vs_max_fpm: 1010, cruise_kts: 145, max_kts: 170, hp: 550, cruise_throttle: 0.72 },
  // ── Piston twins ──
  BE55: { vy_kts: 105, vs_max_fpm: 1670, cruise_kts: 190, max_kts: 230, hp: 520, cruise_throttle: 0.72 },
  BE76: { vy_kts: 85,  vs_max_fpm: 1248, cruise_kts: 155, max_kts: 195, hp: 360, cruise_throttle: 0.72 },
  PA44: { vy_kts: 90,  vs_max_fpm: 1340, cruise_kts: 165, max_kts: 202, hp: 360, cruise_throttle: 0.72 },
  PA34: { vy_kts: 90,  vs_max_fpm: 1290, cruise_kts: 180, max_kts: 220, hp: 440, cruise_throttle: 0.72 },
  C310: { vy_kts: 106, vs_max_fpm: 1700, cruise_kts: 207, max_kts: 240, hp: 520, cruise_throttle: 0.72 },
  // ── Turboprops ──
  PC12: { vy_kts: 115, vs_max_fpm: 1920, cruise_kts: 280, max_kts: 320, hp: 1200, cruise_throttle: 0.85 },
  M600: { vy_kts: 110, vs_max_fpm: 2000, cruise_kts: 274, max_kts: 320, hp: 600,  cruise_throttle: 0.85 },
  TBM7: { vy_kts: 124, vs_max_fpm: 2380, cruise_kts: 290, max_kts: 320, hp: 700,  cruise_throttle: 0.85 },
  TBM8: { vy_kts: 124, vs_max_fpm: 2380, cruise_kts: 320, max_kts: 330, hp: 850,  cruise_throttle: 0.85 },
  TBM9: { vy_kts: 124, vs_max_fpm: 2400, cruise_kts: 330, max_kts: 350, hp: 850,  cruise_throttle: 0.85 },
  C208: { vy_kts: 104, vs_max_fpm: 925,  cruise_kts: 184, max_kts: 220, hp: 675,  cruise_throttle: 0.85 },
  PAY1: { vy_kts: 121, vs_max_fpm: 2380, cruise_kts: 280, max_kts: 320, hp: 1000, cruise_throttle: 0.85 },
  BE30: { vy_kts: 121, vs_max_fpm: 2530, cruise_kts: 290, max_kts: 320, hp: 1250, cruise_throttle: 0.85 },
  B350: { vy_kts: 130, vs_max_fpm: 2450, cruise_kts: 313, max_kts: 359, hp: 2100, cruise_throttle: 0.85 },
  // ── Light jets ──
  C525: { vy_kts: 160, vs_max_fpm: 3400, cruise_kts: 380, max_kts: 460, hp: 2200, cruise_throttle: 0.85 },
  C55B: { vy_kts: 160, vs_max_fpm: 3500, cruise_kts: 400, max_kts: 470, hp: 3000, cruise_throttle: 0.85 },
  C56X: { vy_kts: 165, vs_max_fpm: 4200, cruise_kts: 430, max_kts: 490, hp: 3500, cruise_throttle: 0.85 },
  C68A: { vy_kts: 170, vs_max_fpm: 4500, cruise_kts: 420, max_kts: 480, hp: 4500, cruise_throttle: 0.85 },
  E55P: { vy_kts: 165, vs_max_fpm: 3600, cruise_kts: 380, max_kts: 440, hp: 2500, cruise_throttle: 0.85 },
  E50P: { vy_kts: 160, vs_max_fpm: 3000, cruise_kts: 360, max_kts: 410, hp: 1800, cruise_throttle: 0.85 },
  // ── Helicopters ──
  R22:  { vy_kts: 53,  vs_max_fpm: 1000, cruise_kts: 96,  max_kts: 102, hp: 124, cruise_throttle: 0.72 },
  R44:  { vy_kts: 55,  vs_max_fpm: 1000, cruise_kts: 115, max_kts: 130, hp: 245, cruise_throttle: 0.72 },
  R66:  { vy_kts: 65,  vs_max_fpm: 1000, cruise_kts: 110, max_kts: 140, hp: 300, cruise_throttle: 0.72 },
  AS50: { vy_kts: 67,  vs_max_fpm: 1700, cruise_kts: 137, max_kts: 155, hp: 590, cruise_throttle: 0.72 },
  B06:  { vy_kts: 60,  vs_max_fpm: 1500, cruise_kts: 117, max_kts: 130, hp: 420, cruise_throttle: 0.72 },
  B407: { vy_kts: 65,  vs_max_fpm: 2000, cruise_kts: 133, max_kts: 140, hp: 700, cruise_throttle: 0.72 },
  // ── Engineless ──
  GLID: { vy_kts: 45,  vs_max_fpm: 0,    cruise_kts: 55,  max_kts: 130, hp: 0, cruise_throttle: 0 },
  ASK2: { vy_kts: 45,  vs_max_fpm: 0,    cruise_kts: 55,  max_kts: 130, hp: 0, cruise_throttle: 0 },
  DG50: { vy_kts: 50,  vs_max_fpm: 0,    cruise_kts: 60,  max_kts: 140, hp: 0, cruise_throttle: 0 },
  K21:  { vy_kts: 45,  vs_max_fpm: 0,    cruise_kts: 55,  max_kts: 130, hp: 0, cruise_throttle: 0 },
  LS4:  { vy_kts: 50,  vs_max_fpm: 0,    cruise_kts: 60,  max_kts: 140, hp: 0, cruise_throttle: 0 },
}

// Resolve perf for an ICAO type. When the type isn't in the table,
// derive a heuristic from `hp` so unknowns still get a usable
// estimate (and the caller can see source="hp_derived"). Returns the
// perf object + a `source` string for diagnostics.
export function perfForType(icaoType) {
  const code = String(icaoType || '').toUpperCase()
  if (AIRCRAFT_PERF[code]) {
    return { ...AIRCRAFT_PERF[code], source: `table:${code}` }
  }
  // Heuristic fallback: scale from a notional HP. Better than nothing
  // until we land a real table entry for the type.
  const hp = DEFAULT_HP
  return {
    vy_kts: 80,
    vs_max_fpm: 700,
    cruise_kts: 130,
    max_kts: 170,
    hp,
    cruise_throttle: DEFAULT_CRUISE_THROTTLE,
    source: 'fallback:default',
  }
}
