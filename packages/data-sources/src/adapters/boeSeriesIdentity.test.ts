import { describe, expect, it } from "vitest";
import { INDICATORS } from "@tightrope/shared";
import identities from "../fixtures/boe-series-identities.json" with { type: "json" };
import { BOE_YIELDS_SERIES_CODES } from "./boeYields.js";
import { BOE_FX_SERIES_CODES } from "./boeFx.js";
import { BOE_MORTGAGE_SERIES_CODE } from "./boeMortgageRates.js";

describe("primary-catalogue BoE economic identities", () => {
  it("maps the legacy gilt IDs to 10y and 20y nominal zero-coupon series", () => {
    const codes = BOE_YIELDS_SERIES_CODES.split(",") as Array<"IUDMNZC" | "IUDLNZC">;
    expect(codes.map(code => identities.series[code].maturity_years)).toEqual([10, 20]);
    expect(codes.every(code => identities.series[code].concept === "nominal_zero_coupon")).toBe(true);
    expect(INDICATORS.gilt_30y!.description).toContain("20-year");
  });

  it("distinguishes standard sterling ERI from the separately published broad index", () => {
    expect(BOE_FX_SERIES_CODES.split(",")).toEqual(["XUDLUSS", "XUDLBK67"]);
    expect(identities.series.XUDLBK67.coverage).toBe("standard");
    expect(identities.series.XUDLBK82.coverage).toBe("broad");
    expect(INDICATORS.gbp_twi!.description).toContain("January 2005 = 100");
    expect(INDICATORS.gbp_twi!.description).not.toMatch(/^Broad/i);
  });

  it("identifies IUMBV34 as a quoted 75%-LTV mortgage product rate, not an effective paid rate", () => {
    expect(identities.series[BOE_MORTGAGE_SERIES_CODE]).toMatchObject({ concept: "quoted_mortgage_rate", fixed_years: 2, ltv_percent: 75 });
    expect(INDICATORS.mortgage_2y_fix!.label).toContain("Quoted");
    expect(INDICATORS.mortgage_2y_fix!.description).toContain("quoted product rates");
  });
});
