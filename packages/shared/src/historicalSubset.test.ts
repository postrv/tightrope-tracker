import { describe, expect, it } from "vitest";
import { INDICATORS } from "./indicators.js";
import {
  historicalIndicatorsForPillar,
  liveOnlyIndicatorsForPillar,
  LIVE_ONLY_INDICATOR_IDS,
} from "./historicalSubset.js";

describe("historical subset helpers", () => {
  it("LIVE_ONLY_INDICATOR_IDS names every indicator without a defensible historical series", () => {
    // Two reasons for exclusion currently exist:
    //   1. Editorial judgement (the four delivery milestones) — backfilling
    //      would invent assessments never made at the time.
    //   2. No historical endpoint (DMO ilg_share / issuance_long_share) —
    //      the D1A feed only exposes today's snapshot; the archived UI is
    //      not machine-addressable.
    // This guardrail surfaces if someone adds / removes an indicator
    // without updating the disclosure.
    expect(new Set(LIVE_ONLY_INDICATOR_IDS)).toEqual(new Set([
      "new_towns_milestones",
      "bics_rollout",
      "industrial_strategy",
      "smr_programme",
      "ilg_share",
      "issuance_long_share",
    ]));
  });

  it("every live-only indicator carries a non-empty historicalExclusionReason", () => {
    // The methodology page surfaces these reasons verbatim. Missing
    // reasons would render blank cells, which is the credibility hit the
    // disclosure is there to prevent.
    for (const id of LIVE_ONLY_INDICATOR_IDS) {
      const def = INDICATORS[id];
      expect(def, `${id} should exist in the catalog`).toBeDefined();
      expect(def!.historicalExclusionReason, `${id} reason`).toBeTruthy();
      expect(
        (def!.historicalExclusionReason ?? "").length,
        `${id} reason length`,
      ).toBeGreaterThanOrEqual(30);
    }
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

  it("historicalIndicatorsForPillar excludes hasHistoricalSeries:false from delivery and fiscal", () => {
    const delivery = historicalIndicatorsForPillar("delivery").map((d) => d.id);
    expect(delivery).not.toContain("new_towns_milestones");
    expect(delivery).not.toContain("bics_rollout");
    expect(delivery).not.toContain("industrial_strategy");
    expect(delivery).not.toContain("smr_programme");
    // Delivery still has housing_trajectory + planning_consents.
    expect(delivery).toContain("housing_trajectory");
    expect(delivery).toContain("planning_consents");

    const fiscal = historicalIndicatorsForPillar("fiscal").map((d) => d.id);
    // DMO indicators have no machine-addressable historical feed — the
    // D1A XML only exposes today's snapshot. They must be excluded from
    // backfill quorum, otherwise historical days silently score with
    // fewer observations than the denominator expects.
    expect(fiscal).not.toContain("ilg_share");
    expect(fiscal).not.toContain("issuance_long_share");
    // Fiscal still has the ONS PSF + OBR EFO indicators.
    expect(fiscal).toContain("borrowing_outturn");
    expect(fiscal).toContain("cb_headroom");
  });

  it("historicalIndicatorsForPillar returns every indicator for market + labour (no live-only)", () => {
    // Only delivery and fiscal currently have live-only indicators; the
    // other pillars match indicatorsForPillar 1:1 under both lenses.
    for (const pillar of ["market", "labour"] as const) {
      const histIds = historicalIndicatorsForPillar(pillar).map((i) => i.id).sort();
      const allIds = Object.values(INDICATORS)
        .filter((i) => i.pillar === pillar).map((i) => i.id).sort();
      expect(histIds).toEqual(allIds);
    }
  });

  it("liveOnlyIndicatorsForPillar lists DMO on fiscal and editorial four on delivery", () => {
    expect(liveOnlyIndicatorsForPillar("market").map((i) => i.id)).toEqual([]);
    expect(liveOnlyIndicatorsForPillar("labour").map((i) => i.id)).toEqual([]);

    const fiscal = liveOnlyIndicatorsForPillar("fiscal").map((i) => i.id);
    expect(new Set(fiscal)).toEqual(new Set(["ilg_share", "issuance_long_share"]));

    const delivery = liveOnlyIndicatorsForPillar("delivery").map((i) => i.id);
    expect(new Set(delivery)).toEqual(new Set([
      "new_towns_milestones",
      "bics_rollout",
      "industrial_strategy",
      "smr_programme",
    ]));
  });
});
