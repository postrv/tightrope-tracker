import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/growth-sentiment.json" with { type: "json" };
import { growthSentimentAdapter } from "./growthSentiment.js";

describe("growthSentimentAdapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits three observations with distinct indicator-specific sourceIds", async () => {
    const result = await growthSentimentAdapter.fetch(globalThis.fetch);
    expect(result.observations.length).toBeGreaterThanOrEqual(3);

    const pmi = result.observations.find((o) => o.indicatorId === "services_pmi")!;
    const conf = result.observations.find((o) => o.indicatorId === "consumer_confidence")!;
    const rics = result.observations.find((o) => o.indicatorId === "rics_price_balance")!;

    expect(pmi).toBeDefined();
    expect(conf).toBeDefined();
    expect(rics).toBeDefined();

    expect(pmi.sourceId).toBe("sp_global_pmi");
    expect(conf.sourceId).toBe("gfk_confidence");
    expect(rics.sourceId).toBe("rics_rms");

    // PMI is a diffusion index centred on 50; sanity-check the range.
    expect(pmi.value).toBeGreaterThan(20);
    expect(pmi.value).toBeLessThan(80);

    // GfK CC is commonly in the range [-50, 10].
    expect(conf.value).toBeGreaterThan(-60);
    expect(conf.value).toBeLessThan(20);

    // RICS is a net balance in percent, so always in [-100, 100].
    expect(rics.value).toBeGreaterThan(-100);
    expect(rics.value).toBeLessThan(100);

    // All three share the same payload hash because they come from one fixture.
    expect(pmi.payloadHash).toBe(conf.payloadHash);
    expect(conf.payloadHash).toBe(rics.payloadHash);
  });

  it("throws AdapterError when the fixture has rotted past the 40-day freshness window", async () => {
    const observedMs = Date.parse((fixture as { observed_at: string }).observed_at);
    expect(Number.isFinite(observedMs), "fixture has parseable observed_at").toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedMs + 60 * 24 * 60 * 60 * 1000)); // 60 days later

    await expect(growthSentimentAdapter.fetch(globalThis.fetch)).rejects.toThrow(/stale/i);
  });

  it("emits cleanly the day after the fixture publishes", async () => {
    const observedMs = Date.parse((fixture as { observed_at: string }).observed_at);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedMs + 24 * 60 * 60 * 1000));

    const result = await growthSentimentAdapter.fetch(globalThis.fetch);
    expect(result.observations.length).toBeGreaterThanOrEqual(3);
  });
});
