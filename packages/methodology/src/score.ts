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

  return {
    pillar,
    value: roundTo(value, 1),
    band: band.id,
    weight: pillarDef.weight,
    contributions,
    trend7d: trend,
    delta7d,
    sparkline30d: input.sparkline30d.map((n) => roundTo(n, 2)),
  };
}

export interface HeadlineComputationInput {
  pillars: Record<PillarId, PillarScore>;
  sparkline90d: readonly number[];
  value24hAgo?: number;
  value30dAgo?: number;
  valueYtdAgo?: number;
  updatedAt: Iso8601;
}

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

  return {
    value,
    band,
    editorial,
    updatedAt: input.updatedAt,
    delta24h: input.value24hAgo === undefined ? 0 : roundTo(value - input.value24hAgo, 1),
    delta30d: input.value30dAgo === undefined ? 0 : roundTo(value - input.value30dAgo, 1),
    deltaYtd: input.valueYtdAgo === undefined ? 0 : roundTo(value - input.valueYtdAgo, 1),
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
