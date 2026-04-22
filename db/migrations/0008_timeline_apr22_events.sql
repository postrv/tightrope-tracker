-- Add three timeline events covering 8–22 April 2026: ceasefire announcement,
-- Resolution Foundation headroom warning, and March CPI print.

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_04_22',
  '2026-04-22',
  'March CPI rises to 3.3%, BoE path under scrutiny',
  'ONS releases March 2026 CPI inflation data showing headline CPI at 3.3% YoY (up from ~3.0% in February), driven by lingering energy and petrol price effects from the Iran conflict period. Markets price in a more cautious BoE path ahead of the 30 April MPC decision; gilt yields stabilise but remain elevated.',
  'fiscal',
  'ONS Consumer price inflation',
  'https://www.ons.gov.uk/economy/inflationandpriceindices/bulletins/consumerpriceinflation/latest'
);

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_04_21',
  '2026-04-21',
  'Resolution Foundation: conflict could erase £16bn of headroom',
  'Resolution Foundation warns that a prolonged or severe Middle East conflict could erase up to £16bn of the Chancellor''s current-budget headroom — almost three-quarters of the March OBR cushion — via higher energy prices, inflation, and debt interest. Report highlights fiscal vulnerability even under the current ceasefire.',
  'fiscal',
  'Resolution Foundation',
  'https://www.resolutionfoundation.org/publications/'
);

INSERT INTO timeline_events (id, event_date, title, summary, category, source_label, source_url)
VALUES (
  't_2026_04_08',
  '2026-04-08',
  'US, Israel and Iran agree conditional ceasefire',
  'US, Israel and Iran agree a conditional two-week ceasefire; UK Foreign Secretary and international finance ministers welcome the de-escalation, citing restored Strait of Hormuz shipping and falling oil and gas prices. Initial market relief begins, setting the stage for sterling''s recovery to pre-war levels by 17 April.',
  'geopolitical',
  'Foreign Office / gov.uk',
  'https://www.gov.uk/government/organisations/foreign-commonwealth-development-office'
);
