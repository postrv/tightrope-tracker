-- 0003_seed_inaugural_correction.sql
-- Publishes the Q4 2025 planning_consents correction (7,300 -> 7,200)
-- retroactively so the /corrections page is non-empty from day one.
--
-- Context: commit 042b64b ("Correct Q4 2025 planning_consents (7,300 -> 7,200)")
-- was made as a code change to the housing fixture. The corrections log
-- existed as a table but had no write path, so the correction was never
-- published. With the admin POST /admin/correction handler now live, the
-- same event is materialised here so the public accountability surface
-- reflects the real editing history of the figure.
--
-- `INSERT OR IGNORE` makes this migration idempotent: re-running it is a
-- no-op, and a subsequent POST /admin/correction with the same explicit id
-- would return 409 rather than duplicate.
INSERT OR IGNORE INTO corrections (
  id,
  published_at,
  affected_indicator,
  original_value,
  corrected_value,
  reason
) VALUES (
  '2026-04-17-planning-consents-q4-2025',
  '2026-04-17T00:00:00.000Z',
  'planning_consents',
  '7,300',
  '7,200',
  'Q4 2025 large-site consents re-derived from the MHCLG release (major dwellings 900 + minor dwellings 6,300 = 7,200). The earlier 7,300 figure was a provisional rounding superseded by the published breakdown.'
);
