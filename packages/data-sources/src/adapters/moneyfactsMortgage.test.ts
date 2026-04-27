import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/mortgage.json" with { type: "json" };
import { moneyfactsMortgageAdapter } from "./moneyfactsMortgage.js";

describe("moneyfactsMortgageAdapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits a mortgage_2y_fix observation from the fixture", async () => {
    const result = await moneyfactsMortgageAdapter.fetch(globalThis.fetch);
    expect(result.observations).toHaveLength(1);
    const obs = result.observations[0]!;
    expect(obs.indicatorId).toBe("mortgage_2y_fix");
    expect(obs.sourceId).toBe("moneyfacts");
    expect(typeof obs.value).toBe("number");
    expect(obs.value).toBeGreaterThan(0);
    expect(obs.value).toBeLessThan(20);
    expect(obs.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(obs.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws AdapterError when the fixture has rotted past the 45-day freshness window", async () => {
    const observedMs = Date.parse((fixture as { observed_at: string }).observed_at);
    expect(Number.isFinite(observedMs), "fixture has parseable observed_at").toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedMs + 60 * 24 * 60 * 60 * 1000)); // 60 days later

    await expect(moneyfactsMortgageAdapter.fetch(globalThis.fetch)).rejects.toThrow(/stale/i);
  });

  it("emits cleanly the day after the fixture publishes", async () => {
    const observedMs = Date.parse((fixture as { observed_at: string }).observed_at);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedMs + 24 * 60 * 60 * 1000));

    const result = await moneyfactsMortgageAdapter.fetch(globalThis.fetch);
    expect(result.observations).toHaveLength(1);
  });

  it("emits cleanly at exactly 45 days post-fixture (boundary)", async () => {
    const observedMs = Date.parse((fixture as { observed_at: string }).observed_at);
    vi.useFakeTimers();
    // 45 days minus one minute — strictly under the threshold.
    vi.setSystemTime(new Date(observedMs + 45 * 24 * 60 * 60 * 1000 - 60_000));

    const result = await moneyfactsMortgageAdapter.fetch(globalThis.fetch);
    expect(result.observations).toHaveLength(1);
  });
});
