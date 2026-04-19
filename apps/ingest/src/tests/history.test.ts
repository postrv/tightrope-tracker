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

  it("returns oldest {value, observedAt} when it is at least minAge old", () => {
    const rows = [
      { observed_at: "2026-03-26T00:00:00Z", value: 56.2 },
      { observed_at: "2026-04-01T00:00:00Z", value: 52.0 },
      { observed_at: "2026-04-18T00:00:00Z", value: 48.5 },
    ];
    // oldest (2026-03-26) is ~24 days old -- comfortably >= 7 days.
    expect(valueOldestIfAged(rows, 7 * DAY_MS, now)).toEqual({
      value: 56.2,
      observedAt: "2026-03-26T00:00:00Z",
    });
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

describe("valueAtLeastAgo returns {value, observedAt}", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date("2026-04-19T12:00:00Z");

  it("returns the observedAt alongside the value so callers can surface the actual baseline date", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      observed_at: new Date(now.getTime() - (59 - i) * DAY_MS).toISOString(),
      value: 60 - i * 0.1,
    }));
    const got = valueAtLeastAgo(rows, 30 * DAY_MS, now);
    // Row at index 29 is exactly 30 days back — the most recent row with ts <= cutoff.
    expect(got).toEqual({
      value: 60 - 29 * 0.1,
      observedAt: rows[29]!.observed_at,
    });
  });

  it("returns undefined when the series doesn't reach back to the target window", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      observed_at: new Date(now.getTime() - (9 - i) * DAY_MS).toISOString(),
      value: 50,
    }));
    expect(valueAtLeastAgo(rows, 30 * DAY_MS, now)).toBeUndefined();
  });
});

describe("valueAtLeastAgo -> valueOldestIfAged fallback pattern", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date("2026-04-19T12:00:00Z");

  it("falls back to the oldest row when the window doesn't reach target age, and both carry the baseline observedAt", () => {
    // 24 days of daily rows — fewer than the 30d target window, so the
    // fallback kicks in. The baseline date must flow through so callers
    // can distinguish "true 30d delta" from "since 2026-03-26".
    const rows = Array.from({ length: 24 }, (_, i) => ({
      observed_at: new Date(now.getTime() - (23 - i) * DAY_MS).toISOString(),
      value: 56.2 - i * 0.3,
    }));
    const primary = valueAtLeastAgo(rows, 30 * DAY_MS, now);
    expect(primary).toBeUndefined();
    const fallback = valueOldestIfAged(rows, 7 * DAY_MS, now);
    expect(fallback).toEqual({ value: 56.2, observedAt: rows[0]!.observed_at });
  });

  it("shared-fallback case: both 30d and YTD targets miss, both return the SAME baseline — this is the situation where delta30d and deltaYtd collapse to an identical number", () => {
    // Regression for the live-prod bug where the API returned
    // delta30d == deltaYtd == -7.9. Rooted in both lookups falling back
    // to the same oldest row. The fix is not at this layer (both
    // correctly return the row); it is at the consumer layer (surface
    // baselineDate so the UI can render "since 19 Jan" honestly).
    const rows = Array.from({ length: 25 }, (_, i) => ({
      observed_at: new Date(now.getTime() - (24 - i) * DAY_MS).toISOString(),
      value: 56.2 - i * 0.3,
    }));
    const ytdMs = now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 1);
    const v30 = valueAtLeastAgo(rows, 30 * DAY_MS, now)
      ?? valueOldestIfAged(rows, 7 * DAY_MS, now);
    const vYtd = valueAtLeastAgo(rows, ytdMs, now)
      ?? valueOldestIfAged(rows, 7 * DAY_MS, now);
    expect(v30).toBeDefined();
    expect(vYtd).toBeDefined();
    expect(v30!.value).toBe(vYtd!.value);
    expect(v30!.observedAt).toBe(vYtd!.observedAt);
  });
});
