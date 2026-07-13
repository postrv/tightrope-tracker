import { describe, expect, it } from "vitest";
import { lseFtse250Adapter } from "./lseFtse250.js";
import type { AdapterContext } from "../types.js";

const LIVE_CTX: AdapterContext = { secrets: { EODHD_API_KEY: "test-key" } };

describe("lseFtse250Adapter — live path", () => {
  it("queries the FTMC.INDX indices symbol (the .LSE alias 402s since 2026-07-02)", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: RequestInfo | URL) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify([{ date: "2026-07-10", close: 23371.41, adjusted_close: 23371.41, volume: 0 }]),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;

    const result = await lseFtse250Adapter.fetch(fetchImpl, LIVE_CTX);
    expect(capturedUrl).toContain("/eod/FTMC.INDX?");
    const obs = result.observations[0]!;
    expect(obs.indicatorId).toBe("ftse_250");
    expect(obs.value).toBe(23371.4);
    expect(obs.observedAt).toBe("2026-07-10T16:30:00Z");
  });

  it("falls back to the fixture on HTTP 402 (plan gating) without throwing", async () => {
    const fetchImpl = (async () => new Response("Payment Required", { status: 402 })) as typeof globalThis.fetch;
    const result = await lseFtse250Adapter.fetch(fetchImpl, LIVE_CTX);
    expect(result.observations[0]!.indicatorId).toBe("ftse_250");
    expect(result.sourceUrl).not.toContain("eodhd.com"); // fixture attribution, not the failed live URL
  });
});

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
