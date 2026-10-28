import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import catalogue from "../fixtures/boe-series-catalogue.json" with { type: "json" };
import { BOE_BREAKEVENS_SERIES_CODES, boeBreakevensAdapter } from "./boeBreakevens.js";

// Independent primary-source evidence: the BoE catalogue supplies economic
// meanings; its archived CSV supplies actual inflation, nominal and real data.
// This catches a consistently wrong derivation in BOTH live/historical modes.
const csv = readFileSync(fileURLToPath(new URL("../../../../data/exports/boe-inflation-source-2026-10-28.csv", import.meta.url)), "utf8");

describe("BoE inflation series economic identity", () => {
  it("uses the catalogue's inflation series rather than confusing it with the real curve", () => {
    expect(catalogue.series.IUDSIZC).toContain("Inflation Zero Coupon");
    expect(catalogue.series.IUDSRZC).toContain("Real Zero Coupon");
    expect(BOE_BREAKEVENS_SERIES_CODES).toBe("IUDSIZC");
    expect(createHash("sha256").update(csv).digest("hex")).toBe("183bfd76cbc5d2cd13a508a5600cdf2a7b0a94afa09e580d161c61cfd9207473");
  });

  it("returns the published inflation value for live and historical evidence, not nominal minus inflation", async () => {
    const fetchCsv = async () => new Response(csv);
    const live = await boeBreakevensAdapter.fetch(fetchCsv);
    expect(live.observations[0]).toMatchObject({ observedAt: "2026-10-26T16:00:00Z", value: 3.6941 });
    const history = await boeBreakevensAdapter.fetchHistorical!(fetchCsv, {
      from: new Date("2024-08-01"), to: new Date("2024-08-01T23:59:59Z"),
    });
    expect(history.observations).toHaveLength(1);
    expect(history.observations[0]).toMatchObject({ observedAt: "2024-08-01T16:00:00Z", value: 3.6565 });
    expect(history.observations[0]!.value).not.toBeCloseTo(3.6251 - 3.6565, 5);
  });
});
