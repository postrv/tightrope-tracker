/**
 * Drift-guard: the hand-computed values in the MHCLG housing fixtures must
 * match the shared derivation formulas applied to their stored raw
 * components. The formulas lived only as prose in housing-history.json's
 * methodology block until 2026-07; packages/shared/src/derivations.ts is now
 * their code home (the curator's derived-indicator capture computes with
 * them), and this test pins the fixtures to that single source of truth —
 * an editor who updates a value without its raw component (or vice versa),
 * or who quietly changes a denominator, fails CI here.
 *
 * Tolerance 0.05: fixture values are hand-rounded to 1 dp (worst observed
 * drift across the history set is 0.048).
 */
import { describe, expect, it } from "vitest";
import { deriveHousingTrajectory, derivePlanningConsents } from "@tightrope/shared";
import housing from "./housing.json" with { type: "json" };
import housingHistory from "./housing-history.json" with { type: "json" };

const TOLERANCE = 0.05;

interface Component {
  value: number | null;
  raw_completions_sa?: number;
  raw_decisions_granted?: number;
}
interface HistoryPoint {
  period?: string;
  observed_at: string;
  housing_trajectory?: Component;
  planning_consents?: Component;
}

describe("housing fixtures match the shared derivation formulas", () => {
  it("housing.json (live) — housing_trajectory derives from raw_completions_sa", () => {
    const t = (housing as { housing_trajectory: Component }).housing_trajectory;
    expect(t.raw_completions_sa, "live fixture must carry its raw component").toBeTypeOf("number");
    expect(Math.abs(t.value! - deriveHousingTrajectory(t.raw_completions_sa!))).toBeLessThanOrEqual(TOLERANCE);
  });

  it("housing.json (live) — planning_consents derives from raw_decisions_granted", () => {
    const c = (housing as { planning_consents: Component }).planning_consents;
    expect(c.raw_decisions_granted, "live fixture must carry its raw component").toBeTypeOf("number");
    expect(Math.abs(c.value! - derivePlanningConsents(c.raw_decisions_granted!))).toBeLessThanOrEqual(TOLERANCE);
  });

  it("housing-history.json — every valued point derives from its raw component", () => {
    const points = (housingHistory as { points: HistoryPoint[] }).points;
    expect(points.length).toBeGreaterThan(0);
    for (const p of points) {
      const label = p.period ?? p.observed_at;
      const t = p.housing_trajectory;
      if (t && t.value !== null && t.value !== undefined) {
        expect(t.raw_completions_sa, `${label}: housing_trajectory value without raw_completions_sa`).toBeTypeOf("number");
        expect(
          Math.abs(t.value - deriveHousingTrajectory(t.raw_completions_sa!)),
          `${label}: housing_trajectory ${t.value} drifts from formula on ${t.raw_completions_sa}`,
        ).toBeLessThanOrEqual(TOLERANCE);
      }
      const c = p.planning_consents;
      if (c && c.value !== null && c.value !== undefined) {
        expect(c.raw_decisions_granted, `${label}: planning_consents value without raw_decisions_granted`).toBeTypeOf("number");
        expect(
          Math.abs(c.value - derivePlanningConsents(c.raw_decisions_granted!)),
          `${label}: planning_consents ${c.value} drifts from formula on ${c.raw_decisions_granted}`,
        ).toBeLessThanOrEqual(TOLERANCE);
      }
    }
  });
});
