import { afterEach, describe, expect, it, vi } from "vitest";
import { lseFtse250Adapter } from "./lseFtse250.js";
import type { AdapterContext } from "../types.js";

const LIVE_CTX: AdapterContext = { secrets: { EODHD_API_KEY: "test-key" } };

describe("lseFtse250Adapter — live path", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("falls back to Yahoo ^FTMC when EODHD returns 402", async () => {
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("eodhd.com")) return new Response("Payment Required", { status: 402 });
      if (u.includes("query1.finance.yahoo.com")) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [{
                timestamp: [1787326530], // 2026-08-21 close
                indicators: { quote: [{ close: [24718.82] }] },
              }],
            },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await lseFtse250Adapter.fetch(fetchImpl, LIVE_CTX);
    expect(result.sourceUrl).toContain("query1.finance.yahoo.com");
    const obs = result.observations[0]!;
    expect(obs.indicatorId).toBe("ftse_250");
    expect(obs.value).toBe(24718.8);
    expect(obs.observedAt).toBe("2026-08-21T16:30:00Z");
  });

  it("falls back to the fixture on HTTP 402 (plan gating) without throwing", async () => {
    const fetchImpl = (async () => new Response("Payment Required", { status: 402 })) as typeof globalThis.fetch;
    const result = await lseFtse250Adapter.fetch(fetchImpl, LIVE_CTX);
    expect(result.observations[0]!.indicatorId).toBe("ftse_250");
    expect(result.sourceUrl).not.toContain("eodhd.com"); // fixture attribution, not the failed live URL
    expect(result.sourceUrl).not.toContain("finance.yahoo.com");
  });

  it("skips an in-session EODHD bar and uses the previous completed close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T11:00:00Z")); // 12:00 London, cash session open
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("eodhd.com")) {
        return new Response(
          JSON.stringify([
            { date: "2026-09-01", close: 24477.67, adjusted_close: 24477.67, volume: 0 },
            { date: "2026-08-28", close: 24938.8, adjusted_close: 24938.8, volume: 0 },
          ]),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await lseFtse250Adapter.fetch(fetchImpl, LIVE_CTX);
    const obs = result.observations[0]!;
    expect(obs.value).toBe(24938.8);
    expect(obs.observedAt).toBe("2026-08-28T16:30:00Z");
    expect(result.sourceUrl).toContain("eodhd.com");
  });

  it("accepts today's EODHD bar once the London close has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T16:00:00Z")); // 17:00 London
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("eodhd.com")) {
        return new Response(
          JSON.stringify([
            { date: "2026-09-01", close: 24477.67, adjusted_close: 24477.67, volume: 0 },
            { date: "2026-08-28", close: 24938.8, adjusted_close: 24938.8, volume: 0 },
          ]),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await lseFtse250Adapter.fetch(fetchImpl, LIVE_CTX);
    const obs = result.observations[0]!;
    expect(obs.value).toBe(24477.7);
    expect(obs.observedAt).toBe("2026-09-01T16:30:00Z");
  });

  it("skips an in-session Yahoo bar and uses the previous completed close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T11:00:00Z"));
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("eodhd.com")) return new Response("Payment Required", { status: 402 });
      if (u.includes("query1.finance.yahoo.com")) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [{
                timestamp: [1787900400, 1788246000], // 2026-08-28 07:00 UTC, 2026-09-01 07:00 UTC
                indicators: { quote: [{ close: [24938.8, 24477.67] }] },
              }],
            },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await lseFtse250Adapter.fetch(fetchImpl, LIVE_CTX);
    const obs = result.observations[0]!;
    expect(result.sourceUrl).toContain("query1.finance.yahoo.com");
    expect(obs.value).toBe(24938.8);
    expect(obs.observedAt).toBe("2026-08-28T16:30:00Z");
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
