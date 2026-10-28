-- The timestamp is the tracker's standard London cash-close convention.
-- LSE supplies the official closing DATE; this does not assert an exact
-- auction publication time or attribute the full-session move to the Budget.
INSERT OR IGNORE INTO timeline_events (
  id, event_date, title, summary, category, source_label, source_url
) VALUES (
  't_2026_10_28_housebuilder_official_close',
  '2026-10-28T16:30:00Z',
  '28 October close: housebuilders fall 3.2 index points',
  'The fixed five-company housebuilder price index fell from 55.8 to 52.6, using official LSE closing prices for Persimmon, Barratt Redrow, Taylor Wimpey, Berkeley and Vistry. All five quotes identify 28 October, GBX and a closed session; the previous closes reproduce the retained 55.8 reference. The OFF_CLOSE field is used, not the last trade. The 16:30 UTC marker is the tracker''s standard cash-close convention; LSE''s source gives the closing date rather than a verified auction publication time. These full-session price changes are not a total-return measure and do not isolate the Budget''s effect. The observation was ingested at 18:33 UTC, so earlier recorded composite scores do not yet include it.',
  'market',
  'London Stock Exchange official closing quotes — all-five archived evidence',
  'https://github.com/postrv/tightrope-tracker/blob/main/packages/data-sources/src/fixtures/lse-housebuilders-2026-10-28/manifest.json'
);
