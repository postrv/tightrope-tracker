-- Editorial disclosure for the reviewed computation correction. This patch
-- never changes indicator observations or previously published score rows.
-- Apply with the matching corrected ingest/API/web code, after source backfills.

INSERT OR IGNORE INTO corrections (
  id, published_at, affected_indicator, original_value, corrected_value, reason
) VALUES (
  '2026-10-28-baseline-reference-days',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'headline and pillar baseline sampling',
  '38.3 (previous code, replayed after the FTSE history catch-up)',
  '42.8 (corrected code, identical current indicator readings)',
  'The filter intended to exclude superseded, incorrectly dated live fixtures also discarded genuine earlier live observations. It reduced the DMO daily series to a single sample and housebuilders to two samples. The correction retains valid earlier observations and counts each indicator reference day once, removing duplicate midnight/close representations of the same daily publication. The same selection now feeds live scoring and the public baseline summaries used by Explore. On the same 28 October inputs the replay changes the headline from 38.3 to 42.8, with corrected Market/Fiscal/Labour/Delivery pillars of 34.0/50.9/58.2/34.6. The previously published pre-backfill headline was 38.2. This is a computation correction, not a measured Budget reaction. Indicator and pillar weights, score direction and schema v2 are unchanged. Earlier published score snapshots are retained as published; comparisons crossing this correction require that caveat.'
);

INSERT OR IGNORE INTO corrections (
  id, published_at, affected_indicator, original_value, corrected_value, reason
) VALUES (
  '2026-10-28-obr-november-2025-precision',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'cb_headroom, November 2025 vintage',
  '£22.0bn (rounded executive-summary margin)',
  '£21.7bn (OBR November 2025 EFO, Table A.9)',
  'The historical fixture and audited historical observation are corrected to the detailed OBR table precision: a £21.7bn current-budget surplus in 2029–30. The executive summary rounds that margin to £22bn. The March 2026 vintage remains £23.6bn. This precision correction changes neither the ordering of the four stored headroom vintages nor the current headroom percentile score. Source: https://obr.uk/efo/economic-and-fiscal-outlook-november-2025/.'
);

INSERT INTO timeline_events (
  id, event_date, title, summary, category, source_label, source_url
) VALUES (
  't_2026_10_28_baseline_correction',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'Score calculation correction: baseline history restored',
  'A calculation correction retains valid historical live observations and counts each indicator reference day once. A same-input replay changes the headline from 38.3 to 42.8, with unchanged weights and score schema. This is not a Budget reaction. Earlier snapshots remain as published; changes across this date include this correction.',
  'methodology',
  'Tightrope public corrections log, 28 October 2026',
  'https://tightropetracker.uk/corrections'
)
ON CONFLICT(id) DO UPDATE SET
  title = excluded.title,
  summary = excluded.summary, category = excluded.category,
  source_label = excluded.source_label, source_url = excluded.source_url,
  score_delta = NULL;
