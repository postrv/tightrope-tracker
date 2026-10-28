import { afterEach, describe, expect, it, vi } from "vitest";
import housebuilders from "../fixtures/housebuilders.json" with { type: "json" };
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
    expect(result.observations[0]!.observedAt).toBe("2026-04-22T15:30:00Z");
  });

  it("stamps a winter close at 16:30 UTC", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T02:00:00Z"));
    const responses = {
      PSN: eodResponse(1248.5, "2026-11-02"),
      BTRW: eodResponse(421.0, "2026-11-02"),
      TW: eodResponse(118.2, "2026-11-02"),
    };
    const result = await eodhdHousebuildersAdapter.fetch(
      mockFetch(responses) as unknown as typeof globalThis.fetch,
      CTX_WITH_KEY,
    );
    expect(result.observations[0]!.observedAt).toBe("2026-11-02T16:30:00Z");
  });

  it("uses a common completed session instead of mixing constituent dates", async () => {
    const responses = {
      PSN: eodResponse(1248.5, "2026-10-27"),
      BTRW: eodResponse(421.0, "2026-10-27"),
      TW: eodResponse(118.2, "2026-10-26"),
      BKG: eodResponse(3912.0, "2026-10-26"),
      VTY: eodResponse(652.0, "2026-10-26"),
    };
    const result = await eodhdHousebuildersAdapter.fetch(
      mockFetch(responses) as typeof globalThis.fetch, CTX_WITH_KEY,
    );
    expect(result.observations[0]!.observedAt).toBe("2026-10-26T16:30:00Z");
    const expected = (118.2 / 163.26 + 3912 / 4684.43 + 652 / 919.61) * 100 / 3;
    expect(result.observations[0]!.value).toBe(Math.round(expected * 10) / 10);
  });

  it("skips an unfinished Budget-day bar and uses the prior completed close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T12:30:00Z"));
    const responses = Object.fromEntries(["PSN", "BTRW", "TW"].map((symbol) => [symbol,
      JSON.stringify([
        ...JSON.parse(eodResponse(9999, "2026-10-28")),
        ...JSON.parse(eodResponse(500, "2026-10-27")),
      ]),
    ]));
    const result = await eodhdHousebuildersAdapter.fetch(
      mockFetch(responses) as typeof globalThis.fetch, CTX_WITH_KEY,
    );
    expect(result.observations[0]!.observedAt).toBe("2026-10-27T16:30:00Z");
    expect(result.observations[0]!.value).toBeLessThan(200);
  });

  it("falls back when valid closes do not share a session, without counting duplicate rows", async () => {
    const responses = {
      PSN: JSON.stringify(Array(3).fill(JSON.parse(eodResponse(1248.5, "2026-10-27"))[0])),
      BTRW: eodResponse(421, "2026-10-26"),
      TW: eodResponse(118.2, "2026-10-23"),
      BKG: eodResponse(3912, "2026-99-99"),
    };
    const result = await eodhdHousebuildersAdapter.fetch(
      mockFetch(responses) as typeof globalThis.fetch, CTX_WITH_KEY,
    );
    expect(result.observations[0]!.payloadHash).toBe("fixture-fallback");
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

  it("serves the 27 October housebuilder close from the fallback fixture", async () => {
    const fx = housebuilders as { observed_at: string; housebuilder_idx: { value: number } };
    const result = await eodhdHousebuildersAdapter.fetch(globalThis.fetch);
    expect(fx.observed_at).toBe("2026-10-27T16:30:00Z");
    expect(fx.housebuilder_idx.value).toBe(55.8);
    expect(result.observations[0]).toMatchObject({
      indicatorId: "housebuilder_idx",
      observedAt: "2026-10-27T16:30:00Z",
      value: 55.8,
    });
  });

  it("throws a stale-fixture AdapterError when the fixture fallback has aged past 14 days", async () => {
    // Move the clock far past the fixture's observed_at so the 14-day guard
    // trips. This is the "both live and fixture have rotted" alert path —
    // it must surface loudly rather than re-emit a stale composite.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
    await expect(
      eodhdHousebuildersAdapter.fetch(mockFetch({}) as unknown as typeof globalThis.fetch),
    ).rejects.toThrow(/stale/i);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
