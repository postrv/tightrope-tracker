/**
 * Tests for the AnnotatedHeadlineChart component.
 *
 * Renders the component to HTML via Astro's experimental Container API,
 * then asserts on the resulting markup with linkedom (a fast, Node-native
 * DOM emulator). We exercise the contract:
 *   - the SVG renders
 *   - one marker is emitted per snapped event
 *   - tooltips contain the event title and category label
 *   - the SVG carries a numeric ARIA summary
 *   - showPillars=true emits four pillar series
 */
import { describe, expect, it } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { parseHTML } from "linkedom";
import type { PillarId, ScoreHistory, ScoreHistoryPoint, TimelineEvent } from "@tightrope/shared";
import AnnotatedHeadlineChart from "./AnnotatedHeadlineChart.astro";

const PILLARS_ZERO: Record<PillarId, number> = {
  market: 0, fiscal: 0, labour: 0, delivery: 0,
};

function point(date: string, headline: number, pillars: Partial<Record<PillarId, number>> = {}): ScoreHistoryPoint {
  return { timestamp: `${date}T12:00:00Z`, headline, pillars: { ...PILLARS_ZERO, ...pillars } };
}

function buildHistory(): ScoreHistory {
  const days: ScoreHistoryPoint[] = [];
  for (let i = 0; i < 14; i++) {
    const day = String(i + 1).padStart(2, "0");
    days.push(point(`2026-04-${day}`, 50 + i, {
      market: 60 + i,
      fiscal: 55 + (i % 4),
      labour: 40 + (i % 3),
      delivery: 30 + (i % 5),
    }));
  }
  return { points: days, rangeDays: 14, scoreDirection: "higher_is_better", schemaVersion: 2 };
}

function ev(id: string, date: string, partial: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id,
    date,
    title: partial.title ?? `Event ${id}`,
    summary: partial.summary ?? "An event summary",
    category: partial.category ?? "fiscal",
    sourceLabel: partial.sourceLabel ?? "ONS",
    ...(partial.sourceUrl !== undefined ? { sourceUrl: partial.sourceUrl } : {}),
    ...(partial.scoreDelta !== undefined ? { scoreDelta: partial.scoreDelta } : {}),
  };
}

async function render(props: {
  history: ScoreHistory;
  events: readonly TimelineEvent[];
  showPillars?: boolean;
}): Promise<Document> {
  const container = await AstroContainer.create();
  const html = await container.renderToString(AnnotatedHeadlineChart, { props });
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return document;
}

describe("AnnotatedHeadlineChart", () => {
  it("renders an SVG with an aria-label numeric summary", async () => {
    const doc = await render({ history: buildHistory(), events: [] });
    const svg = doc.querySelector("svg.chart-svg");
    expect(svg).not.toBeNull();
    const aria = svg!.getAttribute("aria-label") ?? "";
    expect(aria).toMatch(/Headline Tightrope Score/);
    expect(aria).toMatch(/starts/);
    expect(aria).toMatch(/range/);
  });

  it("emits one marker per snapped event", async () => {
    const events: TimelineEvent[] = [
      ev("a", "2026-04-03T12:00:00Z"),
      ev("b", "2026-04-08T12:00:00Z", { category: "monetary" }),
      ev("c", "2026-04-11T12:00:00Z", { category: "geopolitical" }),
    ];
    const doc = await render({ history: buildHistory(), events });
    const markers = doc.querySelectorAll("g.marker");
    expect(markers.length).toBe(3);
    // Each marker carries an aria-label including title and date.
    const labels = Array.from(markers).map((m) => m.getAttribute("aria-label") ?? "");
    expect(labels[0]).toMatch(/Event a/);
    expect(labels[0]).toMatch(/3 Apr/);
    expect(labels[1]).toMatch(/Event b/);
    expect(labels[2]).toMatch(/Event c/);
  });

  it("drops events outside the history window", async () => {
    const events: TimelineEvent[] = [
      ev("inside", "2026-04-05T12:00:00Z"),
      ev("before", "2026-01-01T12:00:00Z"),
      ev("after", "2026-12-31T12:00:00Z"),
    ];
    const doc = await render({ history: buildHistory(), events });
    expect(doc.querySelectorAll("g.marker").length).toBe(1);
  });

  it("renders a tooltip per marker containing the event title, summary and source link", async () => {
    const events: TimelineEvent[] = [
      ev("a", "2026-04-05T12:00:00Z", {
        title: "OBR April forecast",
        summary: "Office for Budget Responsibility published spring forecast.",
        sourceLabel: "OBR",
        sourceUrl: "https://obr.uk/forecast",
      }),
    ];
    const doc = await render({ history: buildHistory(), events });
    const tooltips = doc.querySelectorAll(".tooltip");
    expect(tooltips.length).toBe(1);
    expect(tooltips[0]!.getAttribute("role")).toBe("tooltip");
    const html = tooltips[0]!.innerHTML;
    expect(html).toMatch(/OBR April forecast/);
    expect(html).toMatch(/Office for Budget Responsibility/);
    expect(html).toMatch(/href="https:\/\/obr\.uk\/forecast"/);
  });

  it("falls back to a plain source label when no sourceUrl is present", async () => {
    const events: TimelineEvent[] = [
      ev("a", "2026-04-05T12:00:00Z", { sourceLabel: "Editorial note" }),
    ];
    const doc = await render({ history: buildHistory(), events });
    const tooltip = doc.querySelector(".tooltip");
    expect(tooltip).not.toBeNull();
    expect(tooltip!.textContent ?? "").toMatch(/Editorial note/);
    // No anchor inside the source line means the URL fallback path was hit.
    expect(tooltip!.querySelector(".tooltip-source a")).toBeNull();
  });

  it("renders four pillar lines when showPillars is true", async () => {
    const doc = await render({ history: buildHistory(), events: [], showPillars: true });
    const pillarLines = doc.querySelectorAll("path.pillar-line");
    expect(pillarLines.length).toBe(4);
  });

  it("omits pillar lines by default", async () => {
    const doc = await render({ history: buildHistory(), events: [] });
    expect(doc.querySelectorAll("path.pillar-line").length).toBe(0);
  });

  it("renders y-axis labels at the canonical band boundaries", async () => {
    const doc = await render({ history: buildHistory(), events: [] });
    // Six labels: 0, 20, 40, 60, 80, 100 — pulled from BANDS.
    const axisLabels = Array.from(doc.querySelectorAll("text.axis-label"))
      .map((el) => el.textContent?.trim() ?? "");
    for (const v of ["0", "20", "40", "60", "80", "100"]) {
      expect(axisLabels).toContain(v);
    }
  });

  it("truncates long event summaries in the tooltip", async () => {
    const longSummary = "x".repeat(300);
    const events: TimelineEvent[] = [
      ev("a", "2026-04-05T12:00:00Z", { summary: longSummary }),
    ];
    const doc = await render({ history: buildHistory(), events });
    const summaryEl = doc.querySelector(".tooltip-summary");
    const text = summaryEl?.textContent ?? "";
    expect(text.length).toBeLessThan(longSummary.length);
    expect(text.endsWith("…")).toBe(true);
  });

  it("renders a permanent label for every event category", async () => {
    const events: TimelineEvent[] = [
      ev("budget", "2026-04-05T12:00:00Z", { title: "Spring Statement", category: "fiscal" }),
      ev("conflict", "2026-04-10T12:00:00Z", { title: "Geopolitical shock", category: "geopolitical" }),
      ev("rate", "2026-04-12T12:00:00Z", { title: "Bank Rate cut", category: "monetary" }),
      ev("policy", "2026-04-13T12:00:00Z", { title: "Industrial strategy reset", category: "policy" }),
      ev("delivery", "2026-04-14T12:00:00Z", { title: "Planning Act receives assent", category: "delivery" }),
    ];
    const doc = await render({ history: buildHistory(), events });
    const labels = Array.from(doc.querySelectorAll("g.event-label text.event-label-text"))
      .map((el) => el.textContent?.trim() ?? "");
    expect(labels).toContain("Spring Statement");
    expect(labels).toContain("Geopolitical shock");
    expect(labels).toContain("Bank Rate cut");
    expect(labels.some((label) => label.startsWith("Industrial strategy"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Planning Act receives"))).toBe(true);
  });

  it("makes permanent labels interactive detail targets", async () => {
    const events: TimelineEvent[] = [
      ev("budget", "2026-04-05T12:00:00Z", { title: "Spring Statement", category: "fiscal" }),
    ];
    const doc = await render({ history: buildHistory(), events });
    const label = doc.querySelector("g.event-label");
    const marker = doc.querySelector("g.marker");
    const tooltip = doc.querySelector(".tooltip");
    expect(label).not.toBeNull();
    expect(label!.getAttribute("data-event-id")).toBe("budget");
    expect(label!.getAttribute("role")).toBe("button");
    expect(label!.querySelector("rect.event-label-hit")).not.toBeNull();
    expect(label!.querySelector("line.event-label-connector")).not.toBeNull();
    expect(label!.getAttribute("aria-describedby")).toBe(tooltip!.getAttribute("id"));
    expect(marker!.getAttribute("data-event-id")).toBe("budget");
    expect(marker!.getAttribute("aria-describedby")).toBe(tooltip!.getAttribute("id"));
  });

  it("abbreviates long permanent-label titles", async () => {
    const longTitle = "Office for Budget Responsibility releases its forecast";
    const events: TimelineEvent[] = [
      ev("long", "2026-04-05T12:00:00Z", { title: longTitle, category: "fiscal" }),
    ];
    const doc = await render({ history: buildHistory(), events });
    const labelText = doc.querySelector("g.event-label text.event-label-text")?.textContent ?? "";
    // Abbreviated label is capped so labels fit inside the six-lane layout
    // without colliding with adjacent events.
    expect(labelText.length).toBeLessThan(longTitle.length);
    expect(labelText.length).toBeLessThanOrEqual(22);
  });

  it("splits comma-separated event titles at the first clause", async () => {
    const events: TimelineEvent[] = [
      ev("comma", "2026-04-05T12:00:00Z", {
        title: "Iran shock, oil spike",
        category: "geopolitical",
      }),
    ];
    const doc = await render({ history: buildHistory(), events });
    const labelText = doc.querySelector("g.event-label text.event-label-text")?.textContent?.trim() ?? "";
    expect(labelText).toBe("Iran shock");
  });

  it("keeps short actor-led labels meaningful", async () => {
    const events: TimelineEvent[] = [
      ev("ceasefire", "2026-04-05T12:00:00Z", {
        title: "US, Israel and Iran agree conditional ceasefire",
        category: "geopolitical",
      }),
    ];
    const doc = await render({ history: buildHistory(), events });
    const labelText = doc.querySelector("g.event-label text.event-label-text")?.textContent?.trim() ?? "";
    expect(labelText).toBe("US ceasefire");
  });
});
