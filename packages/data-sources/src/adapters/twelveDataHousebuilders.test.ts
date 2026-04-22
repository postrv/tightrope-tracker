import { describe, expect, it } from "vitest";
import { twelveDataHousebuildersAdapter } from "./twelveDataHousebuilders.js";

function mockResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

const VALID_BATCH = JSON.stringify({
  PSN:  { symbol: "PSN",  close: "1248.50", datetime: "2026-04-17", currency: "GBX" },
  BTRW: { symbol: "BTRW", close: "421.00",  datetime: "2026-04-17", currency: "GBX" },
  TW:   { symbol: "TW",   close: "118.20",  datetime: "2026-04-17", currency: "GBX" },
  BKG:  { symbol: "BKG",  close: "3912.00", datetime: "2026-04-17", currency: "GBX" },
  VTY:  { symbol: "VTY",  close: "652.00",  datetime: "2026-04-17", currency: "GBX" },
});

const CTX_WITH_KEY = { secrets: { TWELVE_DATA_KEY: "test-key" } };

describe("twelveDataHousebuildersAdapter", () => {
  it("computes composite from valid batch response", async () => {
    const fetchImpl = async () => mockResponse(VALID_BATCH);
    const result = await twelveDataHousebuildersAdapter.fetch(
      fetchImpl as unknown as typeof globalThis.fetch,
      CTX_WITH_KEY,
    );
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.indicatorId).toBe("housebuilder_idx");
    expect(result.observations[0]!.value).toBeCloseTo(71.7, 0);
    expect(result.observations[0]!.sourceId).toBe("twelve_data_housebuilders");
    expect(result.observations[0]!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to fixture when no API key provided", async () => {
    const fetchImpl = async () => mockResponse("{}");
    const result = await twelveDataHousebuildersAdapter.fetch(
      fetchImpl as unknown as typeof globalThis.fetch,
    );
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.indicatorId).toBe("housebuilder_idx");
    expect(result.observations[0]!.payloadHash).toBe("fixture-fallback");
  });

  it("falls back to fixture on API error", async () => {
    const fetchImpl = async () => mockResponse("Server Error", 500);
    const result = await twelveDataHousebuildersAdapter.fetch(
      fetchImpl as unknown as typeof globalThis.fetch,
      CTX_WITH_KEY,
    );
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.payloadHash).toBe("fixture-fallback");
  });

  it("tolerates missing constituents if >= 3 resolve", async () => {
    const partial = JSON.stringify({
      PSN:  { symbol: "PSN",  close: "1248.50", datetime: "2026-04-17" },
      TW:   { symbol: "TW",   close: "118.20",  datetime: "2026-04-17" },
      BKG:  { symbol: "BKG",  close: "3912.00", datetime: "2026-04-17" },
      BTRW: { code: 400, message: "not found", status: "error" },
      VTY:  { code: 400, message: "not found", status: "error" },
    });
    const fetchImpl = async () => mockResponse(partial);
    const result = await twelveDataHousebuildersAdapter.fetch(
      fetchImpl as unknown as typeof globalThis.fetch,
      CTX_WITH_KEY,
    );
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.payloadHash).not.toBe("fixture-fallback");
  });

  it("falls back to fixture if fewer than 3 constituents resolve", async () => {
    const tooFew = JSON.stringify({
      PSN: { symbol: "PSN", close: "1248.50", datetime: "2026-04-17" },
      TW:  { symbol: "TW",  close: "118.20",  datetime: "2026-04-17" },
      BTRW: { code: 400, message: "not found", status: "error" },
      BKG:  { code: 400, message: "not found", status: "error" },
      VTY:  { code: 400, message: "not found", status: "error" },
    });
    const fetchImpl = async () => mockResponse(tooFew);
    const result = await twelveDataHousebuildersAdapter.fetch(
      fetchImpl as unknown as typeof globalThis.fetch,
      CTX_WITH_KEY,
    );
    expect(result.observations[0]!.payloadHash).toBe("fixture-fallback");
  });
});
