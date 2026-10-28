-- Disclosure only. Execute AFTER the reviewed atomic source repair succeeds.
-- Event/publication time comes from its successful audit, never Budget time.
-- No observation or published score rows are changed by this patch.
WITH applied AS (
  SELECT completed_at FROM ingestion_audit
  WHERE source_id = 'boe_breakevens:correction' AND status = 'success'
    AND rows_written = 1066
    AND payload_hash = '183bfd76cbc5d2cd13a508a5600cdf2a7b0a94afa09e580d161c61cfd9207473'
  ORDER BY completed_at DESC LIMIT 1
)
INSERT OR IGNORE INTO corrections (
  id, published_at, affected_indicator, original_value, corrected_value, reason
)
SELECT
  '2026-10-28-breakeven-series-definition', completed_at,
  'breakeven_5y: live value and 1066 existing raw observations across 609 reference dates',
  'IUDSNZC minus IUDSIZC; latest 1.2673 on 26 October 2026',
  'Official BoE IUDSIZC directly; latest 3.6941 on 26 October 2026',
  'The adapter misidentified IUDSIZC as a real yield. The independent BoE catalogue identifies IUDSIZC as five-year Inflation Zero Coupon; IUDSRZC is the real-yield code. Subtracting the inflation series from nominal IUDSNZC produced a real-rate-like quantity, not inflation compensation. The corrected live and historical parser uses IUDSIZC directly. A reviewed atomic repair replaced all 1066 existing keys (961 historical and 105 live representations) across the same 609 reference dates, from 3 June 2024 to 26 October 2026; no dates were added. The complete pre-correction rows and official source CSV are archived publicly. Original source/reference/release fields and historical/live selection tiers are preserved, while ingestion timestamps and payload hashes identify the correction. Earlier published headline and pillar scores remain as published. A controlled replay freezing all other current readings moved the headline from 39.1 to 40.2 and Market Stability from 33.6 to 36.1; that is data-definition sensitivity, not a Budget reaction or a rewritten historical score. The earlier claim that the negative -0.0314 reading on 1 August 2024 was valid inflation evidence is retracted: official IUDSIZC was 3.6565. This is RPI-linked gilt-market inflation compensation over five years, including risk and liquidity premia, not a pure CPI forecast. Daily BoE first-publication times are not available in the stored history; the official current vintage does not reconstruct an as-known historical archive. Sources: https://www.bankofengland.co.uk/boeapps/database/FromShowColumns.asp?searchText=yield and https://www.bankofengland.co.uk/statistics/details/further-details-about-yields-data . Archived CSV SHA-256: 183bfd76cbc5d2cd13a508a5600cdf2a7b0a94afa09e580d161c61cfd9207473.'
FROM applied;

WITH applied AS (
  SELECT completed_at FROM ingestion_audit
  WHERE source_id = 'boe_breakevens:correction' AND status = 'success'
    AND rows_written = 1066
    AND payload_hash = '183bfd76cbc5d2cd13a508a5600cdf2a7b0a94afa09e580d161c61cfd9207473'
  ORDER BY completed_at DESC LIMIT 1
)
INSERT OR IGNORE INTO timeline_events (
  id, event_date, title, summary, category, source_label, source_url
)
SELECT
  't_2026_10_28_breakeven_definition_correction', completed_at,
  'Source correction: five-year inflation series',
  'The five-year breakeven input now reads the BoE inflation series IUDSIZC directly, correcting a nominal-minus-inflation error across 1066 existing raw keys and 609 reference days. Historical score snapshots remain as published. Changes at this correction time reflect corrected data definitions and must not be attributed to the Budget.',
  'methodology', 'Tightrope source audit and BoE series catalogue',
  'https://tightropetracker.uk/corrections'
FROM applied;
