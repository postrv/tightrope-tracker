import { describe, expect, it } from "vitest";
import { eiaBrentAdapter } from "./eiaBrent.js";

describe("eiaBrentAdapter", () => {
  it("emits a brent_gbp observation from the fixture", async () => {
    const result = await eiaBrentAdapter.fetch(globalThis.fetch);
    expect(result.observations).toHaveLength(1);
    const obs = result.observations[0]!;
    expect(obs.indicatorId).toBe("brent_gbp");
    expect(obs.sourceId).toBe("eia_brent");
    expect(typeof obs.value).toBe("number");
    expect(obs.value).toBeGreaterThan(10);
    expect(obs.value).toBeLessThan(300);
    expect(obs.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(obs.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
