import { describe, expect, it } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { parseHTML } from "linkedom";
import type { ScoreHistory } from "@tightrope/shared";
import HeadlineChartSection from "./HeadlineChartSection.astro";

describe("homepage history refresh boundary", () => {
  it.each([true, false])("marks history refresh validity from actual returned recordings (%s)", async (hasData) => {
    const history: ScoreHistory = {
      points: hasData ? [{ timestamp: "2026-10-29T12:00:00Z", headline: 37,
        pillars: { market: 35, fiscal: 36, labour: 46, delivery: 32 } }] : [],
      rangeDays: 90, scoreDirection: "higher_is_better", schemaVersion: 2,
    };
    const container = await AstroContainer.create();
    const doc = parseHTML(await container.renderToString(HeadlineChartSection, { props: { history, events: [] } })).document;
    const region = doc.querySelector('[data-live-region="headline-history"]')!;
    expect(region.getAttribute("data-live-valid")).toBe(String(hasData));
    expect(Boolean(region.querySelector("svg.chart-svg"))).toBe(hasData);
    expect(Boolean(region.querySelector(".empty"))).toBe(!hasData);
    expect(region.querySelector("[data-live-region]")).toBeNull();
  });
});
