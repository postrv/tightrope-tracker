-- Partial UNIQUE index on curator_captures(source_id, content_sha256) for the
-- INGEST-STAGED capture paths only (AUTOMATION_PLAN cleanup C7).
--
-- Two ingest paths write deterministic rows here that must never duplicate on a
-- re-poll:
--   * plausibility quarantines from writeObservations (§2.2), and
--   * gov.uk timeline candidates staged for review (§1.4).
-- Both leave `model_id` NULL (they are not AI captures). The UNIQUE index lets
-- those two INSERTs use `ON CONFLICT (source_id, content_sha256) DO NOTHING`,
-- closing the check-then-act race the old SELECT-then-INSERT dedupe left open.
--
-- SCOPED `WHERE model_id IS NULL` on purpose: AI-captured rows (the curator
-- sweep) always carry a model_id and legitimately re-capture the SAME artefact
-- hash on every FORCE sweep (the pre-deadline sweep deliberately ignores the
-- content-hash short-circuit). Uniquing those would make the second weekly
-- force sweep fail its INSERT, so they are excluded here and keep relying on the
-- non-unique idx_curator_captures_dedupe from migration 0011. curator
-- insertCapture is therefore intentionally NOT switched to ON CONFLICT.
CREATE UNIQUE INDEX idx_curator_captures_staged_dedupe
  ON curator_captures (source_id, content_sha256)
  WHERE model_id IS NULL;
