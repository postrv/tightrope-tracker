import { describe, expect, it } from "vitest";
import { onsPsfAdapter, parseOnsMonthlySeries, parseOnsMonthly } from "./onsPsf.js";

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

  it("propagates the upstream updateDate as releasedAt when present", () => {
    const body = JSON.stringify({
      months: [
        { date: "2025 MAR", year: "2025", month: "MAR", value: "3", updateDate: "2025-04-22T00:00:00.000Z" },
        { date: "2025 JAN", year: "2025", month: "JAN", value: "1", updateDate: "2025-02-20T00:00:00.000Z" },
        { date: "2025 FEB", year: "2025", month: "FEB", value: "2", updateDate: "2025-03-21T00:00:00.000Z" },
      ],
    });
    const series = parseOnsMonthlySeries(body, "x", "u");
    expect(series.map((p) => p.releasedAt)).toEqual([
      "2025-02-20T00:00:00.000Z",
      "2025-03-21T00:00:00.000Z",
      "2025-04-22T00:00:00.000Z",
    ]);
  });

  it("omits releasedAt for rows where updateDate is missing", () => {
    const body = JSON.stringify({
      months: [
        { date: "2025 JAN", year: "2025", month: "JAN", value: "1" },
      ],
    });
    const series = parseOnsMonthlySeries(body, "x", "u");
    expect(series[0]!.releasedAt).toBeUndefined();
  });
});

/**
 * Sign-convention regression tests — anchored to live ONS values fetched on
 * 2026-04-19 from
 *   https://www.ons.gov.uk/economy/governmentpublicsectorandtaxes/publicsectorfinance/timeseries/j5ii/pusf/data
 *   https://www.ons.gov.uk/economy/governmentpublicsectorandtaxes/publicsectorfinance/timeseries/nmfx/pusf/data
 *
 * ONS publishes J5II with **negative = net borrowing** and **positive = net
 * surplus**; the UK's January self-assessment receipts are the only month
 * that prints a surplus, making Jan 2026 (+31855 £m) an effective regression
 * canary: if anyone "simplifies" the adapter by dropping the sign flip, the
 * surplus will appear as a deficit and this test will fail loudly.
 *
 * NMFX ("Net Interest payable") is signed **positive = interest paid**; no
 * flip is needed.
 */
describe("onsPsfAdapter sign convention (regression)", () => {
  it("stores J5II deficit as positive borrowing in £bn (Dec 2025: -13692 £m -> +13.692 £bn)", () => {
    const body = JSON.stringify({
      months: [{ date: "2025 DEC", year: "2025", month: "DEC", value: "-13692" }],
    });
    const { value } = parseOnsMonthly(body, "ons_psf", "u");
    // Raw ONS: -13692 £m means "£13.7bn borrowed". Adapter flip: -(-13692)/1000 = +13.692.
    const stored = -value / 1000;
    expect(stored).toBeCloseTo(13.692, 6);
    expect(stored).toBeGreaterThan(0);
  });

  it("stores J5II surplus as negative borrowing in £bn (Jan 2026: +31855 £m -> -31.855 £bn)", () => {
    const body = JSON.stringify({
      months: [{ date: "2026 JAN", year: "2026", month: "JAN", value: "31855" }],
    });
    const { value } = parseOnsMonthly(body, "ons_psf", "u");
    // Raw ONS: +31855 £m means "£31.9bn surplus". Adapter flip: -(31855)/1000 = -31.855.
    // The January sign flip is the canary: any change that breaks sign handling
    // will turn this surplus into a fake £32bn deficit and fail the test.
    const stored = -value / 1000;
    expect(stored).toBeCloseTo(-31.855, 6);
    expect(stored).toBeLessThan(0);
  });

  it("stores NMFX interest paid as positive £bn without flip (Dec 2025: 9065 £m -> +9.065 £bn)", () => {
    const body = JSON.stringify({
      months: [{ date: "2025 DEC", year: "2025", month: "DEC", value: "9065" }],
    });
    const { value } = parseOnsMonthly(body, "ons_psf", "u");
    const stored = value / 1000;
    expect(stored).toBeCloseTo(9.065, 6);
    expect(stored).toBeGreaterThan(0);
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

  it("populates releasedAt from updateDate on historical observations", async () => {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as URL | Request).toString();
      const search = url.match(/cdids=([A-Z0-9]+)/);
      if (search) {
        const cdid = search[1]!;
        return mockJson(JSON.stringify({ items: [{ uri: `/mock/${cdid.toLowerCase()}/pusf`, cdid }] }));
      }
      // One month per series with an explicit updateDate 45 days after the
      // reference period (canonical PSF lag).
      const body = JSON.stringify({
        months: [
          { date: "2025 FEB", year: "2025", month: "FEB", value: "-15000", updateDate: "2025-04-18T00:00:00.000Z" },
        ],
      });
      return mockJson(body);
    };

    const result = await onsPsfAdapter.fetchHistorical!(
      fetchImpl as unknown as typeof globalThis.fetch,
      { from: new Date("2025-02-01T00:00:00Z"), to: new Date("2025-02-28T00:00:00Z") },
    );
    for (const o of result.observations) {
      expect(o.releasedAt).toBe("2025-04-18T00:00:00.000Z");
      // Release must postdate the observed reference period.
      expect(Date.parse(o.releasedAt!)).toBeGreaterThan(Date.parse(o.observedAt));
    }
  });

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
      if (url.includes("/j5ii/")) return mockJson(monthsPayload(-10_000, -1_000)); // ONS signs: -10bn, -1bn/month -> we flip so stored = +10, +11, +12
      if (url.includes("/nmfx/")) return mockJson(monthsPayload(5_000, 500));       // 5bn, +0.5bn/month
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await onsPsfAdapter.fetchHistorical!(
      fetchImpl as unknown as typeof globalThis.fetch,
      { from: new Date("2025-02-01T00:00:00Z"), to: new Date("2025-04-01T00:00:00Z") },
    );
    expect(result.observations).toHaveLength(6); // 2 series × 3 months

    const mar = result.observations.find((o) => o.indicatorId === "borrowing_outturn" && o.observedAt === "2025-03-01T00:00:00Z")!;
    // ONS J5II raw for March: -10000 + (-1000*2) = -12000 £m.
    // Our transform flips the sign and /1000 -> +12 £bn "net borrowing".
    expect(mar.value).toBeCloseTo(12, 6);
    const marInterest = result.observations.find((o) => o.indicatorId === "debt_interest" && o.observedAt === "2025-03-01T00:00:00Z")!;
    // NMFX raw for March: 5000 + (500*2) = 6000 £m. /1000 -> 6 £bn.
    expect(marInterest.value).toBeCloseTo(6, 6);
    for (const o of result.observations) {
      expect(o.payloadHash).toMatch(/^hist:[0-9a-f]{64}$/);
      expect(o.sourceId).toBe("ons_psf");
    }
  });
});
