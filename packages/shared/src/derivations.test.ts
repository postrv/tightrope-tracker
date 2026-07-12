import { describe, expect, it } from "vitest";
import {
  HOUSING_TRAJECTORY_ANNUAL_TARGET,
  PLANNING_CONSENTS_QUARTERLY_BASELINE_2019,
  deriveHousingTrajectory,
  derivePlanningConsents,
} from "./derivations.js";

describe("derivations — MHCLG housing formulas", () => {
  it("constants match the documented methodology", () => {
    // These are the documented denominators from housing-history.json's
    // methodology block. Changing either is a methodology change: it needs a
    // corrections-log entry and a fixture re-derivation, not a quiet edit.
    expect(HOUSING_TRAJECTORY_ANNUAL_TARGET).toBe(300_000);
    expect(PLANNING_CONSENTS_QUARTERLY_BASELINE_2019).toBe(11_500);
  });

  it("deriveHousingTrajectory matches the hand-computed 2026 Q1 fixture value", () => {
    // housing.json: raw_completions_sa 37,170 → 49.6 (1 dp hand rounding).
    expect(deriveHousingTrajectory(37_170)).toBeCloseTo(49.56, 2);
  });

  it("derivePlanningConsents matches the hand-computed 2026 Q1 fixture value", () => {
    // housing.json: 900 major + 5,800 minor = 6,700 → 58.3 (1 dp hand rounding).
    expect(derivePlanningConsents(6_700)).toBeCloseTo(58.26, 2);
  });

  it("is linear in the raw component (no hidden rounding)", () => {
    expect(deriveHousingTrajectory(75_000)).toBe(100);
    expect(derivePlanningConsents(11_500)).toBe(100);
    expect(deriveHousingTrajectory(0)).toBe(0);
  });
});
