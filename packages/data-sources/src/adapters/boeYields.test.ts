import { describe, expect, it } from "vitest";
import { boeYieldsAdapter } from "./boeYields.js";
import { AdapterError } from "../lib/errors.js";

function mockResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/csv" } });
}

describe("boeYieldsAdapter", () => {
  it("emits gilt_10y and gilt_30y observations from the latest populated row", async () => {
    const csv = [
      "DATE,IUDMNZC,IUDLNZC",
      "15 Apr 2026,4.42,4.88",
      "16 Apr 2026,4.47,4.91",
      "17 Apr 2026,4.51,4.96",
    ].join("\n");
    const fetchImpl = async () => mockResponse(csv);
    const result = await boeYieldsAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch);
    expect(result.observations).toHaveLength(2);
    const ten = result.observations.find((o) => o.indicatorId === "gilt_10y")!;
    const thirty = result.observations.find((o) => o.indicatorId === "gilt_30y")!;
    expect(ten.value).toBe(4.51);
    expect(thirty.value).toBe(4.96);
    expect(ten.observedAt).toBe("2026-04-17T16:00:00Z");
    expect(ten.sourceId).toBe("boe_yields");
    expect(ten.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(thirty.payloadHash).toBe(ten.payloadHash);
    expect(result.sourceUrl).toContain("IUDMNZC");
  });

  it("walks back past blank rows to find the most recent numeric row", async () => {
    const csv = [
      "DATE,IUDMNZC,IUDLNZC",
      "15 Apr 2026,4.42,4.88",
      "16 Apr 2026,,",
      "17 Apr 2026,,",
    ].join("\n");
    const fetchImpl = async () => mockResponse(csv);
    const result = await boeYieldsAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch);
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]!.observedAt).toBe("2026-04-15T16:00:00Z");
  });

  it("throws AdapterError on HTTP failure", async () => {
    const fetchImpl = async () => mockResponse("nope", 503);
    await expect(
      boeYieldsAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it("throws AdapterError when the payload has no numeric rows", async () => {
    const csv = ["DATE,IUDMNPY,IUDMNZC", "15 Apr 2026,,"].join("\n");
    const fetchImpl = async () => mockResponse(csv);
    await expect(
      boeYieldsAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it("throws AdapterError when columns are wrong", async () => {
    const csv = "DATE,FOO\n15 Apr 2026,1.0";
    const fetchImpl = async () => mockResponse(csv);
    await expect(
      boeYieldsAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it("throws AdapterError when the endpoint 302s to an HTML error page", async () => {
    // BoE follows the redirect transparently and returns the error HTML with a
    // 200 status; parseCsv would silently produce zero rows. assertLooksLikeCsv
    // catches this so the audit row names the real cause.
    const html = '<head><title>Object moved</title></head><body><h1>Object Moved</h1></body>';
    const fetchImpl = async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    await expect(
      boeYieldsAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});

describe("boeYieldsAdapter.fetchHistorical", () => {
  const fetchCsv = (csv: string) => async () => mockResponse(csv);

  it("emits one observation per indicator per populated row in range", async () => {
    const csv = [
      "DATE,IUDMNZC,IUDLNZC",
      "14 Apr 2026,4.40,4.85",
      "15 Apr 2026,4.42,4.88",
      "16 Apr 2026,4.47,4.91",
      "17 Apr 2026,4.51,4.96",
    ].join("\n");
    const result = await boeYieldsAdapter.fetchHistorical!(
      fetchCsv(csv) as unknown as typeof globalThis.fetch,
      { from: new Date("2026-04-15T00:00:00Z"), to: new Date("2026-04-17T00:00:00Z") },
    );
    expect(result.observations).toHaveLength(6);
    expect(result.earliestObservedAt).toBe("2026-04-15T16:00:00Z");
    expect(result.latestObservedAt).toBe("2026-04-17T16:00:00Z");
    for (const o of result.observations) {
      expect(o.payloadHash).toMatch(/^hist:[0-9a-f]{64}$/);
    }
  });

  it("skips blank rows and reports them in notes", async () => {
    const csv = [
      "DATE,IUDMNZC,IUDLNZC",
      "15 Apr 2026,4.42,4.88",
      "16 Apr 2026,,",
      "17 Apr 2026,4.51,4.96",
    ].join("\n");
    const result = await boeYieldsAdapter.fetchHistorical!(
      fetchCsv(csv) as unknown as typeof globalThis.fetch,
      { from: new Date("2026-04-15T00:00:00Z"), to: new Date("2026-04-17T00:00:00Z") },
    );
    expect(result.observations).toHaveLength(4);
    expect(result.notes).toEqual(["1 blank rows skipped (BoE quiet days)"]);
  });

  it("is deterministic: same value produces identical payloadHash across runs", async () => {
    const csv = "DATE,IUDMNZC,IUDLNZC\n15 Apr 2026,4.42,4.88";
    const opts = { from: new Date("2026-04-15T00:00:00Z"), to: new Date("2026-04-15T00:00:00Z") };
    const r1 = await boeYieldsAdapter.fetchHistorical!(fetchCsv(csv) as unknown as typeof globalThis.fetch, opts);
    const r2 = await boeYieldsAdapter.fetchHistorical!(fetchCsv(csv) as unknown as typeof globalThis.fetch, opts);
    expect(r1.observations.map((o) => o.payloadHash)).toEqual(r2.observations.map((o) => o.payloadHash));
  });
});
