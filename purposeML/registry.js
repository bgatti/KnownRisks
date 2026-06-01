// registry.js — load the FAA aircraft registry CSV and classify owners.
//
// The CSV at c:/tmp/noise_data/aircraft_registry.csv has columns:
//   tail, type, desc, owner_operator, flights, days_seen, years, total_points
//
// Most rows are LLCs / Inc / individual names. Pattern-match the owner
// string to assign an `ownerClass`:
//
//   airline       — SKYWEST / UNITED / AMERICAN / DELTA / SOUTHWEST /
//                   FRONTIER / ALASKA / SPIRIT / JETBLUE / HAWAIIAN /
//                   ALLEGIANT / ENVOY / REPUBLIC / MESA / SUNCOUNTRY
//   manufacturer  — TEXTRON / CIRRUS / CESSNA / BEECH / PIPER / HAWKER /
//                   GULFSTREAM / BOMBARDIER / DASSAULT / DIAMOND /
//                   ICON / MOONEY / BELL / ROBINSON / EMBRAER / DAHER
//                   These are demo/test/sales aircraft.
//   government    — UNITED STATES / STATE OF / COUNTY / CITY OF /
//                   SHERIFF / POLICE / DEPARTMENT
//   fractional    — NETJETS / FLEXJET / PLANESENSE / WHEELS UP / VISTAJET
//   leasing       — TRUSTEE / BANK / TRUST CO / LEASING /  WELLS FARGO
//   flight_school — AVIATION INC, FLIGHT SCHOOL, FLYING CLUB, CFI,
//                   ACADEMY (plus matches against
//                   public/flight_schools_fleets.json owner names)
//   llc_private   — XYZ LLC (anonymizing LLC; assume private)
//   corp_private  — XYZ INC / XYZ CORP (private operator entity)
//   individual    — FIRSTNAME LASTNAME (no LLC/INC/CORP suffix and
//                   no business keyword)
//   unknown       — empty or unmatchable
//
// Use loadRegistry() to get a Map<tail, registryRow>, then
// classifyOwner(rowOrName) for the ownerClass.

import fs from 'node:fs'

export function loadRegistry(csvPath = 'C:/tmp/noise_data/aircraft_registry.csv') {
  const raw = fs.readFileSync(csvPath, 'utf8')
  const lines = raw.split(/\r?\n/)
  const header = lines[0].split(',')
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]))
  const map = new Map()
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue
    // Simple CSV split (the file uses no embedded commas in our spot-checks).
    const cols = lines[i].split(',')
    const tail = cols[idx.tail]?.trim()
    if (!tail) continue
    map.set(tail.toUpperCase(), {
      tail,
      type: cols[idx.type]?.trim() || '',
      desc: cols[idx.desc]?.trim() || '',
      owner: cols[idx.owner_operator]?.trim() || '',
      flights: parseInt(cols[idx.flights] || '0', 10),
      daysSeen: parseInt(cols[idx.days_seen] || '0', 10),
      years: (cols[idx.years] || '').trim(),
      totalPoints: parseInt(cols[idx.total_points] || '0', 10),
    })
  }
  return map
}

const AIRLINE_RE = /\b(SKYWEST|UNITED|AMERICAN|DELTA|SOUTHWEST|FRONTIER|ALASKA|SPIRIT|JETBLUE|HAWAIIAN|ALLEGIANT|ENVOY|REPUBLIC|MESA|SUN COUNTRY|GREAT LAKES|HORIZON|ENDEAVOR|PSA|PIEDMONT|GOJET|COMPASS|ATLAS|FEDEX|UPS)\b/
const MANUFACTURER_RE = /\b(TEXTRON|CIRRUS|CESSNA AIRCRAFT|BEECH AIRCRAFT|PIPER AIRCRAFT|HAWKER|GULFSTREAM|BOMBARDIER|DASSAULT|DIAMOND AIRCRAFT|ICON AIRCRAFT|MOONEY AIRCRAFT|BELL HELICOPTER|ROBINSON HELICOPTER|EMBRAER|DAHER|HONDA AIRCRAFT|AIRBUS|EPIC AIRCRAFT|VANS|TBM|HONDAJET)\b/
const GOVT_RE = /\b(UNITED STATES|STATE OF|COUNTY OF|CITY OF|SHERIFF|POLICE|FIRE DEPT|FIRE DEPARTMENT|NATIONAL PARK|FOREST SERVICE|US ARMY|US NAVY|US AIR|MARSHAL|DEPARTMENT OF|U S A|USAF|USCG|NOAA|FAA)\b/
const FRACTIONAL_RE = /\b(NETJETS|FLEXJET|PLANESENSE|WHEELS UP|VISTAJET|XOJET|FLIGHT OPTIONS|JETSUITE|NICHOLAS AIR|EXECUTIVE AIRSHARE|AIRSHARE)\b/
const LEASING_RE = /\b(TRUSTEE|TRUST CO|WELLS FARGO|BANK OF|LEASING CORP|AIRCRAFT LEASING)\b/
const SCHOOL_HINT_RE = /\b(FLIGHT SCHOOL|FLYING CLUB|FLIGHT TRAINING|AVIATION ACADEMY|AVIATION SCHOOL|PILOT TRAINING|FLIGHT ACADEMY|JOURNEYS AVIATION|BOULDER CITY AVIATION|SPECIALTY FLIGHT|MILE HIGH GLIDING|SOARING SOCIETY)\b/
const SCHOOL_FALLBACK_RE = /\b(AVIATION INC|AVIATION LLC|FLIGHT INC|FLYING INC)\b/   // suggestive but not certain
const LLC_RE = /\bLLC\b/
const INC_CORP_RE = /\b(INC|CORP|CO|COMPANY|CORPORATION)\b/

export function classifyOwner(name) {
  if (!name) return 'unknown'
  const N = name.toUpperCase()
  if (AIRLINE_RE.test(N)) return 'airline'
  if (FRACTIONAL_RE.test(N)) return 'fractional'
  if (MANUFACTURER_RE.test(N)) return 'manufacturer_demo'
  if (GOVT_RE.test(N)) return 'government'
  if (LEASING_RE.test(N)) return 'leasing_trust'
  if (SCHOOL_HINT_RE.test(N)) return 'flight_school'
  if (SCHOOL_FALLBACK_RE.test(N)) return 'flight_school_likely'
  if (LLC_RE.test(N)) return 'llc_private'
  if (INC_CORP_RE.test(N)) return 'corp_private'
  // Words consistent with a person's name: 2-4 ALL CAPS tokens, none of LLC/INC/etc.
  if (/^[A-Z][A-Z\s,.'\-]{2,}$/.test(N) && !/LLC|INC|CORP|TRUST|CO\b|COMPANY/.test(N)) {
    return 'individual'
  }
  return 'unknown'
}
