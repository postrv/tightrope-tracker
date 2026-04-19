-- 0004_cleanup_legacy_payroll_vintage.sql
-- Targeted cleanup for the payroll_mom vintage mix.
--
-- Context: until commit 83b6c6f ("Correct PSF series codes and truth-label
-- the AWE regular-pay indicator") the seed generator wrote `payroll_mom`
-- at -0.02, treating the indicator as a PAYE payroll MoM %. The upstream
-- series (ONS K54L) has always been the AWE whole-economy regular-pay
-- INDEX, publishing values ~230. The mismatch meant that any D1 instance
-- seeded before that commit carried `seed_payroll_mom*` rows at MoM-%
-- scale. Once a live ingestion fetched the same indicator at index scale,
-- the sparkline and historical chart developed a ~130x step change at the
-- live/seed boundary.
--
-- The safe removal criterion is:
--   - indicator_id = 'payroll_mom'
--   - payload_hash LIKE 'seed%'              (seed-generator-tagged rows)
--   - value < 10                             (pre-fix MoM-% scale; any real
--                                             index-scale reading is >= 70
--                                             back to 2000, >= 200 post-2023)
--
-- The value filter is what keeps the migration safe: a post-fix seed row
-- (`payroll_mom=232.8`) has value > 10 and is preserved. A live adapter
-- write never uses a seed_* payload_hash, so production observations are
-- untouched regardless of their value.
--
-- Idempotent: once the pre-fix rows are gone, re-running this migration
-- deletes zero rows.
DELETE FROM indicator_observations
WHERE indicator_id = 'payroll_mom'
  AND payload_hash LIKE 'seed%'
  AND value < 10;
