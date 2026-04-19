import { describe, expect, it } from "vitest";
import { INDICATORS } from "./indicators.js";
import {
  historicalIndicatorsForPillar,
  liveOnlyIndicatorsForPillar,
  LIVE_ONLY_INDICATOR_IDS,
} from "./historicalSubset.js";

describe("historical subset helpers", () => {
  it("LIVE_ONLY_INDICATOR_IDS names the four editorial delivery milestones", () => {
    // These four live under the deliveryMilestones fixture adapter. They
    // carry `hasHistoricalSeries: false` because there is no defensible
    // time-series for "milestones hit this month" — the backfill pipeline
    // must exclude them from quorum math but the live recompute still
    // counts them. This guardrail surfaces if someone adds / removes a
    // fifth editorial indicator without updating the disclosure.
    expect(new Set(LIVE_ONLY_INDICATOR_IDS)).toEqual(new Set([
      "new_towns_milestones",
      "bics_rollout",
      "industrial_strategy",
      "smr_programme",
    ]));
  });

  it("every LIVE_ONLY entry is actually tagged hasHistoricalSeries: false", () => {
    for (const id of LIVE_ONLY_INDICATOR_IDS) {
      const def = INDICATORS[id];
      expect(def, `${id} should exist in the catalog`).toBeDefined();
      expect(def!.hasHistoricalSeries).toBe(false);
    }
  });

  it("every hasHistoricalSeries:false indicator is surfaced in LIVE_ONLY_INDICATOR_IDS", () => {
    // Prevents silent drift the other direction: if someone drops the
    // flag on another indicator, the disclosure needs to learn about it.
    const flagged = Object.values(INDICATORS)
      .filter((i) => i.hasHistoricalSeries === false)
      .map((i) => i.id)
      .sort();
    expect(flagged).toEqual([...LIVE_ONLY_INDICATOR_IDS].sort());
  });

  it("historicalIndicatorsForPillar excludes hasHistoricalSeries:false", () => {
    const delivery = historicalIndicatorsForPillar("delivery");
    const ids = delivery.map((d) => d.id);
    expect(ids).not.toContain("new_towns_milestones");
    expect(ids).not.toContain("bics_rollout");
    expect(ids).not.toContain("industrial_strategy");
    expect(ids).not.toContain("smr_programme");
    // Delivery still has housing_trajectory + planning_consents.
    expect(ids).toContain("housing_trajectory");
    expect(ids).toContain("planning_consents");
  });

  it("historicalIndicatorsForPillar returns every indicator for non-delivery pillars", () => {
    // Only delivery currently has live-only indicators; the rest of the
    // pillars match indicatorsForPillar 1:1 under both lenses.
    for (const pillar of ["market", "fiscal", "labour"] as const) {
      const histIds = historicalIndicatorsForPillar(pillar).map((i) => i.id).sort();
      const allIds = Object.values(INDICATORS)
        .filter((i) => i.pillar === pillar).map((i) => i.id).sort();
      expect(histIds).toEqual(allIds);
    }
  });

  it("liveOnlyIndicatorsForPillar lists only the delivery editorial four", () => {
    expect(liveOnlyIndicatorsForPillar("market").map((i) => i.id)).toEqual([]);
    expect(liveOnlyIndicatorsForPillar("fiscal").map((i) => i.id)).toEqual([]);
    expect(liveOnlyIndicatorsForPillar("labour").map((i) => i.id)).toEqual([]);
    const delivery = liveOnlyIndicatorsForPillar("delivery").map((i) => i.id);
    expect(new Set(delivery)).toEqual(new Set(LIVE_ONLY_INDICATOR_IDS));
  });
});
