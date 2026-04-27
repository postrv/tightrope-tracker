-- 0009_housing_methodology_correction.sql
--
-- Two coupled edits, applied atomically:
--
--   1. UPDATE the `housing_305k` delivery commitment's `latest` and
--      `notes` fields so the publicly-displayed text matches the
--      methodology actually used by the live `housing_trajectory`
--      indicator (quarterly completions × 4, vs 300k OBR working
--      assumption). Pre-fix, the card showed "221,400 (FY24/25)" —
--      that's the *net additional dwellings* annual figure, a
--      different (broader) measure than the indicator's quarterly
--      completions input. Apples-to-apples now.
--
--   2. INSERT a corrections-log row documenting the homepage value
--      shift. The shift was caused by a snapshot-selector bug
--      (Phase 1 audit, see AUDIT_FINDINGS.md §1) which let a stale
--      seed-era row (72.4%) win the MAX(observed_at) race against
--      the current fixture (49.0%). The selector now picks by
--      MAX(ingested_at) over non-hist/non-seed rows, so the live
--      indicator value reflects the on-disk fixture.
--
-- Both writes use idempotent verbs (UPDATE always; INSERT OR IGNORE
-- on the correction id) so this migration is safe to re-run.
--
-- Future enhancement (NOT in this migration): switch the indicator
-- to trailing-4-quarter (T4Q) completions instead of single-quarter
-- × 4. Same denominator, same target, but a more stable annual
-- measure that updates quarterly. We have the back-data in
-- `packages/data-sources/src/fixtures/housing-history.json`.

UPDATE delivery_commitments
SET
  latest = 'Live indicator: Q4 2025 completions × 4 = 146,880 vs 300k OBR working assumption (49%). Annual NAD FY24/25: 221,400 vs 305k Labour target (73%).',
  notes = 'Two complementary measures of housing delivery. (1) The live indicator uses ''Completions, seasonally adjusted'' from the MHCLG Housing supply quarterly release — a quarterly cadence we annualise (×4) and compare against the 300,000-per-year OBR working assumption documented in the EFO supplementary tables. (2) The annual headline figure is ''Net additional dwellings'' from MHCLG Live Tables 211, a broader measure that includes change-of-use and conversions, published once a year (FY24/25 was 221,400). The 305k-by-2030/31 path target is the Labour government''s headline pledge; OBR''s 300k working assumption is what the live indicator benchmarks against to keep continuity with pre-Labour trajectory analysis. Showing both because they tell the same story at different sampling rates and at slightly different scope.',
  updated_at = '2026-04-27T12:00:00.000Z'
WHERE id = 'housing_305k';

INSERT OR IGNORE INTO corrections (
  id,
  published_at,
  affected_indicator,
  original_value,
  corrected_value,
  reason
) VALUES (
  '2026-04-27-housing-trajectory-selector-fix',
  '2026-04-27T12:00:00.000Z',
  'housing_trajectory',
  '72.4% (legacy seed row, FY-outturn-ratio methodology, observed_at 2026-03-31)',
  '49.0% (live fixture, quarterly-run-rate methodology, observed_at 2025-12-31)',
  'A snapshot-selector bug caused the API to serve a stale seed-era row that outranked the current fixture under MAX(observed_at). The selector now picks live observations by MAX(ingested_at) over rows whose payload_hash is not historical-backfill or seed; the homepage now displays the fixture-driven Q4 2025 completions × 4 / 300k = 49.0%. The 72.4% figure was an annual outturn ratio (net additional dwellings 221,400 / 305k) — a different measure from the indicator''s methodology and never the value the fixture intended to publish. Both measures remain documented in the delivery commitment card alongside the indicator.'
);
