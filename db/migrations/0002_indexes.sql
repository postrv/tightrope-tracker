-- 0002_indexes.sql
-- Adds a source_id + observed_at descending index to indicator_observations.
-- Used by the ingest audit and by per-source backfill queries to avoid a full
-- table scan on what is the largest table in the database.
CREATE INDEX IF NOT EXISTS idx_indicator_observations_by_source
  ON indicator_observations (source_id, observed_at DESC);
