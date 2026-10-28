-- Verified Budget-day context and corrections to historical timeline metadata.
-- Reviewed against the linked primary releases on 28 October 2026.
-- This patch affects editorial annotations only: no observations, scores,
-- weights, delivery assessments, or forecast vintages are changed.
-- Budget outcome/forecast figures remain unasserted until officially published.
-- Stable legacy IDs are retained when correcting an event date.
--
-- Apply only this targeted patch to production; never re-seed the live database:
--   cd apps/api && pnpm exec wrangler d1 execute tightrope_db --remote \
--     --file=../../db/patches/add-2026-budget-context-timeline-events.sql
-- The timeline cache expires after 30 minutes; use the existing authenticated
-- purge-cache workflow for immediate visibility if credentials are available.

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_10_28_budget',
  '2026-10-28',
  'Budget day: statement scheduled for 12:30',
  'Parliament schedules the 2026 Budget statement for approximately 12:30 after Prime Minister’s Questions. This marks the announced fiscal-event date; no Budget measures, OBR forecast figures or market reaction are assumed here.',
  'fiscal',
  'UK Parliament, Budget statement notice (23 October 2026)',
  'https://www.parliament.uk/business/news/2026/october-2026/budget-statement-wednesday-28-october/'
)
ON CONFLICT(id) DO UPDATE SET
  event_date = excluded.event_date,
  title = excluded.title,
  summary = excluded.summary,
  category = excluded.category,
  source_label = excluded.source_label,
  source_url = excluded.source_url,
  score_delta = NULL;

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_10_23',
  '2026-10-23',
  'Consumer confidence falls 11 points to -24',
  'The GfK Consumer Confidence Barometer powered by NIM falls from -13 to -24 in October. All five component measures decline. Interviews took place from 1 to 14 October, before the Budget; the release is a household-sentiment reading rather than a response to the statement.',
  'market',
  'GfK Consumer Confidence Barometer powered by NIM / NIQ, October 2026',
  'https://nielseniq.com/global/en/news-center/2026/consumer-confidence-plunges-11-points-to-24-in-october/'
)
ON CONFLICT(id) DO UPDATE SET
  event_date = excluded.event_date,
  title = excluded.title,
  summary = excluded.summary,
  category = excluded.category,
  source_label = excluded.source_label,
  source_url = excluded.source_url,
  score_delta = NULL;

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_10_21_borrowing',
  '2026-10-21',
  'September borrowing reaches £24.5bn',
  'ONS estimates September public sector net borrowing at £24.5 billion, £1.8 billion above a year earlier and £1.9 billion above the OBR forecast. Borrowing in the financial year to September is £97.8 billion, £6.0 billion above forecast but £4.4 billion below the previous year. These are provisional outturns, separate from forecast fiscal-rule headroom.',
  'fiscal',
  'ONS Public sector finances, September 2026',
  'https://www.ons.gov.uk/economy/governmentpublicsectorandtaxes/publicsectorfinance/bulletins/publicsectorfinances/september2026'
)
ON CONFLICT(id) DO UPDATE SET
  event_date = excluded.event_date,
  title = excluded.title,
  summary = excluded.summary,
  category = excluded.category,
  source_label = excluded.source_label,
  source_url = excluded.source_url,
  score_delta = NULL;

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_10_21_cpi',
  '2026-10-21',
  'September CPI inflation rises to 3.5%',
  'CPI inflation rises to 3.5% in September from 3.1% in August; CPIH rises to 3.6% from 3.3%. Motor fuels make the largest upward contribution to the change in the annual rates. Core CPI increases to 2.8%.',
  'fiscal',
  'ONS Consumer price inflation, September 2026',
  'https://www.ons.gov.uk/economy/inflationandpriceindices/bulletins/consumerpriceinflation/september2026'
)
ON CONFLICT(id) DO UPDATE SET
  event_date = excluded.event_date,
  title = excluded.title,
  summary = excluded.summary,
  category = excluded.category,
  source_label = excluded.source_label,
  source_url = excluded.source_url,
  score_delta = NULL;

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_10_20',
  '2026-10-20',
  'Unemployment at 4.7%; vacancies fall to 691,000',
  'The October labour-market bulletin estimates unemployment at 4.7% and inactivity at 20.9% for June to August. Vacancies fall to 691,000 in July to September. The early September payroll estimate rises by 13,000 on the month and remains provisional; it should not be confused with the revised August observation.',
  'policy',
  'ONS Labour market overview, October 2026',
  'https://www.ons.gov.uk/employmentandlabourmarket/peopleinwork/employmentandemployeetypes/bulletins/uklabourmarket/october2026'
)
ON CONFLICT(id) DO UPDATE SET
  event_date = excluded.event_date,
  title = excluded.title,
  summary = excluded.summary,
  category = excluded.category,
  source_label = excluded.source_label,
  source_url = excluded.source_url,
  score_delta = NULL;

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_10_15',
  '2026-10-15',
  'August GDP grows 0.1%; three-month growth is 0.7%',
  'ONS estimates real GDP growth of 0.1% in August and 0.7% over the three months to August. Monthly production grows by 0.8%, services are flat and construction falls by 0.2%. These initial estimates are subject to revision.',
  'market',
  'ONS GDP monthly estimate, August 2026',
  'https://www.ons.gov.uk/economy/grossdomesticproductgdp/bulletins/gdpmonthlyestimateuk/august2026'
)
ON CONFLICT(id) DO UPDATE SET
  event_date = excluded.event_date,
  title = excluded.title,
  summary = excluded.summary,
  category = excluded.category,
  source_label = excluded.source_label,
  source_url = excluded.source_url,
  score_delta = NULL;

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_04_22',
  '2026-04-22',
  'March CPI inflation rises to 3.3%',
  'ONS publishes March CPI inflation of 3.3%, up from 3.0% in February. The bulletin is published ahead of the 30 April monetary-policy decision.',
  'fiscal',
  'ONS Consumer price inflation, March 2026',
  'https://www.ons.gov.uk/economy/inflationandpriceindices/bulletins/consumerpriceinflation/march2026'
)
ON CONFLICT(id) DO UPDATE SET
  event_date = excluded.event_date,
  title = excluded.title,
  summary = excluded.summary,
  category = excluded.category,
  source_label = excluded.source_label,
  source_url = excluded.source_url,
  score_delta = NULL;

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_04_08',
  '2026-04-08',
  'Two-week US–Israel–Iran ceasefire announced',
  'The UK Foreign Secretary welcomes the announcement of a two-week ceasefire and proposed US–Iran talks. The statement calls for the Strait of Hormuz to reopen; it does not establish that shipping has already returned to normal.',
  'geopolitical',
  'Foreign Secretary statement, 8 April 2026',
  'https://www.gov.uk/government/news/foreign-secretary-statement-ceasefire-in-the-middle-east-8-april'
)
ON CONFLICT(id) DO UPDATE SET
  event_date = excluded.event_date,
  title = excluded.title,
  summary = excluded.summary,
  category = excluded.category,
  source_label = excluded.source_label,
  source_url = excluded.source_url,
  score_delta = NULL;

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_03_03',
  '2026-03-03',
  'OBR Spring Forecast: £23.6bn headroom; 2026 growth at 1.1%',
  'The March OBR forecast puts current-budget headroom at £23.6 billion, compared with £21.7 billion in November 2025. Real GDP growth in 2026 is forecast at 1.1%. These are forecast-vintage figures, not current outturns.',
  'fiscal',
  'OBR Economic and fiscal outlook, March 2026',
  'https://obr.uk/efo/economic-and-fiscal-outlook-march-2026/'
)
ON CONFLICT(id) DO UPDATE SET
  event_date = excluded.event_date,
  title = excluded.title,
  summary = excluded.summary,
  category = excluded.category,
  source_label = excluded.source_label,
  source_url = excluded.source_url,
  score_delta = NULL;

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_02_28',
  '2026-02-28',
  'US and Israel strike Iran; Iran launches retaliatory strikes',
  'The UK Prime Minister confirms US and Israeli strikes on targets in Iran and subsequent Iranian strikes across the region. The UK says it played no role in the initial strikes. ',
  'geopolitical',
  'Prime Minister statement on Iran, 28 February 2026',
  'https://www.gov.uk/government/speeches/pm-statement-on-iran-28-february-2026'
)
ON CONFLICT(id) DO UPDATE SET
  event_date = excluded.event_date,
  title = excluded.title,
  summary = excluded.summary,
  category = excluded.category,
  source_label = excluded.source_label,
  source_url = excluded.source_url,
  score_delta = NULL;

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_02_12',
  '2026-02-05',
  'Bank of England holds Bank Rate at 3.75%, vote splits 5–4',
  'The MPC votes 5–4 to maintain Bank Rate at 3.75%; four members prefer a cut to 3.5%. The Bank says further easing will depend on the evolving inflation outlook.',
  'monetary',
  'Bank of England, February 2026 MPC',
  'https://www.bankofengland.co.uk/monetary-policy-summary-and-minutes/2026/february-2026'
)
ON CONFLICT(id) DO UPDATE SET
  event_date = excluded.event_date,
  title = excluded.title,
  summary = excluded.summary,
  category = excluded.category,
  source_label = excluded.source_label,
  source_url = excluded.source_url,
  score_delta = NULL;

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2025_11',
  '2025-11-26',
  'Autumn Budget: current-budget headroom at £21.7bn',
  'The Budget forecasts a £21.7 billion current-budget surplus in 2029–30, the stability-rule target year, and says the rule is met a year early. ',
  'fiscal',
  'HM Treasury, Budget 2025 speech',
  'https://www.gov.uk/government/speeches/budget-2025-speech'
)
ON CONFLICT(id) DO UPDATE SET
  event_date = excluded.event_date,
  title = excluded.title,
  summary = excluded.summary,
  category = excluded.category,
  source_label = excluded.source_label,
  source_url = excluded.source_url,
  score_delta = NULL;

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2025_06',
  '2025-06-23',
  'Modern Industrial Strategy published',
  'The government publishes its ten-year Modern Industrial Strategy and initial sector plans. The strategy covers eight growth sectors. ',
  'policy',
  'Department for Business and Trade, written ministerial statement',
  'https://questions-statements.parliament.uk/written-statements/detail/2025-06-23/hcws725'
)
ON CONFLICT(id) DO UPDATE SET
  event_date = excluded.event_date,
  title = excluded.title,
  summary = excluded.summary,
  category = excluded.category,
  source_label = excluded.source_label,
  source_url = excluded.source_url,
  score_delta = NULL;

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2025_03',
  '2025-03-26',
  'Spring Statement restores £9.9bn current-budget headroom',
  'Policy changes restore the forecast current-budget surplus to £9.9 billion in 2029–30. Before policy measures, the forecast had deteriorated to a £4.1 billion deficit. The post-policy headroom matches the Autumn 2024 margin.',
  'fiscal',
  'HM Treasury, Spring Statement 2025',
  'https://www.gov.uk/government/publications/spring-statement-2025-document/spring-statement-2025-html'
)
ON CONFLICT(id) DO UPDATE SET
  event_date = excluded.event_date,
  title = excluded.title,
  summary = excluded.summary,
  category = excluded.category,
  source_label = excluded.source_label,
  source_url = excluded.source_url,
  score_delta = NULL;

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2024_10',
  '2024-10-30',
  'First Reeves Budget: £9.9bn current-budget headroom',
  'The Budget introduces the stability and investment rules. The OBR forecasts a £9.9 billion current-budget surplus in the target year, 2029–30. Employer National Insurance rises and capital investment increases.',
  'fiscal',
  'HM Treasury, Autumn Budget 2024',
  'https://www.gov.uk/government/publications/autumn-budget-2024/autumn-budget-2024-html'
)
ON CONFLICT(id) DO UPDATE SET
  event_date = excluded.event_date,
  title = excluded.title,
  summary = excluded.summary,
  category = excluded.category,
  source_label = excluded.source_label,
  source_url = excluded.source_url,
  score_delta = NULL;

UPDATE timeline_events
SET summary = 'Headline CPI inflation is 2.9% in the year to July, up from 2.6% in June. ONS attributes the pickup to a sharp rise in gas prices following the July energy-price-cap change — the largest gas-price increase in almost four years — with housing and household services the largest upward contribution. Core CPI is unchanged at 2.6%. The reading sits below the Bank of England''s July projection of a 3.2% peak in 2026 Q4.'
WHERE id = 't_2026_08_19';
