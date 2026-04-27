import { describe, expect, it } from "vitest";
import { onsRtiAdapter } from "./onsRti.js";

function mockJson(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

describe("onsRtiAdapter.fetchHistorical", () => {
  function monthsPayload(values: number[]): string {
    const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN"] as const;
    const months = values.map((v, i) => ({
      date: `2025 ${MONTHS[i]}`, year: "2025", month: MONTHS[i]!, value: String(v),
    }));
    return JSON.stringify({ months });
  }

  it("emits payroll_mom per month in range and dd_failure_rate from the curated history fixture", async () => {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as URL | Request).toString();
      if (url.includes("api.beta.ons.gov.uk")) {
        return mockJson(JSON.stringify({ items: [{ uri: "/mock/k54l/emp", cdid: "K54L" }] }));
      }
      if (url.includes("/mock/k54l/emp/data")) {
        return mockJson(monthsPayload([0.1, 0.2, 0.3, 0.15, 0.25, 0.18]));
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await onsRtiAdapter.fetchHistorical!(
      fetchImpl as unknown as typeof globalThis.fetch,
      { from: new Date("2025-03-01T00:00:00Z"), to: new Date("2025-05-01T00:00:00Z") },
    );
    // Both payroll_mom (from the live ONS series) and dd_failure_rate (from
    // dd-failure-rate-history.json) emit observations in this range. Each
    // payroll print is dated month-start; each dd print is dated month-end.
    const payrollDates = result.observations.filter((o) => o.indicatorId === "payroll_mom").map((o) => o.observedAt);
    expect(payrollDates).toEqual([
      "2025-03-01T00:00:00Z",
      "2025-04-01T00:00:00Z",
      "2025-05-01T00:00:00Z",
    ]);
    const ddDates = result.observations.filter((o) => o.indicatorId === "dd_failure_rate").map((o) => o.observedAt);
    expect(ddDates.length).toBeGreaterThanOrEqual(2); // March + April month-ends fall in range
    for (const o of result.observations) {
      expect(o.payloadHash).toMatch(/^hist:[0-9a-f]{64}$/);
    }
  });
});
