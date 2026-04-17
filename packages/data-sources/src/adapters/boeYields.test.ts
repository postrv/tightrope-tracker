import { describe, expect, it } from "vitest";
import { boeYieldsAdapter } from "./boeYields.js";
import { AdapterError } from "../lib/errors.js";

function mockResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/csv" } });
}

describe("boeYieldsAdapter", () => {
  it("emits gilt_10y and gilt_30y observations from the latest populated row", async () => {
    const csv = [
      "DATE,IUDMNPY,IUDMNZC",
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
    expect(ten.observedAt).toBe("2026-04-17T00:00:00Z");
    expect(ten.sourceId).toBe("boe_yields");
    expect(ten.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(thirty.payloadHash).toBe(ten.payloadHash);
    expect(result.sourceUrl).toContain("IUDMNPY");
  });

  it("walks back past blank rows to find the most recent numeric row", async () => {
    const csv = [
      "DATE,IUDMNPY,IUDMNZC",
      "15 Apr 2026,4.42,4.88",
      "16 Apr 2026,,",
      "17 Apr 2026,,",
    ].join("\n");
    const fetchImpl = async () => mockResponse(csv);
    const result = await boeYieldsAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch);
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]!.observedAt).toBe("2026-04-15T00:00:00Z");
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
});
