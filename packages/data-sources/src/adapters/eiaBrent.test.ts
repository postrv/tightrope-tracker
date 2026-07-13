import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/brent.json" with { type: "json" };
import { eiaBrentAdapter } from "./eiaBrent.js";
import type { AdapterContext } from "../types.js";

/** Live-path context: EIA key + a published gbp_usd fix (the relay-fed series). */
function liveCtx(fx: { value: number; observedAt: string } | null = { value: 1.3356, observedAt: "2026-07-06T16:00:00Z" }): AdapterContext {
  return {
    secrets: { EIA_API_KEY: "test-key" },
    getLatestObservation: async (id) => (id === "gbp_usd" ? fx : null),
  };
}

function eiaFetchStub(rows: Array<{ period: string; value: number | string }>): typeof globalThis.fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (!u.startsWith("https://api.eia.gov/")) throw new Error(`unexpected fetch: ${u}`);
    return new Response(JSON.stringify({ response: { data: rows } }), { status: 200 });
  }) as typeof globalThis.fetch;
}

describe("eiaBrentAdapter — live path", () => {
  it("queries the RBRTE series facet and pairs with the published gbp_usd fix", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: RequestInfo | URL) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ response: { data: [{ period: "2026-07-06", value: "69.56" }] } }), { status: 200 });
    }) as typeof globalThis.fetch;

    const result = await eiaBrentAdapter.fetch(fetchImpl, liveCtx());
    // The 2026-07-13 root cause: facets[series][]=EPCBRENT (a PRODUCT code)
    // matched nothing and EIA replied 200 with zero rows for two weeks.
    expect(capturedUrl).toContain("facets%5Bseries%5D%5B%5D=RBRTE");
    expect(capturedUrl).not.toContain("EPCBRENT");
    const obs = result.observations[0]!;
    expect(obs.indicatorId).toBe("brent_gbp");
    expect(obs.value).toBeCloseTo(69.56 / 1.3356, 2);
    expect(obs.observedAt).toBe("2026-07-06T00:00:00Z");
  });

  it("falls back to the fixture when EIA returns zero rows, and a stale fixture names the live reason", async () => {
    // Fresh fixture: zero-rows EIA -> fixture value served quietly.
    const result = await eiaBrentAdapter.fetch(eiaFetchStub([]), liveCtx());
    expect(result.observations[0]!.value).toBe((fixture as { brent_gbp: { value: number } }).brent_gbp.value);

    // Stale fixture: the audit error must carry the live-path root cause.
    const observedMs = Date.parse((fixture as { observed_at: string }).observed_at);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedMs + 30 * 24 * 60 * 60 * 1000));
    await expect(eiaBrentAdapter.fetch(eiaFetchStub([]), liveCtx()))
      .rejects.toThrow(/stale.*live path: EIA returned no usable Brent rows/is);
    vi.useRealTimers();
  });

  it("falls back with a pairing reason when no gbp_usd observation is published", async () => {
    const result = await eiaBrentAdapter.fetch(
      eiaFetchStub([{ period: "2026-07-06", value: 69.56 }]),
      liveCtx(null),
    );
    // Fixture path served (fresh) — the live path declined to price without FX.
    expect(result.sourceUrl).toBe((fixture as { source_url: string }).source_url);
  });

  it("rejects a stale pairing (EIA print and fix more than 7 days apart)", async () => {
    const result = await eiaBrentAdapter.fetch(
      eiaFetchStub([{ period: "2026-07-06", value: 69.56 }]),
      liveCtx({ value: 1.3356, observedAt: "2026-06-20T16:00:00Z" }),
    );
    expect(result.sourceUrl).toBe((fixture as { source_url: string }).source_url);
  });
});

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
