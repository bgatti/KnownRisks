# Technical Debt — proposed cleanups

Running list of cleanups identified while building the population-impact
leaderboard / scoring / explainer / recent-landings work. Nothing here is
broken-in-production; these are consolidation, correctness-edge, and
data-currency items. File/line refs are approximate (they drift with edits).

---

## High priority (correctness / divergence)

### 1. Leaderboard scoring diverges between live and historical paths
`vite.config.js` has two scoring implementations:
- **live path** (`buildLiveLeaderboard`): `score = flights^1.5 × cleanliness × 1/(1+impact_index)`
- **historical fallback** (`/leaderboard` SQL path): still `score = flights × cleanliness × impactFactor` (linear flights)

They can rank differently for the same query depending on which source serves
it (`?source=tracks` or live-empty fallback). **Fix:** extract one `scoreEntry({flights, excursion_rate, impact_index})` helper and call it from both; share `LEADERBOARD_FLIGHT_EXP`, `ZONE_K`, `POP_SCALE`.

### 2. `tracks` table is stale; no live→historical promotion
The historical `tracks` table ends ~2026-04-10. The leaderboard now reads
`live_tracks` for recent windows, but:
- `/api/noise/stats`, `/api/noise/tracks`, and the `?source=tracks` fallback still serve stale data.
- A `days=30` *calendar* query against `tracks` returns nothing.

**Fix:** either a daily job that promotes each rolled-over `live_tracks` day into
`tracks` (with the full classify + `pop_impact`), or formally document `tracks`
as "historical/globe archive only" and route all recent reads to `live_tracks`.

### 3. `pop_impact` column is largely redundant
The live leaderboard computes `impact_index` from geometry at query time and
**ignores** the backfilled `tracks.pop_impact` column. That column is only used
by the rarely-hit `?source=tracks` fallback. The 30-day backfill job exists
mainly to feed that fallback. **Decide:** keep the column for historical scoring,
or drop the column + backfill pass and have the fallback compute live too (one
code path for impact everywhere).

---

## Medium priority (duplication)

### 4. Per-tail `call → base/purpose/school/desc` lookup duplicated 3×
The `array_agg(... ORDER BY date DESC) FILTER (WHERE ... IS NOT NULL)` query
appears in boot enrichment, `buildLiveLeaderboard`, and `recent-landings`
(plus a `DISTINCT ON` variant in `/missions`). **Fix:** one
`db.lookupTailInfo(tails)` returning `Map<call,{base,purpose,school,descr}>`.

### 5. Three airport reference lists
- `ENRICH_AP` (module scope: code/lat/lon/elev) — used by boot/recent-landings.
- `AP` (inside flight-ops endpoint: code/lat/lon/elev/tpa + `RUNWAYS`).
- `src/airports.js` (client: code/lat/lon + `nearestAirport`/`nmFrom`).

**Fix:** one server-side airports module (superset of fields) imported wherever
needed; keep the client list in sync from it or generate it.

### 6. `POP_SCALE` / kernel constants duplicated
`const POP_SCALE = 1000` is declared at module scope **and** again inside the
historical leaderboard handler. The kernel constants live in `src/popGrid.js`
(`POP_KERNEL`), but `POP_SCALE`, `LEADERBOARD_FLIGHT_EXP`, `LEADERBOARD_ZONE_K`,
and `impactGrade` thresholds are scattered in `vite.config.js`. **Fix:** one
exported `SCORING` config object.

### 7. Landing/geometry enrichment duplicated
The origin/dest/landed/on_ground_min trailing-ground-dwell logic is implemented
in both the boot enrichment block and `recent-landings`. **Fix:** shared
`classifyLanding(points, airport)` → `{origin, dest, landed, landed_at, on_ground_min, airborne_min, origin_dist_nm}`.

### 8. `ContourLayer` coupling
`ImpactExplain.jsx` imports `ContourLayer` from `KioskMap.jsx`, pulling the
whole kiosk module as a dependency. **Fix:** move `ContourLayer` to its own
`src/ContourLayer.jsx` and import it in both.

---

## Low priority (calibration / data limits / cleanup)

### 9. Uncalibrated scoring constants
`POP_SCALE=1000`, `LEADERBOARD_FLIGHT_EXP=1.5`, and the `impactGrade` letter
thresholds (A<0.3 … F) are reasonable first guesses, not calibrated against the
real distribution. **Action:** once enough live data exists, fit thresholds so
grades/score_pct spread sensibly per airport.

### 10. `origin_dist_nm` capped by capture radius
The ADS-B capture is a ~36 nm corridor, so `origin_dist_nm` (first observed fix →
field) maxes ~36 nm. The visitor `>100 nm` gate can't trip from this alone.
**Action:** if true origin distance is required, add a flight-plan/origin data
source; otherwise document the gate as "observed inbound leg."

### 11. Aircraft icons depend on a live Wikipedia lookup
`GET /aircraft-icons/<TYPE>` 302-redirects to a Wikipedia page-image for the
type (cached). Works, but it's an external runtime dependency: Wikipedia can
rate-limit/change, the chosen photo isn't curated (whatever the top search hit
is), and a miss falls back to the SVG placeholder. **Action (optional):** curate
a local set under `public/aircraft-icons/<TYPE>.png` (or `aircraft_icons.json`
overrides) for the common types so the kiosk doesn't depend on Wikipedia; the
endpoint already prefers a local file when present.

### 12. Leaderboard live aggregation cost
`buildLiveLeaderboard` runs `adsb.extractTowCycles` over **all** corridor
aircraft for the window on every cache-miss (5-min TTL). Fine now; for long
windows / more traffic, precompute per-tail daily rollups.

### 13. `getLiveDataHorizon` not used to bound queries
Leaderboard `days` can exceed the live store's horizon silently. **Action:**
echo `data_horizon` and clamp/annotate when the requested window pre-dates data.

### 14. Kiosk-side: drop bundled noise model after the swap
Once `impact-map.js` switches to `recent-landings` (`impact_grade`/`impact_score`
+ `bands[]`), remove the bundled `NoiseHealthModel`/`scoreTrack` so there's one
impact calculation (server-side population kernel) instead of two.

### 15. Deploy hygiene
- Always re-stage fresh from `web/` before `railway up` (the file-by-file sync to
  a long-lived staging dir caused a stale-deploy incident — see `.claude/deploy.md`).
- `backfill-job` requires `package.json` `start` rewritten to `node backfill.js`
  in a clean scratch dir (a busy dir silently kept `start=vite` once).
