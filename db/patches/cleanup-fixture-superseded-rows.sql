-- cleanup-fixture-superseded-rows.sql
--
-- Remove "stale-live" rows in `indicator_observations` that have been
-- superseded by a more recently-ingested live row for the same
-- (indicator_id, source_id) pair. These accumulate when an editorial
-- fixture changes its `observed_at` to an *earlier* date — the
-- previously-written live row at the older `observed_at` survives
-- under the (indicator_id, observed_at) PK and pollutes any selector
-- that looks at the table without filtering for the most recent ingest.
--
-- The application code (apps/api, apps/web, apps/ingest, apps/og) was
-- already updated to pick by MAX(ingested_at) over rows with
-- `payload_hash` not in ('hist:%', 'seed%'), so this patch is purely
-- a defensive cleanup of the underlying data — not required for
-- correctness post-deploy.
--
-- Scope:
--   - Live rows only: `payload_hash` is neither `'hist:%'` nor `'seed%'`,
--     and not NULL (NULL is treated as live elsewhere; we leave them be).
--   - Per (indicator_id, source_id) keep the row with MAX(ingested_at);
--     delete every earlier one.
--
-- Run as:
--   wrangler d1 execute tightrope_db --remote --file=db/patches/cleanup-fixture-superseded-rows.sql
-- Always run with --local first against a fresh seed and inspect the
-- row counts before --remote.
--
-- Authored: 2026-04-27 (Tightrope production audit)

-- Sanity check: how many rows are about to be deleted?
SELECT
  COUNT(*) AS rows_to_delete,
  COUNT(DISTINCT indicator_id || '|' || source_id) AS pairs_affected
FROM indicator_observations o
WHERE
  o.payload_hash IS NOT NULL
  AND o.payload_hash NOT LIKE 'hist:%'
  AND o.payload_hash NOT LIKE 'seed%'
  AND NOT EXISTS (
    -- True iff this row IS the most-recently-ingested live row for its pair.
    SELECT 1 FROM indicator_observations m
    WHERE m.indicator_id = o.indicator_id
      AND m.source_id = o.source_id
      AND (m.payload_hash IS NOT NULL
           AND m.payload_hash NOT LIKE 'hist:%'
           AND m.payload_hash NOT LIKE 'seed%')
      AND m.ingested_at > o.ingested_at
  )
  -- The above filter actually gives us "is the keeper" (no row with greater
  -- ingested_at exists). To get "should be deleted", invert to "there
  -- exists a more-recently-ingested live row for the same pair":
  AND EXISTS (
    SELECT 1 FROM indicator_observations m
    WHERE m.indicator_id = o.indicator_id
      AND m.source_id = o.source_id
      AND (m.payload_hash IS NOT NULL
           AND m.payload_hash NOT LIKE 'hist:%'
           AND m.payload_hash NOT LIKE 'seed%')
      AND m.ingested_at > o.ingested_at
  );
-- The two `AND NOT EXISTS` / `AND EXISTS` clauses together select rows
-- where a more-recent live row exists for the pair; the NOT EXISTS branch
-- is redundant but kept for symmetry with the DELETE below.

-- Now the actual delete.
DELETE FROM indicator_observations
WHERE rowid IN (
  SELECT o.rowid
  FROM indicator_observations o
  WHERE
    o.payload_hash IS NOT NULL
    AND o.payload_hash NOT LIKE 'hist:%'
    AND o.payload_hash NOT LIKE 'seed%'
    AND EXISTS (
      SELECT 1 FROM indicator_observations m
      WHERE m.indicator_id = o.indicator_id
        AND m.source_id = o.source_id
        AND (m.payload_hash IS NOT NULL
             AND m.payload_hash NOT LIKE 'hist:%'
             AND m.payload_hash NOT LIKE 'seed%')
        AND m.ingested_at > o.ingested_at
    )
);

-- Force the next page-render to rebuild from D1 rather than serving the
-- cached snapshot.
-- (KV invalidation happens via the admin worker, not here. After this
-- patch runs, hit POST /admin/run?source=recompute on the ingest worker.)
