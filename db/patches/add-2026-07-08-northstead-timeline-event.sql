-- Add the 8 July 2026 Manor of Northstead appointment to the timeline:
-- the procedural mechanism by which Nigel Farage resigned his Commons seat,
-- three days after the Labour leadership contest opened and days before a
-- new Prime Minister was due to take office. Surfaced by the curator's
-- gov.uk staging (capture #71, rejected in favour of this hand-authored
-- event during the 2026-07-14 editorial triage). Copy is factual and
-- non-partisan: the notice states only the appointment; no motive is
-- attributed.
--
-- Apply:  cd apps/api && wrangler d1 execute tightrope_db --remote \
--           --file=../../db/patches/add-2026-07-08-northstead-timeline-event.sql

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_07_08_northstead',
  '2026-07-08',
  'Nigel Farage resigns his Commons seat via the Manor of Northstead',
  'The Chancellor of the Exchequer appoints Nigel Paul Farage as Steward and Bailiff of the Manor of Northstead — the procedural mechanism by which an MP resigns their seat, as Parliament does not permit direct resignation. The Reform UK leader leaves the Commons ten weeks after his party''s historic local-election gains and days before the Labour leadership contest concludes, adding a further by-election to the political calendar during the transition of power.',
  'political',
  'HM Treasury (gov.uk announcement)',
  'https://www.gov.uk/government/news/manor-of-northstead--3'
);
