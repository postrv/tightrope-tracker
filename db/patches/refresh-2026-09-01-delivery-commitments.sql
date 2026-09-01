-- Realign public delivery-scorecard rows with the 2026-09-01 currency
-- audit. The live housing indicator has been on Q1 2026 since the June
-- MHCLG release; BICS is an application scheme opening 1 Oct 2026 (not a
-- live 8,140-firm onboarding count); Wylfa/Gwyndod was confirmed and
-- contracted in Nov 2025 / Apr 2026; new-towns final designations due
-- "later summer 2026" have not published; Keep Britain Working tracks
-- the Apr–Jun 2026 LF69 print.
--
-- Apply:
--   cd apps/api && wrangler d1 execute tightrope_db --remote \
--     --file=../../db/patches/refresh-2026-09-01-delivery-commitments.sql
-- Then purge the delivery (and score) cache:
--   curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
--     "https://ingest.tightropetracker.uk/admin/run?source=purge-cache"

UPDATE delivery_commitments
SET latest = 'Live indicator: Q1 2026 completions × 4 = 148,680 vs 300k OBR working assumption (49.6%). Annual NAD FY25/26: 199,500 vs 305k Labour target (65%).',
    notes = 'Two complementary measures of housing delivery. (1) The live indicator uses ''Completions, seasonally adjusted'' from the MHCLG Housing supply quarterly release — a quarterly cadence we annualise (×4) and compare against the 300,000-per-year OBR working assumption documented in the EFO supplementary tables. Q1 2026 SA completions were 37,170. (2) The annual headline figure is ''Net additional dwellings'' from the same release''s NAD estimates (FY25/26 199,500; FY24/25 restated 208,600). The 305k-by-2030/31 path target is the Labour Government''s headline pledge; OBR''s 300k working assumption is what the live indicator benchmarks against to keep continuity with pre-Labour trajectory analysis. Showing both because they tell the same story at different sampling rates and at slightly different scope.',
    updated_at = '2026-09-01T12:00:00.000Z'
WHERE id = 'housing_305k';

UPDATE delivery_commitments
SET latest = '7 sites shortlisted; consultation closed 19 May 2026. Final designations (due summer 2026) not yet published. 0 of 7 first-spade.',
    target = 'Target: all designated 2026',
    status = 'slipping',
    source_url = 'https://www.gov.uk/government/consultations/new-towns-draft-programme',
    source_label = 'New Towns Draft Programme consultation',
    notes = 'MHCLG New Towns Draft Programme consultation (23 March – 19 May 2026) named seven preferred locations. The consultation page is still analysing feedback as of 1 September 2026; final designations were originally expected later summer 2026. First-spade status is tracked in quarterly MHCLG progress updates; we count only sites with confirmed development consent orders.',
    updated_at = '2026-09-01T12:00:00.000Z'
WHERE id = 'new_towns';

UPDATE delivery_commitments
SET latest = 'Final design covers >10,000 manufacturers; applications open 1 Oct 2026, relief from Apr 2027',
    target = 'Up to 25% electricity relief from Apr 2027',
    source_url = 'https://www.gov.uk/government/news/government-cuts-electricity-bill-for-10000-manufacturers-in-boost-for-uk-competitiveness',
    source_label = 'HMT/DBT BICS final design (16 Apr 2026)',
    notes = 'BICS is an eligibility/application scheme, not a live onboarding dashboard. The 16 April 2026 government response expanded eligibility from ~7,000 to over 10,000 manufacturers. Applications open 1 October 2026; exemptions start April 2027 with a one-off payment covering April 2026–March 2027. Tracked against the 16 April 2026 announcement and subsequent eligibility-list updates.',
    updated_at = '2026-09-01T12:00:00.000Z'
WHERE id = 'bics_rollout';

UPDATE delivery_commitments
SET latest = 'Wylfa (Gwyndod, Ynys Môn) confirmed Nov 2025; site-specific design contract signed 13 Apr 2026. FID still 2029.',
    target = 'First site selected — delivered; FID 2029',
    status = 'on_track',
    source_url = 'https://www.gov.uk/government/news/great-british-energy-nuclear-and-rolls-royce-smr-sign-contract',
    source_label = 'GBE-Nuclear / Rolls-Royce SMR contract',
    notes = 'Site confirmation (November 2025) and the 13 April 2026 Great British Energy – Nuclear / Rolls-Royce SMR site-specific design contract. The site was renamed Gwyndod in June 2026. Final investment decision remains 2029; first-steel 2030.',
    updated_at = '2026-09-01T12:00:00.000Z'
WHERE id = 'smr_fleet';

UPDATE delivery_commitments
SET latest = '2.77m in Apr–Jun 2026, effectively unchanged from 2.80m at launch',
    updated_at = '2026-09-01T12:00:00.000Z'
WHERE id = 'keep_britain_working';

SELECT id, latest, status, source_url
FROM delivery_commitments
WHERE id IN ('housing_305k', 'new_towns', 'bics_rollout', 'smr_fleet', 'keep_britain_working')
ORDER BY id;
