/**
 * Current-day bootstrap values for every declared indicator, used by the seed
 * generator (`db/seed/generate.ts`) to pre-populate a fresh D1 instance
 * before the first live ingestion run.
 *
 * These are hand-calibrated starting points. Live adapters overwrite them on
 * the first successful fetch; the seed only matters for "first boot" state
 * and for any indicator whose adapter is editorial/fixture-only.
 *
 * ## Two invariants enforced by `seedValues.test.ts`
 *
 * 1. Completeness — every entry in `INDICATORS` must have a seed value. If a
 *    new indicator is added without one, `db/seed/generate.ts` will throw at
 *    row-emission time; the test catches it earlier.
 * 2. Plausibility — every seed value must fall inside the magnitude range
 *    that the indicator's unit would realistically produce. This catches the
 *    class of bug that affected `payroll_mom` in early 2026: the upstream
 *    series (K54L AWE regular-pay index) emits ~230-scale index values, but
 *    the seed had a MoM-% value of `-0.02`, producing a ~130× step change
 *    between the seeded history and the first real fetch. The test asserts
 *    index-scale values live in `[50, 500]` for `payroll_mom` specifically,
 *    so a return to the old vintage fails loudly.
 */
export const CURRENT_SEED_VALUES: Record<string, number> = {
  // Market pillar
  gilt_10y: 4.78,
  gilt_30y: 5.73,
  gbp_usd: 1.2418,
  gbp_twi: 78.4,
  sonia_12m: 3.92,
  gas_m1: 118.0,
  ftse_250: 19842,
  breakeven_5y: 3.2,
  breakeven_10y: 3.4,
  gilt_il_10y_real: 1.2,
  brent_gbp: 65.65,
  housebuilder_idx: 71.7,
  services_pmi: 50.4,
  consumer_confidence: -19,
  rics_price_balance: 8,
  // Fiscal pillar
  cb_headroom: 23.6,
  psnfl_trajectory: 0.42,
  borrowing_outturn: 4.1,
  debt_interest: 2.7,
  ilg_share: 22.1,
  issuance_long_share: 29.6,
  // Labour pillar
  inactivity_rate: 20.7,
  inactivity_health: 2.81,
  unemployment: 4.6,
  vacancies_per_unemployed: 0.82,
  // AWE regular-pay index (2015=100). MUST be an index-scale value — a MoM%
  // value (~-0.02) here would produce a ~130x sparkline step at the live
  // boundary. Enforced by seedValues.test.ts.
  payroll_mom: 232.8,
  real_regular_pay: 0.7,
  mortgage_2y_fix: 5.84,
  dd_failure_rate: 0.88,
  // Delivery pillar
  housing_trajectory: 72.6,
  planning_consents: 88.3,
  new_towns_milestones: 68.0,
  bics_rollout: 81.4,
  industrial_strategy: 74.0,
  smr_programme: 62.0,
};
