-- Close two holes the July–August recovery patch left: the 30 July MPC
-- (6–3 hold at 3.75%, July MPR) and the 19 August CPI print (2.9%).
--
-- Apply:  cd apps/api && wrangler d1 execute tightrope_db --remote \
--           --file=../../db/patches/add-2026-jul-aug-mpc-cpi-timeline-events.sql
-- Then purge the timeline (and score) cache:
--   curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
--     "https://ingest.tightropetracker.uk/admin/run?source=purge-cache"

INSERT OR IGNORE INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_07_30',
  '2026-07-30',
  'Bank of England holds Bank Rate at 3.75%, vote splits 6–3',
  'The Monetary Policy Committee votes 6–3 to maintain Bank Rate at 3.75%, with three members preferring a quarter-point rise to 4%. The accompanying July Monetary Policy Report projects CPI peaking at around 3.2% in 2026 Q4 as higher energy prices pass through. CPI has fallen to 2.6% since the previous meeting, further than expected, but the Committee judges inflation risks remain tilted to the upside while the Middle East conflict persists. Next decision 17 September.',
  'monetary',
  'Bank of England, July 2026 MPC',
  'https://www.bankofengland.co.uk/monetary-policy-summary-and-minutes/2026/july-2026'
);

INSERT OR IGNORE INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_08_19',
  '2026-08-19',
  'July CPI rises to 2.9% as the energy-price cap steps up',
  'Headline CPI inflation is 2.9% in the year to July, up from 2.6% in June. ONS attributes the pickup to a sharp rise in gas prices following the July energy-price-cap change — the largest gas-price increase in almost four years — with housing and household services the largest upward contribution. Core CPI is unchanged at 2.6%. The print is the first inflation release since the March 3.3% reading and sits below the Bank of England''s July projection of a 3.2% peak in 2026 Q4.',
  'fiscal',
  'ONS Consumer price inflation, July 2026',
  'https://www.ons.gov.uk/economy/inflationandpriceindices/bulletins/consumerpriceinflation/july2026'
);
