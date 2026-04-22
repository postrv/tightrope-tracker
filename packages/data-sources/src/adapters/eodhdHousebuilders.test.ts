import { describe, expect, it } from "vitest";
import { eodhdHousebuildersAdapter } from "./eodhdHousebuilders.js";

const CTX_WITH_KEY = { secrets: { EODHD_API_KEY: "test-key" } };

function eodResponse(close: number, date = "2026-04-22"): string {
  return JSON.stringify([{ date, open: close, high: close, low: close, close, adjusted_close: close, volume: 100000 }]);
}

function mockFetch(responses: Record<string, string>, status = 200) {
  return async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    for (const [symbol, body] of Object.entries(responses)) {
      if (u.includes(`/${symbol}.LSE`)) {
        return new Response(body, { status, headers: { "content-type": "application/json" } });
      }
    }
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
}

describe("eodhdHousebuildersAdapter", () => {
  it("computes composite from valid responses", async () => {
    const responses = {
      PSN: eodResponse(1248.5),
      BTRW: eodResponse(421.0),
      TW: eodResponse(118.2),
      BKG: eodResponse(3912.0),
      VTY: eodResponse(652.0),
    };
    const result = await eodhdHousebuildersAdapter.fetch(
      mockFetch(responses) as unknown as typeof globalThis.fetch,
      CTX_WITH_KEY,
    );
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.indicatorId).toBe("housebuilder_idx");
    expect(result.observations[0]!.value).toBeCloseTo(71.7, 0);
    expect(result.observations[0]!.sourceId).toBe("eodhd_housebuilders");
    expect(result.observations[0]!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to fixture when no API key provided", async () => {
    const result = await eodhdHousebuildersAdapter.fetch(
      mockFetch({}) as unknown as typeof globalThis.fetch,
    );
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.indicatorId).toBe("housebuilder_idx");
    expect(result.observations[0]!.payloadHash).toBe("fixture-fallback");
  });

  it("falls back to fixture on API error", async () => {
    const fetchImpl = async () => new Response("Server Error", { status: 500 });
    const result = await eodhdHousebuildersAdapter.fetch(
      fetchImpl as unknown as typeof globalThis.fetch,
      CTX_WITH_KEY,
    );
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.payloadHash).toBe("fixture-fallback");
  });

  it("tolerates missing constituents if >= 3 resolve", async () => {
    const responses = {
      PSN: eodResponse(1248.5),
      TW: eodResponse(118.2),
      BKG: eodResponse(3912.0),
    };
    const result = await eodhdHousebuildersAdapter.fetch(
      mockFetch(responses) as unknown as typeof globalThis.fetch,
      CTX_WITH_KEY,
    );
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.payloadHash).not.toBe("fixture-fallback");
  });

  it("falls back to fixture if fewer than 3 constituents resolve", async () => {
    const responses = {
      PSN: eodResponse(1248.5),
      TW: eodResponse(118.2),
    };
    const result = await eodhdHousebuildersAdapter.fetch(
      mockFetch(responses) as unknown as typeof globalThis.fetch,
      CTX_WITH_KEY,
    );
    expect(result.observations[0]!.payloadHash).toBe("fixture-fallback");
  });
});
