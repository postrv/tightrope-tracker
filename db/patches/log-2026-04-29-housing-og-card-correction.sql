-- log-2026-04-29-housing-og-card-correction.sql
--
-- Follow-up corrections-log entry for commit e98cd34.
--
-- The /og/delivery-housing.png share card was using Labour's 305k
-- political pledge as the percentage denominator, while the
-- housing_trajectory indicator and the homepage delivery-commitment
-- text both score against the OBR 300k 2030 working assumption.
-- Two different denominators in two surfaces produced 48% on the
-- card vs 49% on the homepage for the same Q4 2025 print
-- (146,880 annualised completions). The card now uses the same
-- 300k anchor as the indicator so a viewer dividing 147 ÷ 300
-- lands on the same 49% the indicator publishes.
--
-- Idempotent: INSERT OR IGNORE keyed on the deterministic id.
--
-- Cache invalidation: corrections render live from D1; no KV purge
-- needed for the corrections list. The OG card itself needs a
-- separate purge of og.tightropetracker.uk/og/delivery-housing.png.
--
-- Run as:
--   wrangler d1 execute tightrope_db --remote \
--     --file=db/patches/log-2026-04-29-housing-og-card-correction.sql

INSERT OR IGNORE INTO corrections
  (id, published_at, affected_indicator, original_value, corrected_value, reason)
VALUES (
  'c_2026_04_29_housing_og_card_denominator',
  '2026-04-29T12:30:00Z',
  'housing_trajectory',
  'Housing share-card displayed "Housing: 48% of the way to the target" against a "305k · 2030 target" denominator (Labour''s political pledge of 305,000 net additional dwellings per year by 2030/31).',
  'Housing share-card now displays "Housing: 49% of the way to the target" against a "300k · OBR 2030 path" denominator (the OBR working assumption that housing_trajectory is scored against). Card text and indicator value now match: 146,880 annualised completions ÷ 300,000 = 49%.',
  'A pre-broadcast cross-check on 2026-04-29 found the OG share card used Labour''s 305k political pledge as the percentage denominator, while the homepage delivery-commitment card and the housing_trajectory indicator score the same numerator (146,880 annualised Q4 2025 completions) against the OBR 300k working assumption. The two denominators answer different questions, but on a single share card we prefer arithmetic coherence with the indicator the card visualises. Labour''s 305k pledge remains surfaced on the homepage delivery-commitment card prose, where both denominators are explained side by side (live indicator 49% vs OBR 300k; annual NAD 73% vs Labour 305k). The numerator (147k annualised completions) is unchanged.'
);

-- Verification.
SELECT id, published_at, affected_indicator
FROM corrections
WHERE id = 'c_2026_04_29_housing_og_card_denominator';
