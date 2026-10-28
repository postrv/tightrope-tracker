import { describe, expect, it } from "vitest";
import { BOE_BREAKEVENS_SERIES_CODES, boeBreakevensAdapter } from "./boeBreakevens.js";
import { AdapterError } from "../lib/errors.js";

function mockResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/csv" } });
}

describe("boeBreakevensAdapter", () => {
  it("emits breakeven_5y from the latest complete row", async () => {
    const csv = [
      "DATE,IUDSNZC,IUDSIZC",
      "15 Apr 2026,4.20,0.80",
      "16 Apr 2026,4.25,0.85",
      "17 Apr 2026,4.30,0.90",
    ].join("\n");
    const fetchImpl = async () => mockResponse(csv);
    const result = await boeBreakevensAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch);

    expect(result.observations).toHaveLength(1);
    const be5 = result.observations.find((o) => o.indicatorId === "breakeven_5y")!;

    // IUDSIZC is already inflation, not the real yield. An extra subtraction
    // would silently emit 3.40 instead of the published 0.90.
    expect(be5.value).toBe(0.90);
    expect(be5.observedAt).toBe("2026-04-17T16:00:00Z");
    expect(be5.sourceId).toBe("boe_yields");
    expect(be5.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sourceUrl).toContain("IUDSIZC");
    expect(result.sourceUrl).not.toContain("IUDSNZC");
    expect(BOE_BREAKEVENS_SERIES_CODES).toBe("IUDSIZC");
  });

  it("walks back past missing inflation rates without requiring nominal yields", async () => {
    const csv = [
      "DATE,IUDSNZC,IUDSIZC",
      "15 Apr 2026,4.20,0.80",
      "16 Apr 2026,4.25,",
      "17 Apr 2026,,",
    ].join("\n");
    const fetchImpl = async () => mockResponse(csv);
    const result = await boeBreakevensAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch);
    expect(result.observations[0]!.observedAt).toBe("2026-04-15T16:00:00Z");
    expect(result.observations).toHaveLength(1);
  });

  it("accepts the official standalone inflation series without nominal or real columns", async () => {
    const result = await boeBreakevensAdapter.fetch(async () => mockResponse("DATE,IUDSIZC\n15 Apr 2026,3.25"));
    expect(result.observations[0]).toMatchObject({ value: 3.25, observedAt: "2026-04-15T16:00:00Z" });
  });

  it("throws AdapterError when columns are missing", async () => {
    const csv = "DATE,IUDSNZC\n15 Apr 2026,4.20";
    const fetchImpl = async () => mockResponse(csv);
    await expect(
      boeBreakevensAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it("throws AdapterError when no row has inflation populated", async () => {
    const csv = [
      "DATE,IUDSNZC,IUDSIZC",
      "15 Apr 2026,4.20,",
      "16 Apr 2026,,",
    ].join("\n");
    const fetchImpl = async () => mockResponse(csv);
    await expect(
      boeBreakevensAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it("throws AdapterError on HTTP failure", async () => {
    const fetchImpl = async () => mockResponse("nope", 503);
    await expect(
      boeBreakevensAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});

describe("boeBreakevensAdapter.fetchHistorical", () => {
  const fetchCsv = (csv: string) => async () => mockResponse(csv);

  it("emits 1 observation per fully-populated row and skips partial rows", async () => {
    const csv = [
      "DATE,IUDSNZC,IUDSIZC",
      "15 Apr 2026,4.20,0.80",
      "16 Apr 2026,4.25,",
      "17 Apr 2026,4.30,0.90",
    ].join("\n");
    const result = await boeBreakevensAdapter.fetchHistorical!(
      fetchCsv(csv) as unknown as typeof globalThis.fetch,
      { from: new Date("2026-04-15T00:00:00Z"), to: new Date("2026-04-17T00:00:00Z") },
    );
    expect(result.observations).toHaveLength(2);
    expect(result.notes).toEqual(["1 rows skipped (missing inflation rate)"]);
    expect(result.observations.map((o) => o.value)).toEqual([0.8, 0.9]);
    const dates = Array.from(new Set(result.observations.map((o) => o.observedAt))).sort();
    expect(dates).toEqual(["2026-04-15T16:00:00Z", "2026-04-17T16:00:00Z"]);
    for (const o of result.observations) {
      expect(o.payloadHash).toMatch(/^hist:[0-9a-f]{64}$/);
    }
  });
});
