-- Editorial disclosure for reviewed historical repairs performed through the
-- existing audited ingestion pipelines. No observation rows are edited here.
-- Canonical gilt rows ingested at 17:36:44.864Z; April Brent at 17:36:49.426Z.
INSERT OR IGNORE INTO corrections (
  id, published_at, affected_indicator, original_value, corrected_value, reason
) VALUES (
  '2026-10-28-historical-source-alignment',
  '2026-10-28T17:36:44.864Z',
  'gilt_10y, gilt_30y and brent_gbp historical observations',
  '84 canonical gilt inputs from 2 April to 31 May 2024 used legacy series values; eight April 2026 Brent dates were missing',
  '84 verified IUDMNZC/IUDLNZC observations at the canonical close and eight EIA/BoE pairs for 21–24 and 27–30 April 2026',
  'A comparison of stored canonical observations with the current official BoE history found 84 mismatches: 42 dates for each of the gilt indicators in April–May 2024. The audited historical pipeline added the verified 10-year nominal zero-coupon IUDMNZC and 20-year nominal zero-coupon IUDLNZC observations at 16:00 using overwrite=false. The legacy gilt_30y identifier remains a 20-year measure as documented. Older midnight representations remain in the raw history but no longer define the canonical baseline sample for those dates. Eight April Brent dates present in the official EIA table and paired BoE FX history were also backfilled without overwriting existing dates. This is a historical source/baseline correction, not a Budget market reaction. Earlier published score snapshots remain as published; comparisons spanning the repair include a data-processing change. Sources: https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&SeriesCodes=IUDMNZC%2CIUDLNZC&Datefrom=02%2FApr%2F2024&Dateto=31%2FMay%2F2024&UsingCodes=Y and https://www.eia.gov/dnav/pet/hist/RBRTED.htm . Publication-metadata limitation: ONS updateDate can represent a later revision, not first publication; stored ingested_at is last write time, not an immutable event-time archive.'
);
INSERT OR IGNORE INTO timeline_events (
  id, event_date, title, summary, category, source_label, source_url
) VALUES (
  't_2026_10_28_historical_source_corrections',
  '2026-10-28T17:36:44.864Z',
  'Historical source corrections: gilt series and Brent gaps',
  'Verified official-source history restored 84 canonical April–May 2024 gilt observations and eight missing April 2026 Brent observations. Older raw representations and published score snapshots remain. This baseline/data correction must not be interpreted as a Budget market reaction.',
  'methodology',
  'Tightrope source audit and public corrections log',
  'https://tightropetracker.uk/corrections'
);

INSERT INTO corrections (
  id, published_at, affected_indicator, original_value, corrected_value, reason
) VALUES (
  '2026-10-28-vacancies-common-period',
  '2026-10-28T17:47:55.565Z',
  'vacancies_per_unemployed',
  '0.4036214953271028 stamped August 2026: August vacancies 691 thousand divided by July unemployment 1712 thousand',
  '0.411214953271028 for July 2026: July vacancies 704 thousand divided by July unemployment 1712 thousand',
  'The live ONS adapter divided the independently latest vacancies and unemployment-level observations, which have different publication lags, and labelled the ratio with the later month. The corrected live calculation joins both source series on their reference period and uses the latest common period, matching historical-mode behaviour. This corrects the live ratio from a mixed August/July calculation to a matched July/July calculation. The corrected observation was written through the existing audited adapter; the superseded August-labelled raw row is retained for audit and excluded by current-snapshot/baseline selection. The following recompute moved the rounded headline from 39.0 to 39.1. This is a calculation/date-alignment correction, not new evidence of a Budget reaction. Earlier published score snapshots are retained as recorded. Sources: ONS AP2Y vacancies https://www.ons.gov.uk/employmentandlabourmarket/peopleinwork/employmentandemployeetypes/timeseries/ap2y/unem/data and MGSC unemployment https://www.ons.gov.uk/employmentandlabourmarket/peoplenotinwork/unemployment/timeseries/mgsc/lms/data .'
) ON CONFLICT(id) DO UPDATE SET reason=excluded.reason;
INSERT OR IGNORE INTO timeline_events (
  id, event_date, title, summary, category, source_label, source_url
) VALUES (
  't_2026_10_28_vacancies_common_period',
  '2026-10-28T17:47:55.565Z',
  'Calculation correction: vacancies ratio uses a common period',
  'The live vacancies/unemployment ratio now pairs July vacancies with July unemployment (0.4112), replacing an August/July mixture (0.4036). This is a calculation and reference-period correction, not an observed Budget reaction; earlier published score snapshots remain as recorded.',
  'methodology',
  'Tightrope calculation audit and ONS source series',
  'https://tightropetracker.uk/corrections'
);
