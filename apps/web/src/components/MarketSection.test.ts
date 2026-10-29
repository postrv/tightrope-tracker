import { describe, expect, it } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { parseHTML } from "linkedom";
import type { PillarScore, ScoreHistory, TodayMovement } from "@tightrope/shared";
import MarketSection from "./MarketSection.astro";

const pillar: PillarScore = {
  pillar: "market", label: "Market", value: 35, band: "acute", weight: 0.5,
  contributions: [{ indicatorId: "gilt_10y", rawValue: 5.3, rawValueUnit: "%", zScore: 1,
    normalised: 35, weight: 0.18, sourceId: "boe_yields", observedAt: "2026-10-27T16:00:00Z" }],
  trend7d: "flat", delta7d: 0, trend30d: "up", delta30d: 1, sparkline30d: [34, 35],
};
const movement: TodayMovement = {
  indicatorId: "gilt_10y", label: "10y gilt", unit: "%", latestValue: 5.3, displayValue: "5.30%",
  change: 0.1, changePct: 1.9, changeDisplay: "+10bp", direction: "up", worsening: true,
  sparkline: [5.2, 5.3], gloss: "Since previous reading.", sourceId: "boe_yields", observedAt: "2026-10-27T16:00:00Z",
};

describe("market chart refresh validity", () => {
  it.each([false, true])("withholds replacement when the supplied history read is empty (%s)", async (hasHistory) => {
    const history: ScoreHistory = {
      points: hasHistory ? [{ timestamp: "2026-10-29T12:00:00Z", headline: 37,
        pillars: { market: 35, fiscal: 36, labour: 46, delivery: 32 } }] : [],
      rangeDays: 90, scoreDirection: "higher_is_better", schemaVersion: 2,
    };
    const container = await AstroContainer.create();
    const doc = parseHTML(await container.renderToString(MarketSection, { props: { pillar, movements: [movement], history } })).document;
    expect(doc.querySelector('[data-live-region="market-data"]')?.getAttribute("data-live-valid")).toBe(String(hasHistory));
  });
});
