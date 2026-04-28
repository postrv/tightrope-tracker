-- fix-delivery-commitments-stale-rows.sql
--
-- Two stale prod rows in `delivery_commitments` that were never picked up
-- by earlier patches:
--
-- 1. `planning_bill.latest` still reads "Received Royal Assent 14 Feb 2026"
--    (the legacy fixture date). The Planning and Infrastructure Act 2025
--    received Royal Assent on 18 December 2025
--    (legislation.gov.uk/ukpga/2025/34, bills.parliament.uk/bills/3946).
--    `planning_bill.notes` was already realigned to 18 Dec by
--    fix-delivery-urls.sql, but `latest` was missed because that patch
--    only touched source_url/source_label/notes.
--
-- 2. `keep_britain_working.notes` still cites ONS series LF2R. The live
--    onsLms adapter (packages/data-sources/src/adapters/onsLms.ts:50)
--    ingests LF69 (the successor to retired LFK2). The seed has the
--    LF69 long-form string at packages/shared/src/deliveryCommitmentsSeed.ts:98.
--
-- Idempotent: each UPDATE is keyed on the stale value, so re-running
-- against an already-corrected DB is a no-op (zero rows match).
--
-- Cache invalidation: the API caches `delivery:latest` in KV with a
-- 30-minute editorial freshness window. After this patch lands, prod
-- will self-heal within ~30 min, OR delete the `delivery:latest` KV key
-- via wrangler for instant refresh, OR hit
-- POST /admin/run?source=recompute on the ingest worker.
--
-- Run as:
--   wrangler d1 execute tightrope_db --remote \
--     --file=db/patches/fix-delivery-commitments-stale-rows.sql
--
-- Authored: 2026-04-28 (follow-up after GPT-5.5 broadcast-readiness
-- audit flagged that fix-delivery-urls.sql + fix-planning-bill-royal-
-- assent-date.sql together still left these two fields stale.)

-- Sanity check before mutation. Should show the two stale strings.
SELECT id, latest, notes
FROM delivery_commitments
WHERE id IN ('planning_bill', 'keep_britain_working');

-- 1. Realign planning_bill.latest to match the seed and the timeline_events
--    Royal Assent date.
UPDATE delivery_commitments
SET latest = 'Received Royal Assent 18 Dec 2025'
WHERE id = 'planning_bill'
  AND latest = 'Received Royal Assent 14 Feb 2026';

-- 2. Realign keep_britain_working.notes to LF69 (long form, matching the
--    seed) so the public source note cites the series the live adapter
--    actually ingests.
UPDATE delivery_commitments
SET notes = 'Inactivity-due-to-long-term-sickness numbers come from ONS Labour Force Survey (series LF69, LFS: Econ. inactivity reasons: Long Term Sick: UK: 16-64). The policy target is set out in the DWP ''Get Britain Working'' white paper; the rolling figure is against that baseline.'
WHERE id = 'keep_britain_working'
  AND notes LIKE '%series LF2R%';

-- Sanity check after mutation. Should show the corrected strings; planning_bill.latest
-- should read "...18 Dec 2025"; keep_britain_working.notes should reference LF69.
SELECT id, latest, notes
FROM delivery_commitments
WHERE id IN ('planning_bill', 'keep_britain_working');
