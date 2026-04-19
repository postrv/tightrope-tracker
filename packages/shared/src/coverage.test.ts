import { describe, expect, it } from "vitest";
import { describeSparklineCoverage, PILLAR_SPARKLINE_WINDOW_DAYS } from "./coverage.js";

describe("describeSparklineCoverage", () => {
  it("exposes the canonical 30-day window used by the homepage charts", () => {
    expect(PILLAR_SPARKLINE_WINDOW_DAYS).toBe(30);
  });

  it("reports full coverage when the series has one point per day in the window", () => {
    const series = Array.from({ length: 30 }, (_, i) => 50 + i * 0.1);
    const cov = describeSparklineCoverage(series);
    expect(cov.plotted).toBe(30);
    expect(cov.window).toBe(30);
    expect(cov.missing).toBe(0);
    expect(cov.isComplete).toBe(true);
  });

  it("flags days that failed quorum as missing when the series is shorter than the window", () => {
    // pillarHistory in db.ts is one row per distinct UTC day that met
    // quorum. If 3 of the last 30 days failed quorum, the series is 27
    // points long. The chart reads left-to-right with no date axis, so
    // "27 of 30" is the bare-minimum honest disclosure.
    const series = Array.from({ length: 27 }, (_, i) => 40 + i * 0.2);
    const cov = describeSparklineCoverage(series);
    expect(cov.plotted).toBe(27);
    expect(cov.window).toBe(30);
    expect(cov.missing).toBe(3);
    expect(cov.isComplete).toBe(false);
  });

  it("caps plotted at the window so an oversaturated series doesn't report negative missing", () => {
    // Defensive: during a migration from live to backfill history, the
    // window could briefly contain more than 30 days (e.g. a seeded
    // slice running long). We never want to tell readers 32-of-30.
    const series = Array.from({ length: 35 }, () => 50);
    const cov = describeSparklineCoverage(series);
    expect(cov.plotted).toBe(30);
    expect(cov.missing).toBe(0);
    expect(cov.isComplete).toBe(true);
  });

  it("handles an empty or undefined series as zero coverage", () => {
    const covEmpty = describeSparklineCoverage([]);
    expect(covEmpty.plotted).toBe(0);
    expect(covEmpty.missing).toBe(30);
    expect(covEmpty.isComplete).toBe(false);
    const covUndef = describeSparklineCoverage(undefined);
    expect(covUndef.plotted).toBe(0);
    expect(covUndef.missing).toBe(30);
    expect(covUndef.isComplete).toBe(false);
  });

  it("accepts a custom window (used by the 90-day headline sparkline)", () => {
    const cov = describeSparklineCoverage(Array.from({ length: 80 }, () => 60), 90);
    expect(cov.plotted).toBe(80);
    expect(cov.window).toBe(90);
    expect(cov.missing).toBe(10);
    expect(cov.isComplete).toBe(false);
  });
});
