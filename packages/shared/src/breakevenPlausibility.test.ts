import { describe, expect, it } from "vitest";
import { checkPlausibility } from "./plausibility.js";

describe("negative but valid BoE breakeven observations", () => {
  it("accepts the verified 1 August 2024 nominal-minus-real value", () => {
    expect(checkPlausibility({ indicatorId: "breakeven_5y", value: -0.03139999999999965, observedAt: "2024-08-01T16:00:00Z" }).ok).toBe(true);
  });
  it("retains magnitude and daily-jump protection", () => {
    expect(checkPlausibility({ indicatorId: "breakeven_5y", value: -2.1, observedAt: "2024-08-01T16:00:00Z" }).ok).toBe(false);
    expect(checkPlausibility({ indicatorId: "breakeven_5y", value: -1, observedAt: "2024-08-01T16:00:00Z", previous: { value: 1, observedAt: "2024-07-31T16:00:00Z" } }).ok).toBe(false);
  });
});
