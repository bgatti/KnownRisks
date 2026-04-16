import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'

// Renders an SVG <path> with real cubic-Bezier commands instead of straight
// L segments. Follows the map's pan/zoom by recomputing the pixel-space path
// on Leaflet's `zoomend` and `moveend` events. Control points are lat/lon;
// curves are computed from them per the chosen curveType.
//
// curveType:
//   'straight' — plain M / L commands (SVG will antialias, but no curvature)
//   'catmull'  — Catmull-Rom → cubic Bezier (tension 0.5, C1 continuous)
//   'bezierC'  — same as catmull (cardinal spline variant)
//   'chaikin'  — smoothed control points (3 iterations) then M/L path
//   'bezierQ'  — quadratic bezier via midpoint control points

export default function SvgCurve({
  points,          // [[lat, lon], ...]
  color = '#22d3ee',
  weight = 2,
  opacity = 1,
  curveType = 'catmull',
  tension = 0.5,          // 0..1 — cardinal-spline tightness for cubic bezier
  chaikinIterations = 3,  // 1..5 — corner-cut passes for chaikin mode
  dashArray = null,
}) {
  const map = useMap()
  const pathRef = useRef(null)

  useEffect(() => {
    if (!map || !points || points.length < 2) return
    const svgRoot = map.getPanes().overlayPane.querySelector('svg')
    if (!svgRoot) return
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', color)
    path.setAttribute('stroke-width', weight)
    path.setAttribute('stroke-opacity', opacity)
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    if (dashArray) path.setAttribute('stroke-dasharray', dashArray)
    svgRoot.appendChild(path)
    pathRef.current = path

    const project = (ll) => map.latLngToLayerPoint(ll)

    const buildD = () => {
      const pts = points.map(project)
      if (pts.length < 2) return ''
      if (curveType === 'straight') {
        return pts.reduce(
          (acc, p, i) => acc + (i === 0 ? `M${p.x} ${p.y}` : ` L${p.x} ${p.y}`),
          '',
        )
      }
      if (curveType === 'chaikin') {
        // Apply Chaikin in pixel space for visually smoother results
        let arr = pts.slice()
        for (let it = 0; it < chaikinIterations; it++) {
          const next = [arr[0]]
          for (let i = 0; i < arr.length - 1; i++) {
            const a = arr[i]
            const b = arr[i + 1]
            next.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y })
            next.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y })
          }
          next.push(arr[arr.length - 1])
          arr = next
        }
        return arr.reduce(
          (acc, p, i) => acc + (i === 0 ? `M${p.x} ${p.y}` : ` L${p.x} ${p.y}`),
          '',
        )
      }
      if (curveType === 'bezierQ') {
        // Quadratic Bezier through midpoints — each input point is a control
        let d = `M${pts[0].x} ${pts[0].y}`
        for (let i = 1; i < pts.length - 1; i++) {
          const p1 = pts[i]
          const p2 = pts[i + 1]
          const mx = (p1.x + p2.x) / 2
          const my = (p1.y + p2.y) / 2
          d += ` Q${p1.x} ${p1.y} ${mx} ${my}`
        }
        d += ` L${pts[pts.length - 1].x} ${pts[pts.length - 1].y}`
        return d
      }
      // 'catmull' and 'bezierC' both use cardinal-to-cubic conversion
      let d = `M${pts[0].x} ${pts[0].y}`
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)]
        const p1 = pts[i]
        const p2 = pts[i + 1]
        const p3 = pts[Math.min(pts.length - 1, i + 2)]
        const c1x = p1.x + ((p2.x - p0.x) * tension) / 3
        const c1y = p1.y + ((p2.y - p0.y) * tension) / 3
        const c2x = p2.x - ((p3.x - p1.x) * tension) / 3
        const c2y = p2.y - ((p3.y - p1.y) * tension) / 3
        d += ` C${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`
      }
      return d
    }

    const update = () => {
      if (!pathRef.current) return
      pathRef.current.setAttribute('d', buildD())
    }

    update()
    map.on('zoomend moveend viewreset', update)
    return () => {
      map.off('zoomend moveend viewreset', update)
      if (pathRef.current && pathRef.current.parentNode) {
        pathRef.current.parentNode.removeChild(pathRef.current)
      }
      pathRef.current = null
    }
  }, [map, points, color, weight, opacity, curveType, tension, chaikinIterations, dashArray])

  return null
}
