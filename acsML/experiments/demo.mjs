#!/usr/bin/env node
// demo.mjs — demonstrate acsML on real flights from the daily archive.
//
// Picks 5 known-good tails (Boulder flight school N1094F, KBJC trainer
// N4632F, KLMO tow N1812E, KAPA owner N24144, a Textron demo N163CP)
// and prints the ACS tasks demonstrated + 61.57 currency events for
// each flight.
//
// Run from noise/web/:
//   node acsML/experiments/demo.mjs

import fs from 'node:fs'
import { identifyOneTrack } from '../service.js'

const DAILY = 'public/tracks_live_2026-04-19.json'   // Sunday full 24h
const TARGET_TAILS = ['N1094F', 'N4632F', 'N1812E', 'N24144', 'N163CP']

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

function pointsFromLive(rawTuples) {
  return rawTuples.map(([lat, lon, alt, tMs]) => ({
    lat, lon, altMslFt: alt, tsUnix: Math.floor(tMs / 1000),
  }))
}

function fmtTs(ts) {
  return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z'
}

function main() {
  console.error(`loading ${DAILY}`)
  const j = JSON.parse(fs.readFileSync(DAILY, 'utf8'))
  console.error(`${j.tracks.length} tails in file`)

  for (const tail of TARGET_TAILS) {
    const tr = j.tracks.find(t => (t.call || t.reg) === tail)
    if (!tr) {
      console.log(`\n### ${tail} — NOT FOUND in ${DAILY}\n`)
      continue
    }
    const flights = splitIntoFlights(tr.points)
    console.log(`\n## ${tail}  (${tr.type || '?'})`)
    console.log(`Day file ${DAILY}: ${flights.length} captured flights\n`)
    for (let fi = 0; fi < flights.length; fi++) {
      const rawFlight = flights[fi]
      if (rawFlight.length < 30) continue
      const points = pointsFromLive(rawFlight)
      const result = identifyOneTrack(points, { typeCode: tr.type, tail })
      const start = result.phase_summary.total_active_s ? new Date(points[0].tsUnix * 1000) : null
      const end = result.phase_summary.total_active_s ? new Date(points[points.length - 1].tsUnix * 1000) : null
      const durMin = ((end - start) / 60000).toFixed(1)
      console.log(`### Flight ${fi + 1} — ${fmtTs(points[0].tsUnix)} → ${fmtTs(points[points.length - 1].tsUnix)}  (${durMin} min, ${points.length} pts)`)
      const ps = result.phase_summary
      console.log(`Phases: T/O=${ps.n_takeoffs}, T&G=${ps.n_touch_and_go}, full_stop=${ps.n_full_stop}, pattern_s=${Math.round(ps.phase_seconds.pattern || 0)}`)
      if (result.tasks_demonstrated.length) {
        console.log('ACS tasks demonstrated:')
        for (const t of result.tasks_demonstrated) {
          console.log(`  ${t.code.padEnd(5)}  ${t.name}  ×${t.instances}`)
          for (const e of t.evidence.slice(0, 2)) {
            console.log(`         · ${e.type} @ ${fmtTs(e.ts || start.getTime() / 1000)} — ${e.explanation || ''}`)
          }
        }
      } else {
        console.log('ACS tasks: (none detected)')
      }
      if (result.currency_events.length) {
        const byRule = {}
        for (const ev of result.currency_events) byRule[ev.rule] = (byRule[ev.rule] || 0) + 1
        console.log('FAR currency events: ' + Object.entries(byRule).map(([r, c]) => `${r}×${c}`).join(', '))
        const nightEvents = result.currency_events.filter(e => e.night)
        if (nightEvents.length) console.log(`  NIGHT (${nightEvents.length}): ${nightEvents.map(e => `${e.kind}@${e.airport || '?'} ${fmtTs(e.ts)}`).join('; ')}`)
      } else {
        console.log('FAR currency events: (none)')
      }
      if (result.notes.length) console.log('Notes: ' + result.notes.join('; '))
      console.log()
    }
  }
}

main()
