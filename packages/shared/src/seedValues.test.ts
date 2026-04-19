import { describe, expect, it } from "vitest";
import { CURRENT_SEED_VALUES } from "./seedValues.js";
import { INDICATORS } from "./indicators.js";

/**
 * Plausibility ranges keyed by indicator id. Deliberately loose — the point
 * is to catch magnitude mistakes (e.g. a MoM-% value leaking into an
 * index-scale indicator), not to assert correctness to the basis point.
 * A real observation falling outside this range means the indicator itself
 * is probably miscategorised.
 */
const PLAUSIBLE_RANGE: Record<string, readonly [number, number]> = {
  // Market — rates and FX
  gilt_10y: [0, 10],
  gilt_30y: [0, 10],
  gbp_usd: [0.9, 2.0],
  gbp_twi: [60, 120],
  sonia_12m: [0, 8],
  gas_m1: [20, 400],
  ftse_250: [5000, 40000],
  breakeven_5y: [0, 8],
  breakeven_10y: [0, 8],
  gilt_il_10y_real: [-2, 5],
  brent_gbp: [20, 200],
  housebuilder_idx: [30, 200],
  services_pmi: [30, 70],
  consumer_confidence: [-50, 30],
  rics_price_balance: [-80, 80],
  // Fiscal
  cb_headroom: [-100, 100],
  psnfl_trajectory: [-5, 5],
  borrowing_outturn: [-40, 40],
  debt_interest: [0, 15],
  ilg_share: [0, 40],
  issuance_long_share: [10, 60],
  // Labour
  inactivity_rate: [15, 30],
  inactivity_health: [1, 5],
  unemployment: [2, 10],
  vacancies_per_unemployed: [0.2, 3.0],
  // AWE regular-pay index — guards the payroll_mom vintage regression.
  // Pre-2015 values land ~70, current ~230. Anything below 50 is the old
  // MoM-% vintage leaking back in.
  payroll_mom: [50, 500],
  real_regular_pay: [-10, 15],
  mortgage_2y_fix: [0.5, 12],
  dd_failure_rate: [0, 5],
  // Delivery
  housing_trajectory: [0, 150],
  planning_consents: [0, 200],
  new_towns_milestones: [0, 100],
  bics_rollout: [0, 100],
  industrial_strategy: [0, 100],
  smr_programme: [0, 100],
};

describe("CURRENT_SEED_VALUES", () => {
  it("has exactly one entry for every defined indicator", () => {
    const indicatorIds = Object.keys(INDICATORS).sort();
    const seedIds = Object.keys(CURRENT_SEED_VALUES).sort();
    expect(seedIds).toEqual(indicatorIds);
  });

  it("has an explicit plausibility range covering every indicator", () => {
    const indicatorIds = Object.keys(INDICATORS).sort();
    const rangeIds = Object.keys(PLAUSIBLE_RANGE).sort();
    // A missing range here would mean a new indicator landed without a
    // test-author ever thinking about its scale. Force that decision.
    expect(rangeIds).toEqual(indicatorIds);
  });

  it.each(Object.keys(INDICATORS).map((id) => [id] as const))(
    "%s seed value is within the plausible range for its unit",
    (id) => {
      const value = CURRENT_SEED_VALUES[id];
      const [lo, hi] = PLAUSIBLE_RANGE[id]!;
      expect(value, `${id} seed ${value} falls outside plausible range [${lo}, ${hi}] for unit '${INDICATORS[id]!.unit}'`).toBeGreaterThanOrEqual(lo);
      expect(value, `${id} seed ${value} falls outside plausible range [${lo}, ${hi}] for unit '${INDICATORS[id]!.unit}'`).toBeLessThanOrEqual(hi);
    },
  );

  it("payroll_mom is an index-scale value (regression from AWE relabel)", () => {
    // The indicator was historically labelled "PAYE payroll MoM %" but the
    // upstream K54L series has always been an AWE regular-pay index (~230).
    // If this ever flips back below 50 the pre-fix MoM vintage has returned,
    // and the historical chart will show a ~130x step at the live boundary.
    expect(CURRENT_SEED_VALUES.payroll_mom).toBeGreaterThan(100);
  });
});
