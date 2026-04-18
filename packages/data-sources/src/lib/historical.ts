/**
 * Shared helpers for `fetchHistorical` implementations.
 */
import type { HistoricalFetchResult, RawObservation } from "../types.js";

/**
 * Wrap a populated `RawObservation[]` into a `HistoricalFetchResult`, deriving
 * the earliest / latest observed_at bounds the upstream actually populated
 * (which may be tighter than the requested range — weekends, holidays, quiet
 * days). Adapters should always return via this helper so the admin response
 * shape is uniform across every source.
 */
export function buildHistoricalResult(
  observations: RawObservation[],
  sourceUrl: string,
  notes: string[] = [],
): HistoricalFetchResult {
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const o of observations) {
    if (earliest === null || o.observedAt < earliest) earliest = o.observedAt;
    if (latest === null || o.observedAt > latest) latest = o.observedAt;
  }
  const base: HistoricalFetchResult = {
    observations,
    sourceUrl,
    fetchedAt: new Date().toISOString(),
    earliestObservedAt: earliest,
    latestObservedAt: latest,
  };
  return notes.length > 0 ? { ...base, notes } : base;
}

/**
 * Return inclusive UTC-midnight millisecond bounds for a `HistoricalRange`.
 * Adapters use these to clip their per-row output (the upstream endpoint is
 * already range-filtered, but defensive clipping catches off-by-one bugs and
 * any future provider that returns extra rows on either side).
 */
export function rangeUtcBounds(opts: { from: Date; to: Date }): { fromMs: number; toMs: number } {
  const fromMs = Date.UTC(opts.from.getUTCFullYear(), opts.from.getUTCMonth(), opts.from.getUTCDate());
  const toMs = Date.UTC(opts.to.getUTCFullYear(), opts.to.getUTCMonth(), opts.to.getUTCDate());
  return { fromMs, toMs };
}
