-- 0005_add_released_at.sql
-- Add a publication-date column to indicator_observations so monthly and
-- fiscal adapters can distinguish reference period from release date.
--
-- Context: ONS Public Sector Finances (PSF), Labour Market Stats (LMS) and
-- Real-Time Indicators (RTI) publish with a ~3-6 week lag. The indicator
-- observation's `observed_at` encodes the reference period (e.g. 2025-03-31
-- for March 2025) but the actual release date can be 22 April 2025.
-- Backfill must clip on the release date, otherwise the March figure will
-- appear in any backfilled score for April 1-21 despite not being public
-- on those days. That is lookahead bias, and for a publicly-displayed
-- historical chart it's the kind of thing a BBC data journalist spots.
--
-- Schema change:
--   `released_at TEXT NULL` — ISO-8601 UTC. NULL for rows written before
--   this feature (which fall back to `observed_at` in the backfill cutoff
--   check) and for adapters where published ≈ observed anyway (daily gilt
--   yields, daily FX).
--
-- Writers (live + historical) set `released_at` when the adapter knows it.
-- `packages/data-sources` exposes `RawObservation.releasedAt` as optional;
-- the ONS-family adapters populate it from the API's `updateDate` field.
ALTER TABLE indicator_observations ADD COLUMN released_at TEXT;

-- Index the composite COALESCE(released_at, observed_at) is cumbersome in
-- SQLite, so we add a simple (released_at) index and let the query planner
-- use the existing observed_at indexes for the NULL fallback path.
CREATE INDEX IF NOT EXISTS idx_indicator_observations_by_released
  ON indicator_observations (released_at)
  WHERE released_at IS NOT NULL;
