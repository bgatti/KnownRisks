// suntimes.js — sunrise / sunset / civil-twilight calculator.
//
// Standard NOAA Solar Calculator algorithm. Good to ~1 minute at
// reasonable latitudes (the Front Range is fine).
//
// Used by:
//   - currency.js to determine whether a takeoff/landing timestamp
//     falls in the FAR 61.57(b) night window (1 hr after sunset →
//     1 hr before sunrise at the airport lat/lon).
//   - features.js to flag night-flight segments.

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

function julianDate(d) {
  // d is a Date (UTC). Returns Julian Date (days since 4713 BC noon UTC).
  return (d.getTime() / 86400000) + 2440587.5
}

function julianCentury(jd) {
  return (jd - 2451545.0) / 36525.0
}

function geomMeanLongSun(t) {
  let L = 280.46646 + t * (36000.76983 + t * 0.0003032)
  L = ((L % 360) + 360) % 360
  return L
}

function geomMeanAnomSun(t) {
  return 357.52911 + t * (35999.05029 - 0.0001537 * t)
}

function eccentricityEarthOrbit(t) {
  return 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
}

function sunEqOfCenter(t) {
  const m = geomMeanAnomSun(t) * DEG2RAD
  return Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t))
    + Math.sin(2 * m) * (0.019993 - 0.000101 * t)
    + Math.sin(3 * m) * 0.000289
}

function sunTrueLong(t) { return geomMeanLongSun(t) + sunEqOfCenter(t) }

function sunAppLong(t) {
  return sunTrueLong(t) - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * DEG2RAD)
}

function meanObliquityOfEcliptic(t) {
  return 23 + (26 + ((21.448 - t * (46.815 + t * (0.00059 - t * 0.001813)))) / 60) / 60
}

function obliquityCorr(t) {
  return meanObliquityOfEcliptic(t) + 0.00256 * Math.cos((125.04 - 1934.136 * t) * DEG2RAD)
}

function sunDeclination(t) {
  const e = obliquityCorr(t) * DEG2RAD
  const lam = sunAppLong(t) * DEG2RAD
  return Math.asin(Math.sin(e) * Math.sin(lam)) * RAD2DEG
}

function equationOfTime(t) {
  const e = obliquityCorr(t) * DEG2RAD
  const L = geomMeanLongSun(t) * DEG2RAD
  const m = geomMeanAnomSun(t) * DEG2RAD
  const ecc = eccentricityEarthOrbit(t)
  const y = Math.tan(e / 2) ** 2
  const Etime = y * Math.sin(2 * L)
    - 2 * ecc * Math.sin(m)
    + 4 * ecc * y * Math.sin(m) * Math.cos(2 * L)
    - 0.5 * y * y * Math.sin(4 * L)
    - 1.25 * ecc * ecc * Math.sin(2 * m)
  return Etime * 4 * RAD2DEG   // minutes
}

function hourAngle(latDeg, declDeg, zenithDeg) {
  const lat = latDeg * DEG2RAD
  const decl = declDeg * DEG2RAD
  const zen = zenithDeg * DEG2RAD
  const cosH = (Math.cos(zen) - Math.sin(lat) * Math.sin(decl)) / (Math.cos(lat) * Math.cos(decl))
  if (cosH < -1) return Math.PI       // sun never sets — return 180°
  if (cosH > 1) return 0               // sun never rises
  return Math.acos(cosH)
}

/**
 * Sunrise / sunset / civil-twilight in UTC for a given date and
 * location. Returns timestamps as epoch seconds. Returns null on
 * polar day/night where the event doesn't happen.
 *
 * Zeniths:
 *   sunrise/sunset: 90.833° (refraction + solar disc)
 *   civil twilight:   96°
 *
 * @param {Date} date     a Date — only its UTC year/month/day are used
 * @param {number} latDeg
 * @param {number} lonDeg  east-positive (e.g. -105.25 for KBDU)
 */
export function sunTimes(date, latDeg, lonDeg) {
  // Snap to local civil noon, compute t, then add hour angles.
  const utcMidnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  const jd = julianDate(new Date(utcMidnight))
  const t = julianCentury(jd + 0.5)            // approx-noon
  const decl = sunDeclination(t)
  const eqTime = equationOfTime(t)             // minutes

  function eventUtcSeconds(zenithDeg, sign) {
    const ha = hourAngle(latDeg, decl, zenithDeg)
    if (ha === 0 || ha === Math.PI) return null
    const haMinutes = ha * RAD2DEG * 4
    // Solar noon at this longitude (UTC minutes from midnight):
    const solarNoonMin = 720 - 4 * lonDeg - eqTime
    const eventMin = solarNoonMin + sign * haMinutes
    return Math.floor(utcMidnight / 1000) + Math.round(eventMin * 60)
  }

  return {
    sunrise: eventUtcSeconds(90.833, -1),
    sunset:  eventUtcSeconds(90.833, +1),
    civilDawn: eventUtcSeconds(96, -1),
    civilDusk: eventUtcSeconds(96, +1),
  }
}

/**
 * Is the given epoch-second timestamp during FAA "night" at this
 * location for FAR 61.57(b) currency? FAA defines this as 1 hour
 * after sunset to 1 hour before sunrise.
 */
export function isFaaNight(tsUnix, latDeg, lonDeg) {
  const d = new Date(tsUnix * 1000)
  // The sunrise/sunset for "today" relative to this timestamp.
  const today = sunTimes(d, latDeg, lonDeg)
  if (!today.sunset || !today.sunrise) return false

  // The flight could happen across midnight UTC. Compute previous /
  // next day too so we have neighbours.
  const prev = sunTimes(new Date(d.getTime() - 86400000), latDeg, lonDeg)
  const next = sunTimes(new Date(d.getTime() + 86400000), latDeg, lonDeg)

  const ONE_HR = 3600
  // After "today's" sunset + 1h: night begins.
  // Until "tomorrow's" sunrise - 1h: night ends.
  const afterTodaySunset = today.sunset + ONE_HR
  const beforeTomorrowSunrise = (next.sunrise || (today.sunrise + 86400)) - ONE_HR
  if (tsUnix >= afterTodaySunset && tsUnix <= beforeTomorrowSunrise) return true

  // Or after yesterday's sunset (if this timestamp is early-morning UTC).
  const afterYesterdaySunset = (prev.sunset || (today.sunset - 86400)) + ONE_HR
  const beforeTodaySunrise = today.sunrise - ONE_HR
  if (tsUnix >= afterYesterdaySunset && tsUnix <= beforeTodaySunrise) return true

  return false
}

/**
 * Is the given timestamp during civil-twilight or darker? (Sun below
 * horizon, useful for "this is a night flight" labeling separate from
 * the stricter FAA currency definition.)
 */
export function isAfterCivilDusk(tsUnix, latDeg, lonDeg) {
  const d = new Date(tsUnix * 1000)
  const today = sunTimes(d, latDeg, lonDeg)
  const prev = sunTimes(new Date(d.getTime() - 86400000), latDeg, lonDeg)
  if (today.civilDusk && tsUnix >= today.civilDusk
      && tsUnix < (today.civilDawn || today.civilDusk) + 86400) return true
  if (prev.civilDusk && tsUnix >= prev.civilDusk
      && tsUnix < (today.civilDawn || prev.civilDusk + 86400)) return true
  return false
}
