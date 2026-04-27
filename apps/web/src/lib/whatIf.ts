/**
 * Pure logic for the /explore "what-if" simulator.
 *
 * The methodology package's `computePillarScore` requires per-indicator
 * baseline arrays which are NOT serialised onto a `ScoreSnapshot` (we store
 * normalised + z-score, not the raw historical baseline). So we cannot
 * call `computePillarScore` again from the snapshot alone.
 *
 * What we DO have on the snapshot is each indicator's `normalised` value
 * (already a 0-100 pressure score) and its in-pillar `weight`. So the
 * recompute strategy is:
 *
 *   1. For pillars NOT touched by the slider, return them verbatim.
 *   2. For the touched pillar, replace the touched indicator's `normalised`
 *      score with a slider-derived one (linear mapping from the slider's
 *      domain to [0, 100], honouring `risingIsBad`), then weighted-mean
 *      the contributions to a new pillar value.
 *   3. Pass the four pillar values into `computeHeadlineScore` to produce
 *      a fresh headline.
 *
 * This is a deliberate simplification. The live methodology uses an empirical
 * CDF over the indicator's historical baseline, which the slider's linear
 * mapping cannot reproduce without that data. The page footer states this
 * trade-off in plain English; the round-trip test below ensures the live
 * snapshot remains a fixed point of `recomputeFromOverrides` so users always
 * see the *real* score when no slider has been touched.
 */

import {
  bandFor,
  INDICATORS,
  PILLAR_ORDER,
  PILLARS,
  type HeadlineScore,
  type IndicatorContribution,
  type PillarId,
  type PillarScore,
  type ScoreSnapshot,
} from "@tightrope/shared";
import { computeHeadlineScore } from "@tightrope/methodology";

export type LeverKey =
  | "headroom"
  | "gilt30y"
  | "pay"
  | "inactivity"
  | "housing";

export interface LeverDefinition {
  key: LeverKey;
  indicatorId: string;
  pillar: PillarId;
  label: string;
  shortLabel: string;
  unit: string;
  /** Inclusive minimum of the slider domain. */
  min: number;
  /** Inclusive maximum of the slider domain. */
  max: number;
  /** Step granularity for the slider control. */
  step: number;
  /** Pretty-print a slider value. */
  format: (value: number) => string;
}

/**
 * Five canonical headline drivers exposed in the /explore UI. Order is the
 * order they render top-to-bottom in the panel.
 */
export const LEVERS: readonly LeverDefinition[] = [
  {
    key: "headroom",
    indicatorId: "cb_headroom",
    pillar: "fiscal",
    label: "Current-budget headroom",
    shortLabel: "CB headroom",
    unit: "GBPbn",
    min: 0,
    max: 50,
    step: 0.1,
    format: (v: number) => `GBP ${v.toFixed(1)}bn`,
  },
  {
    key: "gilt30y",
    indicatorId: "gilt_30y",
    pillar: "market",
    label: "20-year gilt yield",
    shortLabel: "20y gilt",
    unit: "%",
    min: 3.5,
    max: 6.5,
    step: 0.01,
    format: (v: number) => `${v.toFixed(2)}%`,
  },
  {
    key: "pay",
    indicatorId: "real_regular_pay",
    pillar: "labour",
    label: "Real regular pay growth (YoY)",
    shortLabel: "Real pay",
    unit: "%",
    min: -3,
    max: 5,
    step: 0.1,
    format: (v: number) => `${v.toFixed(1)}%`,
  },
  {
    key: "inactivity",
    indicatorId: "inactivity_health",
    pillar: "labour",
    label: "Health-related inactivity",
    shortLabel: "Health inactive",
    unit: "m",
    min: 1.8,
    max: 3.5,
    step: 0.01,
    format: (v: number) => `${v.toFixed(2)}m`,
  },
  {
    key: "housing",
    indicatorId: "housing_trajectory",
    pillar: "delivery",
    label: "Housing additions vs. trajectory",
    shortLabel: "Housing",
    unit: "%",
    min: 30,
    max: 110,
    step: 0.5,
    format: (v: number) => `${v.toFixed(1)}%`,
  },
] as const;

export const LEVER_KEYS: readonly LeverKey[] = LEVERS.map((l) => l.key);

const LEVER_BY_KEY: Record<LeverKey, LeverDefinition> = LEVERS.reduce(
  (acc, l) => {
    acc[l.key] = l;
    return acc;
  },
  {} as Record<LeverKey, LeverDefinition>,
);

/** Inclusive clamp. NaN sinks to `lo` so a malformed slider can never poison the score. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Parse the URL hash fragment into a partial set of lever overrides.
 *
 * Robust: tolerates a leading `#`, ignores unknown keys, drops malformed
 * numeric values, and never throws. Out-of-range values are NOT clamped
 * here -- the recompute path is the single owner of clamping so the URL
 * faithfully round-trips whatever the user typed.
 */
export function parseScenarioHash(
  hash: string,
): Partial<Record<LeverKey, number>> {
  const out: Partial<Record<LeverKey, number>> = {};
  if (!hash) return out;
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!trimmed) return out;
  const params = new URLSearchParams(trimmed);
  for (const [k, v] of params) {
    if (!isLeverKey(k)) continue;
    if (v === "" || v.trim() === "") continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    out[k] = n;
  }
  return out;
}

/**
 * Serialise a full set of lever values to the URL hash. Keys are emitted
 * in `LEVER_KEYS` order (deterministic) and values are rounded to a
 * sensible number of decimal places per lever.
 */
export function formatScenarioHash(
  values: Record<LeverKey, number>,
): string {
  const parts: string[] = [];
  for (const key of LEVER_KEYS) {
    const def = LEVER_BY_KEY[key];
    const decimals = decimalsForStep(def.step);
    const raw = values[key];
    if (!Number.isFinite(raw)) continue;
    const rounded = Number(raw.toFixed(decimals));
    parts.push(`${key}=${rounded}`);
  }
  return parts.join("&");
}

/**
 * Pull the live value for every lever from the snapshot's contributions.
 * Falls back to the slider midpoint if a contribution is missing -- the
 * snapshot might be empty during cold-start.
 */
export function liveValuesFromSnapshot(
  snapshot: ScoreSnapshot,
): Record<LeverKey, number> {
  const out = {} as Record<LeverKey, number>;
  for (const lever of LEVERS) {
    const pillar = snapshot.pillars[lever.pillar];
    const contrib = pillar?.contributions.find(
      (c) => c.indicatorId === lever.indicatorId,
    );
    if (contrib && Number.isFinite(contrib.rawValue)) {
      out[lever.key] = contrib.rawValue;
    } else {
      out[lever.key] = (lever.min + lever.max) / 2;
    }
  }
  return out;
}

/**
 * Recompute the full snapshot given a set of lever overrides.
 *
 * Pure: same input → same output. Returns a brand-new `ScoreSnapshot` so
 * downstream consumers can swap reference equality. When `overrides` is
 * empty the result is a structural copy of the input (the headline +
 * pillar values are byte-identical -- verified by the round-trip test).
 */
export function recomputeFromOverrides(
  snapshot: ScoreSnapshot,
  overrides: Partial<Record<LeverKey, number>>,
): ScoreSnapshot {
  // Step 1: figure out which indicators have a slider-driven override and
  // what their effective (clamped) raw value is.
  const indicatorOverrides = new Map<
    string,
    { lever: LeverDefinition; rawValue: number; normalised: number }
  >();
  for (const lever of LEVERS) {
    const raw = overrides[lever.key];
    if (raw === undefined || !Number.isFinite(raw)) continue;
    const clamped = clamp(raw, lever.min, lever.max);
    const indicatorDef = INDICATORS[lever.indicatorId];
    const risingIsBad = indicatorDef?.risingIsBad ?? true;
    const normalised = sliderToNormalised(clamped, lever, risingIsBad);
    indicatorOverrides.set(lever.indicatorId, {
      lever,
      rawValue: clamped,
      normalised,
    });
  }

  // Step 2: rebuild each pillar. Untouched pillars are returned verbatim;
  // touched pillars have their contributions rewritten with the override's
  // new normalised value, then re-aggregated as a weighted arithmetic mean
  // (matching the methodology package's `computePillarScore` aggregation).
  const newPillars = {} as Record<PillarId, PillarScore>;
  const touchedPillars = new Set<PillarId>();
  for (const ov of indicatorOverrides.values()) {
    touchedPillars.add(ov.lever.pillar);
  }

  for (const pillarId of PILLAR_ORDER) {
    const pillar = snapshot.pillars[pillarId];
    if (!touchedPillars.has(pillarId)) {
      newPillars[pillarId] = pillar;
      continue;
    }
    newPillars[pillarId] = recomputePillar(pillar, indicatorOverrides);
  }

  // Step 3: recompute the headline from the four (possibly updated) pillar
  // values via the methodology package's `computeHeadlineScore`. This
  // preserves the geometric-mean weighting and dominant-pillar logic.
  const headline = computeHeadlineScore({
    pillars: newPillars,
    sparkline90d: snapshot.headline.sparkline90d,
    updatedAt: snapshot.headline.updatedAt,
  });

  // Carry forward the original deltas + baseline-date metadata when no
  // slider has been touched (so the round-trip test passes), or zero
  // them out when the score has been mutated (the deltas are vs. live
  // history, which the simulator is no longer comparable to).
  const finalHeadline = makeHeadlineWithCarriedFields(
    headline,
    snapshot.headline,
    indicatorOverrides.size === 0,
  );

  return {
    headline: finalHeadline,
    pillars: newPillars,
    schemaVersion: 1,
    ...(snapshot.sourceHealth ? { sourceHealth: snapshot.sourceHealth } : {}),
  };
}

/**
 * Map a slider value within `[lever.min, lever.max]` to a normalised
 * pressure score in `[0, 100]`.
 *
 * If `risingIsBad === true` (e.g. gilt yield, inactivity), max → 100. If
 * `risingIsBad === false` (e.g. headroom, real pay, housing trajectory),
 * max → 0. The mapping is linear -- intentionally simpler than the live
 * ECDF, with the trade-off documented on the page itself.
 */
export function sliderToNormalised(
  value: number,
  lever: LeverDefinition,
  risingIsBad: boolean,
): number {
  const range = lever.max - lever.min;
  if (range === 0) return 0;
  const fraction = clamp((value - lever.min) / range, 0, 1);
  const pressure = risingIsBad ? fraction : 1 - fraction;
  return clamp(pressure * 100, 0, 100);
}

function recomputePillar(
  pillar: PillarScore,
  overrides: Map<
    string,
    { lever: LeverDefinition; rawValue: number; normalised: number }
  >,
): PillarScore {
  if (pillar.contributions.length === 0) {
    return pillar;
  }
  const newContributions: IndicatorContribution[] = pillar.contributions.map(
    (c) => {
      const ov = overrides.get(c.indicatorId);
      if (!ov) return c;
      return {
        ...c,
        rawValue: ov.rawValue,
        normalised: ov.normalised,
      };
    },
  );

  let num = 0;
  let den = 0;
  for (const c of newContributions) {
    num += c.normalised * c.weight;
    den += c.weight;
  }
  const newValue = den === 0 ? pillar.value : roundTo(clamp(num / den, 0, 100), 1);
  const band = bandFor(newValue).id;

  return {
    ...pillar,
    contributions: newContributions,
    value: newValue,
    band,
  };
}

function makeHeadlineWithCarriedFields(
  computed: HeadlineScore,
  original: HeadlineScore,
  isLive: boolean,
): HeadlineScore {
  if (isLive) {
    // Round-trip: the user has not touched any slider, so we want the
    // headline to be byte-identical to the live snapshot. The methodology
    // engine's deltas/dominant-pillar/editorial logic only inspects
    // pillar values + 24h/30d/YTD baselines, so we re-attach the
    // original deltas wholesale.
    return {
      ...original,
      // Recomputed `value`, `band`, `sparkline90d` are already byte-equal
      // to the original because pillar values are unchanged. Take the
      // computed result so any rounding stays consistent if the engine
      // ever changes.
      value: computed.value,
      band: computed.band,
      sparkline90d: computed.sparkline90d,
    };
  }
  // Slider-touched: deltas vs. live history are meaningless. Carry only
  // the timestamp and zero out the deltas + baseline dates.
  return {
    ...computed,
    delta24h: 0,
    delta30d: 0,
    deltaYtd: 0,
    editorial: makeEditorial(computed),
  };
}

function makeEditorial(headline: HeadlineScore): string {
  const def = PILLARS[headline.dominantPillar];
  return `In this scenario, ${def.title.toLowerCase()} is the dominant pillar.`;
}

function isLeverKey(s: string): s is LeverKey {
  return (LEVER_KEYS as readonly string[]).includes(s);
}

function decimalsForStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  // 1 → 0, 0.5 → 1, 0.1 → 1, 0.01 → 2.
  const log = Math.log10(step);
  if (log >= 0) return 0;
  return Math.min(4, Math.ceil(-log));
}

function roundTo(n: number, digits: number): number {
  const mul = 10 ** digits;
  return Math.round(n * mul) / mul;
}
