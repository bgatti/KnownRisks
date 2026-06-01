-- 2026-05-31_tracks_boot_index.sql
--
-- Speeds up the /api/excursions/boot region-wide path (no `airport=`
-- filter), which scanned the entire 24 h window and sorted by a CASE
-- expression over the worst_class column. Production observed 59 s avg /
-- 98 s max / 3-of-3 500s on hours=24&limit=150.
--
-- A JS-level mitigation (response cache + request coalescing + lower
-- unfiltered limit) shipped in the same commit; this index is the
-- belt-and-suspenders fix on the DB side. It is safe to apply
-- independently — no schema changes, only an additive index.
--
-- Apply against Railway when convenient:
--   psql "$DATABASE_URL" -f migrations/2026-05-31_tracks_boot_index.sql
--
-- CONCURRENTLY avoids locking writes during the index build.

-- Primary boot path: WHERE date BETWEEN $1 AND $2
--                      AND worst_class IS NOT NULL
--                      AND bands IS NOT NULL
--                    ORDER BY <severity case>
-- Partial index on (date, worst_class) skips clean rows entirely
-- (they're never returned by /boot) and keeps the index small.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tracks_boot_window_idx
  ON tracks (date, worst_class)
  WHERE worst_class IS NOT NULL AND bands IS NOT NULL;

-- Airport-filtered fast path (already fast in prod but documents intent
-- and helps the planner when the airport filter is selective).
CREATE INDEX CONCURRENTLY IF NOT EXISTS tracks_boot_airport_idx
  ON tracks (base_airport, date)
  WHERE worst_class IS NOT NULL;

-- Per-tail enrichment join (latest non-null base/purpose/school/desc per
-- call). The handler does `WHERE call = ANY($1) GROUP BY call`.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tracks_call_date_idx
  ON tracks (call, date DESC);
