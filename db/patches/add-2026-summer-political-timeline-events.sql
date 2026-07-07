-- Add three timeline events covering the May–June 2026 political turn:
-- the 7 May local elections, the Makerfield by-election, and the Prime
-- Minister's resignation announcement. These annotate the headline-chart
-- fluctuations over that window. Editorial copy is factual and
-- non-partisan; every event pins to a primary or authoritative source.
--
-- Apply:  cd apps/api && wrangler d1 execute tightrope_db --remote \
--           --file=../../db/patches/add-2026-summer-political-timeline-events.sql
-- Then purge the timeline cache:
--   curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
--     "https://ingest.tightropetracker.uk/admin/run?source=purge-cache"

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_05_07',
  '2026-05-07',
  'Local elections: historic Labour losses as Reform UK takes 12 councils',
  'English local elections across 136 authorities deliver the largest gain by any party outside the big two in local-election history: Reform UK wins over 1,050 seats and control of 12 councils. Labour loses roughly 340 councillors, seven councils held since the 1990s, and finishes third in equivalent vote share for the first time. The result intensifies pressure on the government''s delivery agenda and begins the sequence that ends in the Prime Minister''s June resignation.',
  'political',
  'Rallings & Thrasher / LGC',
  'https://www.lgcplus.com/politics/governance-and-structure/rallings-thrasher-how-labour-fell-to-historic-defeat-13-05-2026/'
);

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_06_18',
  '2026-06-18',
  'Andy Burnham wins the Makerfield by-election',
  'Greater Manchester Mayor Andy Burnham wins the Makerfield by-election, defeating Reform UK''s Robert Kenyon and returning to the Commons; he resigns the mayoralty the following day. The contest, triggered by Josh Simons'' resignation on 14 May, is widely read as positioning Burnham for a leadership challenge — four days later the Prime Minister announces his resignation.',
  'political',
  'House of Commons Library',
  'https://commonslibrary.parliament.uk/research-briefings/cbp-10853/'
);

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_06_22',
  '2026-06-22',
  'Prime Minister announces resignation; gilts and sterling wobble, then steady',
  'Keir Starmer announces he will resign as Labour leader and Prime Minister once a leadership election concludes, following the May local-election defeats and the Makerfield result. Markets, having largely priced the outcome, react modestly: sterling slips to around $1.32, the 10-year gilt yield prints near 4.85% intraday before easing, and attention shifts to whether the next government maintains the current fiscal rules. Nominations open 9 July with a new leader due before Parliament returns in September.',
  'political',
  'Al Jazeera (contemporaneous report)',
  'https://www.aljazeera.com/news/2026/6/22/why-has-keir-starmer-resigned-as-uk-prime-minister-and-who-will-take-over'
);
