import { afterEach, describe, expect, it, vi } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { parseHTML } from "linkedom";
import type { IndicatorContribution, TodayMovement } from "@tightrope/shared";
import TodayStrip from "./TodayStrip.astro";

const monthly: TodayMovement = {
  indicatorId: "consumer_confidence", label: "Cons. conf.", unit: "index", latestValue: -19,
  displayValue: "-19", change: 1, changePct: -5, changeDisplay: "+1.00", direction: "up",
  worsening: false, sparkline: [-20, -19], gloss: "Change from previous reading.",
  sourceId: "gfk_confidence", observedAt: "2026-10-31T00:00:00Z",
};
const contribution: IndicatorContribution = {
  indicatorId: monthly.indicatorId, rawValue: monthly.latestValue, rawValueUnit: "index",
  zScore: 0, normalised: 50, weight: 0.04, sourceId: monthly.sourceId,
  observedAt: monthly.observedAt, releasedAt: "2026-10-23T00:00:00Z",
};

async function render(movements: TodayMovement[], contributions: IndicatorContribution[] = []) {
  const container = await AstroContainer.create();
  return parseHTML(await container.renderToString(TodayStrip, { props: { movements, contributions } })).document;
}

afterEach(() => vi.restoreAllMocks());

describe("Latest published changes", () => {
  it("labels monthly readings by reference month and matching release date, using release-aware freshness", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-22T12:00:00Z"));
    const doc = await render([monthly], [contribution]);
    expect(doc.querySelector("h2")?.textContent).toBe("Latest published changes");
    expect(doc.querySelector(".today-sub")?.textContent).toContain("prior market session or monthly release");
    expect(doc.querySelector(".chg")?.textContent).toContain("vs previous reading");
    expect(doc.querySelector(".age-date")?.textContent).toBe("Reference period · Oct 2026");
    expect(doc.querySelector(".release-date")?.textContent).toContain("Released · 23 Oct 2026");
    expect(doc.querySelector(".release-date time")?.getAttribute("datetime")).toBe(contribution.releasedAt);
    // 30 days from release is ageing on the 45-day survey window; the
    // month-end reference label alone would incorrectly look fresher.
    expect(doc.querySelector(".age-stamp")?.classList.contains("age-ageing")).toBe(true);
    expect(doc.querySelector(".age-stamp")?.getAttribute("aria-label")).toContain("Released 23 Oct 2026");
  });

  it("does not borrow a release date from a different snapshot value or reference period", async () => {
    for (const mismatch of [{ ...contribution, rawValue: -20 }, { ...contribution, observedAt: "2026-09-30T00:00:00Z" }]) {
      const doc = await render([monthly], [mismatch]);
      expect(doc.querySelector(".age-date")?.textContent).toBe("Reference period · Oct 2026");
      expect(doc.querySelector(".release-date")).toBeNull();
    }
  });

  it("keeps daily observations explicit and the empty state free of intraday scheduling promises", async () => {
    const doc = await render([{ ...monthly, indicatorId: "gilt_10y", sourceId: "boe_yields", observedAt: "2026-10-28T16:30:00Z" }]);
    expect(doc.querySelector(".age-date")?.textContent).toBe("Observed · 28 Oct 2026");
    expect((await render([])).querySelector(".today-empty")?.textContent).toBe("No published changes are available yet. Sources update on their own release schedules.");
  });
});
