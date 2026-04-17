import { describe, expect, it } from "vitest";
import { lseHousebuildersAdapter } from "./lseHousebuilders.js";

describe("lseHousebuildersAdapter", () => {
  it("emits a housebuilder_idx observation from the fixture", async () => {
    const result = await lseHousebuildersAdapter.fetch(globalThis.fetch);
    expect(result.observations).toHaveLength(1);
    const obs = result.observations[0]!;
    expect(obs.indicatorId).toBe("housebuilder_idx");
    expect(obs.sourceId).toBe("lseg_housebuilders");
    expect(typeof obs.value).toBe("number");
    expect(Number.isFinite(obs.value)).toBe(true);
    expect(obs.value).toBeGreaterThan(0);
    expect(obs.value).toBeLessThan(500);
    expect(obs.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(obs.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sourceUrl).toMatch(/^https?:\/\//);
  });
});
