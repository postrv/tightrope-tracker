-- Fix broken delivery commitment source URLs and stale labels in production D1.
-- These were corrected in deliveryCommitmentsSeed.ts (commit ab0b7ad) but the
-- production database was never re-seeded.

UPDATE delivery_commitments
SET source_url   = 'https://www.gov.uk/government/statistical-data-sets/live-tables-on-house-building',
    source_label = 'MHCLG live tables',
    notes        = 'Figures from MHCLG Live Tables 211 (net additions) and 123 (planning decisions). The OBR trajectory to 305k per year is in the March EFO supplementary tables.'
WHERE id = 'housing_305k';

UPDATE delivery_commitments
SET source_url   = 'https://www.gov.uk/government/groups/the-new-towns-taskforce',
    source_label = 'New Towns Taskforce',
    notes        = 'Taskforce interim report and designations list. First-spade status is tracked in quarterly DLUHC progress updates; we count only sites with confirmed development consent orders.'
WHERE id = 'new_towns';

UPDATE delivery_commitments
SET source_url   = 'https://www.legislation.gov.uk/ukpga/2025/34/enacted',
    source_label = 'Planning & Infrastructure Act 2025',
    notes        = 'Full enacted text on legislation.gov.uk. Stage-by-stage parliamentary record at bills.parliament.uk/bills/3946. Royal Assent 18 December 2025.'
WHERE id = 'planning_bill';

UPDATE delivery_commitments
SET source_url   = 'https://www.gov.uk/government/organisations/department-for-work-pensions',
    source_label = 'DWP',
    notes        = 'Inactivity-due-to-long-term-sickness numbers come from ONS Labour Force Survey (series LF69, LFS: Econ. inactivity reasons: Long Term Sick: UK: 16-64). The policy target is set out in the DWP ''Get Britain Working'' white paper; the rolling figure is against that baseline.'
WHERE id = 'keep_britain_working';

-- Also sync the remaining labels and notes that were enriched in the seed
-- but never made it to D1.

UPDATE delivery_commitments
SET source_label = 'DESNZ (scheme page)',
    notes        = 'Onboarded-firms count from DESNZ monthly BICS update letters and quarterly ministerial statements to the House. There is no single machine-readable dashboard yet; see the DESNZ homepage for the latest statement.'
WHERE id = 'bics_rollout';

UPDATE delivery_commitments
SET source_label = 'Great British Energy',
    notes        = 'Site shortlist and FID dates tracked via Great British Nuclear ministerial updates. Latest status is the most recent SMR programme announcement on the GBE page.'
WHERE id = 'smr_fleet';

UPDATE delivery_commitments
SET source_label = 'Sizewell C project',
    notes        = 'Milestone status from the project''s quarterly updates. Spending profile cross-referenced against DESNZ annual report and OBR EFO Box on NPP programme costs.'
WHERE id = 'sizewell_c';

UPDATE delivery_commitments
SET source_label = 'NESO (connections reform)',
    notes        = 'Queue-reform progress comes from NESO''s Connections Reform programme updates. Confirm via the most recent TMO4+ milestone report on the NESO site.'
WHERE id = 'grid_connections';
