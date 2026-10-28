-- Replace the Budget scheduling notice with the now-published official event.
-- Primary evidence checked 28 October 2026 after 17:17 UTC.
-- OBR Table 7.1 (printed p.161) says14.5, not the rounded15 in the speech.
-- This targeted editorial update does not rewrite observations or scores.
-- Evidence and publication times: packages/data-sources/src/fixtures/budget-2026-evidence.json

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_10_28_budget',
  '2026-10-28T13:29:19Z',
  'OBR Budget forecast published: £14.5bn headroom',
  'John Healey delivers Budget 2026. The OBR’s October forecast puts current-budget headroom at £14.5bn in 2029–30, versus £23.6bn in March. The October pre-measures figure is £12.5bn. These are forecast comparisons, not realised outcomes or an isolated measure of the Budget’s effect. The official forecast was published at 13:29 UTC.',
  'fiscal',
  'OBR October 2026 EFO, Table 7.1; HM Treasury Budget speech',
  'https://www.gov.uk/government/publications/october-2026-economic-and-fiscal-outlook'
)
ON CONFLICT(id) DO UPDATE SET
  event_date=excluded.event_date,
  title=excluded.title,
  summary=excluded.summary,
  category=excluded.category,
  source_label=excluded.source_label,
  source_url=excluded.source_url,
  score_delta=NULL;
