import { describe, expect, it } from "vitest";
import { downsampleLatestPerDay } from "../lib/history.js";

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
