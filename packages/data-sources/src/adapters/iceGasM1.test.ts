import { describe, expect, it } from "vitest";
import { iceGasM1Adapter } from "./iceGasM1.js";

describe("iceGasM1Adapter", () => {
  it("emits a gas_m1 observation from the fixture", async () => {
    const result = await iceGasM1Adapter.fetch(globalThis.fetch);
    expect(result.observations).toHaveLength(1);
    const obs = result.observations[0]!;
    expect(obs.indicatorId).toBe("gas_m1");
    expect(obs.sourceId).toBe("ice_gas");
    expect(typeof obs.value).toBe("number");
    expect(obs.value).toBeGreaterThan(20);
    expect(obs.value).toBeLessThan(400);
    expect(obs.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(obs.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sourceUrl).toMatch(/^https?:\/\//);
  });

  it("has a recent observed_at on the shipped fixture (freshness guard can't throw on current build)", async () => {
    // If this test fails in a future build it means the fixture is older
    // than the 14-day threshold: refresh packages/data-sources/src/fixtures/gas-m1.json
    // from the latest ICE Endex settlement and redeploy.
    await expect(iceGasM1Adapter.fetch(globalThis.fetch)).resolves.toBeDefined();
  });
});
