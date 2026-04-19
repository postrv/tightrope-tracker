import {
  PILLARS,
  PILLAR_ORDER,
  INDICATORS,
  type PillarId,
  type IndicatorDefinition,
  type PillarScore,
  type IndicatorContribution,
  type HeadlineScore,
  type ScoreSnapshot,
  type Trend,
  type Iso8601,
  bandFor,
} from "@tightrope/shared";
import {
  clamp,
  normalisedScore,
  trendSign,
  weightedArithmeticMean,
  weightedGeometricMean,
  zScore,
} from "./normalise.js";

export interface IndicatorReading {
  indicatorId: string;
  value: number;
  observedAt: Iso8601;
  baseline: readonly number[];
}

export interface PillarComputationInput {
  readings: readonly IndicatorReading[];
  /** 30-day pillar sparkline (most recent last). */
  sparkline30d: readonly number[];
  /** Value of this pillar 7 days ago. Used for trend/delta. */
  value7dAgo?: number;
}

function asTrend(sign: 1 | 0 | -1): Trend {
  if (sign === 0) return "flat";
  return sign > 0 ? "up" : "down";
}

export function computeIndicatorContribution(
  reading: IndicatorReading,
  def: IndicatorDefinition,
  pillarWeightSum: number,
): IndicatorContribution & { normalised: number } {
  const normalised = normalisedScore(reading.value, reading.baseline, def.risingIsBad);
  const z = zScore(reading.value, reading.baseline);
  const weight = def.weight / pillarWeightSum;
  return {
    indicatorId: def.id,
    rawValue: reading.value,
    rawValueUnit: def.unit,
    zScore: z,
    normalised,
    weight,
    sourceId: def.sourceId,
    observedAt: reading.observedAt,
  };
}

export function computePillarScore(
  pillar: PillarId,
  input: PillarComputationInput,
): PillarScore {
  const pillarDef = PILLARS[pillar];
  const indicatorDefs = Object.values(INDICATORS).filter((i) => i.pillar === pillar);
  const weightSum = indicatorDefs.reduce((acc, def) => acc + def.weight, 0);

  const contributions: IndicatorContribution[] = [];
  const normalisedValues: number[] = [];
  const weights: number[] = [];

  for (const def of indicatorDefs) {
    const reading = input.readings.find((r) => r.indicatorId === def.id);
    if (!reading) continue;
    const contrib = computeIndicatorContribution(reading, def, weightSum);
    contributions.push({
      indicatorId: contrib.indicatorId,
      rawValue: contrib.rawValue,
      rawValueUnit: contrib.rawValueUnit,
      zScore: contrib.zScore,
      normalised: contrib.normalised,
      weight: contrib.weight,
      sourceId: contrib.sourceId,
      observedAt: contrib.observedAt,
    });
    normalisedValues.push(contrib.normalised);
    weights.push(contrib.weight);
  }

  const rawPillar = normalisedValues.length === 0
    ? 0
    : weightedArithmeticMean(normalisedValues, weights);

  // Direction handling is done at the indicator level (risingIsBad flag). The
  // delivery pillar is tagged `inverted: true` because every one of its inputs
  // is rising-is-good -- but each indicator already produces a pressure score,
  // so the pillar arithmetic mean is already pressure-oriented. No further flip.
  const value = clamp(rawPillar, 0, 100);
  const band = bandFor(value);
  const sign = trendSign(input.sparkline30d.slice(-14));
  const trend = asTrend(sign);
  const delta7d = input.value7dAgo === undefined ? 0 : roundTo(value - input.value7dAgo, 1);

  // 30d trend/delta: first → last across the full sparkline. A sparkline
  // shorter than two points can't span the window honestly, so both fall
  // back to flat/0 — the UI renders "X of 30 days scored" for coverage.
  let trend30d: Trend = "flat";
  let delta30d = 0;
  if (input.sparkline30d.length >= 2) {
    const first = input.sparkline30d[0]!;
    const last = input.sparkline30d[input.sparkline30d.length - 1]!;
    trend30d = asTrend(trendSign(input.sparkline30d));
    delta30d = roundTo(last - first, 1);
  }

  return {
    pillar,
    label: pillarDef.shortTitle,
    value: roundTo(value, 1),
    band: band.id,
    weight: pillarDef.weight,
    contributions,
    trend7d: trend,
    delta7d,
    trend30d,
    delta30d,
    sparkline30d: input.sparkline30d.map((n) => roundTo(n, 2)),
  };
}

export interface HeadlineComputationInput {
  pillars: Record<PillarId, PillarScore>;
  sparkline90d: readonly number[];
  value24hAgo?: number;
  value30dAgo?: number;
  valueYtdAgo?: number;
  /**
   * ISO date of the row actually used as the 30d baseline. When the row
   * is more than `BASELINE_TOLERANCE_DAYS` off a clean 30d window (i.e.
   * history doesn't yet reach back 30 days and we fell back to the
   * oldest available row), the baseline date is surfaced on the output
   * so the UI can render "since DD MMM" rather than a misleading "30d".
   */
  value30dAgoObservedAt?: Iso8601;
  /**
   * ISO date of the row actually used as the YTD baseline. When the row
   * is meaningfully later than Jan 1 of `updatedAt`'s year, the baseline
   * date is surfaced on the output.
   */
  valueYtdAgoObservedAt?: Iso8601;
  updatedAt: Iso8601;
}

/**
 * How far the actual baseline observedAt can drift from the intended
 * window before we flag it on the output as a "since X" fallback. Seven
 * days matches the minimum-age floor on valueOldestIfAged (i.e. if the
 * baseline row is within 7 days of the ideal target, it's close enough
 * not to confuse a reader).
 */
const BASELINE_TOLERANCE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function computeHeadlineScore(input: HeadlineComputationInput): HeadlineScore {
  const values = PILLAR_ORDER.map((p) => input.pillars[p].value);
  const weights = PILLAR_ORDER.map((p) => PILLARS[p].weight);
  const rawHeadline = weightedGeometricMean(values, weights);
  const value = roundTo(clamp(rawHeadline, 0, 100), 1);

  // Dominant pillar = highest weight * value product.
  let dominant: PillarId = "market";
  let best = -1;
  for (const p of PILLAR_ORDER) {
    const impact = input.pillars[p].value * PILLARS[p].weight;
    if (impact > best) {
      best = impact;
      dominant = p;
    }
  }

  const editorial = renderEditorialNote(dominant, input.pillars);
  const band = bandFor(value).id;

  const now = Date.parse(input.updatedAt);
  const hasTime = Number.isFinite(now);

  // A 30d baseline is "clean" if the row it came from is within
  // BASELINE_TOLERANCE_DAYS of exactly 30 days ago. Outside that window
  // — which happens when history doesn't yet stretch 30 days back and we
  // fell back to the oldest available row — the UI should render
  // "since DD MMM" instead of "30d", so expose the actual baseline date.
  let delta30dBaselineDate: Iso8601 | undefined;
  if (hasTime && input.value30dAgoObservedAt && input.value30dAgo !== undefined) {
    const baselineMs = Date.parse(input.value30dAgoObservedAt);
    if (Number.isFinite(baselineMs)) {
      const ageDays = (now - baselineMs) / DAY_MS;
      if (Math.abs(ageDays - 30) > BASELINE_TOLERANCE_DAYS) {
        delta30dBaselineDate = input.value30dAgoObservedAt;
      }
    }
  }

  // A YTD baseline is "clean" only if the row it came from sits on or
  // within a week of 1 January. In the bootstrap state where we only
  // have a few weeks of history, valueYtdAgoObservedAt will fall inside
  // the current year and should be flagged.
  let deltaYtdBaselineDate: Iso8601 | undefined;
  if (hasTime && input.valueYtdAgoObservedAt && input.valueYtdAgo !== undefined) {
    const baselineMs = Date.parse(input.valueYtdAgoObservedAt);
    if (Number.isFinite(baselineMs)) {
      const yearStartMs = Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
      const daysAfterJan1 = (baselineMs - yearStartMs) / DAY_MS;
      if (daysAfterJan1 > BASELINE_TOLERANCE_DAYS) {
        deltaYtdBaselineDate = input.valueYtdAgoObservedAt;
      }
    }
  }

  return {
    value,
    band,
    editorial,
    updatedAt: input.updatedAt,
    delta24h: input.value24hAgo === undefined ? 0 : roundTo(value - input.value24hAgo, 1),
    delta30d: input.value30dAgo === undefined ? 0 : roundTo(value - input.value30dAgo, 1),
    deltaYtd: input.valueYtdAgo === undefined ? 0 : roundTo(value - input.valueYtdAgo, 1),
    ...(delta30dBaselineDate ? { delta30dBaselineDate } : {}),
    ...(deltaYtdBaselineDate ? { deltaYtdBaselineDate } : {}),
    dominantPillar: dominant,
    sparkline90d: input.sparkline90d.map((n) => roundTo(n, 1)),
  };
}

function renderEditorialNote(dominant: PillarId, pillars: Record<PillarId, PillarScore>): string {
  const p = pillars[dominant];
  const def = PILLARS[dominant];
  const trendWord = p.trend7d === "up" ? "rising"
    : p.trend7d === "down" ? "easing"
    : "broadly unchanged";
  const direction = p.delta7d > 0 ? "up" : p.delta7d < 0 ? "down" : "flat";
  const mag = Math.abs(p.delta7d).toFixed(1);
  return `${def.title} is the dominant pillar; pressure is ${trendWord} (${direction} ${mag} on the week).`;
}

export function assembleSnapshot(
  pillars: Record<PillarId, PillarScore>,
  headline: HeadlineScore,
): ScoreSnapshot {
  return { headline, pillars, schemaVersion: 1 };
}

function roundTo(n: number, digits: number): number {
  const mul = 10 ** digits;
  return Math.round(n * mul) / mul;
}

export { roundTo };
