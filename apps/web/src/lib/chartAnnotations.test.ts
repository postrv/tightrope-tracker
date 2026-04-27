/**
 * Tests for the pure event-to-chart annotation mapper.
 *
 * These tests pin down the snapping rules so the renderer can rely on
 * deterministic, well-bounded output even when callers pass partial or
 * messy inputs.
 */
import { describe, expect, it } from "vitest";
import type { PillarId, ScoreHistory, ScoreHistoryPoint, TimelineEvent } from "@tightrope/shared";
import { mapEventsToChart } from "./chartAnnotations.js";

const PILLARS_ZERO: Record<PillarId, number> = {
  market: 0,
  fiscal: 0,
  labour: 0,
  delivery: 0,
};

function point(date: string, headline: number): ScoreHistoryPoint {
  return { timestamp: `${date}T12:00:00Z`, headline, pillars: { ...PILLARS_ZERO } };
}

function history(points: ScoreHistoryPoint[]): ScoreHistory {
  return { points, rangeDays: 90, schemaVersion: 1 };
}

function event(id: string, date: string, partial?: Partial<TimelineEvent>): TimelineEvent {
  return {
    id,
    date,
    title: `Event ${id}`,
    summary: "summary",
    category: "fiscal",
    sourceLabel: "label",
    ...partial,
  };
}

describe("mapEventsToChart", () => {
  it("returns an empty array when history has no points", () => {
    expect(mapEventsToChart(history([]), [event("a", "2026-04-10")])).toEqual([]);
  });

  it("returns an empty array when no events are passed", () => {
    expect(
      mapEventsToChart(history([point("2026-04-01", 50), point("2026-04-02", 51)]), []),
    ).toEqual([]);
  });

  it("drops events that occur before the start of the history window", () => {
    const h = history([
      point("2026-04-01", 50),
      point("2026-04-15", 55),
    ]);
    // 2026-03-15 is well before 2026-04-01 (>1d tolerance); should be dropped.
    const out = mapEventsToChart(h, [event("e1", "2026-03-15")]);
    expect(out).toEqual([]);
  });

  it("drops events that occur after the end of the history window", () => {
    const h = history([
      point("2026-04-01", 50),
      point("2026-04-15", 55),
    ]);
    const out = mapEventsToChart(h, [event("e1", "2026-05-15")]);
    expect(out).toEqual([]);
  });

  it("snaps an event whose date matches a history timestamp to that index", () => {
    const h = history([
      point("2026-04-01", 50),
      point("2026-04-02", 52),
      point("2026-04-03", 54),
    ]);
    const out = mapEventsToChart(h, [event("e1", "2026-04-02T12:00:00Z")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.seriesIndex).toBe(1);
    expect(out[0]!.value).toBe(52);
  });

  it("snaps an event between two history points to the nearer one", () => {
    const h = history([
      point("2026-04-01", 50),
      point("2026-04-05", 60),
      point("2026-04-10", 70),
    ]);
    // 2026-04-04 is closer to 2026-04-05 than to 2026-04-01.
    const out = mapEventsToChart(h, [event("e1", "2026-04-04T12:00:00Z")]);
    expect(out).toHaveLength(1);
    // Distance to 04-04 → 04-05 is 1d, which is within tolerance and closer
    // than 3d to 04-01.
    expect(out[0]!.seriesIndex).toBe(1);
    expect(out[0]!.value).toBe(60);
  });

  it("drops an event when the nearest history point is more than one day away", () => {
    const h = history([
      point("2026-04-01", 50),
      point("2026-04-10", 60),
    ]);
    // 2026-04-05 is 4d from each — outside the 1d snap tolerance.
    const out = mapEventsToChart(h, [event("e1", "2026-04-05T12:00:00Z")]);
    expect(out).toEqual([]);
  });

  it("retains multiple events on the same day", () => {
    const h = history([
      point("2026-04-01", 50),
      point("2026-04-02", 51),
      point("2026-04-03", 52),
    ]);
    const out = mapEventsToChart(h, [
      event("a", "2026-04-02T08:00:00Z"),
      event("b", "2026-04-02T15:00:00Z"),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.event.id)).toEqual(["a", "b"]);
    // Both snap to the same series index but xRatio differs because the
    // event timestamps within the day differ.
    expect(out[0]!.seriesIndex).toBe(1);
    expect(out[1]!.seriesIndex).toBe(1);
    expect(out[0]!.xRatio).toBeLessThan(out[1]!.xRatio);
  });

  it("preserves input order in the output (deterministic)", () => {
    const h = history([
      point("2026-04-01", 50),
      point("2026-04-02", 51),
      point("2026-04-03", 52),
      point("2026-04-04", 53),
    ]);
    const events = [
      event("z", "2026-04-04T12:00:00Z"),
      event("a", "2026-04-01T12:00:00Z"),
      event("m", "2026-04-03T12:00:00Z"),
    ];
    const out1 = mapEventsToChart(h, events);
    const out2 = mapEventsToChart(h, events);
    expect(out1.map((p) => p.event.id)).toEqual(["z", "a", "m"]);
    expect(out2.map((p) => p.event.id)).toEqual(["z", "a", "m"]);
  });

  it("computes xRatio proportional to the event date within the span", () => {
    // Daily-cadence history so events can land anywhere in the window
    // without falling outside the 1-day snap tolerance.
    const days: ScoreHistoryPoint[] = [];
    for (let i = 0; i < 11; i++) {
      const day = String(i + 1).padStart(2, "0");
      days.push(point(`2026-04-${day}`, 50 + i));
    }
    const h = history(days);
    const out = mapEventsToChart(h, [
      event("start", "2026-04-01T12:00:00Z"),
      event("mid", "2026-04-06T12:00:00Z"),
      event("end", "2026-04-11T12:00:00Z"),
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]!.xRatio).toBeCloseTo(0, 5);
    expect(out[1]!.xRatio).toBeCloseTo(0.5, 2);
    expect(out[2]!.xRatio).toBeCloseTo(1, 5);
  });

  it("handles a single-point history by placing the event at xRatio 0.5", () => {
    const h = history([point("2026-04-05", 55)]);
    const out = mapEventsToChart(h, [event("e1", "2026-04-05T12:00:00Z")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.xRatio).toBe(0.5);
  });

  it("ignores events with unparseable dates rather than throwing", () => {
    const h = history([point("2026-04-01", 50), point("2026-04-02", 51)]);
    const out = mapEventsToChart(h, [event("bad", "not-a-date")]);
    expect(out).toEqual([]);
  });

  it("ignores corrupt history rows and falls back to the rest", () => {
    const h = history([
      { timestamp: "not-a-date", headline: 99, pillars: { ...PILLARS_ZERO } },
      point("2026-04-01", 50),
      point("2026-04-02", 51),
    ]);
    const out = mapEventsToChart(h, [event("e1", "2026-04-01T12:00:00Z")]);
    expect(out).toHaveLength(1);
    // Snapped to a real point, not the corrupt row at index 0.
    expect(out[0]!.value).toBe(50);
  });
});
