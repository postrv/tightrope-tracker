/**
 * Pure logic for the /explore "what-if" simulator.
 *
 * Two modes of normalisation, one preferred and one fallback:
 *
 *   1. **ECDF** (preferred). When per-indicator baseline summaries are
 *      passed via the `baselines` argument we run the slider's raw
 *      value through the empirical CDF -- the same routine the live
 *      methodology uses. The summary is a 101-knot quantile sketch
 *      that reproduces `ecdf()` to within 1% in probability terms;
 *      well below the 0.5pt rounding the UI applies. The result is a
 *      faithful what-if -- moving a slider produces the score the live
 *      methodology *would* produce for that input.
 *
 *   2. **Linear** (fallback). When a baseline summary is missing for
 *      an indicator (e.g. delivery editorials with `hasHistoricalSeries
 *      = false`, or a cold-start where the API hasn't returned the
 *      baselines payload yet), we fall back to a linear remapping of
 *      the slider domain to [0, 100], honouring `risingIsBad`.
 *
 * Round-trip identity: when no overrides are supplied, the result is a
 * structural copy of the input. When an override is supplied that
 * exactly matches the live raw value for that indicator, the contrib's
 * `normalised` is taken from the snapshot rather than being re-derived
 * (which would otherwise pick up O(1%) ECDF approximation error and
 * drift the headline by ~0.1pt). This guarantees that touching a slider
 * back to its live position reproduces the live snapshot byte-for-byte.
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
import {
  computeHeadlineScore,
  normalisedFromSummary,
  type BaselineSummary,
} from "@tightrope/methodology";

/**
 * Canonical lever set spanning all four pillars. Each entry is a single
 * indicator users can drag. The size of the set was chosen to cover the
 * primary headline drivers in proportion to pillar weight while keeping
 * the panel scannable. Editorial-only delivery indicators (no historical
 * series) are intentionally excluded because there is no baseline to
 * normalise against -- they would only ever fall through to the linear
 * approximation.
 */
export type LeverKey =
  // Market
  | "gilt10y"
  | "gilt30y"
  | "breakeven5y"
  | "brent"
  | "servicesPmi"
  // Fiscal
  | "headroom"
  | "psnflDev"
  | "borrowing"
  // Labour
  | "pay"
  | "inactivity"
  | "unemployment"
  | "mortgage2y"
  // Delivery
  | "housing"
  | "consents";

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
 * Lever catalogue. Order is the order they render top-to-bottom within
 * each pillar group in the UI.
 */
export const LEVERS: readonly LeverDefinition[] = [
  // ---------- Market ----------
  {
    key: "gilt10y",
    indicatorId: "gilt_10y",
    pillar: "market",
    label: "10-year gilt yield",
    shortLabel: "10y gilt",
    unit: "%",
    min: 0.5,
    max: 6.5,
    step: 0.01,
    format: (v) => `${v.toFixed(2)}%`,
  },
  {
    key: "gilt30y",
    indicatorId: "gilt_30y",
    pillar: "market",
    label: "20-year gilt yield",
    shortLabel: "20y gilt",
    unit: "%",
    min: 1.5,
    max: 7.0,
    step: 0.01,
    format: (v) => `${v.toFixed(2)}%`,
  },
  {
    key: "breakeven5y",
    indicatorId: "breakeven_5y",
    pillar: "market",
    label: "5y breakeven inflation",
    shortLabel: "5y BE",
    unit: "%",
    min: 1.0,
    max: 6.0,
    step: 0.01,
    format: (v) => `${v.toFixed(2)}%`,
  },
  {
    key: "brent",
    indicatorId: "brent_gbp",
    pillar: "market",
    label: "Brent crude in GBP",
    shortLabel: "Brent GBP",
    unit: "GBP/bbl",
    min: 30,
    max: 150,
    step: 0.5,
    format: (v) => `GBP ${v.toFixed(1)}/bbl`,
  },
  {
    key: "servicesPmi",
    indicatorId: "services_pmi",
    pillar: "market",
    label: "UK Services PMI",
    shortLabel: "Services PMI",
    unit: "index",
    min: 35,
    max: 65,
    step: 0.1,
    format: (v) => v.toFixed(1),
  },

  // ---------- Fiscal ----------
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
    format: (v) => `GBP ${v.toFixed(1)}bn`,
  },
  {
    key: "psnflDev",
    indicatorId: "psnfl_trajectory",
    pillar: "fiscal",
    label: "PSNFL trajectory deviation",
    shortLabel: "PSNFL dev",
    unit: "pp",
    min: -3,
    max: 5,
    step: 0.05,
    format: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}pp`,
  },
  {
    key: "borrowing",
    indicatorId: "borrowing_outturn",
    pillar: "fiscal",
    label: "Public-sector net borrowing (monthly)",
    shortLabel: "PSNB",
    unit: "GBPbn",
    min: 0,
    max: 50,
    step: 0.1,
    format: (v) => `GBP ${v.toFixed(1)}bn`,
  },

  // ---------- Labour ----------
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
    format: (v) => `${v.toFixed(1)}%`,
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
    format: (v) => `${v.toFixed(2)}m`,
  },
  {
    key: "unemployment",
    indicatorId: "unemployment",
    pillar: "labour",
    label: "Unemployment rate (16+)",
    shortLabel: "Unemployment",
    unit: "%",
    min: 2.5,
    max: 9.0,
    step: 0.05,
    format: (v) => `${v.toFixed(1)}%`,
  },
  {
    key: "mortgage2y",
    indicatorId: "mortgage_2y_fix",
    pillar: "labour",
    label: "2-year fixed mortgage rate",
    shortLabel: "2y fix",
    unit: "%",
    min: 1.5,
    max: 8.0,
    step: 0.01,
    format: (v) => `${v.toFixed(2)}%`,
  },

  // ---------- Delivery ----------
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
    format: (v) => `${v.toFixed(1)}%`,
  },
  {
    key: "consents",
    indicatorId: "planning_consents",
    pillar: "delivery",
    label: "Planning consents vs. baseline",
    shortLabel: "Consents",
    unit: "%",
    min: 30,
    max: 130,
    step: 0.5,
    format: (v) => `${v.toFixed(1)}%`,
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
 * Serialise lever values to the URL hash. Keys are emitted in
 * `LEVER_KEYS` order (deterministic) and values are rounded to a
 * sensible number of decimal places per lever. Keys whose value is
 * missing or non-finite are skipped.
 */
export function formatScenarioHash(
  values: Partial<Record<LeverKey, number>>,
): string {
  const parts: string[] = [];
  for (const key of LEVER_KEYS) {
    const def = LEVER_BY_KEY[key];
    const decimals = decimalsForStep(def.step);
    const raw = values[key];
    if (raw === undefined || !Number.isFinite(raw)) continue;
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
 *
 * `baselines` is optional. When supplied, indicators with a summary use
 * the empirical-CDF normalisation; indicators without a summary, and
 * any call that omits the argument entirely, fall back to a linear
 * remap of the slider domain to [0, 100].
 *
 * Identity preservation: if a slider is set within `step / 2` of its
 * live raw value, the contribution's `normalised` is taken from the
 * snapshot rather than re-derived through the ECDF. This avoids the
 * O(1%) approximation drift that would otherwise mean "putting the
 * slider back where it was" produced a slightly different headline.
 */
export function recomputeFromOverrides(
  snapshot: ScoreSnapshot,
  overrides: Partial<Record<LeverKey, number>>,
  baselines?: Record<string, BaselineSummary>,
): ScoreSnapshot {
  // Step 0: derive live values for every lever from the snapshot. We need
  // them to (a) snap-to-live identity, and (b) the contributions-empty
  // delta fallback below.
  const liveValues = liveValuesFromSnapshot(snapshot);

  // Step 1: figure out which indicators have a slider-driven override and
  // what their effective (clamped) raw value + normalised score are.
  const indicatorOverrides = new Map<
    string,
    { lever: LeverDefinition; rawValue: number; normalised: number; liveNormalised: number }
  >();
  for (const lever of LEVERS) {
    const raw = overrides[lever.key];
    if (raw === undefined || !Number.isFinite(raw)) continue;
    const clamped = clamp(raw, lever.min, lever.max);
    const indicatorDef = INDICATORS[lever.indicatorId];
    const risingIsBad = indicatorDef?.risingIsBad ?? true;
    const liveNormalised = normalisedForLever(liveValues[lever.key], lever, risingIsBad, baselines, snapshot);

    // Prefer the snapshot's existing normalised score when the slider
    // hasn't really moved (within rounding). Avoids ECDF approximation
    // drift on the live identity case.
    const existing = findContribution(snapshot, lever);
    if (existing && Math.abs(clamped - existing.rawValue) < lever.step / 2) {
      indicatorOverrides.set(lever.indicatorId, {
        lever,
        rawValue: clamped,
        normalised: existing.normalised,
        liveNormalised,
      });
      continue;
    }

    // ECDF path: requires a baseline summary for the indicator.
    const summary = baselines?.[lever.indicatorId];
    let normalised: number;
    if (summary && summary.knots.length > 0) {
      normalised = normalisedFromSummary(clamped, summary, risingIsBad);
    } else {
      normalised = sliderToNormalised(clamped, lever, risingIsBad);
    }
    indicatorOverrides.set(lever.indicatorId, {
      lever,
      rawValue: clamped,
      normalised,
      liveNormalised,
    });
  }

  // Step 2: rebuild each pillar. Untouched pillars are returned verbatim;
  // touched pillars have their contributions rewritten with the override's
  // new normalised value, then re-aggregated as a weighted arithmetic mean.
  // When a pillar has no contributions at all (rare: stale-cache snapshot
  // from before the contributions field was populated), fall back to a
  // delta-from-live model so the simulator still reacts.
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
    newPillars[pillarId] = pillar.contributions.length === 0
      ? recomputePillarByDelta(pillar, indicatorOverrides)
      : recomputePillar(pillar, indicatorOverrides);
  }

  // Step 3: recompute the headline from the four (possibly updated) pillar
  // values via the methodology package's `computeHeadlineScore`.
  const headline = computeHeadlineScore({
    pillars: newPillars,
    sparkline90d: snapshot.headline.sparkline90d,
    updatedAt: snapshot.headline.updatedAt,
  });

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

function findContribution(snapshot: ScoreSnapshot, lever: LeverDefinition): IndicatorContribution | undefined {
  return snapshot.pillars[lever.pillar]?.contributions.find(
    (c) => c.indicatorId === lever.indicatorId,
  );
}

/**
 * Map a slider value within `[lever.min, lever.max]` to a normalised
 * pressure score in `[0, 100]` via a linear remap. Used as a fallback
 * when no baseline summary is available for the indicator.
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
    { lever: LeverDefinition; rawValue: number; normalised: number; liveNormalised: number }
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

  // Weighted arithmetic mean over the contributions, mirroring
  // `computePillarScore` in packages/methodology. Kept inline (rather than
  // calling computePillarScore directly) because the simulator needs a fast
  // recompute on every lever drag and `computePillarScore` rebuilds the full
  // contribution shape from raw IndicatorReadings. If the methodology ever
  // switches to a non-weighted-arithmetic-mean aggregator (e.g. geometric),
  // this branch must move with it — see whatIf.test.ts pin-tests.
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

/**
 * Fallback recompute used when `pillar.contributions` is empty -- a defensive
 * path for stale cached snapshots that pre-date the contributions field
 * being populated. We can't re-aggregate from contributions, so we apply a
 * delta-from-live model: every active override moves the pillar value by
 * `inPillarWeight(lever) * (overrideNormalised - liveNormalised)`. Other
 * indicators in the pillar contribute zero to the delta because they're
 * unchanged. The result is identical to `recomputePillar` in the limit
 * where the snapshot does carry contributions, and converges to the right
 * answer regardless of how many sliders are moved.
 *
 * The synthesized contributions list contains only the moved levers so
 * downstream (`paintLeverEffects`) can still report the per-lever delta.
 */
function recomputePillarByDelta(
  pillar: PillarScore,
  overrides: Map<
    string,
    { lever: LeverDefinition; rawValue: number; normalised: number; liveNormalised: number }
  >,
): PillarScore {
  let delta = 0;
  const synth: IndicatorContribution[] = [];
  for (const ov of overrides.values()) {
    if (ov.lever.pillar !== pillar.pillar) continue;
    const w = inPillarWeight(ov.lever);
    delta += w * (ov.normalised - ov.liveNormalised);
    const def = INDICATORS[ov.lever.indicatorId];
    synth.push({
      indicatorId: ov.lever.indicatorId,
      rawValue: ov.rawValue,
      rawValueUnit: def?.unit ?? "",
      zScore: 0,
      normalised: ov.normalised,
      weight: w,
      sourceId: def?.sourceId ?? "",
      observedAt: pillar.contributions[0]?.observedAt ?? "",
    });
  }
  const newValue = roundTo(clamp(pillar.value + delta, 0, 100), 1);
  const band = bandFor(newValue).id;
  return {
    ...pillar,
    contributions: synth,
    value: newValue,
    band,
  };
}

/**
 * The lever's in-pillar weight: its indicator's headline weight divided
 * by the sum of headline weights of every indicator in the same pillar.
 * Mirrors how `computePillarScore` derives `contribution.weight` server-side.
 */
function inPillarWeight(lever: LeverDefinition): number {
  const def = INDICATORS[lever.indicatorId];
  if (!def) return 0;
  let sum = 0;
  for (const i of Object.values(INDICATORS)) {
    if (i.pillar === lever.pillar) sum += i.weight;
  }
  return sum > 0 ? def.weight / sum : 0;
}

/**
 * Compute a normalised pressure score for a lever's raw value using
 * the same logic as the override path: prefer the snapshot's existing
 * contribution if present (avoids ECDF approximation drift), then ECDF
 * via the baseline summary, then linear remap of the slider domain.
 */
function normalisedForLever(
  raw: number,
  lever: LeverDefinition,
  risingIsBad: boolean,
  baselines: Record<string, BaselineSummary> | undefined,
  snapshot: ScoreSnapshot,
): number {
  const existing = findContribution(snapshot, lever);
  if (existing && Math.abs(raw - existing.rawValue) < lever.step / 2) {
    return existing.normalised;
  }
  const summary = baselines?.[lever.indicatorId];
  if (summary && summary.knots.length > 0) {
    return normalisedFromSummary(raw, summary, risingIsBad);
  }
  return sliderToNormalised(raw, lever, risingIsBad);
}

function makeHeadlineWithCarriedFields(
  computed: HeadlineScore,
  original: HeadlineScore,
  isLive: boolean,
): HeadlineScore {
  if (isLive) {
    // Round-trip: the user has not touched any slider. Pillar values are
    // unchanged so the recomputed headline is byte-equal to live; we still
    // re-attach the original deltas/editorial wholesale so the metadata
    // remains identical.
    return {
      ...original,
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
