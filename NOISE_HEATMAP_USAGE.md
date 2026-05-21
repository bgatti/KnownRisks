# Noise Heatmap — Embedding Guide

A self-contained renderer that converts an array of aircraft tracks into
a colorized PNG heatmap suitable for overlaying on Leaflet, MapLibre,
Google Maps, or any image-overlay-capable map.

## Files (already deployed, fetch directly)

| URL | Purpose |
|-----|---------|
| `https://web-app-production-fedf.up.railway.app/src/noiseRaster.js` | Main module — exports `computeNoiseRaster()` and `computeImpactRaster()` |
| `https://web-app-production-fedf.up.railway.app/src/terrain.js` | Terrain elevation lookup (SRTM-derived). Imported by noiseRaster |
| `https://web-app-production-fedf.up.railway.app/terrain.json` | ~5 MB terrain grid (Front Range region only). Loaded on demand by terrain.js |

These are vite-served ES modules. Import with:

```js
import { computeNoiseRaster } from 'https://web-app-production-fedf.up.railway.app/src/noiseRaster.js'
import { loadTerrain } from 'https://web-app-production-fedf.up.railway.app/src/terrain.js'
```

For production sites, prefer copying the files into your bundle (the
deployed copy may change without notice and CORS may not allow direct
import everywhere).

## Input shape

```js
const tracks = [
  {
    type: 'C172',           // ICAO type code — drives engine HP and cruise speed
    t0: 1700000000000,      // optional — epoch ms of first point (for time-of-day filter)
    points: [
      [40.0394, -105.2258, 5400],         // [lat, lon, alt_ft]
      [40.0420, -105.2200, 5800],         // 3-tuple (no time)
      [40.0500, -105.2100, 6500, 1024],   // 4-tuple [lat, lon, alt_ft, ts_seconds_offset]
    ],
  },
  // ... more tracks
]
```

## Basic usage

```js
import { computeNoiseRaster } from './noiseRaster.js'
import { loadTerrain } from './terrain.js'

await loadTerrain()  // loads terrain.json (skip for non-Front-Range areas, fallback elevation will be used)

const result = computeNoiseRaster(tracks, {
  blobsPerNm: 1,           // density along path (1 blob/nm = ~1 dot per minute of cruise)
  accumAutoRange: false,   // false = absolute scale (compare across maps), true = per-map auto-fit
  accumLogLo: -7.50,       // dim-end energy threshold (log10) — lower = more sensitive
  accumLogHi: -1.20,       // bright-end (log10) — higher = harder to saturate red
})

if (!result) return  // null when no usable input

// result = {
//   dataUrl: 'data:image/png;base64,...',  // ready to overlay
//   latLngBounds: [[latMin, lonMin], [latMax, lonMax]],
//   stats: { rawBlobs, decimation, tracks, loLog10, hiLog10, cells, blobs },
// }
```

### Render on Leaflet

```js
import L from 'leaflet'
const overlay = L.imageOverlay(result.dataUrl, result.latLngBounds, {
  opacity: 0.75,
  interactive: false,
})
overlay.addTo(map)
```

### Render on MapLibre

```js
map.addSource('noise', {
  type: 'image',
  url: result.dataUrl,
  coordinates: [
    [result.latLngBounds[0][1], result.latLngBounds[1][0]], // top-left  [lon, lat]
    [result.latLngBounds[1][1], result.latLngBounds[1][0]], // top-right
    [result.latLngBounds[1][1], result.latLngBounds[0][0]], // bottom-right
    [result.latLngBounds[0][1], result.latLngBounds[0][0]], // bottom-left
  ],
})
map.addLayer({
  id: 'noise',
  type: 'raster',
  source: 'noise',
  paint: { 'raster-opacity': 0.75 },
})
```

## Recommended visual polish

A small CSS blur on the rendered overlay smooths blocky pixel edges
without any CPU cost (GPU-accelerated):

```css
.leaflet-image-layer { filter: blur(8px); }
```

## Options reference

| Option | Default | What it does |
|--------|---------|--------------|
| `blobsPerNm` | 1 | Spatial density — how many noise blobs per nautical mile of track. Single-aircraft views typically use 2; aggregate views use 1. |
| `radiusScale` | 3.0 | Blob radius multiplier. Larger = smoother/wider footprint. |
| `directionalGain` | 0.6 | Ellipse stretch along heading (0 = circles, 0.95 = strong fore-aft narrowing). |
| `accumAutoRange` | false | When true, auto-fits the colorize range to this map's energy distribution (good for single tracks). |
| `accumLogLo` | -6.90 | Lower energy bound (log10). Below = transparent. |
| `accumLogHi` | -0.60 | Upper energy bound (log10). Above = saturated red. |
| `samplePeriodS` | 1 | Assumed seconds between consecutive points (for energy profile). |
| `maxBlobs` | 50000 | Hard cap on blob count. Above this, decimates uniformly. |
| `rasterPx` | 1200 | Pixels on the longer grid axis (output PNG resolution). |
| `todStart` / `todEnd` | null | Local-hour-of-day filter (e.g., 22 / 5 = nighttime in MST). Requires `t0` on tracks and `[lat, lon, alt, sec]` 4-tuples. |
| `tzOffsetS` | -25200 (MST) | Timezone offset in seconds for the TOD filter. |

## Source data — fetch from the live API

If you don't have your own track data, use the existing API:

```js
// All recent tracks (last 0.5 hours)
const r = await fetch('https://web-app-production-fedf.up.railway.app/api/excursions/boot?hours=0.5&limit=500')
const data = await r.json()
// data.tracks[*].bands[*].points = [[lat, lon, alt, ts_ms], ...]
// Flatten to the input shape:
const tracks = data.tracks.map(t => ({
  type: t.type,
  points: t.bands.flatMap(b => b.points.map(p => [p[0], p[1], p[2]])),
}))
```

Other useful endpoints:
- `/api/excursions/segments?tail=N52993&hours=720` — historical for one tail
- `/api/excursions/segments?hours=24&lat=40.04&lon=-105.22` — recent within a 4-mi radius
- `/api/aircraft-ops?base=KBDU&radius=10` — current intent classification

## How the heatmap works

1. **Resample** each track to uniform `1/blobsPerNm` nm spacing (haversine arc-length walk)
2. **Energy profile** per point: estimated engine HP = f(climb rate, airspeed, aircraft type)
3. **Blob radius** = max(50, AGL) × 0.3048 × radiusScale meters — sound spreads farther at altitude but is fainter (dispersed energy)
4. **Accumulate**: each blob deposits Gaussian energy into a fine grid; ellipses stretched along heading
5. **Colorize**: log-scale lookup table maps energy → color (10-stop palette from deep blue → red)
6. **Output**: data-URL PNG with bounds, ready for any image-overlay map layer

The model is HP-based (not dB-based) — it estimates aggregate "engine
energy deposited per square meter of ground" rather than measured sound
pressure level. Useful for relative noise impact comparisons across
flights, schools, time periods, etc., not for noise-ordinance enforcement.

## License / attribution

The terrain data is derived from public-domain SRTM. The aircraft HP
table is from manufacturer specs. The noise model is original — please
credit "FlightSafe / KBDU Noise Monitor" if used in publications.
