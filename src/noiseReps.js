/**
 * Elected-representative contacts for each FRNAA airport.
 *
 * NOTE: this is a best-effort static dataset for a simulation. Real email
 * addresses and office-holders change over time — verify before live use.
 * Many federal offices only accept messages through a web form; we store the
 * form URL in the `email` slot so the UI can present it as a link and the
 * mailto: fallback simply skips it.
 */

/**
 * Fuzzy-resolve the FRNAA airports whose catchment best matches a locality
 * (city/town/village/county) derived from a reverse-geocoder. Returns an
 * ordered list — most likely airport first — so the caller can either use
 * the full list or just the top pick.
 */
const CITY_TO_AIRPORTS = {
  boulder: ['KBDU'],
  gunbarrel: ['KBDU'],
  niwot: ['KBDU'],
  louisville: ['KBDU', 'KBJC'],
  superior: ['KBJC', 'KBDU'],
  longmont: ['KLMO'],
  erie: ['KEIK'],
  lafayette: ['KEIK', 'KBDU'],
  broomfield: ['KBJC'],
  westminster: ['KBJC'],
  arvada: ['KBJC'],
  'fort collins': ['KFNL'],
  loveland: ['KFNL'],
  berthoud: ['KFNL'],
  johnstown: ['KFNL'],
  windsor: ['KFNL'],
}
const COUNTY_TO_AIRPORTS = {
  'boulder county':    ['KBDU', 'KLMO'],
  'weld county':       ['KEIK', 'KFNL'],
  'jefferson county':  ['KBJC'],
  'broomfield county': ['KBJC'],
  'larimer county':    ['KFNL'],
}

export function airportsForLocality(locality) {
  if (!locality) return []
  const norm = (s) => (s || '').toLowerCase().trim()
  const city = norm(locality.city || locality.town || locality.village || locality.hamlet)
  const county = norm(locality.county)
  const out = []
  const push = (list) => { for (const a of list || []) if (!out.includes(a)) out.push(a) }
  if (city in CITY_TO_AIRPORTS) push(CITY_TO_AIRPORTS[city])
  if (county in COUNTY_TO_AIRPORTS) push(COUNTY_TO_AIRPORTS[county])
  return out
}

/**
 * Human-readable locality label from a reverse-geocode result.
 * e.g. "Gunbarrel · Boulder County, CO, US"
 */
export function formatLocality(loc) {
  if (!loc) return ''
  const place = loc.city || loc.town || loc.village || loc.hamlet || loc.suburb
  const region = [loc.county, loc.state, loc.country_code?.toUpperCase()].filter(Boolean).join(', ')
  if (place && region) return `${place} · ${region}`
  return place || region || ''
}

export const SHARED_REPS = {
  governor: {
    role: 'Governor of Colorado',
    name: 'Governor Polis',
    email: 'https://www.colorado.gov/governor/contact-governor',
    web: true,
  },
  senators: [
    { role: 'U.S. Senator (CO)', name: 'Sen. Michael Bennet',   email: 'https://www.bennet.senate.gov/public/index.cfm/contact',    web: true },
    { role: 'U.S. Senator (CO)', name: 'Sen. John Hickenlooper', email: 'https://www.hickenlooper.senate.gov/contact/',              web: true },
  ],
}

/**
 * Per-airport reps. `federal` points at the congressional district covering
 * the airfield; we resolve the actual Representative from a shared map so we
 * don't duplicate the contact entry if two airports share a district.
 */
export const US_HOUSE_BY_DISTRICT = {
  'CO-2': { role: 'U.S. Representative (CO-2)', name: 'Rep. Joe Neguse', email: 'https://neguse.house.gov/contact', web: true },
  'CO-8': { role: 'U.S. Representative (CO-8)', name: 'Rep. Gabe Evans', email: 'https://gabeevans.house.gov/contact', web: true },
}

export const AIRPORT_REPS = {
  KBDU: {
    label: 'Boulder Municipal',
    city:  { name: 'City of Boulder' },
    cityContacts: [
      { role: 'Mayor of Boulder',  name: 'Mayor of Boulder',        email: 'brocketta@bouldercolorado.gov' },
      { role: 'Boulder City Council', name: 'Boulder City Council', email: 'council@bouldercolorado.gov' },
    ],
    county: { name: 'Boulder County' },
    countyContacts: [
      { role: 'Boulder County Commissioners', name: 'Boulder County Commissioners', email: 'commissioners@bouldercounty.org' },
    ],
    state: [
      { role: 'Colorado State Senate (SD-18)', name: 'CO State Senate — District 18', email: 'https://leg.colorado.gov/', web: true },
      { role: 'Colorado State House (HD-10)',  name: 'CO State House — District 10',  email: 'https://leg.colorado.gov/', web: true },
    ],
    federalDistrict: 'CO-2',
  },

  KLMO: {
    label: 'Vance Brand (Longmont)',
    city:  { name: 'City of Longmont' },
    cityContacts: [
      { role: 'Mayor of Longmont',    name: 'Mayor of Longmont',    email: 'mayor@longmontcolorado.gov' },
      { role: 'Longmont City Council',name: 'Longmont City Council', email: 'citycouncil@longmontcolorado.gov' },
    ],
    county: { name: 'Boulder County' },
    countyContacts: [
      { role: 'Boulder County Commissioners', name: 'Boulder County Commissioners', email: 'commissioners@bouldercounty.org' },
    ],
    state: [
      { role: 'Colorado State Senate (SD-17)', name: 'CO State Senate — District 17', email: 'https://leg.colorado.gov/', web: true },
      { role: 'Colorado State House (HD-11)',  name: 'CO State House — District 11',  email: 'https://leg.colorado.gov/', web: true },
    ],
    federalDistrict: 'CO-2',
  },

  KEIK: {
    label: 'Erie Municipal',
    city:  { name: 'Town of Erie' },
    cityContacts: [
      { role: 'Mayor of Erie',       name: 'Mayor of Erie',         email: 'mayor@erieco.gov' },
      { role: 'Erie Board of Trustees', name: 'Erie Board of Trustees', email: 'board@erieco.gov' },
    ],
    county: { name: 'Weld County / Boulder County' },
    countyContacts: [
      { role: 'Weld County Commissioners',    name: 'Weld County Commissioners',    email: 'commissioners@weldgov.com' },
      { role: 'Boulder County Commissioners', name: 'Boulder County Commissioners', email: 'commissioners@bouldercounty.org' },
    ],
    state: [
      { role: 'Colorado State Senate (SD-23)', name: 'CO State Senate — District 23', email: 'https://leg.colorado.gov/', web: true },
      { role: 'Colorado State House (HD-19)',  name: 'CO State House — District 19',  email: 'https://leg.colorado.gov/', web: true },
    ],
    federalDistrict: 'CO-8',
  },

  KBJC: {
    label: 'Rocky Mountain Metro (Broomfield/Jeffco)',
    city:  { name: 'City & County of Broomfield' },
    cityContacts: [
      { role: 'Mayor of Broomfield',    name: 'Mayor of Broomfield',    email: 'mayor@broomfield.org' },
      { role: 'Broomfield City Council',name: 'Broomfield City Council', email: 'citycouncil@broomfield.org' },
    ],
    county: { name: 'Jefferson County / Broomfield (consolidated)' },
    countyContacts: [
      { role: 'Jefferson County Commissioners', name: 'Jefferson County Commissioners', email: 'commissioners@jeffco.us' },
    ],
    state: [
      { role: 'Colorado State Senate (SD-24)', name: 'CO State Senate — District 24', email: 'https://leg.colorado.gov/', web: true },
      { role: 'Colorado State House (HD-33)',  name: 'CO State House — District 33',  email: 'https://leg.colorado.gov/', web: true },
    ],
    federalDistrict: 'CO-8',
  },

  KFNL: {
    label: 'Northern Colorado Regional (Fort Collins/Loveland)',
    city:  { name: 'Fort Collins & Loveland' },
    cityContacts: [
      { role: 'Mayor of Fort Collins',      name: 'Mayor of Fort Collins',       email: 'cityleaders@fcgov.com' },
      { role: 'Fort Collins City Council',  name: 'Fort Collins City Council',   email: 'cityleaders@fcgov.com' },
      { role: 'Mayor of Loveland',          name: 'Mayor of Loveland',           email: 'council@cityofloveland.org' },
      { role: 'Loveland City Council',      name: 'Loveland City Council',       email: 'council@cityofloveland.org' },
    ],
    county: { name: 'Larimer County' },
    countyContacts: [
      { role: 'Larimer County Commissioners', name: 'Larimer County Commissioners', email: 'bocc@larimer.org' },
    ],
    state: [
      { role: 'Colorado State Senate (SD-14)', name: 'CO State Senate — District 14', email: 'https://leg.colorado.gov/', web: true },
      { role: 'Colorado State House (HD-53)',  name: 'CO State House — District 53',  email: 'https://leg.colorado.gov/', web: true },
    ],
    federalDistrict: 'CO-2',
  },
}

/**
 * Resolve a flat, deduped, tier-ordered list of rep contacts for a set of
 * airports. Each entry is `{ id, tier, role, name, email, web }`.
 * `tier ∈ { 'city', 'county', 'state', 'federal', 'governor' }`.
 */
export function repsForAirports(airportIds) {
  const seen = new Set()
  const out = []
  const push = (tier, r) => {
    if (!r) return
    const key = `${tier}:${r.email}:${r.name}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ id: key, tier, ...r })
  }

  const ids = Array.from(new Set(airportIds || []))
  for (const aid of ids) {
    const a = AIRPORT_REPS[aid]
    if (!a) continue
    for (const c of a.cityContacts   || []) push('city',   c)
    for (const c of a.countyContacts || []) push('county', c)
    for (const c of a.state          || []) push('state',  c)
    if (a.federalDistrict) push('federal', US_HOUSE_BY_DISTRICT[a.federalDistrict])
  }
  for (const s of SHARED_REPS.senators) push('federal', s)
  push('governor', SHARED_REPS.governor)

  return out
}

export const TIER_LABELS = {
  city:     'City',
  county:   'County',
  state:    'State',
  federal:  'Federal',
  governor: "Governor's office",
}

/**
 * Build a mailto: URL that opens the user's mail client with the selected
 * reps as recipients and a pre-filled body summarizing their complaints.
 * Web-form-only reps are excluded from the `to` list — the UI should render
 * them as separate links.
 */
export function buildMailtoForReport({ reps, subject, body }) {
  const to = reps.filter((r) => !r.web).map((r) => r.email)
  if (!to.length) return null
  const params = new URLSearchParams()
  if (subject) params.set('subject', subject)
  if (body)    params.set('body',    body)
  return `mailto:${to.join(',')}?${params.toString()}`
}
