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

  it("emits payroll_mom per month in range and notes that dd_failure_rate is skipped", async () => {
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
    expect(result.observations.map((o) => o.observedAt)).toEqual([
      "2025-03-01T00:00:00Z",
      "2025-04-01T00:00:00Z",
      "2025-05-01T00:00:00Z",
    ]);
    for (const o of result.observations) {
      expect(o.indicatorId).toBe("payroll_mom");
      expect(o.payloadHash).toMatch(/^hist:[0-9a-f]{64}$/);
    }
    expect(result.notes?.[0]).toContain("dd_failure_rate");
  });
});
