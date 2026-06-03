#!/usr/bin/env node
// scan_all_acs.mjs — scan the full daily archive looking for which
// ACS codes get exercised, including right-hand steep turns,
// emergency descents, and turns around a point.

import fs from 'node:fs'
import { identifyOneTrack } from '../service.js'

const DAILY = process.env.DAILY || 'public/tracks_live_2026-04-19.json'

function splitIntoFlights(points, gapMin = 30) {
  if (!points || points.length === 0) return []
  const gapMs = gapMin * 60 * 1000
  const flights = []
  let cur = [points[0]]
  for (let i = 1; i < points.length; i++) {
    if (points[i][3] - points[i - 1][3] > gapMs) {
      if (cur.length >= 2) flights.push(cur)
      cur = []
    }
    cur.push(points[i])
  }
  if (cur.length >= 2) flights.push(cur)
  return flights
}

function pointsFromLive(raw) {
  return raw.map(([lat, lon, alt, tMs]) => ({ lat, lon, altMslFt: alt, tsUnix: Math.floor(tMs / 1000) }))
}

const j = JSON.parse(fs.readFileSync(DAILY, 'utf8'))
console.error(`scanning ${j.tracks.length} tails in ${DAILY}`)

// Count ACS codes seen + count steep_turn directions + collect
// examples of the rarer codes.
const codeCounts = {}
const examples = {}
let steepLeft = 0, steepRight = 0
let emergDescent = 0
let turnAroundPoint = 0
let rectangularCourse = 0
let totalFlights = 0
let processed = 0
const t0 = Date.now()

for (const tr of j.tracks) {
  const tail = tr.call || tr.reg
  if (!tail) continue
  const flights = splitIntoFlights(tr.points)
  for (const f of flights) {
    if (f.length < 30) continue
    const points = pointsFromLive(f)
    const r = identifyOneTrack(points, { typeCode: tr.type, tail })
    totalFlights++
    for (const task of r.tasks_demonstrated) {
      codeCounts[task.code] = (codeCounts[task.code] || 0) + task.instances
      if (!examples[task.code]) {
        examples[task.code] = {
          tail, type: tr.type, ts: task.evidence[0]?.ts,
          explanation: task.evidence[0]?.explanation,
        }
      }
      // Look at steep_turn directions explicitly.
      if (task.code === 'V.A') {
        for (const ev of task.evidence) {
          if (/right turn/.test(ev.explanation || '')) steepRight++
          else if (/left turn/.test(ev.explanation || '')) steepLeft++
        }
      }
      if (task.code === 'IX.A') emergDescent += task.instances
      if (task.code === 'V.D') turnAroundPoint += task.instances
      if (task.code === 'V.B') rectangularCourse += task.instances
    }
    processed++
    if (processed % 200 === 0) {
      const rate = processed / ((Date.now() - t0) / 1000)
      console.error(`  ${processed} flights @ ${rate.toFixed(1)}/s`)
    }
  }
}

console.log(`\n=== ACS code coverage across ${totalFlights} flights on ${DAILY} ===`)
const sorted = Object.entries(codeCounts).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
for (const [code, count] of sorted) {
  console.log(`  ${code.padEnd(6)} ${String(count).padStart(5)}    e.g. ${examples[code]?.tail || '-'} ${examples[code]?.explanation || ''}`.slice(0, 160))
}
console.log()
console.log(`Steep turn directions:  left=${steepLeft}  right=${steepRight}`)
console.log(`Emergency Descent (IX.A): ${emergDescent}`)
console.log(`Turns Around a Point (V.D): ${turnAroundPoint}`)
console.log(`Rectangular Course (V.B): ${rectangularCourse}`)
console.log()
console.log('Example IX.B evidence (throttle in evidence?):')
const ixb = examples['IX.B']
if (ixb) console.log(`  ${ixb.tail} — ${ixb.explanation}`)
console.log('Example VII.B Power-Off:')
const viib = examples['VII.B']
if (viib) console.log(`  ${viib.tail} — ${viib.explanation}`)
console.log('Example VII.C Power-On (NEW with throttle):')
const viic = examples['VII.C']
if (viic) console.log(`  ${viic.tail} — ${viic.explanation}`)
