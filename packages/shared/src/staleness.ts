import type { IndicatorDefinition, PillarId } from "./indicators.js";

/**
 * Freshness threshold for a single indicator, tied to its source's
 * publication cadence (captured in `IndicatorDefinition.maxStaleMs`) rather
 * than the pillar it happens to sit in.
 *
 * Example: OBR EFO publishes twice a year, so a one-size-fits-all pillar
 * window would call the fiscal pillar stale between every EFO release.
 * Per-indicator values (~220d for EFO, ~90d for ONS PSF, ~5d for DMO / BoE
 * daily feeds) reflect the real cadence so the quorum check only fires
 * when an adapter has actually gone quiet.
 */
export function maxStaleMsForIndicator(def: IndicatorDefinition): number {
  return def.maxStaleMs;
}

/**
 * Hard ceiling for the age of a persisted score row (pillar_scores or
 * headline_scores) served to users. Recompute fires every 5 minutes and
 * writes every non-stale pillar, so under healthy conditions no row should
 * be older than a few minutes. If a score row is past this ceiling, either
 * recompute has stopped running or every pillar has been failing its own
 * staleness quorum -- either way, the serve layer should flag it.
 */
export const MAX_SCORE_AGE_MS = 30 * 60 * 1000;

export function isScoreRowStale(observedAt: string | undefined, now: Date = new Date()): boolean {
  if (!observedAt) return true;
  const ts = Date.parse(observedAt);
  if (!Number.isFinite(ts)) return true;
  return now.getTime() - ts > MAX_SCORE_AGE_MS;
}

/**
 * Fraction of a pillar's *observed* indicators that must be fresh to count
 * as a quorum. Exported so recompute (and tests) share one source of truth.
 */
export const PILLAR_FRESHNESS_QUORUM_FRACTION = 0.5;

/**
 * One pillar's quorum evaluation result. Returned by
 * `evaluatePillarFreshness` and consumed by the ingest recompute to decide
 * whether to skip persisting the pillar and flag it stale on the homepage.
 */
export interface PillarFreshnessResult {
  pillarId: PillarId;
  /** Number of indicators with observations inside their own maxStaleMs. */
  freshCount: number;
  /** Number of indicators that have at least one observation in the DB. */
  observedCount: number;
  /** Quorum threshold: ceil(observedCount * QUORUM_FRACTION), min 1. */
  quorum: number;
  /** Indicator ids whose latest observation is past its own maxStaleMs. */
  staleIndicatorIds: string[];
  /** Indicator ids with no observation at all (excluded from quorum math). */
  missingIndicatorIds: string[];
  /** True iff freshCount < quorum (or there are no observations at all). */
  stale: boolean;
}

/**
 * Decide whether a pillar meets the freshness quorum at `now`. For each
 * indicator in the pillar,
 *
 *   - no observation at all            -> `missingIndicatorIds`, ignored
 *                                         from both numerator and denominator
 *   - observation age <= its maxStaleMs -> contributes to `freshCount`
 *   - observation age >  its maxStaleMs -> `staleIndicatorIds`
 *
 * The pillar is stale iff `freshCount < ceil(observedCount * 0.5)`. An
 * unconfigured indicator (no observations) does not block the pillar from
 * meeting quorum -- it's a data-engineering gap, not a data staleness
 * issue, and surfacing it via the stale banner would be wrong.
 */
export function evaluatePillarFreshness(
  pillarId: PillarId,
  pillarIndicators: readonly IndicatorDefinition[],
  latestByIndicator: ReadonlyMap<string, { value: number; observedAt: string }>,
  now: Date,
): PillarFreshnessResult {
  const nowMs = now.getTime();
  let freshCount = 0;
  const staleIndicatorIds: string[] = [];
  const missingIndicatorIds: string[] = [];
  for (const def of pillarIndicators) {
    const latest = latestByIndicator.get(def.id);
    if (!latest) {
      missingIndicatorIds.push(def.id);
      continue;
    }
    const ageMs = nowMs - Date.parse(latest.observedAt);
    if (Number.isFinite(ageMs) && ageMs <= maxStaleMsForIndicator(def)) {
      freshCount++;
    } else {
      staleIndicatorIds.push(def.id);
    }
  }
  const observedCount = pillarIndicators.length - missingIndicatorIds.length;
  const quorum = observedCount > 0
    ? Math.max(1, Math.ceil(observedCount * PILLAR_FRESHNESS_QUORUM_FRACTION))
    : 0;
  const stale = observedCount === 0 || freshCount < quorum;
  return {
    pillarId,
    freshCount,
    observedCount,
    quorum,
    staleIndicatorIds,
    missingIndicatorIds,
    stale,
  };
}
