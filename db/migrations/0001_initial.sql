-- Tightrope Tracker -- initial schema
-- Applied to the `tightrope_db` D1 database. Migrations are numbered strictly
-- ascending; never edit an applied migration -- add a new one.

-- Time-series of raw indicator observations.
CREATE TABLE IF NOT EXISTS indicator_observations (
  indicator_id   TEXT    NOT NULL,
  observed_at    TEXT    NOT NULL,            -- ISO 8601 UTC
  value          REAL    NOT NULL,
  source_id      TEXT    NOT NULL,
  ingested_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  payload_hash   TEXT,
  PRIMARY KEY (indicator_id, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_indicator_observations_by_observed
  ON indicator_observations (indicator_id, observed_at DESC);

-- Time-series of computed pillar scores.
CREATE TABLE IF NOT EXISTS pillar_scores (
  pillar_id   TEXT    NOT NULL,               -- 'market' | 'fiscal' | 'labour' | 'delivery'
  observed_at TEXT    NOT NULL,
  value       REAL    NOT NULL,
  band        TEXT    NOT NULL,
  PRIMARY KEY (pillar_id, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_pillar_scores_by_observed
  ON pillar_scores (pillar_id, observed_at DESC);

-- Time-series of computed headline scores.
CREATE TABLE IF NOT EXISTS headline_scores (
  observed_at TEXT    PRIMARY KEY,
  value       REAL    NOT NULL,
  band        TEXT    NOT NULL,
  dominant    TEXT    NOT NULL,
  editorial   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_headline_scores_by_observed
  ON headline_scores (observed_at DESC);

-- Editorially curated delivery scorecard.
CREATE TABLE IF NOT EXISTS delivery_commitments (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  department   TEXT NOT NULL,
  latest       TEXT NOT NULL,
  target       TEXT NOT NULL,
  status       TEXT NOT NULL,                 -- on_track | slipping | missed | shipped
  source_url   TEXT NOT NULL,
  source_label TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  notes        TEXT
);

-- Editorially curated timeline events.
CREATE TABLE IF NOT EXISTS timeline_events (
  id          TEXT PRIMARY KEY,
  event_date  TEXT NOT NULL,                  -- ISO 8601 date
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  category    TEXT NOT NULL,
  source_label TEXT NOT NULL,
  source_url  TEXT,
  score_delta REAL
);
CREATE INDEX IF NOT EXISTS idx_timeline_events_by_date
  ON timeline_events (event_date DESC);

-- Public corrections log.
CREATE TABLE IF NOT EXISTS corrections (
  id                  TEXT PRIMARY KEY,
  published_at        TEXT NOT NULL,
  affected_indicator  TEXT NOT NULL,
  original_value      TEXT NOT NULL,
  corrected_value     TEXT NOT NULL,
  reason              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corrections_by_published
  ON corrections (published_at DESC);

-- Audit log: one row per ingestion attempt.
CREATE TABLE IF NOT EXISTS ingestion_audit (
  id             TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  completed_at   TEXT,
  status         TEXT NOT NULL,               -- success | failure | partial
  rows_written   INTEGER NOT NULL DEFAULT 0,
  payload_hash   TEXT,
  error          TEXT,
  source_url     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingestion_audit_by_started
  ON ingestion_audit (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingestion_audit_by_source
  ON ingestion_audit (source_id, started_at DESC);

-- "What moved today" cached card snapshots (refreshed by recompute worker).
CREATE TABLE IF NOT EXISTS today_movements (
  indicator_id    TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  latest_value    REAL NOT NULL,
  display_value   TEXT NOT NULL,
  change          REAL NOT NULL,
  change_pct      REAL NOT NULL,
  change_display  TEXT NOT NULL,
  direction       TEXT NOT NULL,              -- up | down | flat
  worsening       INTEGER NOT NULL,           -- 0/1
  sparkline       TEXT NOT NULL,              -- JSON array
  gloss           TEXT NOT NULL,
  observed_at     TEXT NOT NULL
);

-- MP constituency cache (populated from parliament.uk members API on first lookup).
CREATE TABLE IF NOT EXISTS mp_lookup_cache (
  postcode_prefix TEXT PRIMARY KEY,
  constituency    TEXT NOT NULL,
  member_id       INTEGER NOT NULL,
  member_name     TEXT NOT NULL,
  party           TEXT NOT NULL,
  email           TEXT,
  fetched_at      TEXT NOT NULL
);
