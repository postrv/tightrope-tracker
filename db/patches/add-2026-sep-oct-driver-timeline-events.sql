-- Annotate the September–October 2026 movers on the headline chart.
-- These are the releases that moved the market, fiscal and labour
-- pillars after the 21 August borrowing row: August and September
-- services PMI, the September labour-market bulletin, August CPI,
-- the 17 September MPC, August borrowing, September consumer
-- confidence, and the September RICS house-price balance.
--
-- Apply:  cd apps/api && pnpm exec wrangler d1 execute tightrope_db --remote \
--           --file=../../db/patches/add-2026-sep-oct-driver-timeline-events.sql
-- Then purge the timeline cache:
--   curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
--     "https://ingest.tightropetracker.uk/admin/run?source=purge-cache"

INSERT OR IGNORE INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_09_03',
  '2026-09-03',
  'August services PMI rises to a four-month high of 52.5',
  'The S&P Global UK Services PMI Business Activity Index final print for August is 52.5, up from 52.1 in July and the highest in four months. New work rises for a second month. Input-cost inflation picks up from a five-month low in July as fuel and transport bills rise. Employment falls for a 23rd month, the longest run since the survey began in 1996, though at the slowest pace since October 2025.',
  'market',
  'S&P Global UK Services PMI, August 2026 final',
  'https://www.pmi.spglobal.com/Public/Home/PressRelease/577726f5cdab43de8bab0ac5d4d84b97'
);

INSERT OR IGNORE INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_09_15',
  '2026-09-15',
  'Unemployment holds at 4.9% as payrolls slip',
  'The ILO unemployment rate is 4.9% in May to July 2026, largely unchanged on the quarter and up 0.2 percentage points on the year. The 16–64 inactivity rate is 20.9%, down 0.1 percentage points on both the quarter and the year. Payrolled employees fall by 19,000 between June and July. The employment rate is 75.1%. These are the labour-pillar prints in the September bulletin.',
  'policy',
  'ONS Labour market overview, September 2026',
  'https://www.ons.gov.uk/employmentandlabourmarket/peopleinwork/employmentandemployeetypes/bulletins/uklabourmarket/september2026'
);

INSERT OR IGNORE INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_09_16',
  '2026-09-16',
  'August CPI rises to 3.1% on motor fuels',
  'Headline CPI inflation is 3.1% in the year to August, up from 2.9% in July. CPIH is 3.3%, up from 3.1%. Transport, particularly motor fuels, makes the largest upward contribution to the change in both annual rates. Core CPI is unchanged at 2.6%. The print is published the day before the September MPC decision.',
  'fiscal',
  'ONS Consumer price inflation, August 2026',
  'https://www.ons.gov.uk/economy/inflationandpriceindices/bulletins/consumerpriceinflation/august2026'
);

INSERT OR IGNORE INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_09_17',
  '2026-09-17',
  'Bank of England holds Bank Rate at 3.75% and sets a multi-year gilt unwind',
  'The Monetary Policy Committee votes 6–3 to maintain Bank Rate at 3.75%, with three members preferring a rise to 4%. On energy prices as of 14 September, with Brent at $106 a barrel, staff expect CPI to reach slightly above 4% in 2027 Q1, compared with a 3.2% peak in 2026 Q4 at the July Report. The Committee also votes unanimously to reduce the gilt stock held for monetary policy purposes to zero by the end of 2034, at an average pace of £46 billion a year, through £20 billion of annual sales alongside maturing gilts. Next decision 5 November.',
  'monetary',
  'Bank of England, September 2026 MPC',
  'https://www.bankofengland.co.uk/monetary-policy-summary-and-minutes/2026/september-2026'
);

INSERT OR IGNORE INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_09_22',
  '2026-09-22',
  'August borrowing prints at £18.3bn',
  'Public sector net borrowing is £18.3 billion in August 2026, £2.9 billion more than a year earlier and £3.5 billion above the OBR monthly profile. Spending rose faster than receipts, partly reflecting inflation. The monthly print is the second-highest August on record before adjusting for inflation, and it is the borrowing figure the fiscal pillar now carries.',
  'fiscal',
  'ONS Public sector finances, August 2026',
  'https://www.ons.gov.uk/economy/governmentpublicsectorandtaxes/publicsectorfinance/bulletins/publicsectorfinances/august2026'
);

INSERT OR IGNORE INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_09_25',
  '2026-09-25',
  'GfK consumer confidence rises to -13 for a third month',
  'The GfK Consumer Confidence Index is -13 in September, up one point from -14 in August. It is the third consecutive monthly increase, the first such run since summer 2024. Four of the five measures rise; the major-purchase index falls one point to -8. GfK notes that with inflation, energy and fuel prices rising, sentiment could falter. The index is the market pillar read on household consumption.',
  'market',
  'NIQ / GfK (September 2026 press release)',
  'https://nielseniq.com/global/en/news-center/2026/consumer-confidence-up-one-point-in-september-to-13/'
);

INSERT OR IGNORE INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_10_05',
  '2026-10-05',
  'September services PMI eases to 52.1',
  'The S&P Global UK Services PMI Business Activity Index final print for September is 52.1, down from 52.5 in August and above the flash estimate of 51.7. Output rises for a third month, but new orders grow at the slowest pace since July. Input-cost inflation is the strongest since June, led by fuel prices, and prices charged rise at the fastest pace since May. Employment falls for a twenty-fourth month, at the slowest pace since October 2025.',
  'market',
  'S&P Global UK Services PMI, September 2026 final',
  'https://www.pmi.spglobal.com/Public/Home/PressRelease/23453dfdab0048ee8a69994752851579'
);

INSERT OR IGNORE INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_10_06',
  '2026-10-06',
  'September house-price balance falls to -32%',
  'The RICS UK Residential Market Survey headline net balance of surveyors reporting rising rather than falling house prices is -32% in September, down from -28% in August. The fall breaks four months in which the balance had become gradually less negative. Near-term price expectations stay negative, at -24%. The balance is the market pillar read on residential investment.',
  'market',
  'RICS UK Residential Market Survey, September 2026',
  'https://www.rics.org/content/dam/ricsglobal/documents/market-surveys/RICS-UK-Residential-Market-Survey_September-2026.pdf'
);
