import { describe, expect, it } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { parseHTML } from "linkedom";
import type { HeadlineScore, TimelineEvent } from "@tightrope/shared";
import Hero from "./Hero.astro";

const headline: HeadlineScore = {
  value: 42.8, band: "strained", editorial: "Market is the biggest drag.", updatedAt: "2026-10-28T13:10:00Z",
  delta24h: 2.5, delta30d: 1, deltaYtd: 2, dominantPillar: "market", sparkline90d: [],
};

async function render(calculationCorrection?: TimelineEvent) {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Hero, { props: { headline, calculationCorrection } });
  return parseHTML(html).document;
}

describe("Hero calculation transparency", () => {
  it("puts a sourced calculation-change notice beside the score and comparisons", async () => {
    const doc = await render({
      id: "correction-baseline-reference-days-2026-10-28", date: "2026-10-28T13:10:00Z", category: "methodology",
      title: "Score calculation corrected", summary: "Baseline observations are deduplicated by reference day.",
      sourceLabel: "Tracker corrections", sourceUrl: "https://tightropetracker.uk/corrections",
    });
    const card = doc.querySelector(".composite-card")!;
    expect(card.querySelector(".score-value")?.textContent).toBe("42.8");
    expect(card.querySelector(".calculation-note")?.textContent).toContain("Score calculation corrected on 28 Oct 2026");
    expect(card.querySelector(".calculation-note")?.textContent).toContain("Comparisons across this date include a calculation change");
    expect(card.querySelector(".calculation-note a")?.getAttribute("href")).toBe("https://tightropetracker.uk/corrections");
  });

  it("omits the notice when no recent calculation correction is supplied", async () => {
    expect((await render()).querySelector(".calculation-note")).toBeNull();
  });
});
