import { describe, expect, it } from "vitest";
import { onsPsfAdapter, parseOnsMonthlySeries } from "./onsPsf.js";

function mockJson(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

describe("parseOnsMonthlySeries", () => {
  it("returns every parseable month in ascending order", () => {
    const body = JSON.stringify({
      months: [
        { date: "2025 MAR", year: "2025", month: "MAR", value: "3" },
        { date: "2025 JAN", year: "2025", month: "JAN", value: "1" },
        { date: "2025 FEB", year: "2025", month: "FEB", value: "2" },
      ],
    });
    const series = parseOnsMonthlySeries(body, "x", "u");
    expect(series.map((p) => p.observedAt)).toEqual([
      "2025-01-01T00:00:00Z",
      "2025-02-01T00:00:00Z",
      "2025-03-01T00:00:00Z",
    ]);
  });

  it("skips non-numeric and unparseable rows without throwing", () => {
    const body = JSON.stringify({
      months: [
        { date: "2025 JAN", year: "2025", month: "JAN", value: "1" },
        { date: "2025 XX",  year: "2025", month: "XX",  value: "2" },
        { date: "2025 FEB", year: "2025", month: "FEB", value: "not a number" },
      ],
    });
    const series = parseOnsMonthlySeries(body, "x", "u");
    expect(series).toHaveLength(1);
    expect(series[0]!.value).toBe(1);
  });
});

describe("onsPsfAdapter.fetchHistorical", () => {
  function monthsPayload(base: number, slope: number): string {
    const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN"] as const;
    const months = MONTHS.map((m, i) => ({
      date: `2025 ${m}`, year: "2025", month: m, value: String(base + i * slope),
    }));
    return JSON.stringify({ months });
  }

  it("emits one observation per series per month in range, in GBP bn", async () => {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as URL | Request).toString();
      const search = url.match(/cdids=([A-Z0-9]+)/);
      if (search) {
        const cdid = search[1]!;
        return mockJson(JSON.stringify({ items: [{ uri: `/mock/${cdid.toLowerCase()}/pusf`, cdid }] }));
      }
      // Both CDIDs use the same synthetic payload shape; vary base per CDID
      // so the two series produce distinct values.
      if (url.includes("/jw2o/")) return mockJson(monthsPayload(10_000, 1_000)); // 10bn, +1bn/month
      if (url.includes("/jw2p/")) return mockJson(monthsPayload(5_000, 500));     // 5bn, +0.5bn/month
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await onsPsfAdapter.fetchHistorical!(
      fetchImpl as unknown as typeof globalThis.fetch,
      { from: new Date("2025-02-01T00:00:00Z"), to: new Date("2025-04-01T00:00:00Z") },
    );
    expect(result.observations).toHaveLength(6); // 2 series × 3 months

    const mar = result.observations.find((o) => o.indicatorId === "borrowing_outturn" && o.observedAt === "2025-03-01T00:00:00Z")!;
    expect(mar.value).toBeCloseTo(12, 6); // base 10bn + 2 months × 1bn, values converted from GBPm /1000
    for (const o of result.observations) {
      expect(o.payloadHash).toMatch(/^hist:[0-9a-f]{64}$/);
      expect(o.sourceId).toBe("ons_psf");
    }
  });
});
