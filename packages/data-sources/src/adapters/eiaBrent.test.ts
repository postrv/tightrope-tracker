import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/brent.json" with { type: "json" };
import { eiaBrentAdapter } from "./eiaBrent.js";

describe("eiaBrentAdapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("throws AdapterError when the fixture has rotted past the 14-day freshness window", async () => {
    // Advance system time so the bundled fixture's observed_at is older
    // than the 14-day guard. The adapter must trip into the audit log
    // rather than re-emit a stale Brent print every five minutes.
    const observedMs = Date.parse((fixture as { observed_at: string }).observed_at);
    expect(Number.isFinite(observedMs), "fixture has a parseable observed_at").toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedMs + 30 * 24 * 60 * 60 * 1000)); // 30 days later

    await expect(eiaBrentAdapter.fetch(globalThis.fetch)).rejects.toThrow(/stale/i);
  });

  it("emits cleanly when called the day after the fixture publishes", async () => {
    const observedMs = Date.parse((fixture as { observed_at: string }).observed_at);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedMs + 24 * 60 * 60 * 1000)); // +1 day

    const result = await eiaBrentAdapter.fetch(globalThis.fetch);
    expect(result.observations).toHaveLength(1);
  });
});
