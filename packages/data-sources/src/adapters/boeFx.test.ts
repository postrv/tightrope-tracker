import { describe, expect, it } from "vitest";
import { boeFxAdapter } from "./boeFx.js";
import { AdapterError } from "../lib/errors.js";

function mockResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/csv" } });
}

describe("boeFxAdapter", () => {
  it("emits gbp_usd and gbp_twi from the latest row", async () => {
    const csv = [
      "DATE,XUDLUSS,XUDLBK67",
      "16 Apr 2026,1.2705,78.3",
      "17 Apr 2026,1.2710,78.5",
    ].join("\n");
    const fetchImpl = async () => mockResponse(csv);
    const result = await boeFxAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch);
    expect(result.observations.map((o) => o.indicatorId).sort()).toEqual(["gbp_twi", "gbp_usd"]);
    const usd = result.observations.find((o) => o.indicatorId === "gbp_usd")!;
    const twi = result.observations.find((o) => o.indicatorId === "gbp_twi")!;
    expect(usd.value).toBe(1.271);
    expect(twi.value).toBe(78.5);
    expect(usd.observedAt).toBe("2026-04-17T16:00:00Z");
    expect(usd.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws AdapterError on HTTP failure", async () => {
    const fetchImpl = async () => mockResponse("nope", 500);
    await expect(
      boeFxAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it("throws AdapterError when columns are missing", async () => {
    const csv = "DATE,SPAM\n17 Apr 2026,1.0";
    const fetchImpl = async () => mockResponse(csv);
    await expect(
      boeFxAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});

describe("boeFxAdapter.fetchHistorical", () => {
  const fetchCsv = (csv: string) => async () => mockResponse(csv);

  it("emits gbp_usd and gbp_twi per day in range with hist: payloadHash", async () => {
    const csv = [
      "DATE,XUDLUSS,XUDLBK67",
      "15 Apr 2026,1.2700,78.2",
      "16 Apr 2026,1.2705,78.3",
      "17 Apr 2026,1.2710,78.5",
    ].join("\n");
    const result = await boeFxAdapter.fetchHistorical!(
      fetchCsv(csv) as unknown as typeof globalThis.fetch,
      { from: new Date("2026-04-15T00:00:00Z"), to: new Date("2026-04-17T00:00:00Z") },
    );
    expect(result.observations).toHaveLength(6);
    for (const o of result.observations) {
      expect(o.payloadHash).toMatch(/^hist:[0-9a-f]{64}$/);
    }
    expect(result.earliestObservedAt).toBe("2026-04-15T16:00:00Z");
    expect(result.latestObservedAt).toBe("2026-04-17T16:00:00Z");
  });

  it("clips to requested range", async () => {
    const csv = [
      "DATE,XUDLUSS,XUDLBK67",
      "10 Apr 2026,1.27,78.0",
      "15 Apr 2026,1.27,78.2",
      "20 Apr 2026,1.27,78.4",
    ].join("\n");
    const result = await boeFxAdapter.fetchHistorical!(
      fetchCsv(csv) as unknown as typeof globalThis.fetch,
      { from: new Date("2026-04-15T00:00:00Z"), to: new Date("2026-04-15T00:00:00Z") },
    );
    expect(result.observations.map((o) => o.observedAt)).toEqual([
      "2026-04-15T16:00:00Z",
      "2026-04-15T16:00:00Z",
    ]);
  });
});
