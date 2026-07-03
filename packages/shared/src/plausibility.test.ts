import { describe, expect, it } from "vitest";
import { PLAUSIBILITY, checkPlausibility } from "./plausibility.js";
import { INDICATORS } from "./indicators.js";
import { CURRENT_SEED_VALUES } from "./seedValues.js";

describe("PLAUSIBILITY registry", () => {
  it("has exactly one entry for every defined indicator", () => {
    expect(Object.keys(PLAUSIBILITY).sort()).toEqual(Object.keys(INDICATORS).sort());
  });

  it("every bound is well-formed (min < max, positive jump rate)", () => {
    for (const [id, b] of Object.entries(PLAUSIBILITY)) {
      expect(b.min, `${id} min < max`).toBeLessThan(b.max);
      expect(b.maxJumpPerDay, `${id} maxJumpPerDay > 0`).toBeGreaterThan(0);
    }
  });

  it("every seed value clears its own min/max (seed↔plausibility can't diverge)", () => {
    for (const [id, value] of Object.entries(CURRENT_SEED_VALUES)) {
      const res = checkPlausibility({ indicatorId: id, value, observedAt: "2026-07-03T00:00:00Z" });
      expect(res.ok, `${id} seed ${value} tripped ${res.bound}: ${res.detail}`).toBe(true);
    }
  });
});

describe("checkPlausibility — range gate", () => {
  it("passes a value inside the band", () => {
    expect(checkPlausibility({ indicatorId: "gilt_10y", value: 4.8, observedAt: "2026-07-03T00:00:00Z" }).ok).toBe(true);
  });

  it("quarantines a value above max", () => {
    const res = checkPlausibility({ indicatorId: "gilt_10y", value: 42, observedAt: "2026-07-03T00:00:00Z" });
    expect(res.ok).toBe(false);
    expect(res.bound).toBe("max");
  });

  it("quarantines a value below min", () => {
    const res = checkPlausibility({ indicatorId: "gbp_usd", value: 0.2, observedAt: "2026-07-03T00:00:00Z" });
    expect(res.ok).toBe(false);
    expect(res.bound).toBe("min");
  });

  it("quarantines a non-finite value", () => {
    const res = checkPlausibility({ indicatorId: "gilt_10y", value: Number.NaN, observedAt: "2026-07-03T00:00:00Z" });
    expect(res.ok).toBe(false);
    expect(res.bound).toBe("max");
  });

  it("fails open for an indicator with no configured bound", () => {
    expect(checkPlausibility({ indicatorId: "not_an_indicator", value: 1e9, observedAt: "2026-07-03T00:00:00Z" }).ok).toBe(true);
  });

  // The 2026-04-29 audit's denominator-misalignment class: a raw MHCLG count
  // leaked in where a percentage-of-baseline belonged.
  it("catches the denominator-misalignment class (planning_consents raw count)", () => {
    // planning_consents should be ~58 (% of baseline); the raw
    // decisions-granted count 6700 must be quarantined.
    const res = checkPlausibility({ indicatorId: "planning_consents", value: 6700, observedAt: "2026-03-31T00:00:00Z" });
    expect(res.ok).toBe(false);
    expect(res.bound).toBe("max");
  });

  it("catches the denominator-misalignment class (housing_trajectory raw completions)", () => {
    const res = checkPlausibility({ indicatorId: "housing_trajectory", value: 37170, observedAt: "2026-03-31T00:00:00Z" });
    expect(res.ok).toBe(false);
    expect(res.bound).toBe("max");
  });
});

describe("checkPlausibility — jump gate", () => {
  it("passes a normal day-over-day gilt move", () => {
    const res = checkPlausibility({
      indicatorId: "gilt_10y",
      value: 4.9,
      observedAt: "2026-07-03T00:00:00Z",
      previous: { value: 4.8, observedAt: "2026-07-02T00:00:00Z" },
    });
    expect(res.ok).toBe(true);
  });

  it("quarantines an implausible same-gap jump", () => {
    const res = checkPlausibility({
      indicatorId: "gilt_10y",
      value: 9.5,
      observedAt: "2026-07-03T00:00:00Z",
      previous: { value: 4.8, observedAt: "2026-07-02T00:00:00Z" }, // Δ4.7 in one day, max 0.8/day
    });
    expect(res.ok).toBe(false);
    expect(res.bound).toBe("maxJumpPerDay");
  });

  it("scales the allowance by the gap: a monthly print's large move passes", () => {
    // services_pmi moves 6 points across a ~30-day gap — well inside
    // 0.6/day × 30 = 18.
    const res = checkPlausibility({
      indicatorId: "services_pmi",
      value: 54,
      observedAt: "2026-06-30T00:00:00Z",
      previous: { value: 48, observedAt: "2026-05-31T00:00:00Z" },
    });
    expect(res.ok).toBe(true);
  });

  it("skips the jump gate on the first observation (no previous)", () => {
    expect(checkPlausibility({ indicatorId: "gilt_10y", value: 4.8, observedAt: "2026-07-03T00:00:00Z" }).ok).toBe(true);
  });
});
