import { describe, expect, it } from "vitest";
import { lseFtse250Adapter } from "./lseFtse250.js";

describe("lseFtse250Adapter", () => {
  it("emits an ftse_250 observation from the fixture", async () => {
    const result = await lseFtse250Adapter.fetch(globalThis.fetch);
    expect(result.observations).toHaveLength(1);
    const obs = result.observations[0]!;
    expect(obs.indicatorId).toBe("ftse_250");
    expect(obs.sourceId).toBe("lseg");
    expect(typeof obs.value).toBe("number");
    expect(obs.value).toBeGreaterThan(5000);
    expect(obs.value).toBeLessThan(40000);
    expect(obs.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(obs.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sourceUrl).toMatch(/^https?:\/\//);
  });

  it("has a recent observed_at on the shipped fixture (freshness guard can't throw on current build)", async () => {
    await expect(lseFtse250Adapter.fetch(globalThis.fetch)).resolves.toBeDefined();
  });
});
