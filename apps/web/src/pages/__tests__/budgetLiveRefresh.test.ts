import { afterEach, describe, expect, it, vi } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import type { ScoreSnapshot } from "@tightrope/shared";
import type { BudgetComparison, BudgetIndicatorComparison } from "~/lib/budget.js";
import archivedSnapshot from "../../../public/evidence/budget-2026-reference-snapshot.json";
import { applyLiveDocument } from "~/lib/liveRefresh.js";

const { comparisonMock, snapshotMock } = vi.hoisted(() => ({ comparisonMock: vi.fn(), snapshotMock: vi.fn() }));
vi.mock("~/lib/budget.js", () => ({ loadBudgetComparison: comparisonMock }));
vi.mock("~/lib/page-data.js", () => ({ loadSnapshot: snapshotMock }));
const { default: Budget } = await import("../budget.astro");

function indicator(id: string, pillar: string, label: string): BudgetIndicatorComparison {
  return {
    id, pillar, label, unit: "%", before: null, latest: null,
    status: "awaiting_post_budget_data", baselineNotice: null, delta: null, deltaDisplay: null,
  };
}

async function render(at: string, indicators: BudgetIndicatorComparison[], unavailable = false): Promise<string> {
  const comparison: BudgetComparison = {
    cutoff: "2026-10-28T12:30:00Z", baselineMode: "recorded_snapshot",
    baselineCapturedAt: "2026-10-28T12:56:25Z", baselineSnapshotAt: "2026-10-28T12:55:31Z",
    baselineSourceUrl: "https://api.tightropetracker.uk/api/v1/score", baselineArchiveUrl: "/evidence/budget-2026-reference-snapshot.json",
    baselineSourceSha256: "a".repeat(64), generatedAt: at, indicators, unavailable,
    score: { before: null, latest: { timestamp: at, value: 37 }, delta: null, comparable: false, corrections: [] },
  };
  comparisonMock.mockResolvedValue(comparison);
  snapshotMock.mockResolvedValue({ ...archivedSnapshot,
    headline: { ...archivedSnapshot.headline, updatedAt: at },
  } as unknown as ScoreSnapshot);
  const container = await AstroContainer.create();
  return container.renderToString(Budget, { request: new Request("https://example.test/budget") });
}

function parseWithoutPageResources(html: string): Document {
  // happy-dom loads linked resources even in a detached DOMParser document.
  // Remove them before parsing; only the Budget filter is executed explicitly.
  return new DOMParser().parseFromString(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*>/gi, ""), "text/html");
}

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Budget refresh keeps reader controls", () => {
  it("retains the selected filter and search text, applying them to replacement rows", async () => {
    const initial = await render("2026-10-29T12:00:00Z", [
      indicator("gilt_10y", "market", "10-year gilt yield"), indicator("real_regular_pay", "labour", "Real pay"),
    ]);
    const filterCode = [...initial.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
      .map(match => match[1]!).find(code => code.includes("data-budget-filter"))!;
    const first = parseWithoutPageResources(initial);
    // Exercise the data/controller contract without loading fonts, analytics,
    // bundled modules or other page resources in the DOM test environment.
    const stamp = first.querySelector('meta[name="live-score-updated-at"]')!;
    document.head.innerHTML = stamp.outerHTML;
    document.body.innerHTML = first.body.innerHTML;
    new Function(filterCode)();
    const controls = document.querySelector(".reading-controls")!;
    const market = controls.querySelector<HTMLButtonElement>('[data-budget-filter="market"]')!;
    const search = controls.querySelector<HTMLInputElement>("[data-budget-search]")!;
    expect(controls.closest("[data-live-region]")).toBeNull();
    market.click();
    search.value = "gilt";
    search.dispatchEvent(new Event("input"));

    const fresh = parseWithoutPageResources(await render("2026-10-29T12:05:00Z", [
      indicator("gilt_10y", "market", "10-year gilt yield"), indicator("gbp_usd", "market", "GBP / USD"),
      indicator("real_regular_pay", "labour", "Real pay"),
    ]));
    applyLiveDocument(fresh);

    expect(document.querySelector(".reading-controls")).toBe(controls);
    expect(document.querySelector("[data-budget-search]")).toBe(search);
    expect(search.value).toBe("gilt");
    expect(market.getAttribute("aria-pressed")).toBe("true");
    const rows = [...document.querySelectorAll<HTMLTableRowElement>("[data-budget-row]")];
    expect(rows).toHaveLength(3);
    expect(rows.filter(row => !row.hidden).map(row => row.dataset.search)).toEqual(["10-year gilt yield gilt_10y"]);

    const beforeFailure = document.querySelector('[data-live-region="budget-readings"]');
    applyLiveDocument(parseWithoutPageResources(await render("2026-10-29T12:10:00Z", [], true)));
    expect(document.querySelector('[data-live-region="budget-readings"]')).toBe(beforeFailure);
    expect(document.querySelectorAll("[data-budget-row]")).toHaveLength(3);
    expect(document.querySelector(".reading-controls")).toBe(controls);
  });
});
