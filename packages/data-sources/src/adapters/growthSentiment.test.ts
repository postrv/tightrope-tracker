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

    // Mixed-vintage slots: PMI/GfK may carry a newer observed_at than RICS
    // when the August RMS is not yet out. Each slot's date must win over
    // the fixture-level fallback.
    const fx = fixture as {
      observed_at: string;
      services_pmi?: { observed_at?: string; published?: string };
      consumer_confidence?: { observed_at?: string; published?: string };
      rics_price_balance?: { observed_at?: string; published?: string };
    };
    expect(pmi.observedAt).toBe(fx.services_pmi?.observed_at ?? fx.observed_at);
    expect(conf.observedAt).toBe(fx.consumer_confidence?.observed_at ?? fx.observed_at);
    expect(rics.observedAt).toBe(fx.rics_price_balance?.observed_at ?? fx.observed_at);
    expect(pmi.releasedAt).toBe(`${fx.services_pmi?.published}T00:00:00Z`);
    expect(conf.releasedAt).toBe(`${fx.consumer_confidence?.published}T00:00:00Z`);
    expect(rics.releasedAt).toBe(`${fx.rics_price_balance?.published}T00:00:00Z`);
  });

  it("backfills final monthly prints with their actual publication dates", async () => {
    const result = await growthSentimentAdapter.fetchHistorical!(globalThis.fetch, {
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-09-30T00:00:00Z"),
    });
    const byKey = new Map(result.observations.map((o) => [`${o.indicatorId}:${o.observedAt.slice(0, 7)}`, o]));
    expect(byKey.get("services_pmi:2026-08")).toMatchObject({ value: 52.5, releasedAt: "2026-09-03T00:00:00Z" });
    expect(byKey.get("services_pmi:2026-09")).toMatchObject({ value: 52.1, releasedAt: "2026-10-05T00:00:00Z" });
    expect(byKey.get("consumer_confidence:2026-09")).toMatchObject({ value: -13, releasedAt: "2026-09-25T00:00:00Z" });
    expect(byKey.get("rics_price_balance:2026-09")).toMatchObject({ value: -32, releasedAt: "2026-10-06T00:00:00Z" });
  });

  it("emits the October 2026 GfK headline of -24 and leaves the September final PMI in place", async () => {
    const live = await growthSentimentAdapter.fetch(globalThis.fetch);
    const conf = live.observations.find((o) => o.indicatorId === "consumer_confidence")!;
    const pmi = live.observations.find((o) => o.indicatorId === "services_pmi")!;
    const fx = fixture as { consumer_confidence: { value: number } };
    expect(fx.consumer_confidence.value).toBe(-24);
    expect(conf).toMatchObject({
      value: -24,
      observedAt: "2026-10-31T00:00:00Z",
      releasedAt: "2026-10-23T00:00:00Z",
    });
    expect(conf.value).toBe(fx.consumer_confidence.value);
    expect(pmi).toMatchObject({ value: 52.1, releasedAt: "2026-10-05T00:00:00Z" });

    const history = await growthSentimentAdapter.fetchHistorical!(globalThis.fetch, {
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-10-31T00:00:00Z"),
    });
    const october = history.observations.find((o) => o.indicatorId === "consumer_confidence");
    expect(october).toMatchObject({
      value: -24,
      observedAt: "2026-10-31T00:00:00Z",
      releasedAt: "2026-10-23T00:00:00Z",
    });
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
