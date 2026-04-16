import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, Polyline, Polygon, CircleMarker, Tooltip } from 'react-leaflet'
import { NOISE_ZONES } from './noiseZones'
import { classifyPoint } from './geo'

const KBDU = [40.0394, -105.2258]

function parseHashQuery(hash) {
  const q = hash.split('?')[1] || ''
  const out = {}
  for (const pair of q.split('&')) {
    if (!pair) continue
    const [k, v] = pair.split('=')
    out[decodeURIComponent(k)] = decodeURIComponent(v || '')
  }
  return out
}

// Scan localStorage across all captured days for the requested tail. Returns
// the most recent matching aircraft record, or null.
function findAircraftByTail(tail) {
  if (!tail) return null
  const keys = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith('noise_live_')) keys.push(k)
  }
  keys.sort().reverse() // newest day first
  const up = tail.toUpperCase()
  for (const k of keys) {
    try {
      const parsed = JSON.parse(localStorage.getItem(k) || '{}')
      for (const ac of parsed.aircraft || []) {
        const candidate = (ac.call || ac.icao || '').toUpperCase()
        if (candidate === up) return { ...ac, dayKey: k }
      }
    } catch {}
  }
  return null
}

// Split an aircraft's point stream into distinct flights. A gap > 15 min
// between consecutive timestamps starts a new flight. Each flight carries its
// own start/end timestamps and points.
const FLIGHT_GAP_MS = 15 * 60 * 1000
function splitIntoFlights(points) {
  const flights = []
  let cur = null
  for (const p of points) {
    const ts = p[3]
    if (!cur || ts - cur.endTs > FLIGHT_GAP_MS) {
      cur = { startTs: ts, endTs: ts, points: [p] }
      flights.push(cur)
    } else {
      cur.endTs = ts
      cur.points.push(p)
    }
  }
  return flights
}

// Pick the flight that contains a given timestamp, or the most recent flight
// if `at` is not provided or doesn't match.
function pickFlight(flights, at) {
  if (!flights.length) return null
  if (at) {
    const t = Number(at)
    const match = flights.find((f) => t >= f.startTs && t <= f.endTs)
    if (match) return match
    // Fall through to the flight closest in time.
    return flights.reduce((best, f) => {
      const d = Math.min(Math.abs(f.startTs - t), Math.abs(f.endTs - t))
      if (!best || d < best._d) return { ...f, _d: d }
      return best
    }, null)
  }
  return flights[flights.length - 1]
}

function formatTime(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '—'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

// Short deterministic id from the flight's start timestamp, for "Flight"
// labels in the notice header (e.g. "BDU-8F3C").
function flightShortId(tail, startTs) {
  const base = `${tail}-${startTs}`
  let h = 0
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).slice(-4).toUpperCase()
}

// Break a track's points into contiguous colored segments, one per
// classification change. "clean" runs render in muted gray; yellow/orange/red
// highlight the actual deviations.
function segmentTrack(points) {
  const segs = []
  let cur = null
  for (const p of points) {
    const cls = classifyPoint(p[0], p[1], p[2], NOISE_ZONES) || 'clean'
    if (!cur || cur.cls !== cls) {
      if (cur && cur.pts.length) cur.pts.push([p[0], p[1]]) // join segments visually
      cur = { cls, pts: [[p[0], p[1]]], minAlt: p[2], minAltPt: [p[0], p[1]] }
      segs.push(cur)
    } else {
      cur.pts.push([p[0], p[1]])
      if (p[2] != null && (cur.minAlt == null || p[2] < cur.minAlt)) {
        cur.minAlt = p[2]
        cur.minAltPt = [p[0], p[1]]
      }
    }
  }
  return segs
}

const COLORS = {
  clean: '#16a34a',
  yellow: '#facc15',
  orange: '#f97316',
  red: '#dc2626',
}

export default function NoticePage() {
  const [hash, setHash] = useState(() => window.location.hash || '')
  useEffect(() => {
    const on = () => setHash(window.location.hash || '')
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  const { tail = '', at = '', school = '' } = parseHashQuery(hash)
  const ac = useMemo(() => findAircraftByTail(tail), [tail])

  const flights = useMemo(
    () => (ac?.points?.length ? splitIntoFlights(ac.points) : []),
    [ac],
  )
  const flight = useMemo(() => pickFlight(flights, at), [flights, at])
  const flightPoints = flight?.points || []
  const flightId = flight ? flightShortId(tail, flight.startTs) : null

  const segments = useMemo(
    () => (flightPoints.length ? segmentTrack(flightPoints) : []),
    [flightPoints],
  )

  // Compute a bounds-ish center: flight midpoint if available, else KBDU.
  const center = useMemo(() => {
    if (!flightPoints.length) return KBDU
    let sLat = 0, sLon = 0
    for (const p of flightPoints) { sLat += p[0]; sLon += p[1] }
    return [sLat / flightPoints.length, sLon / flightPoints.length]
  }, [flightPoints])

  // Deviation stats: count events and worst classification within this flight.
  const deviations = useMemo(() => {
    if (!flightPoints.length) return []
    const out = []
    let cur = null
    for (const p of flightPoints) {
      const c = classifyPoint(p[0], p[1], p[2], NOISE_ZONES)
      if (c) {
        if (!cur) cur = { worst: c, startTs: p[3], endTs: p[3], peakAlt: p[2] }
        else {
          cur.endTs = p[3]
          if (p[2] < cur.peakAlt) cur.peakAlt = p[2]
          const rank = { yellow: 1, orange: 2, red: 3 }
          if (rank[c] > rank[cur.worst]) cur.worst = c
        }
      } else if (cur) {
        out.push(cur)
        cur = null
      }
    }
    if (cur) out.push(cur)
    return out
  }, [ac])

  return (
    <div className="h-full w-full flex bg-[#f4f1ea] text-[#2b2b2b]">
      {/* Left column — the message */}
      <aside className="w-[420px] min-w-[360px] max-w-[38%] overflow-y-auto border-r border-black/10 bg-white">
        <div className="bg-[#1b3a5b] text-white px-6 py-5">
          <div className="uppercase tracking-[2px] text-[10px] opacity-80">
            Boulder Municipal Airport · KBDU
          </div>
          <h1 className="mt-1 text-xl font-serif">
            Good Pilots Make Good Neighbors
          </h1>
        </div>

        {/* FLIGHT / TAIL / TIME identifying strip */}
        <div className="grid grid-cols-3 bg-[#0f2540] text-white/90 divide-x divide-white/10 font-sans">
          <div className="px-4 py-3">
            <div className="text-[9px] uppercase tracking-[1.5px] text-white/50">Flight</div>
            <div className="font-mono text-sm mt-0.5">
              {flightId ? `BDU-${flightId}` : '—'}
            </div>
          </div>
          <div className="px-4 py-3">
            <div className="text-[9px] uppercase tracking-[1.5px] text-white/50">Tail</div>
            <div className="font-mono text-sm mt-0.5">{tail || '—'}</div>
          </div>
          <div className="px-4 py-3">
            <div className="text-[9px] uppercase tracking-[1.5px] text-white/50">Time</div>
            <div className="text-[11px] mt-0.5 leading-tight">
              {flight ? (
                <>
                  <div>{formatTime(flight.startTs)}</div>
                  <div className="text-white/50">
                    · {formatDuration(flight.endTs - flight.startTs)}
                  </div>
                </>
              ) : (
                '—'
              )}
            </div>
          </div>
        </div>

        <div className="px-6 py-5 font-serif text-[15px] leading-relaxed space-y-4">
          <p className="italic text-[#4a4a4a]">A friendly hello from one pilot to another.</p>

          <p>
            Welcome to Boulder Municipal Airport. We noticed a recent visit
            {tail ? ` by ${tail} ` : ' '}
            near our <em>Voluntary Noise Abatement</em> corridors, and we'd
            love the chance to introduce you to how we fly here together.
          </p>

          <p>
            Boulder sits in a narrow strip of shared airspace west of Denver,
            and every voluntary courtesy our visitors extend is a piece of the
            progress this community is making together. The corridors are
            pilot-built, pilot-maintained, and they work because pilots like
            you choose to fly them.
          </p>

          <div className="bg-[#faf7ef] border-l-4 border-[#c98a2a] px-4 py-3">
            <div className="font-sans text-[13px] uppercase tracking-wide text-[#1b3a5b] font-semibold mb-1">
              The Progress We're Making Together
            </div>
            <ul className="list-disc ml-5 text-[14px] space-y-1">
              <li>
                A friendly ADS-B courtesy-review program, built to help visiting
                pilots learn the local flows.
              </li>
              <li>
                Monthly <em>Airspace Awareness</em> ride-alongs with local CFIs
                who'll walk the corridors with you from the cockpit.
              </li>
              <li>
                A First Saturday fly-in breakfast where visiting and local
                pilots share coffee and local knowledge.
              </li>
              <li>
                Year-over-year voluntary compliance trends shared openly with
                the City of Boulder Airport Administration and the pilot
                community.
              </li>
            </ul>
            <div className="font-sans text-[11px] text-[#4a4a4a] mt-2 italic">
              ADS-B participation is voluntary and this review is for courtesy
              and education only — we use it purely to say hello and invite
              you in.
            </div>
          </div>

          <p>
            Boulder Municipal is the oldest airport in Colorado, and noise
            around any airport is a genuinely complex topic — legal, political,
            historical, practical — that no single letter (or lifetime) can
            fully unpack. What we <em>can</em> say plainly is that our team is
            making every effort to be the best neighbors we can be, and for us
            that means careful, thoughtful airspace management alongside the
            pilots who fly here.
          </p>

          <p>
            That's where you come in. We'd love to welcome you in and share
            what we've learned. Join us for a{' '}
            <strong>First Saturday fly-in breakfast</strong>, a Front Range
            Airspace Wings event, or best of all an{' '}
            <strong>Airspace Awareness flight</strong> right here at KBDU, where
            a local CFI will walk the flows with you from the cockpit.
          </p>

          <p className="italic text-[#4a4a4a] pt-2">
            Blue skies, and welcome to Boulder,<br />
            The team at Boulder Municipal Airport (KBDU)
          </p>
        </div>

        <div className="px-6 py-4 border-t border-black/10 bg-[#ece7dc]">
          <div className="font-sans text-[11px] uppercase tracking-wide text-[#1b3a5b] mb-2">
            Flight details
          </div>
          {flight ? (
            <div className="font-sans text-[12px] space-y-1">
              {ac?.type && (
                <div>
                  <span className="text-black/50">Type:</span> {ac.type}
                </div>
              )}
              <div>
                <span className="text-black/50">Start:</span> {formatTime(flight.startTs)}
              </div>
              <div>
                <span className="text-black/50">End:</span> {formatTime(flight.endTs)}
              </div>
              <div>
                <span className="text-black/50">Duration:</span>{' '}
                {formatDuration(flight.endTs - flight.startTs)}
              </div>
            </div>
          ) : (
            <div className="text-[12px] text-black/60 italic">
              No flight track found for {tail || 'this tail'} in local capture.
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-black/10 bg-white">
          <a
            href={`mailto:boulderdesk@journeysaviation.com?subject=${encodeURIComponent(
              `Tail not affiliated: ${tail || '?'}${flightId ? ' · BDU-' + flightId : ''}`,
            )}&body=${encodeURIComponent(
              `Hello KBDU,\n\nThe notice I received (tail ${tail}${
                flightId ? ', flight BDU-' + flightId : ''
              }${school ? ', attributed to ' + school : ''}) is not one of our aircraft.\n\nSuggested correct operator / owner:\n\nThanks,\n`,
            )}`}
            className="block text-center text-[12px] text-[#1b3a5b] underline hover:text-[#c98a2a]"
          >
            Click here if this aircraft is not affiliated with {school || 'this flight school'}
          </a>
          <div className="text-[10px] text-black/40 text-center mt-1">
            We'll update our records and re-route the notice.
          </div>
        </div>
      </aside>

      {/* Right column — map */}
      <div className="flex-1 relative">
        <MapContainer
          center={center}
          zoom={12}
          style={{ height: '100%', width: '100%' }}
          scrollWheelZoom={true}
        >
          <TileLayer
            attribution='&copy; OpenStreetMap'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {/* Noise zones */}
          {NOISE_ZONES.map((z, i) => (
            <Polygon
              key={i}
              positions={z.polygon}
              pathOptions={{
                color: '#991b1b',
                weight: 2,
                fillColor: '#dc2626',
                fillOpacity: 0.35,
              }}
            >
              <Tooltip sticky>{z.name}</Tooltip>
            </Polygon>
          ))}

          {/* KBDU marker */}
          <CircleMarker
            center={KBDU}
            radius={6}
            pathOptions={{ color: '#1b3a5b', fillColor: '#c98a2a', fillOpacity: 1, weight: 2 }}
          >
            <Tooltip permanent direction="right" offset={[8, 0]}>
              <span style={{ fontFamily: 'serif', fontSize: '12px' }}>KBDU</span>
            </Tooltip>
          </CircleMarker>

          {/* The flight track — segmented, violations highlighted */}
          {segments.map((s, i) => (
            <Polyline
              key={i}
              positions={s.pts}
              pathOptions={{
                color: COLORS[s.cls] || COLORS.clean,
                weight: s.cls === 'clean' ? 5 : 7,
                opacity: 0.95,
              }}
            />
          ))}

          {/* Permanent altitude labels — violation segments only */}
          {segments
            .filter((s) => s.cls !== 'clean' && s.minAlt != null && s.minAltPt)
            .map((s, i) => (
              <CircleMarker
                key={`alt-${i}`}
                center={s.minAltPt}
                radius={0}
                pathOptions={{ opacity: 0, fillOpacity: 0 }}
              >
                <Tooltip
                  permanent
                  direction="top"
                  offset={[0, -4]}
                  className="alt-label"
                >
                  {Math.round(s.minAlt).toLocaleString()} ft
                </Tooltip>
              </CircleMarker>
            ))}
        </MapContainer>
      </div>
    </div>
  )
}
