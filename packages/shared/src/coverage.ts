/**
 * Canonical window (in UTC days) for pillar trajectory sparklines. Matches
 * the 30-day slice used by `pillarHistory` in apps/web/src/lib/db.ts and
 * apps/api/src/lib/db.ts. If you change this, the db queries must change
 * in lockstep.
 */
export const PILLAR_SPARKLINE_WINDOW_DAYS = 30;

export interface SparklineCoverage {
  /** How many distinct UTC days in the window are represented in the series. */
  plotted: number;
  /** The full window size (i.e. expected plot points under full coverage). */
  window: number;
  /** Days in the window that are missing — failed quorum or no backfill yet. */
  missing: number;
  /** True iff plotted === window (every day in the window has a score row). */
  isComplete: boolean;
}

/**
 * Describe how fully a pillar sparkline covers its window. Each element in
 * `series` is one UTC day (the db query downsamples to latest-per-day), so
 * `series.length` is a direct count of days that met quorum. Days that
 * failed quorum are absent from the series — this helper exposes the gap
 * count so the UI can disclose it ("Scored 27 of 30 days") and the
 * /methodology page can explain what a missing day means.
 */
export function describeSparklineCoverage(
  series: readonly number[] | undefined,
  windowDays: number = PILLAR_SPARKLINE_WINDOW_DAYS,
): SparklineCoverage {
  const len = series ? series.length : 0;
  const plotted = Math.min(len, windowDays);
  const missing = Math.max(0, windowDays - plotted);
  return {
    plotted,
    window: windowDays,
    missing,
    isComplete: missing === 0,
  };
}
