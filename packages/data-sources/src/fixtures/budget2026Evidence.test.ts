import { describe, expect, it } from "vitest";
import evidence from "./budget-2026-evidence.json" with { type: "json" };
import obr from "./obr-efo.json" with { type: "json" };

describe("published Budget 2026 evidence", () => {
  it("uses the detailed OBR table and keeps the two forecast comparisons distinct", () => {
    const fiscal = evidence.fiscal;
    expect(fiscal.currentBudgetHeadroomGbpBn).toBe(14.5);
    expect(fiscal.targetFiscalYear).toBe("2029/30");
    expect(fiscal.forecastRevisionGbpBn).toBeCloseTo(
      fiscal.currentBudgetHeadroomGbpBn - fiscal.previousVintageHeadroomGbpBn,
    );
    expect(fiscal.withinForecastPolicyDifferenceGbpBn).toBeCloseTo(
      fiscal.postMeasuresHeadroomGbpBn - fiscal.preMeasuresHeadroomGbpBn,
    );
    expect(obr.vintages[0]?.indicators.cb_headroom.value).toBe(fiscal.currentBudgetHeadroomGbpBn);
    expect(obr.vintages[0]?.released_at).toBe(evidence.timing.forecastPublishedAt);
  });

  it("does not mistake web publication times or the approximate schedule for an actual speech start", () => {
    expect(evidence.status).toBe("delivered");
    expect(evidence.timing.verifiedActualStatementStartAt).toBeNull();
    expect(evidence.timing.scheduledStartPrecision).toBe("approximately");
    expect(Date.parse(evidence.timing.comparisonCutoffAt)).toBeLessThan(
      Date.parse(evidence.timing.forecastPublishedAt),
    );
    expect(evidence.timing.forecastPublishedAt).toBe("2026-10-28T13:29:19Z");
    expect(evidence.timing.speechTranscriptPublishedAt).toBe("2026-10-28T15:45:59Z");
    expect(Object.values(evidence.sources).every(source => source.url.startsWith("https://"))).toBe(true);
  });
});
