import { describe, expect, it } from "vitest";
import { downsampleLatestPerDay, valueAtLeastAgo, valueOldestIfAged } from "../lib/history.js";

describe("downsampleLatestPerDay", () => {
  it("collapses multiple rows per day to the latest value per UTC day", () => {
    const rows = [
      { observed_at: "2026-04-16T08:00:00.000Z", value: 40 },
      { observed_at: "2026-04-16T14:00:00.000Z", value: 42 },
      { observed_at: "2026-04-16T23:55:00.000Z", value: 43 },
      { observed_at: "2026-04-17T00:05:00.000Z", value: 44 },
      { observed_at: "2026-04-17T17:00:00.000Z", value: 48 },
    ];
    expect(downsampleLatestPerDay(rows)).toEqual([43, 48]);
  });

  it("handles 5-minute recompute cadence without returning hours of same-day rows", () => {
    const today = Array.from({ length: 90 }, (_, i) => ({
      observed_at: `2026-04-18T${String(10 + Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5).padStart(2, "0")}:00.000Z`,
      value: 48.8,
    }));
    const out = downsampleLatestPerDay(today);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(48.8);
  });

  it("returns empty for empty input", () => {
    expect(downsampleLatestPerDay([])).toEqual([]);
  });

  it("orders output ascending by day regardless of input order", () => {
    const rows = [
      { observed_at: "2026-04-18T10:00:00.000Z", value: 3 },
      { observed_at: "2026-04-16T10:00:00.000Z", value: 1 },
      { observed_at: "2026-04-17T10:00:00.000Z", value: 2 },
    ];
    expect(downsampleLatestPerDay(rows)).toEqual([1, 2, 3]);
  });
});

describe("valueOldestIfAged", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date("2026-04-19T12:00:00Z");

  it("returns oldest value when it is at least minAge old", () => {
    const rows = [
      { observed_at: "2026-03-26T00:00:00Z", value: 56.2 },
      { observed_at: "2026-04-01T00:00:00Z", value: 52.0 },
      { observed_at: "2026-04-18T00:00:00Z", value: 48.5 },
    ];
    // oldest (2026-03-26) is ~24 days old -- comfortably >= 7 days.
    expect(valueOldestIfAged(rows, 7 * DAY_MS, now)).toBe(56.2);
  });

  it("returns undefined when the oldest row is younger than minAge", () => {
    const rows = [
      { observed_at: "2026-04-17T00:00:00Z", value: 48.1 },
      { observed_at: "2026-04-18T00:00:00Z", value: 48.5 },
    ];
    // oldest is ~2 days old; short of the 7-day floor.
    expect(valueOldestIfAged(rows, 7 * DAY_MS, now)).toBeUndefined();
  });

  it("returns undefined for empty series", () => {
    expect(valueOldestIfAged([], 7 * DAY_MS, now)).toBeUndefined();
  });
});

describe("valueAtLeastAgo -> valueOldestIfAged fallback pattern", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date("2026-04-19T12:00:00Z");

  it("falls back to oldest when the window doesn't reach target age", () => {
    // 24 days of daily rows -- fewer than the 30d target window.
    const rows = Array.from({ length: 24 }, (_, i) => ({
      observed_at: new Date(now.getTime() - (23 - i) * DAY_MS).toISOString(),
      value: 56.2 - i * 0.3,
    }));
    const v30 = valueAtLeastAgo(rows, 30 * DAY_MS, now)
      ?? valueOldestIfAged(rows, 7 * DAY_MS, now);
    expect(v30).toBe(56.2);
  });

  it("prefers the exact-window value when history reaches back far enough", () => {
    // 60 days of daily rows -- 30d window easily covered.
    const rows = Array.from({ length: 60 }, (_, i) => ({
      observed_at: new Date(now.getTime() - (59 - i) * DAY_MS).toISOString(),
      value: 60 - i * 0.1,
    }));
    const v30 = valueAtLeastAgo(rows, 30 * DAY_MS, now)
      ?? valueOldestIfAged(rows, 7 * DAY_MS, now);
    // Should pick the row at index 29 (30 days back), not the oldest (index 0).
    expect(v30).toBe(60 - 29 * 0.1);
  });
});
