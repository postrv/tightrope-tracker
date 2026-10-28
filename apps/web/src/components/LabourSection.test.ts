import { describe, expect, it } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { parseHTML } from "linkedom";
import type { IndicatorContribution, PillarScore } from "@tightrope/shared";
import LabourSection from "./LabourSection.astro";

function contribution(indicatorId: string, rawValue: number): IndicatorContribution {
  return { indicatorId, rawValue, sourceId: "ons_lms", rawValueUnit: "", weight: .1, zScore: 0, normalised: 50, observedAt: "2026-08-01T00:00:00Z", releasedAt: "2026-10-20T07:00:00Z" };
}
async function render(contributions: IndicatorContribution[]) {
  const pillar: PillarScore = { pillar: "labour", label: "Labour", value: 50, weight: .2, band: "strained", trend7d: "flat", delta7d: 0, trend30d: "flat", delta30d: 0, sparkline30d: [], contributions };
  const container = await AstroContainer.create();
  const html = await container.renderToString(LabourSection, { props: { pillar } });
  return parseHTML(html).document;
}

describe("LabourSection measured readings", () => {
  it("uses scored observations with reference and release dates, without illustrative trend lines", async () => {
    const doc = await render([contribution("real_regular_pay", 1.7), contribution("inactivity_rate", 20.9)]);
    const cards = doc.querySelectorAll("article.reading-card");
    expect(cards.length).toBe(4);
    expect(cards[0]?.querySelector(".reading-value")?.textContent).toBe("1.7%");
    expect(cards[0]?.textContent).toContain("1 Aug 2026");
    expect(cards[0]?.textContent).toContain("20 Oct 2026");
    expect(doc.querySelector("svg.chart")).toBeNull();
    expect(cards[1]?.textContent).toContain("No current scored observation");
  });

  it("does not invent a zero mortgage change when the current rate is missing", async () => {
    const doc = await render([]);
    expect(doc.querySelector(".mortgage-big")?.textContent).toContain("—");
    expect(doc.querySelector(".mortgage-caption")?.textContent).toContain("current mortgage-rate observation is required");
  });
});
