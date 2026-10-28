import { describe, expect, it } from "vitest";
import rtiFixture from "../fixtures/ons-rti.json" with { type: "json" };
import { onsRtiAdapter } from "./onsRti.js";

function mockJson(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function mockOnsFetch(): typeof globalThis.fetch {
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN"].map((month, i) => ({
    date: `2025 ${month}`, year: "2025", month, value: String([0.1, 0.2, 0.3, 0.15, 0.25, 0.18][i]),
  }));
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    if (url.includes("api.beta.ons.gov.uk")) {
      return mockJson(JSON.stringify({ items: [{ uri: "/mock/k54l/emp", cdid: "K54L" }] }));
    }
    if (url.includes("/mock/k54l/emp/data")) {
      return mockJson(JSON.stringify({ months }));
    }
    throw new Error(`unexpected URL: ${url}`);
  }) as typeof globalThis.fetch;
}

describe("onsRtiAdapter.fetchHistorical", () => {
  it("emits payroll_mom per month in range and dd_failure_rate from the curated history fixture", async () => {
    const result = await onsRtiAdapter.fetchHistorical!(
      mockOnsFetch(),
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
    const marchDd = result.observations.find((o) => o.indicatorId === "dd_failure_rate" && o.observedAt.startsWith("2025-03-31"));
    expect(marchDd?.releasedAt).toBe("2025-05-15T00:00:00Z");
  });

  it("marks the August 2026 history point with its publication date", async () => {
    const result = await onsRtiAdapter.fetchHistorical!(
      mockOnsFetch(),
      { from: new Date("2026-08-01T00:00:00Z"), to: new Date("2026-08-31T00:00:00Z") },
    );
    const dd = result.observations.filter((o) => o.indicatorId === "dd_failure_rate");
    expect(dd).toMatchObject([{
      observedAt: "2026-08-31T00:00:00Z",
      value: 2.4,
      releasedAt: "2026-09-17T00:00:00Z",
    }]);
  });

  it("appends the September 2026 chart total, rounded to the history file's one decimal", async () => {
    const result = await onsRtiAdapter.fetchHistorical!(
      mockOnsFetch(),
      { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-30T00:00:00Z") },
    );
    const dd = result.observations.filter((o) => o.indicatorId === "dd_failure_rate");
    expect(dd).toMatchObject([{
      observedAt: "2026-09-30T00:00:00Z",
      value: 2.4,
      releasedAt: "2026-10-22T00:00:00Z",
    }]);
  });
});

describe("onsRtiAdapter.fetch", () => {
  it("emits the September 2026 Figure 4 Total of 2.43 with the 22 October publication date", async () => {
    const fx = rtiFixture as { observed_at: string; published: string; dd_failure_rate: { value: number } };
    const result = await onsRtiAdapter.fetch(mockOnsFetch());
    const dd = result.observations.find((o) => o.indicatorId === "dd_failure_rate");
    expect(fx.dd_failure_rate.value).toBe(2.43);
    expect(dd).toMatchObject({
      observedAt: "2026-09-30T00:00:00Z",
      value: 2.43,
      releasedAt: "2026-10-22T00:00:00Z",
    });
    expect(dd?.value).toBe(fx.dd_failure_rate.value);
    expect(dd?.observedAt).toBe(fx.observed_at);
  });
});
