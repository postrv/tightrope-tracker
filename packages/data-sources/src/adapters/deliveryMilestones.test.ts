import { describe, expect, it } from "vitest";
import { deliveryMilestonesAdapter } from "./deliveryMilestones.js";

describe("deliveryMilestonesAdapter", () => {
  it("emits one observation for each of the four editorial delivery indicators", async () => {
    const result = await deliveryMilestonesAdapter.fetch(globalThis.fetch);
    const ids = result.observations.map((o) => o.indicatorId).sort();
    expect(ids).toEqual(["bics_rollout", "industrial_strategy", "new_towns_milestones", "smr_programme"]);
  });

  it("emits each observation with plausible percent values and a content hash", async () => {
    const result = await deliveryMilestonesAdapter.fetch(globalThis.fetch);
    for (const obs of result.observations) {
      expect(obs.value).toBeGreaterThanOrEqual(0);
      expect(obs.value).toBeLessThanOrEqual(100);
      expect(obs.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      expect(obs.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("carries the correct per-indicator sourceId rather than a blanket 'editorial' tag", async () => {
    const result = await deliveryMilestonesAdapter.fetch(globalThis.fetch);
    const sourceByIndicator = Object.fromEntries(
      result.observations.map((o) => [o.indicatorId, o.sourceId] as const),
    );
    expect(sourceByIndicator["new_towns_milestones"]).toBe("gov_uk");
    expect(sourceByIndicator["bics_rollout"]).toBe("desnz");
    expect(sourceByIndicator["industrial_strategy"]).toBe("dbt");
    expect(sourceByIndicator["smr_programme"]).toBe("gov_uk");
  });

  it("has a recent observed_at on the shipped fixture (adapter's 90-day freshness guard can't throw on current build)", async () => {
    // If this test fails in a future build, the fixture is older than the
    // 90-day threshold: refresh packages/data-sources/src/fixtures/delivery-milestones.json
    // from the latest departmental announcements and redeploy.
    await expect(deliveryMilestonesAdapter.fetch(globalThis.fetch)).resolves.toBeDefined();
  });
});
