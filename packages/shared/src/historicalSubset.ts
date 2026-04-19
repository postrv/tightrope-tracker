import { INDICATORS, type IndicatorDefinition, type PillarId } from "./indicators.js";

/**
 * Indicators whose values are editorial interpretations of political
 * announcements (e.g. milestones-hit). They carry `hasHistoricalSeries:
 * false` in the catalog. The historical backfill pipeline excludes them
 * from quorum math because backfilling an editorial score to a prior
 * date would invent judgement calls that were never made at the time.
 *
 * Live recompute still uses every indicator — the snapshot on the
 * homepage is the full picture. The trajectory chart (30d / 90d history)
 * is the honest minimum: a subset of the pillar's indicators, explicitly
 * disclosed on /methodology.
 */
export const LIVE_ONLY_INDICATOR_IDS: readonly string[] = Object.values(INDICATORS)
  .filter((i) => i.hasHistoricalSeries === false)
  .map((i) => i.id);

export function historicalIndicatorsForPillar(pillar: PillarId): IndicatorDefinition[] {
  return Object.values(INDICATORS).filter(
    (i) => i.pillar === pillar && i.hasHistoricalSeries !== false,
  );
}

export function liveOnlyIndicatorsForPillar(pillar: PillarId): IndicatorDefinition[] {
  return Object.values(INDICATORS).filter(
    (i) => i.pillar === pillar && i.hasHistoricalSeries === false,
  );
}
