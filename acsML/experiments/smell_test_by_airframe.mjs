#!/usr/bin/env node
// smell_test_by_airframe.mjs — operator round-10 methodology:
//
//   "easy smell test: ACS should appear in training aircraft
//    if they detect on tow and gliders often, probably an issue
//    (ideally we won't cheat and tell the ML what kind of plane it
//    is — until we get good results)"
//
// Runs the identifier WITHOUT type-applicability gates (i.e. on the
// raw shape-detector output), and reports per-airframe-role fire
// rates for each ACS task. If tow / glider rates are HIGH, the
// shape detector itself is over-firing.

import fs from 'node:fs'
import { extractAcsSignals } from '../features.js'

const DAILY = 'public/tracks_live_2026-04-19.json'

// We deliberately bypass identifyAcsSegments to skip its
// TASK_EXCLUSIONS gating. We want raw per-shape detection rates.

function splitFlights(points, gapMin = 30) {
  const out = []; let cur = [points[0]]
  for (let i = 1; i < points.length; i++) {
    if (points[i][3] - points[i-1][3] > gapMin*60*1000) { if (cur.length>=2) out.push(cur); cur = [] }
    cur.push(points[i])
  }
  if (cur.length >= 2) out.push(cur)
  return out
}
function ptsFromRaw(f) { return f.map(([lat,lon,alt,tMs]) => ({ lat, lon, altMslFt: alt, tsUnix: Math.floor(tMs/1000) })) }

function airframeRole(typeCode) {
  const T = String(typeCode || '').toUpperCase()
  if (/^(GLID|VENT|NIMB|DISC|SGS|ASTR|JS\d|LS\d|PIK|ASW|SZD|BALL)|^AS[1-3]\d|^DG\d/.test(T)) return 'glider'
  if (/^(PA25|PA18|PIAT|PC6)$/.test(T)) return 'tow_plane'
  if (/^(C150|C152|C172|C162|C72R|P28A|P28B|PA28|DA40|DA20|BE76|PA44)$/.test(T)) return 'trainer'
  if (/^(B73|B7|A2|A3|CRJ|E7|E1|E2|MD8|DC8|MD9)/.test(T)) return 'airliner'
  if (/^(C25|C5\d|C6\d|C70|C72|C75|GLF|G[1-7]|HDJ|LJ\d|H25|F2T|F9|E50P|E55P|SF50)/.test(T)) return 'bizjet'
  if (/^(R22|R44|R66|EC|AS5|AS6|S76|B06|B40|B47|H50|H125|MD5|H47|UH|MH|CH)/.test(T)) return 'helicopter'
  if (/^(PC12|TBM|BE9|BE10|BE20|BE40|BE30|BE35|BE36|MU2)/.test(T)) return 'turboprop'
  return 'other_ga'
}

// Map phaseML detection types → ACS codes (same as standards JSON)
const TASK_FROM_TYPE = {
  steep_turn: 'V.A',
  s_turns_across_road: 'V.C',
  turn_around_a_point: 'V.D',
  slow_flight: 'VII.A',
  stall_recovery: 'VII.B_or_C',
  emergency_descent: 'IX.A',
  emergency_approach_landing: 'IX.B',
  holding_pattern: 'VIII.E_or_holding',
  rectangular_course: 'V.B',
  touch_and_go: 'IV.K',
  landed_full_stop: 'IV.B',
}

const j = JSON.parse(fs.readFileSync(DAILY, 'utf8'))
const flightsByRole = {}
const detectionsByRoleByTask = {}
let totalFlights = 0

for (const tr of j.tracks) {
  const role = airframeRole(tr.type)
  const flights = splitFlights(tr.points || [])
  for (const f of flights) {
    if (f.length < 30) continue
    const points = ptsFromRaw(f)
    const { detections } = extractAcsSignals(points, { typeCode: tr.type })
    if (!detections.length) {
      // Even empty counts as a flight for the rate denominator
    }
    flightsByRole[role] = (flightsByRole[role] || 0) + 1
    totalFlights++
    detectionsByRoleByTask[role] = detectionsByRoleByTask[role] || {}
    for (const det of detections) {
      const taskCode = TASK_FROM_TYPE[det.type]
      if (!taskCode) continue
      detectionsByRoleByTask[role][taskCode] = (detectionsByRoleByTask[role][taskCode] || 0) + 1
    }
  }
}

const roles = ['trainer', 'glider', 'tow_plane', 'helicopter', 'turboprop', 'bizjet', 'airliner', 'other_ga']
const tasks = ['IV.B', 'IV.K', 'V.A', 'V.B', 'V.C', 'V.D', 'VII.A', 'VII.B_or_C', 'VIII.E_or_holding', 'IX.A', 'IX.B']

console.log(`Total flights classified: ${totalFlights}`)
console.log()
console.log('Flights per airframe role:')
for (const role of roles) console.log(`  ${role.padEnd(12)} ${String(flightsByRole[role] || 0).padStart(5)}`)
console.log()
console.log('=== Detections per 100 flights, by role × task ===')
console.log('(rate <= 5 / 100 means the detector RARELY fires for that role)')
console.log()
const header = 'task              ' + roles.map(r => r.slice(0, 7).padStart(8)).join('')
console.log(header)
console.log('-'.repeat(header.length))
for (const task of tasks) {
  const cells = roles.map(role => {
    const n = (detectionsByRoleByTask[role] || {})[task] || 0
    const total = flightsByRole[role] || 1
    const rate = (100 * n / total).toFixed(1)
    return rate.padStart(8)
  })
  console.log(`  ${task.padEnd(16)}` + cells.join(''))
}
console.log()
console.log('SMELL TEST: a healthy ACS detector should fire most often on TRAINER')
console.log('aircraft. If glider / tow_plane / helicopter rates exceed trainer,')
console.log('the shape detector is conflating role-specific normal flying with')
console.log('the ACS training task it is supposed to detect.')
