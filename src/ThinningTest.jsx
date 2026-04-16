import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import SvgCurve from './SvgCurve.jsx'

const KBDU = [40.0394, -105.2258]
const FT_PER_DEG_LAT = 364560

// ─── Point-thinning algorithms ────────────────────────────────────────────────

// 3D distance in feet between two [lat, lon, alt] points. Altitude is
// weighted equally with horizontal ft, so a 100 ft climb is the same "cost"
// as a 100 ft horizontal move — reasonable for pattern work where vertical
// change matters for classification.
function dist3dFt(a, b) {
  const dLat = (b[0] - a[0]) * FT_PER_DEG_LAT
  const dLon = (b[1] - a[1]) * FT_PER_DEG_LAT * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180)
  const dAlt = (b[2] - a[2])
  return Math.sqrt(dLat * dLat + dLon * dLon + dAlt * dAlt)
}

// Perpendicular distance (ft) from point p to the straight line ab.
// 2D only — altitude not included (DP would otherwise over-preserve turns).
function perpDistFt(p, a, b) {
  const latRef = (a[0] + b[0] + p[0]) / 3
  const cos = Math.cos((latRef * Math.PI) / 180)
  const px = (p[1] - a[1]) * FT_PER_DEG_LAT * cos
  const py = (p[0] - a[0]) * FT_PER_DEG_LAT
  const dx = (b[1] - a[1]) * FT_PER_DEG_LAT * cos
  const dy = (b[0] - a[0]) * FT_PER_DEG_LAT
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px, py)
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2))
  const projX = t * dx
  const projY = t * dy
  return Math.hypot(px - projX, py - projY)
}

// Radial (3D) — keep a point only if it's > `minFt` from the last kept one.
// Always keeps first and last points of the track.
function thinRadial(points, minFt) {
  if (points.length < 3 || minFt <= 0) return points
  const out = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    if (dist3dFt(points[i], out[out.length - 1]) >= minFt) {
      out.push(points[i])
    }
  }
  out.push(points[points.length - 1])
  return out
}

// Douglas-Peucker with horizontal perpendicular distance tolerance (ft).
function thinDP(points, epsilonFt) {
  if (points.length < 3 || epsilonFt <= 0) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop()
    let maxD = 0
    let idx = -1
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistFt(points[i], points[lo], points[hi])
      if (d > maxD) { maxD = d; idx = i }
    }
    if (maxD > epsilonFt && idx >= 0) {
      keep[idx] = 1
      stack.push([lo, idx])
      stack.push([idx, hi])
    }
  }
  const out = []
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i])
  return out
}

function thin(points, algo, tolerance) {
  if (algo === 'none') return points
  if (algo === 'radial') return thinRadial(points, tolerance)
  if (algo === 'dp') return thinDP(points, tolerance)
  if (algo === 'combined') return thinDP(thinRadial(points, tolerance / 2), tolerance)
  return points
}

// ─── Corner-smoothing pre-filters ────────────────────────────────────────────
// Applied to the control points BEFORE the spline/curve renderer. The rule is
// "an aircraft can't make sharp corners" — any kink in the raw data must be
// ADS-B noise or a tracking artifact, not an actual maneuver. Smoothing
// averages those transitions out so the rendered curve matches a plausible
// flight path.

// Moving average over a sliding window — each point is replaced by the
// unweighted mean of its window-sized neighborhood. Point count unchanged.
// window = total points in the kernel (must be odd to stay centered).
function movingAverageLL(points, window) {
  if (window < 3 || points.length < 3) return points.map((p) => p.slice())
  const half = Math.floor(window / 2)
  const out = []
  for (let i = 0; i < points.length; i++) {
    let sLat = 0, sLon = 0, sAlt = 0, n = 0
    const lo = Math.max(0, i - half)
    const hi = Math.min(points.length - 1, i + half)
    for (let j = lo; j <= hi; j++) {
      sLat += points[j][0]
      sLon += points[j][1]
      sAlt += points[j][2] || 0
      n++
    }
    out.push([sLat / n, sLon / n, sAlt / n])
  }
  return out
}

// Chaikin corner-cut in lat/lon space. Each iteration doubles the point count.
// Unlike the pixel-space version in SvgCurve, this modifies the CONTROL points
// that later feed the spline renderer, so the result is cumulative smoothing.
function chaikinLL(points, iterations) {
  if (iterations < 1 || points.length < 3) return points.map((p) => p.slice())
  let arr = points.map((p) => p.slice())
  for (let it = 0; it < iterations; it++) {
    const next = [arr[0]]
    for (let i = 0; i < arr.length - 1; i++) {
      const a = arr[i]
      const b = arr[i + 1]
      next.push([
        0.75 * a[0] + 0.25 * b[0],
        0.75 * a[1] + 0.25 * b[1],
        0.75 * (a[2] || 0) + 0.25 * (b[2] || 0),
      ])
      next.push([
        0.25 * a[0] + 0.75 * b[0],
        0.25 * a[1] + 0.75 * b[1],
        0.25 * (a[2] || 0) + 0.75 * (b[2] || 0),
      ])
    }
    next.push(arr[arr.length - 1])
    arr = next
  }
  return arr
}

// Dispatcher — pick the corner-smoothing pre-filter.
function cornerSmooth(points, type, amount) {
  if (!points || points.length < 3 || type === 'none') return points
  if (type === 'movavg') return movingAverageLL(points, amount)
  if (type === 'chaikin') return chaikinLL(points, amount)
  return points
}

// ─── Curve smoothers ──────────────────────────────────────────────────────────
// All operate on [lat, lon] arrays and return a densified [lat, lon] polyline.

// Chaikin corner-cutting — does NOT pass through the input points, but
// produces a very smooth polyline after a few iterations. Cheap and
// forgiving on noisy input.
function chaikinSmooth(points, iterations = 3) {
  if (points.length < 3) return points.map((p) => [p[0], p[1]])
  let pts = points.map((p) => [p[0], p[1]])
  for (let it = 0; it < iterations; it++) {
    const next = [pts[0]]
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i]
      const p2 = pts[i + 1]
      next.push([0.75 * p1[0] + 0.25 * p2[0], 0.75 * p1[1] + 0.25 * p2[1]])
      next.push([0.25 * p1[0] + 0.75 * p2[0], 0.25 * p1[1] + 0.75 * p2[1]])
    }
    next.push(pts[pts.length - 1])
    pts = next
  }
  return pts
}

// Quadratic Bezier between midpoints, with each input point as the control.
// Produces a curve tangent to the input polyline at each midpoint. This is
// the "classic smooth-through-waypoints" technique used by most mapping
// libraries. Passes through the midpoints but not the input vertices.
function bezierQuadSmooth(points, samples = 8) {
  if (points.length < 3) return points.map((p) => [p[0], p[1]])
  const out = [[points[0][0], points[0][1]]]
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = points[i - 1]
    const p1 = points[i]
    const p2 = points[i + 1]
    const m0Lat = (p0[0] + p1[0]) / 2
    const m0Lon = (p0[1] + p1[1]) / 2
    const m1Lat = (p1[0] + p2[0]) / 2
    const m1Lon = (p1[1] + p2[1]) / 2
    for (let s = 1; s <= samples; s++) {
      const t = s / samples
      const u = 1 - t
      out.push([
        u * u * m0Lat + 2 * u * t * p1[0] + t * t * m1Lat,
        u * u * m0Lon + 2 * u * t * p1[1] + t * t * m1Lon,
      ])
    }
  }
  out.push([points[points.length - 1][0], points[points.length - 1][1]])
  return out
}

// Cubic Bezier cardinal-spline variant — computes two handles per segment
// from neighboring points with a tension parameter. Passes through all
// points and has C1 continuity at each vertex. Tension 0 = Catmull-Rom
// equivalent, higher tension flattens curves at vertices.
function bezierCubicSmooth(points, samples = 8, tension = 0.5) {
  if (points.length < 3) return points.map((p) => [p[0], p[1]])
  const out = [[points[0][0], points[0][1]]]
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]
    // Control handles using cardinal tension
    const c1Lat = p1[0] + ((p2[0] - p0[0]) * tension) / 3
    const c1Lon = p1[1] + ((p2[1] - p0[1]) * tension) / 3
    const c2Lat = p2[0] - ((p3[0] - p1[0]) * tension) / 3
    const c2Lon = p2[1] - ((p3[1] - p1[1]) * tension) / 3
    for (let s = 1; s <= samples; s++) {
      const t = s / samples
      const u = 1 - t
      // Cubic Bernstein polynomials
      const b0 = u * u * u
      const b1 = 3 * u * u * t
      const b2 = 3 * u * t * t
      const b3 = t * t * t
      out.push([
        b0 * p1[0] + b1 * c1Lat + b2 * c2Lat + b3 * p2[0],
        b0 * p1[1] + b1 * c1Lon + b2 * c2Lon + b3 * p2[1],
      ])
    }
  }
  return out
}

// Dispatcher — pick a smoother by string ID.
function applyCurve(points, curveType) {
  if (points.length < 2) return points.map((p) => [p[0], p[1]])
  const ll = points.map((p) => [p[0], p[1]])
  if (curveType === 'straight') return ll
  if (curveType === 'catmull') return catmullRomSmooth(points, 8)
  if (curveType === 'chaikin') return chaikinSmooth(ll, 3)
  if (curveType === 'bezierQ') return bezierQuadSmooth(ll, 8)
  if (curveType === 'bezierC') return bezierCubicSmooth(ll, 8, 0.5)
  return ll
}

// ─── Catmull-Rom spline smoothing ─────────────────────────────────────────────
// Generates a densified polyline passing through every control point.
// samples = intermediate points per segment. Higher = smoother but more data.
// Uses "centripetal" variant (alpha=0.5) for stability against closely-spaced
// control points.
function catmullRomSmooth(points, samples = 8) {
  if (points.length < 3) return points.map((p) => [p[0], p[1]])
  const out = []
  const alpha = 0.5
  const getT = (ti, pi, pj) => {
    const dLat = (pj[0] - pi[0]) * FT_PER_DEG_LAT
    const dLon = (pj[1] - pi[1]) * FT_PER_DEG_LAT * Math.cos(((pi[0] + pj[0]) / 2) * Math.PI / 180)
    const d = Math.hypot(dLat, dLon)
    return ti + Math.pow(Math.max(1e-9, d), alpha)
  }
  // Duplicate first and last points so the curve starts/ends on them
  const extended = [points[0], ...points, points[points.length - 1]]
  for (let i = 0; i < extended.length - 3; i++) {
    const p0 = extended[i]
    const p1 = extended[i + 1]
    const p2 = extended[i + 2]
    const p3 = extended[i + 3]
    const t0 = 0
    const t1 = getT(t0, p0, p1)
    const t2 = getT(t1, p1, p2)
    const t3 = getT(t2, p2, p3)
    for (let s = 0; s < samples; s++) {
      const t = t1 + (s / samples) * (t2 - t1)
      const a1Lat = ((t1 - t) / (t1 - t0)) * p0[0] + ((t - t0) / (t1 - t0)) * p1[0]
      const a1Lon = ((t1 - t) / (t1 - t0)) * p0[1] + ((t - t0) / (t1 - t0)) * p1[1]
      const a2Lat = ((t2 - t) / (t2 - t1)) * p1[0] + ((t - t1) / (t2 - t1)) * p2[0]
      const a2Lon = ((t2 - t) / (t2 - t1)) * p1[1] + ((t - t1) / (t2 - t1)) * p2[1]
      const a3Lat = ((t3 - t) / (t3 - t2)) * p2[0] + ((t - t2) / (t3 - t2)) * p3[0]
      const a3Lon = ((t3 - t) / (t3 - t2)) * p2[1] + ((t - t2) / (t3 - t2)) * p3[1]
      const b1Lat = ((t2 - t) / (t2 - t0)) * a1Lat + ((t - t0) / (t2 - t0)) * a2Lat
      const b1Lon = ((t2 - t) / (t2 - t0)) * a1Lon + ((t - t0) / (t2 - t0)) * a2Lon
      const b2Lat = ((t3 - t) / (t3 - t1)) * a2Lat + ((t - t1) / (t3 - t1)) * a3Lat
      const b2Lon = ((t3 - t) / (t3 - t1)) * a2Lon + ((t - t1) / (t3 - t1)) * a3Lon
      const cLat = ((t2 - t) / (t2 - t1)) * b1Lat + ((t - t1) / (t2 - t1)) * b2Lat
      const cLon = ((t2 - t) / (t2 - t1)) * b1Lon + ((t - t1) / (t2 - t1)) * b2Lon
      out.push([cLat, cLon])
    }
  }
  out.push([points[points.length - 1][0], points[points.length - 1][1]])
  return out
}

// Build a cumulative-distance table for a polyline so we can look up
// a (lat, lon, heading) at an arbitrary distance along it.
function buildPathIndex(latLons) {
  const cum = [0]
  for (let i = 1; i < latLons.length; i++) {
    const a = latLons[i - 1]
    const b = latLons[i]
    const dLat = (b[0] - a[0]) * FT_PER_DEG_LAT
    const dLon = (b[1] - a[1]) * FT_PER_DEG_LAT * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180)
    cum.push(cum[cum.length - 1] + Math.hypot(dLat, dLon))
  }
  return { cum, total: cum[cum.length - 1] }
}

function positionOnPath(latLons, index, distFt) {
  const { cum, total } = index
  if (latLons.length === 0) return { lat: 0, lon: 0, heading: 0 }
  if (distFt <= 0) return { lat: latLons[0][0], lon: latLons[0][1], heading: 0 }
  if (distFt >= total) {
    const last = latLons[latLons.length - 1]
    const prev = latLons[latLons.length - 2] || last
    return { lat: last[0], lon: last[1], heading: bearing(prev, last) }
  }
  // Binary search for the segment
  let lo = 0, hi = cum.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= distFt) lo = mid; else hi = mid
  }
  const a = latLons[lo]
  const b = latLons[hi]
  const segLen = cum[hi] - cum[lo]
  const t = segLen > 0 ? (distFt - cum[lo]) / segLen : 0
  return {
    lat: a[0] + (b[0] - a[0]) * t,
    lon: a[1] + (b[1] - a[1]) * t,
    heading: bearing(a, b),
  }
}

function bearing(a, b) {
  const dLat = b[0] - a[0]
  const dLon = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180)
  // 0 = north, 90 = east
  return (Math.atan2(dLon, dLat) * 180) / Math.PI
}

// Plane icon divIcon — rotated by heading, colored per path.
function makePlaneIcon(heading, color) {
  return L.divIcon({
    className: 'thinning-plane',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    html: `
      <div style="transform: rotate(${heading || 0}deg); width:22px; height:22px;">
        <svg viewBox="0 0 24 24" width="22" height="22" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2 L14 10 L22 12 L14 14 L13 22 L12 18 L11 22 L10 14 L2 12 L10 10 Z"
                fill="${color}" stroke="#0f172a" stroke-width="1" stroke-linejoin="round"/>
        </svg>
      </div>
    `,
  })
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ThinningTest() {
  const [data, setData] = useState(null)
  const [selectedSrc, setSelectedSrc] = useState(null)
  const [algo, setAlgo] = useState('radial')
  const [tolerance, setTolerance] = useState(100)
  const [curveType, setCurveType] = useState('catmull') // straight | catmull | chaikin | bezierQ | bezierC
  const [tension, setTension] = useState(0.5)            // cardinal-spline tension (catmull/bezierC)
  const [chaikinIters, setChaikinIters] = useState(3)    // chaikin corner-cut iterations (render)
  const [cornerSmoothType, setCornerSmoothType] = useState('none') // none | movavg | chaikin
  const [cornerSmoothAmount, setCornerSmoothAmount] = useState(5)  // window size OR iterations
  const [showQuality, setShowQuality] = useState(false)
  const [animating, setAnimating] = useState(false)
  const [gsKt, setGsKt] = useState(100)                  // animation speed in knots
  const [speedMult, setSpeedMult] = useState(10)         // × on real groundspeed
  const [planeSpacingMi, setPlaneSpacingMi] = useState(1) // nm between plane icons in the train
  const [distOrig, setDistOrig] = useState(0)
  const [distThin, setDistThin] = useState(0)

  useEffect(() => {
    fetch('/tracks_yearly.json')
      .then((r) => r.json())
      .then(setData)
      .catch((e) => console.error(e))
  }, [])

  // Pick the 30 tracks with the most points — thinning matters most there.
  const candidates = useMemo(() => {
    if (!data?.tracks) return []
    return data.tracks
      .slice()
      .sort((a, b) => (b.points?.length || 0) - (a.points?.length || 0))
      .slice(0, 30)
  }, [data])

  // Default to the first candidate once loaded.
  useEffect(() => {
    if (candidates.length && !selectedSrc) setSelectedSrc(candidates[0].src)
  }, [candidates, selectedSrc])

  const track = useMemo(
    () => candidates.find((t) => t.src === selectedSrc) || null,
    [candidates, selectedSrc],
  )

  // Raw original points come straight from tracks_yearly.json.
  const rawOriginal = track?.points || []
  // Corner-smoothing pre-filter: averages out tracker noise BEFORE the spline
  // renderer so sharp kinks from individual bad ADS-B samples don't turn into
  // visible curve kinks. Thinning then operates on the smoothed stream.
  const original = useMemo(
    () => cornerSmooth(rawOriginal, cornerSmoothType, cornerSmoothAmount),
    [rawOriginal, cornerSmoothType, cornerSmoothAmount],
  )
  const thinned = useMemo(
    () => (original.length ? thin(original, algo, tolerance) : []),
    [original, algo, tolerance],
  )

  const reductionPct = original.length
    ? ((1 - thinned.length / original.length) * 100).toFixed(1)
    : '0'

  // Rendered polylines: dispatched through applyCurve() so users can swap
  // between straight lines, Catmull-Rom, Chaikin, quadratic or cubic Bezier.
  const originalRender = useMemo(
    () => (original.length >= 2 ? applyCurve(original, curveType) : []),
    [original, curveType],
  )
  const thinnedRender = useMemo(
    () => (thinned.length >= 2 ? applyCurve(thinned, curveType) : []),
    [thinned, curveType],
  )

  // Quality classification: compute per-original-segment length, find the
  // median, and label each segment as excellent / good / poor based on how
  // many times longer than the median it is. Long gaps are ADS-B dropouts.
  // (We don't have timestamps in historical tracks, so distance is the
  // best proxy for elapsed time between captures.)
  const qualitySegments = useMemo(() => {
    if (original.length < 2) return { segments: [], median: 0, drops: 0 }
    const lens = []
    for (let i = 1; i < original.length; i++) {
      lens.push(dist3dFt(original[i - 1], original[i]))
    }
    const sorted = lens.slice().sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] || 1
    const segs = []
    let drops = 0
    for (let i = 1; i < original.length; i++) {
      const len = lens[i - 1]
      const ratio = len / Math.max(1, median)
      let quality
      if (ratio < 2) quality = 'excellent'
      else if (ratio < 5) quality = 'good'
      else { quality = 'poor'; drops++ }
      segs.push({
        a: [original[i - 1][0], original[i - 1][1]],
        b: [original[i][0], original[i][1]],
        len,
        ratio,
        quality,
      })
    }
    return { segments: segs, median, drops }
  }, [original])

  // Path length indices for animation — compute once per render path.
  const origIndex = useMemo(() => buildPathIndex(originalRender), [originalRender])
  const thinIndex = useMemo(() => buildPathIndex(thinnedRender), [thinnedRender])

  // Animation loop via requestAnimationFrame.
  // Speed is in knots → ft/s: 1 kt ≈ 1.688 ft/s. speedMult scales wall-clock
  // so the train rolls through the path at e.g. 10× real time.
  const FT_PER_SEC_PER_KT = 1.6878
  const lastTsRef = useRef(null)
  useEffect(() => {
    if (!animating) {
      lastTsRef.current = null
      return
    }
    let raf = 0
    const tick = (ts) => {
      if (lastTsRef.current == null) lastTsRef.current = ts
      const dt = (ts - lastTsRef.current) / 1000
      lastTsRef.current = ts
      const step = gsKt * FT_PER_SEC_PER_KT * speedMult * dt
      setDistOrig((d) => (origIndex.total > 0 ? (d + step) % origIndex.total : 0))
      setDistThin((d) => (thinIndex.total > 0 ? (d + step) % thinIndex.total : 0))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      lastTsRef.current = null
    }
  }, [animating, gsKt, speedMult, origIndex, thinIndex])

  // Reset the distances when the track or algorithm changes so the animation
  // restarts at the beginning with the new path.
  useEffect(() => {
    setDistOrig(0)
    setDistThin(0)
  }, [selectedSrc, algo, tolerance, curveType, cornerSmoothType, cornerSmoothAmount])

  // Train of plane positions: one icon per `planeSpacingMi` of path, spaced
  // that distance apart, all advancing together. When a lead icon passes the
  // end, the modulo wraps it back to start so the train is continuous.
  const spacingFt = planeSpacingMi * 5280
  const origTrain = useMemo(() => {
    if (!animating || originalRender.length < 2 || origIndex.total === 0) return []
    const n = Math.max(1, Math.floor(origIndex.total / spacingFt))
    const out = []
    for (let i = 0; i < n; i++) {
      const d = (((distOrig - i * spacingFt) % origIndex.total) + origIndex.total) % origIndex.total
      out.push(positionOnPath(originalRender, origIndex, d))
    }
    return out
  }, [originalRender, origIndex, distOrig, animating, spacingFt])
  const thinTrain = useMemo(() => {
    if (!animating || thinnedRender.length < 2 || thinIndex.total === 0) return []
    const n = Math.max(1, Math.floor(thinIndex.total / spacingFt))
    const out = []
    for (let i = 0; i < n; i++) {
      const d = (((distThin - i * spacingFt) % thinIndex.total) + thinIndex.total) % thinIndex.total
      out.push(positionOnPath(thinnedRender, thinIndex, d))
    }
    return out
  }, [thinnedRender, thinIndex, distThin, animating, spacingFt])

  return (
    <div className="h-full flex">
      <aside className="w-72 border-r border-white/10 p-3 overflow-y-auto space-y-4">
        <div>
          <div className="text-xs text-white/50 uppercase tracking-wide mb-1">Track</div>
          <select
            value={selectedSrc || ''}
            onChange={(e) => setSelectedSrc(e.target.value)}
            style={{ backgroundColor: '#1f2937', color: '#e5e7eb' }}
            className="w-full border border-white/15 text-xs rounded px-2 py-1"
          >
            {candidates.map((t) => (
              <option
                key={t.src}
                value={t.src}
                style={{ backgroundColor: '#1f2937', color: '#e5e7eb' }}
              >
                {t.call || '?'} · {t.type || '—'} · {t.points.length} pts · {t.src.replace('globe/', '')}
              </option>
            ))}
          </select>
        </div>

        <div>
          <div className="text-xs text-white/50 uppercase tracking-wide mb-1">Algorithm</div>
          <div className="space-y-1">
            {[
              { v: 'none',     label: 'None (baseline)' },
              { v: 'radial',   label: 'Radial distance (3D)' },
              { v: 'dp',       label: 'Douglas-Peucker (2D ε)' },
              { v: 'combined', label: 'Radial → DP' },
            ].map((o) => (
              <label key={o.v} className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input
                  type="radio"
                  checked={algo === o.v}
                  onChange={() => setAlgo(o.v)}
                />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <div className="text-xs text-white/50 uppercase tracking-wide mb-1">
            Tolerance: <span className="text-white font-mono">{tolerance} ft</span>
          </div>
          <input
            type="range"
            min="10"
            max="1000"
            step="10"
            value={tolerance}
            onChange={(e) => setTolerance(Number(e.target.value))}
            className="w-full"
          />
          <div className="flex justify-between text-[9px] text-white/40 mt-0.5">
            <span>10 ft</span>
            <span>1000 ft</span>
          </div>
          <div className="text-[10px] text-white/50 mt-1 italic">
            Radial: minimum 3D gap between kept points.
            DP: max perpendicular deviation from the original line.
          </div>
        </div>

        <div>
          <div className="text-xs text-white/50 uppercase tracking-wide mb-1">Curve type</div>
          <select
            value={curveType}
            onChange={(e) => setCurveType(e.target.value)}
            style={{ backgroundColor: '#1f2937', color: '#e5e7eb' }}
            className="w-full border border-white/15 text-xs rounded px-2 py-1"
          >
            <option value="straight">Straight lines</option>
            <option value="catmull">Catmull-Rom spline</option>
            <option value="chaikin">Chaikin corner-cut</option>
            <option value="bezierQ">Quadratic Bezier</option>
            <option value="bezierC">Cubic Bezier</option>
          </select>
          <div className="text-[10px] text-white/40 mt-1 italic">
            Catmull-Rom and Cubic Bezier both pass through every point.
            Chaikin and Quadratic Bezier are smoother but drift from the
            control points.
          </div>
          {(curveType === 'catmull' || curveType === 'bezierC') && (
            <div className="mt-2">
              <div className="flex justify-between text-[10px] text-white/60">
                <span>Tension</span>
                <span className="font-mono text-white/80">{tension.toFixed(2)}</span>
              </div>
              <input
                type="range" min="0" max="1" step="0.05"
                value={tension}
                onChange={(e) => setTension(Number(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between text-[9px] text-white/40 mt-0.5">
                <span>0 sharp</span>
                <span>0.5 smooth</span>
                <span>1 loose</span>
              </div>
            </div>
          )}
          {curveType === 'chaikin' && (
            <div className="mt-2">
              <div className="flex justify-between text-[10px] text-white/60">
                <span>Chaikin passes</span>
                <span className="font-mono text-white/80">{chaikinIters}</span>
              </div>
              <input
                type="range" min="1" max="6" step="1"
                value={chaikinIters}
                onChange={(e) => setChaikinIters(Number(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between text-[9px] text-white/40 mt-0.5">
                <span>1 (blocky)</span>
                <span>6 (very smooth)</span>
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="text-xs text-white/50 uppercase tracking-wide mb-1">
            Corner smoothing (pre-filter)
          </div>
          <select
            value={cornerSmoothType}
            onChange={(e) => setCornerSmoothType(e.target.value)}
            style={{ backgroundColor: '#1f2937', color: '#e5e7eb' }}
            className="w-full border border-white/15 text-xs rounded px-2 py-1"
          >
            <option value="none">None (preserve raw shape)</option>
            <option value="movavg">Moving average</option>
            <option value="chaikin">Chaikin pre-pass</option>
          </select>
          <div className="text-[10px] text-white/40 mt-1 italic">
            Applied to the control points BEFORE thinning and the curve
            renderer. Averages out ADS-B noise so sharp kinks become smooth
            turns — aircraft can't make instantaneous heading changes anyway.
          </div>
          {cornerSmoothType === 'movavg' && (
            <div className="mt-2">
              <div className="flex justify-between text-[10px] text-white/60">
                <span>Window size</span>
                <span className="font-mono text-white/80">{cornerSmoothAmount} pts</span>
              </div>
              <input
                type="range" min="3" max="15" step="2"
                value={cornerSmoothAmount}
                onChange={(e) => setCornerSmoothAmount(Number(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between text-[9px] text-white/40 mt-0.5">
                <span>3 (gentle)</span>
                <span>15 (aggressive)</span>
              </div>
            </div>
          )}
          {cornerSmoothType === 'chaikin' && (
            <div className="mt-2">
              <div className="flex justify-between text-[10px] text-white/60">
                <span>Iterations</span>
                <span className="font-mono text-white/80">{cornerSmoothAmount}</span>
              </div>
              <input
                type="range" min="1" max="4" step="1"
                value={cornerSmoothAmount}
                onChange={(e) => setCornerSmoothAmount(Number(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between text-[9px] text-white/40 mt-0.5">
                <span>1 (×2 pts)</span>
                <span>4 (×16 pts)</span>
              </div>
              <div className="text-[9px] text-amber-300/70 mt-0.5 italic">
                Each iteration doubles the point count. 4 iterations = 16×
                control points fed to the spline.
              </div>
            </div>
          )}
        </div>

        <div>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={showQuality}
              onChange={(e) => setShowQuality(e.target.checked)}
            />
            <span>Show data quality (dropouts)</span>
          </label>
          <div className="text-[10px] text-white/40 mt-0.5 italic">
            Segments colored green / yellow / red by length ratio to the
            track's median spacing. Red = suspected ADS-B dropout.
          </div>
          {showQuality && (
            <div className="text-[10px] text-white/60 mt-1 space-y-0.5">
              <div>median gap: <span className="font-mono">{qualitySegments.median.toFixed(0)} ft</span></div>
              <div>dropouts: <span className="font-mono text-red-400">{qualitySegments.drops}</span></div>
            </div>
          )}
        </div>

        <div>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={animating}
              onChange={(e) => setAnimating(e.target.checked)}
            />
            <span>Animate plane icons</span>
          </label>
          {animating && (
            <div className="mt-2 space-y-2">
              <div>
                <div className="flex justify-between text-[10px] text-white/60">
                  <span>Groundspeed</span>
                  <span className="font-mono text-white/80">{gsKt} kt</span>
                </div>
                <input
                  type="range" min="40" max="300" step="10"
                  value={gsKt}
                  onChange={(e) => setGsKt(Number(e.target.value))}
                  className="w-full"
                />
                <div className="flex justify-between text-[9px] text-white/40 mt-0.5">
                  <span>40 kt (R44)</span>
                  <span>300 kt (CJ1)</span>
                </div>
              </div>
              <div>
                <div className="flex justify-between text-[10px] text-white/60">
                  <span>Speed ×</span>
                  <span className="font-mono text-white/80">{speedMult}×</span>
                </div>
                <input
                  type="range" min="1" max="50" step="1"
                  value={speedMult}
                  onChange={(e) => setSpeedMult(Number(e.target.value))}
                  className="w-full"
                />
                <div className="flex justify-between text-[9px] text-white/40 mt-0.5">
                  <span>real time</span>
                  <span>50×</span>
                </div>
              </div>
              <div>
                <div className="flex justify-between text-[10px] text-white/60">
                  <span>Plane spacing</span>
                  <span className="font-mono text-white/80">{planeSpacingMi} mi</span>
                </div>
                <input
                  type="range" min="0.25" max="5" step="0.25"
                  value={planeSpacingMi}
                  onChange={(e) => setPlaneSpacingMi(Number(e.target.value))}
                  className="w-full"
                />
                <div className="flex justify-between text-[9px] text-white/40 mt-0.5">
                  <span>0.25 (dense)</span>
                  <span>5 (sparse)</span>
                </div>
              </div>
              <div className="text-[9px] text-white/40 italic">
                Planes in flight: {Math.max(1, Math.floor(origIndex.total / (planeSpacingMi * 5280)))} (orig) /
                {' '}{Math.max(1, Math.floor(thinIndex.total / (planeSpacingMi * 5280)))} (thin)
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-white/10 pt-3 space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-white/50">Original</span>
            <span className="font-mono">{original.length} → {originalRender.length}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/50">Thinned</span>
            <span className="font-mono text-cyan-300">
              {thinned.length} → {thinnedRender.length}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/50">Reduction</span>
            <span className="font-mono text-green-400">{reductionPct}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/50">Orig length</span>
            <span className="font-mono text-white/70">
              {(origIndex.total / 6076).toFixed(2)} nm
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/50">Thin length</span>
            <span className="font-mono text-cyan-300">
              {(thinIndex.total / 6076).toFixed(2)} nm
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/50">Distance loss</span>
            <span className="font-mono text-red-400">
              {origIndex.total
                ? ((1 - thinIndex.total / origIndex.total) * 100).toFixed(2)
                : '0.00'}%
            </span>
          </div>
        </div>

        {track && (
          <div className="border-t border-white/10 pt-3 text-[10px] text-white/40 space-y-0.5">
            <div>Tail: <span className="font-mono text-white/70">{track.call}</span></div>
            <div>Type: <span className="font-mono text-white/70">{track.type || '—'}</span></div>
            <div>Day: <span className="font-mono text-white/70">{track.src}</span></div>
          </div>
        )}

        <div className="border-t border-white/10 pt-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-white/50 uppercase tracking-wide">Settings</span>
            <button
              onClick={() => {
                const el = document.getElementById('thinning-settings-box')
                if (el) {
                  el.select()
                  try { document.execCommand('copy') } catch {}
                }
              }}
              className="text-[10px] text-cyan-300 hover:text-white"
            >
              copy
            </button>
          </div>
          <textarea
            id="thinning-settings-box"
            readOnly
            value={(() => {
              const lines = [
                `track:     ${track?.call || '?'} · ${track?.type || '—'} · ${track?.src || ''}`,
                `corner_smooth: ${cornerSmoothType}${cornerSmoothType !== 'none' ? ` (${cornerSmoothAmount})` : ''}`,
                `algo:      ${algo}`,
                `tolerance: ${tolerance} ft`,
                `curve:     ${curveType}`,
                `tension:   ${tension.toFixed(2)}`,
                `chaikin_iters: ${chaikinIters}`,
                `animate:   ${animating ? `on @ ${gsKt} kt × ${speedMult}` : 'off'}`,
                `spacing:   ${planeSpacingMi} mi between planes`,
                `quality:   ${showQuality ? 'on' : 'off'}`,
                `---`,
                `original:  ${original.length} pts → rendered ${originalRender.length}`,
                `thinned:   ${thinned.length} pts → rendered ${thinnedRender.length}`,
                `reduction: ${reductionPct}%`,
                `orig_len:  ${(origIndex.total / 6076).toFixed(2)} nm`,
                `thin_len:  ${(thinIndex.total / 6076).toFixed(2)} nm`,
                `len_loss:  ${
                  origIndex.total
                    ? ((1 - thinIndex.total / origIndex.total) * 100).toFixed(2)
                    : '0.00'
                }%`,
                `median_gap: ${qualitySegments.median.toFixed(0)} ft`,
                `dropouts:  ${qualitySegments.drops}`,
              ]
              return lines.join('\n')
            })()}
            style={{ backgroundColor: '#1f2937', color: '#e5e7eb' }}
            className="w-full h-48 border border-white/15 rounded px-2 py-1 text-[10px] font-mono resize-none"
            onFocus={(e) => e.target.select()}
          />
          <div className="text-[9px] text-white/30 mt-1 italic">
            Click inside or hit "copy" to select all. Paste back in chat
            to replicate this configuration.
          </div>
        </div>

        <div className="border-t border-white/10 pt-3 text-[10px] text-white/40">
          <div className="font-semibold text-white/60 mb-1">How to use</div>
          Pick a high-point-count track, toggle algorithms, drag tolerance.
          The gray polyline is the original; the cyan polyline is the thinned
          version with kept points marked. Look for cases where the cyan
          deviates from the gray around pattern turns or runway approaches —
          that's where classification accuracy would degrade.
        </div>
      </aside>

      <div className="flex-1 relative">
        <MapContainer center={KBDU} zoom={11} className="h-full w-full">
          {/* SVG renderer is required so SvgCurve can inject <path> elements
              into the overlay pane's <svg>. Canvas mode would drop them. */}
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

          {/* Original path — real SVG cubic-Bezier (not a polyline) */}
          {original.length > 1 && (
            <SvgCurve
              points={original.map((p) => [p[0], p[1]])}
              color="#9ca3af"
              weight={4}
              opacity={0.4}
              curveType={curveType}
              tension={tension}
              chaikinIterations={chaikinIters}
            />
          )}

          {/* Thinned path on top */}
          {thinned.length > 1 && (
            <SvgCurve
              points={thinned.map((p) => [p[0], p[1]])}
              color="#22d3ee"
              weight={2}
              opacity={1}
              curveType={curveType}
              tension={tension}
              chaikinIterations={chaikinIters}
            />
          )}

          {/* Dots on the kept points — shows where the thinning decided to stop */}
          {thinned.map((p, i) => (
            <CircleMarker
              key={i}
              center={[p[0], p[1]]}
              radius={2}
              pathOptions={{ color: '#22d3ee', weight: 0, fillColor: '#22d3ee', fillOpacity: 1 }}
            />
          ))}

          {/* Data-quality overlay: color each original segment by gap size */}
          {showQuality && qualitySegments.segments.map((s, i) => {
            const color =
              s.quality === 'poor' ? '#dc2626'
              : s.quality === 'good' ? '#f59e0b'
              : '#22c55e'
            return (
              <Polyline
                key={`q-${i}`}
                positions={[s.a, s.b]}
                pathOptions={{
                  color,
                  weight: s.quality === 'poor' ? 5 : 3,
                  opacity: 0.85,
                }}
              >
                <Tooltip sticky>
                  {s.quality} · {s.len.toFixed(0)} ft ({s.ratio.toFixed(1)}× median)
                </Tooltip>
              </Polyline>
            )
          })}

          {/* Train of plane icons — one per mile of path, marching at 10× speed */}
          {origTrain.map((p, i) => (
            <Marker
              key={`o-${i}`}
              position={[p.lat, p.lon]}
              icon={makePlaneIcon(p.heading, '#9ca3af')}
              interactive={false}
            />
          ))}
          {thinTrain.map((p, i) => (
            <Marker
              key={`t-${i}`}
              position={[p.lat, p.lon]}
              icon={makePlaneIcon(p.heading, '#22d3ee')}
              interactive={false}
            />
          ))}
        </MapContainer>
      </div>
    </div>
  )
}
