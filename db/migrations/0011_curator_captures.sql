-- Staging + review queue for the AI curation pipeline (apps/curator).
-- Every AI-captured candidate lands here first; nothing reaches
-- indicator_observations / delivery_commitments / timeline_events without
-- either passing the deterministic verification gates (auto-publish,
-- numeric observations only) or explicit human approval.
--
-- Also the quarantine destination for plausibility-gate violations raised
-- by the ingest worker's writeObservations (AUTOMATION_PLAN.md §2.2), and
-- the staging table for gov.uk timeline candidates (§1.4) — one review
-- surface for everything that needs a human decision.

CREATE TABLE curator_captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- matches SOURCES / ingestion_audit source ids (e.g. 'sp_global_pmi')
  source_id TEXT NOT NULL,
  -- NULL for delivery_commitment / timeline_event drafts
  indicator_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN (
    'observation', 'delivery_milestone', 'delivery_commitment', 'timeline_event'
  )),
  -- ISO instant the capture run fetched the artefact
  captured_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  -- sha256 of the raw artefact bytes; dedupe key against the previous
  -- capture of the same source, and suffix of the R2 archive object
  content_sha256 TEXT NOT NULL,
  -- R2 object key in ARCHIVE holding the raw HTML/PDF/markdown artefact
  raw_r2_key TEXT,
  -- period the value refers to (observations only)
  observed_at TEXT,
  -- upstream publication instant, when the artefact states one
  released_at TEXT,
  -- numeric captures; NULL for editorial drafts
  value REAL,
  -- JSON: full extraction payload (units, secondary values, draft copy
  -- for editorial kinds, field patches for delivery_commitment drafts)
  payload TEXT,
  -- verbatim source sentence anchoring the value (gate G1); required for
  -- any capture that can publish an observation
  quote TEXT,
  -- verifier-agreed confidence in [0,1]
  confidence REAL,
  -- JSON: gate-by-gate verification results (G1..G6)
  verification TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'shadow',          -- rollout shadow mode: verified but never publishable
    'pending',         -- awaiting human review
    'auto_published',  -- passed all gates, published without review
    'approved',        -- human-approved and published
    'rejected',        -- human-rejected
    'superseded',      -- a newer capture of the same source replaced it
    'quarantined',     -- plausibility-gate violation (from ingest or curator)
    'unchanged'        -- artefact hash matched previous capture; no extraction ran
  )),
  -- 'auto' or a short reviewer note
  decided_by TEXT,
  decided_at TEXT,
  -- 'indicator_id|observed_at' once written to indicator_observations
  published_observation_key TEXT,
  model_id TEXT,
  prompt_version TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_curator_captures_status
  ON curator_captures (status, kind, created_at DESC);
CREATE INDEX idx_curator_captures_dedupe
  ON curator_captures (source_id, content_sha256);
CREATE INDEX idx_curator_captures_indicator
  ON curator_captures (indicator_id, observed_at);
