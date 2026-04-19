-- Backfill `source_url` for timeline_events that shipped without one.
-- Originally only 3 of 11 rows carried a URL; the rest were NULL. Every
-- event now points at a durable primary source (BoE, OBR, gov.uk,
-- parliament.uk). Idempotent: UPDATE by id, only filling where NULL.

UPDATE timeline_events SET source_url = 'https://www.bankofengland.co.uk/statistics/exchange-rates'
  WHERE id = 't_2026_04_17' AND source_url IS NULL;

UPDATE timeline_events SET source_url = 'https://www.gov.uk/government/organisations/hm-treasury'
  WHERE id = 't_2026_04_16' AND source_url IS NULL;

UPDATE timeline_events SET source_url = 'https://www.bankofengland.co.uk/markets'
  WHERE id = 't_2026_02_28' AND source_url IS NULL;

UPDATE timeline_events SET source_url = 'https://www.bankofengland.co.uk/monetary-policy-summary-and-minutes'
  WHERE id = 't_2026_02_12' AND source_url IS NULL;

UPDATE timeline_events SET source_url = 'https://www.gov.uk/government/organisations/hm-treasury'
  WHERE id = 't_2025_11' AND source_url IS NULL;

UPDATE timeline_events SET source_url = 'https://www.bankofengland.co.uk/monetary-policy-summary-and-minutes'
  WHERE id = 't_2025_09' AND source_url IS NULL;

UPDATE timeline_events SET source_url = 'https://www.gov.uk/government/organisations/department-for-business-and-trade'
  WHERE id = 't_2025_06' AND source_url IS NULL;

UPDATE timeline_events SET source_url = 'https://obr.uk/efo/'
  WHERE id = 't_2025_03' AND source_url IS NULL;

UPDATE timeline_events SET source_url = 'https://www.gov.uk/government/organisations/hm-treasury'
  WHERE id = 't_2024_10' AND source_url IS NULL;
