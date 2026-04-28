-- fix-planning-bill-royal-assent-date.sql
--
-- Correct the live `timeline_events` row for the Planning and Infrastructure
-- Bill Royal Assent. Production currently carries:
--
--   id          = 't_2026_02_14'
--   event_date  = '2026-02-14'
--   source_label= 'Parliament'
--   source_url  = 'https://bills.parliament.uk/'
--
-- which contradicts (a) the local seed (db/seed/seed.sql line 1411 +
-- db/seed/generate.ts ~line 246), (b) the delivery_commitments row for
-- `planning_bill` ("Received Royal Assent 18 Dec 2025"), and (c) the verified
-- ground truth: the Planning and Infrastructure Act 2025 received Royal
-- Assent on Thursday 18 December 2025 (legislation.gov.uk/ukpga/2025/34,
-- bills.parliament.uk/bills/3946, gov.uk press release "Landmark Planning
-- and Infrastructure Bill becomes law"). 14 February 2026 was never a
-- parliamentary milestone for this Bill -- it appears to be a fixture
-- artefact that was never corrected against the live D1.
--
-- This patch realigns the live row to the seed/correct values:
--   - id          't_2026_02_14'  -> 't_2025_12_18'
--   - event_date  '2026-02-14'    -> '2025-12-18'
--   - source_label'Parliament'    -> 'Planning & Infrastructure Act 2025'
--   - source_url  bills root      -> legislation.gov.uk/ukpga/2025/34/enacted
-- title and summary are already correct on the live row, so they're left
-- alone (set explicitly here only for the INSERT-fallback branch).
--
-- Idempotency: this patch is a no-op once it has been applied. Re-running it
-- against an already-corrected DB will (a) skip the UPDATE because no row
-- with id='t_2026_02_14' remains, and (b) skip the INSERT because the
-- t_2025_12_18 row already exists. The DELETE is wrapped in the same guard.
--
-- Cache invalidation: the API caches `timeline:latest` in KV with a 30-minute
-- editorial freshness window (apps/api/src/lib/cache.ts EDITORIAL_FRESHNESS_MS).
-- After this patch lands, prod will self-heal within ~30 minutes. To force
-- immediate refresh, hit POST /admin/run?source=recompute on the ingest
-- worker or delete the `timeline:latest` KV key directly.
--
-- Run as:
--   wrangler d1 execute tightrope_db --remote --file=db/patches/fix-planning-bill-royal-assent-date.sql
-- Always run with --local first against a fresh seed and inspect the row
-- before --remote.
--
-- Authored: 2026-04-28 (Tightrope production audit, follow-up to
-- fix-delivery-urls.sql which corrected the delivery_commitments row but
-- not the timeline_events row.)

-- Sanity check before mutation: show what (if anything) is about to change.
SELECT id, event_date, title, source_label, source_url
FROM timeline_events
WHERE id IN ('t_2026_02_14', 't_2025_12_18');

-- Idempotent fix:
--   1. If the correct row (t_2025_12_18) is missing AND the wrong row
--      (t_2026_02_14) exists, rewrite the wrong row in place. PRIMARY KEY
--      can be UPDATEd in SQLite and avoids the need for an INSERT/DELETE
--      pair (which would briefly leave the table without a Royal Assent
--      event in any open transaction).
UPDATE timeline_events
SET id           = 't_2025_12_18',
    event_date   = '2025-12-18',
    title        = 'Planning & Infrastructure Bill receives Royal Assent',
    summary      = 'Landmark reform of the planning system passes both houses with cross-bench support; commencement orders expected by late spring.',
    category     = 'delivery',
    source_label = 'Planning & Infrastructure Act 2025',
    source_url   = 'https://www.legislation.gov.uk/ukpga/2025/34/enacted'
WHERE id = 't_2026_02_14'
  AND NOT EXISTS (SELECT 1 FROM timeline_events WHERE id = 't_2025_12_18');

--   2. Belt-and-braces: if both rows somehow co-exist (e.g. a previous
--      partial run inserted t_2025_12_18 but did not delete t_2026_02_14),
--      remove the stale Feb 14 row.
DELETE FROM timeline_events
WHERE id = 't_2026_02_14'
  AND EXISTS (SELECT 1 FROM timeline_events WHERE id = 't_2025_12_18');

--   3. If neither row exists (extremely unlikely -- would mean the live
--      timeline lost the Royal Assent event entirely), insert it from the
--      seed. INSERT OR IGNORE makes this a no-op when the row is already
--      there.
INSERT OR IGNORE INTO timeline_events
  (id, event_date, title, summary, category, source_label, source_url)
VALUES
  ('t_2025_12_18',
   '2025-12-18',
   'Planning & Infrastructure Bill receives Royal Assent',
   'Landmark reform of the planning system passes both houses with cross-bench support; commencement orders expected by late spring.',
   'delivery',
   'Planning & Infrastructure Act 2025',
   'https://www.legislation.gov.uk/ukpga/2025/34/enacted');

-- Sanity check after mutation: should show exactly one row, dated 2025-12-18.
SELECT id, event_date, title, source_label, source_url
FROM timeline_events
WHERE id IN ('t_2026_02_14', 't_2025_12_18');
