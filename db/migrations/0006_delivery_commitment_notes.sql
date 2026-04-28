-- Backfill `notes` for existing delivery_commitment rows so the Delivery
-- scorecard can render a primary-source pointer under each commitment even
-- when the `source_url` lands on a departmental homepage rather than a
-- deep document.
--
-- Idempotent: UPDATE matches by id; if a future migration adds or renames
-- a commitment, the seed file remains the source of truth via
-- packages/shared/src/deliveryCommitmentsSeed.ts.

UPDATE delivery_commitments
SET notes = 'Figures from MHCLG Live Tables 211 (net additions) and 123 (planning decisions). The OBR trajectory to 305k per year is in the March EFO supplementary tables.',
    source_label = 'MHCLG live tables'
WHERE id = 'housing_305k';

UPDATE delivery_commitments
SET notes = 'Taskforce interim report and designations list. First-spade status is tracked in quarterly DLUHC progress updates; we count only sites with confirmed development consent orders.',
    source_label = 'New Towns Taskforce'
WHERE id = 'new_towns';

UPDATE delivery_commitments
SET notes = 'Onboarded-firms count from DESNZ monthly BICS update letters and quarterly ministerial statements to the House. There is no single machine-readable dashboard yet; see the DESNZ homepage for the latest statement.',
    source_label = 'DESNZ (scheme page)'
WHERE id = 'bics_rollout';

UPDATE delivery_commitments
SET notes = 'Site shortlist and FID dates tracked via Great British Nuclear ministerial updates. Latest status is the most recent SMR programme announcement on the GBE page.',
    source_label = 'Great British Energy'
WHERE id = 'smr_fleet';

UPDATE delivery_commitments
SET notes = 'Search ''Planning and Infrastructure Bill'' on bills.parliament.uk for the stage-by-stage record and the Act text. Royal Assent date is authoritative on the Legislation.gov.uk entry for the Act.',
    source_label = 'UK Parliament Bills'
WHERE id = 'planning_bill';

UPDATE delivery_commitments
SET notes = 'Inactivity-due-to-long-term-sickness numbers come from ONS Labour Force Survey (series LF69, LFS: Econ. inactivity reasons: Long Term Sick: UK: 16-64). The policy target is set out in the DWP ''Get Britain Working'' white paper; the rolling figure is against that baseline.'
WHERE id = 'keep_britain_working';

UPDATE delivery_commitments
SET notes = 'Milestone status from the project''s quarterly updates. Spending profile cross-referenced against DESNZ annual report and OBR EFO Box on NPP programme costs.',
    source_label = 'Sizewell C project'
WHERE id = 'sizewell_c';

UPDATE delivery_commitments
SET notes = 'Queue-reform progress comes from NESO''s Connections Reform programme updates. Confirm via the most recent TMO4+ milestone report on the NESO site.',
    source_label = 'NESO (connections reform)'
WHERE id = 'grid_connections';
