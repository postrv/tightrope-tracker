-- Annotate the July–August 2026 recovery on the headline chart: Burnham
-- takes office, the GfK "Burnham bounce", the July services PMI returning
-- to expansion, and the July public-sector-finances print that lifts the
-- fiscal pillar after May's overshoot. These sit after the existing
-- gilt-window / summer-political events (local elections 7 May, Makerfield
-- 18 Jun, resignation 22 Jun, Iran 8 Jul). Copy is factual and
-- non-partisan; every event pins to a primary or contemporaneous source.
--
-- Apply:  cd apps/api && wrangler d1 execute tightrope_db --remote \
--           --file=../../db/patches/add-2026-july-aug-recovery-timeline-events.sql
-- Then purge the timeline (and score) cache:
--   curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
--     "https://ingest.tightropetracker.uk/admin/run?source=purge-cache"

-- Close the loop on the 22 June resignation row, which still said a new
-- leader was due "before Parliament returns in September".
UPDATE timeline_events
SET summary = 'Keir Starmer announces he will resign as Labour leader and Prime Minister once a leadership election concludes, following the May local-election defeats and the Makerfield result. Markets, having largely priced the outcome, react modestly: sterling slips to around $1.32, the 10-year gilt yield prints near 4.85% intraday before easing. Nominations open 9 July; Andy Burnham is elected Labour leader unopposed on 17 July and appointed Prime Minister on 20 July.'
WHERE id = 't_2026_06_22';

INSERT OR IGNORE INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_07_20',
  '2026-07-20',
  'Andy Burnham appointed Prime Minister',
  'Andy Burnham is invited by King Charles III to form a government, succeeding Keir Starmer, after an unopposed Labour leadership election (379 nominations, 94% of the parliamentary party). He takes office pledging to restore political stability and ease the cost of living. Gilt yields and sterling are little changed on the day — the 10-year remains near 5.1% as the renewed Middle East conflict continues to dominate the rate path.',
  'political',
  'Reuters (contemporaneous report)',
  'https://www.reuters.com/world/uk/pledging-rewire-britain-king-north-burnham-becomes-pm-2026-07-19/'
);

INSERT OR IGNORE INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_07_23',
  '2026-07-23',
  'GfK consumer confidence jumps six points to -17',
  'The GfK Consumer Confidence Index rises to -17 in July from -23 in June, the largest monthly gain since November 2023. The survey ran 1-14 July — after the Makerfield result and the Prime Minister''s resignation announcement, and before the leadership contest concluded. GfK cites a "Burnham bounce", summer weather and the World Cup; all five sub-indices rise.',
  'market',
  'NIQ / GfK (July 2026 press release)',
  'https://nielseniq.com/global/en/news-center/2026/consumer-confidence-up-six-points-to-17-in-july/'
);

INSERT OR IGNORE INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_08_05',
  '2026-08-05',
  'UK services PMI returns to expansion at 52.1',
  'The S&P Global UK Services PMI Business Activity Index final print for July is 52.1, revised up from a 51.8 flash and recovering from 48.8 in June — the first expansion reading in three months. New work rises for the first time since February; employment continues to fall, though at a slower pace. Input-cost inflation eases to its lowest since February.',
  'market',
  'S&P Global UK Services PMI, July 2026 final',
  'https://www.pmi.spglobal.com/Public/Home/PressRelease/754c679147324e39ab67e212c7466ab3'
);

INSERT OR IGNORE INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_08_21',
  '2026-08-21',
  'July borrowing prints at £1.8bn',
  'Public sector net borrowing is £1.8 billion in July 2026, £0.7 billion more than a year earlier and £2.3 billion above the OBR''s monthly profile. The monthly level is nonetheless one of the smaller July prints in the comparable series, and year-to-date borrowing is £6.0 billion lower than a year earlier. The print lifts the fiscal pillar after May''s £23.3 billion overshoot.',
  'fiscal',
  'ONS Public sector finances, July 2026',
  'https://www.ons.gov.uk/economy/governmentpublicsectorandtaxes/publicsectorfinance/bulletins/publicsectorfinances/july2026'
);
