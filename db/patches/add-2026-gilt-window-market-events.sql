-- Add six timeline events covering the market/gilt catalysts of the
-- mid-April → mid-July 2026 window: the late-April oil spike, the May
-- gilt-yield peak and relief rally, the June BoE hold and borrowing
-- overshoot, and the early-July renewed-tensions rebound. These annotate
-- the headline-chart moves between the political events already on the
-- timeline (local elections 07 May, Makerfield 18 Jun, PM resignation
-- 22 Jun). Editorial copy is factual and non-partisan; every event pins
-- to a primary or contemporaneous authoritative source. Figures verified
-- against the cited sources 2026-07-12; where third-party summaries
-- disagreed with the primary print (peak date of the 10-year high, the
-- size of the May borrowing overshoot) the primary source's figure is
-- used.
--
-- Apply:  cd apps/api && wrangler d1 execute tightrope_db --remote \
--           --file=../../db/patches/add-2026-gilt-window-market-events.sql
-- The public timeline is cache-stamped; entries appear when the API cache
-- TTL rolls (or purge via the ingest admin surface).

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_04_29',
  '2026-04-29',
  'Oil tops $118 as Hormuz blockade escalates',
  'Brent crude rises for an eighth straight day to top $118 a barrel after the US President pledges to blockade Iran until it agrees a nuclear deal, touching $126.41 the following day — the highest in four years. With the Strait of Hormuz (normally a conduit for around a fifth of global oil and gas) effectively shut, the energy shock feeds directly into UK inflation expectations and pares back priced-in Bank of England rate cuts.',
  'geopolitical',
  'CNBC (contemporaneous report)',
  'https://www.cnbc.com/2026/04/29/oil-prices-brent-wti-trump-iran.html'
);

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_05_15',
  '2026-05-15',
  '10-year gilt yield peaks at 5.14%, highest since 2008',
  'The 10-year gilt yield peaks at 5.137%, its highest since July 2008, with the 30-year touching 5.86% — territory last seen in 1998. The sell-off combines a global rout in long-dated government bonds with a UK-specific political risk premium: a cabinet resignation the day before and open speculation about a leadership challenge revive memories of 2022''s fiscal-credibility shock, and long maturities bear the brunt through higher term premia.',
  'market',
  'Reuters (via Yahoo Finance)',
  'https://uk.finance.yahoo.com/news/uk-10-yields-hit-highest-091911351.html'
);

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_05_22',
  '2026-05-22',
  'Gilt yields post biggest weekly drop since 2023',
  'Gilt yields fall the most in a week since late 2023 as the pressures of mid-May unwind together: Andy Burnham commits to the government''s existing fiscal rules, betting-market odds on a leadership change recede, and oil falls on optimism over US–Iran talks. The 10-year eases roughly 30 basis points from its peak toward 4.85% — a five-week low by 26 May — and the 30-year falls over 30 basis points on the week, while traders price one fewer rate hike for 2026.',
  'market',
  'CNBC (contemporaneous report)',
  'https://www.cnbc.com/2026/05/26/uk-gilt-yields-ease-political-drama-mellows-rate-hikes-ease.html'
);

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_06_18_boe_hold',
  '2026-06-18',
  'Bank of England holds Bank Rate at 3.75%',
  'The Monetary Policy Committee votes 7–2 to hold Bank Rate at 3.75%, with two members preferring a quarter-point rise. CPI inflation has eased to 2.8%, but the Committee expects it to rise later in the year as higher energy prices pass through — global energy costs have retreated since May yet remain above pre-conflict levels and volatile. The hold keeps the rate path data-dependent through an energy shock the MPC cannot look past.',
  'monetary',
  'Bank of England',
  'https://www.bankofengland.co.uk/monetary-policy-summary-and-minutes/2026/june-2026'
);

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_06_19',
  '2026-06-19',
  'May borrowing overshoots the OBR profile at £23.3bn',
  'Public sector net borrowing comes in at £23.3 billion for May — £5.6 billion above the OBR''s monthly profile, driven by higher-than-anticipated central government spending. Borrowing for the financial year to May reaches £46.3 billion against a £38.6 billion forecast. The overshoot lands in the middle of the leadership contest and sharpens the question of how much fiscal headroom survives to the autumn statement.',
  'fiscal',
  'Office for National Statistics',
  'https://www.ons.gov.uk/economy/governmentpublicsectorandtaxes/publicsectorfinance/bulletins/publicsectorfinances/may2026'
);

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_07_08',
  '2026-07-08',
  'Renewed US–Iran tensions push gilts to a four-week high',
  'Fresh US strikes and a declaration that the ceasefire is over send crude to two-week highs and reignite imported-inflation fears. The 10-year gilt yield climbs about 10 basis points on the week to print 4.95% on 9 July — its highest in four weeks — as money markets move to price at least one Bank of England rate hike by year-end, with roughly one-in-four odds of a second. The leadership transition due mid-month keeps a domestic risk premium in the curve.',
  'geopolitical',
  'Trading Economics (market report)',
  'https://tradingeconomics.com/united-kingdom/government-bond-yield/news/555346'
);
