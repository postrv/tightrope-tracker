import { describe, expect, it } from "vitest";
import { boeSoniaAdapter } from "./boeSonia.js";
import { INDICATORS } from "@tightrope/shared";

function mockResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/csv" } });
}

/**
 * Build a synthetic IADB CSV of `n` business-day SONIA prints at a constant
 * rate, dated newest-first (the CSV the IADB endpoint returns is date-ordered
 * but not always newest-first; the adapter sorts internally).
 */
function syntheticCsv(firstIso: Date, n: number, rate: number): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const lines = ["DATE,IUDSOIA"];
  for (let i = 0; i < n; i++) {
    const d = new Date(firstIso.getTime() + i * 24 * 60 * 60 * 1000);
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mmm = months[d.getUTCMonth()]!;
    const yyyy = d.getUTCFullYear();
    lines.push(`${dd} ${mmm} ${yyyy},${rate.toFixed(4)}`);
  }
  return lines.join("\n");
}

describe("sonia_12m indicator label honesty", () => {
  // The adapter computes a 252-trading-day trailing mean of daily SONIA
  // fixings, not a market-implied 12-month forward. Calling it "forward"
  // overclaims: a true forward curve would require an OIS bootstrap or an
  // external vendor, neither of which this adapter has. The label must
  // describe what the code does.
  it("label and description state that the value is a trailing average, not a forward", () => {
    const def = INDICATORS["sonia_12m"]!;
    expect(def).toBeDefined();
    expect(def.label.toLowerCase(), "label").not.toContain("forward");
    expect(def.description.toLowerCase(), "description").not.toContain("forward");
    // Must at least reference the trailing-average nature so readers can
    // reconcile the chart value with the BoE source when they drill in.
    const copy = `${def.label} ${def.description}`.toLowerCase();
    expect(copy).toMatch(/trailing|rolling|compounded|average/);
  });
});

describe("boeSoniaAdapter.fetchHistorical", () => {
  it("emits one sonia_12m observation per day in range once the 252-day window is filled", async () => {
    // 300 days of constant SONIA at 4.5%; window = 252. Days < 252 cumulative
    // are skipped. Range requests the last 10 days => 10 observations.
    const start = new Date(Date.UTC(2025, 5, 1)); // 2025-06-01
    const csv = syntheticCsv(start, 300, 4.5);
    const fetchImpl = async () => mockResponse(csv);
    const from = new Date(start.getTime() + 290 * 24 * 60 * 60 * 1000);
    const to = new Date(start.getTime() + 299 * 24 * 60 * 60 * 1000);

    const result = await boeSoniaAdapter.fetchHistorical!(
      fetchImpl as unknown as typeof globalThis.fetch,
      { from, to },
    );
    expect(result.observations).toHaveLength(10);
    for (const o of result.observations) {
      expect(o.indicatorId).toBe("sonia_12m");
      expect(o.value).toBeCloseTo(4.5, 6);
      expect(o.payloadHash).toMatch(/^hist:[0-9a-f]{64}$/);
    }
  });

  it("reports window shortfall when insufficient prior data exists", async () => {
    // Only 100 days of data; window = 252 → every day in range lacks window.
    const start = new Date(Date.UTC(2025, 0, 1));
    const csv = syntheticCsv(start, 100, 4.5);
    const fetchImpl = async () => mockResponse(csv);
    const from = new Date(start.getTime() + 10 * 24 * 60 * 60 * 1000);
    const to = new Date(start.getTime() + 99 * 24 * 60 * 60 * 1000);

    const result = await boeSoniaAdapter.fetchHistorical!(
      fetchImpl as unknown as typeof globalThis.fetch,
      { from, to },
    );
    expect(result.observations).toHaveLength(0);
    expect(result.notes?.join(" ")).toContain("skipped");
  });

  it("computes rolling mean correctly when rate varies", async () => {
    // Construct a 260-day series: first 252 at 4.0, next 8 at 5.0. Requesting
    // the last day (index 259) should see a 252-day window covering indices
    // 8..259 = 244 days at 4.0 and 8 days at 5.0 → mean = (244*4 + 8*5)/252.
    const start = new Date(Date.UTC(2024, 0, 1));
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const lines = ["DATE,IUDSOIA"];
    for (let i = 0; i < 260; i++) {
      const d = new Date(start.getTime() + i * 86_400_000);
      const rate = i < 252 ? 4.0 : 5.0;
      lines.push(`${String(d.getUTCDate()).padStart(2, "0")} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()},${rate.toFixed(4)}`);
    }
    const csv = lines.join("\n");
    const fetchImpl = async () => mockResponse(csv);
    const from = new Date(start.getTime() + 259 * 86_400_000);
    const to = from;

    const result = await boeSoniaAdapter.fetchHistorical!(
      fetchImpl as unknown as typeof globalThis.fetch,
      { from, to },
    );
    expect(result.observations).toHaveLength(1);
    const expected = (244 * 4.0 + 8 * 5.0) / 252;
    expect(result.observations[0]!.value).toBeCloseTo(expected, 6);
  });
});
