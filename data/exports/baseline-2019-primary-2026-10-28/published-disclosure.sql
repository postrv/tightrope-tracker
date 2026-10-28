-- DRAFT: no production writes until the 8,770-row operation is approved/applied.
-- Resolve BOTH obvious timestamp placeholders from verified applied.json using:
-- node --import tsx scripts/finalize-baseline-2019-audit.mjs --input=/abs/post-apply-dump.json --snapshot=/abs/current-score.json --sql-output=/abs/resolved-disclosure.sql
-- This template deliberately fails before any INSERT while placeholders are
-- unresolved: the guarded JSON error below signals an unresolved draft.
-- It also requires all nine successful historical audits to total 8,770 rows
-- inside the actual application window. No observation or score rows are edited.
SELECT CASE
  WHEN '2026-10-28T23:37:36.764Z' GLOB '20??-??-??T??:??:??*Z'
    AND '2026-10-28T23:40:21.145Z' GLOB '20??-??-??T??:??:??*Z'
  THEN 1
  ELSE json_extract('UNRESOLVED_BASELINE_APPLICATION_TIMESTAMPS', '$')
END AS verified_actual_application_timestamps;

WITH reviewed_run AS (
  SELECT COUNT(*) AS attempts, COUNT(DISTINCT source_id) AS sources,
         SUM(rows_written) AS inserted
  FROM ingestion_audit
  WHERE source_id IN (
    'boe_yields:historical', 'boe_fx:historical', 'boe_breakevens:historical',
    'boe_mortgage_rates:historical', 'ons_lms:historical', 'ons_psf:historical',
    'ons_rti:historical', 'mhclg:historical', 'eia_brent:historical'
  )
    AND status IN ('success', 'unchanged')
    AND started_at >= '2026-10-28T23:37:36.764Z'
    AND completed_at <= '2026-10-28T23:40:21.145Z'
)
INSERT OR IGNORE INTO corrections (
  id, published_at, affected_indicator, original_value, corrected_value, reason
)
SELECT
  '2026-10-28-baseline-history-coverage',
  '2026-10-28T23:40:21.145Z',
  '2019 baseline coverage for 17 market, fiscal, labour and delivery inputs',
  'Shorter stored historical samples; controlled current-reading replay headline 39.4',
  '8,770 missing leading observations; 8,375 baseline-eligible and 395 excluded by the unchanged Q2 2020 policy; controlled replay headline 36.9',
  'An audited, missing-date-only backfill added 8,770 observations across 17 inputs and nine source groups: 7,346 BoE/ONS observations, 28 MHCLG housing/planning observations derived from official ODS tables, and 1,396 EIA Brent observations converted to GBP using reviewed BoE exchange-rate pairs. Every added reference day precedes that indicator''s former first stored reference day. The operation used overwrite=false and preserved every field of all 8,294 original reference records. No earlier headline or pillar scores were regenerated or overwritten. Of the new observations, 8,375 extend the scoring baseline and 395 fall within the existing Q2 2020 exclusion. Weights, score direction and exclusion policy are unchanged. A controlled replay holding the 18:35 UTC current readings constant moves the headline from 39.4 to 36.9; this measures the effect of better baseline coverage, not a Budget reaction. These are current-vintage official histories, not an archive of what was known at each historical date. ONS updateDate can reflect later revisions; BoE daily reference timestamps are not verified publication times; the MHCLG source vintage is 24 September 2026. Other inputs retain shorter histories where comparable evidence has not been prepared. All source captures, ODS cell coordinates, EIA/FX pairs, hashes and replay evidence are archived. Thirty-one added historical values lie outside current live plausibility ranges and remain honestly flagged as reviewed source exceptions; six are baseline-eligible. Current live range and jump guards were not loosened. Sources: https://www.bankofengland.co.uk/boeapps/database/ , https://www.ons.gov.uk/ , https://www.gov.uk/government/collections/house-building-statistics , https://www.gov.uk/government/collections/planning-applications-statistics and https://www.eia.gov/dnav/pet/hist/RBRTED.htm . Candidate archive SHA-256: bad910e7715eeba5e7b47c240a126ea4de0ff276575cd502b83305e214e322a7.'
FROM reviewed_run
WHERE attempts = 9 AND sources = 9 AND inserted = 8770
  AND '2026-10-28T23:37:36.764Z' GLOB '20??-??-??T??:??:??*Z'
  AND '2026-10-28T23:40:21.145Z' GLOB '20??-??-??T??:??:??*Z';

WITH reviewed_run AS (
  SELECT COUNT(*) AS attempts, COUNT(DISTINCT source_id) AS sources,
         SUM(rows_written) AS inserted
  FROM ingestion_audit
  WHERE source_id IN (
    'boe_yields:historical', 'boe_fx:historical', 'boe_breakevens:historical',
    'boe_mortgage_rates:historical', 'ons_lms:historical', 'ons_psf:historical',
    'ons_rti:historical', 'mhclg:historical', 'eia_brent:historical'
  )
    AND status IN ('success', 'unchanged')
    AND started_at >= '2026-10-28T23:37:36.764Z'
    AND completed_at <= '2026-10-28T23:40:21.145Z'
)
INSERT OR IGNORE INTO timeline_events (
  id, event_date, title, summary, category, source_label, source_url
)
SELECT
  't_2026_10_28_baseline_history_coverage',
  '2026-10-28T23:37:36.764Z',
  'Baseline coverage expanded with verified official history',
  'Coverage began changing at this marker and the backfill completed at 2026-10-28T23:40:21.145Z. 8,770 missing leading observations extend 17 inputs towards the existing 2019 baseline: 8,375 are eligible and 395 remain excluded by the Q2 2020 policy. All 8,294 original reference records and earlier published score history are preserved. A frozen-reading replay changes 39.4 to 36.9 because baseline coverage changed; this is not a Budget market reaction.',
  'methodology',
  'Tightrope data-quality audit; BoE, ONS, MHCLG and EIA',
  'https://tightropetracker.uk/corrections'
FROM reviewed_run
WHERE attempts = 9 AND sources = 9 AND inserted = 8770
  AND '2026-10-28T23:37:36.764Z' GLOB '20??-??-??T??:??:??*Z'
  AND '2026-10-28T23:40:21.145Z' GLOB '20??-??-??T??:??:??*Z';
