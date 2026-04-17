/**
 * Pure, dependency-free numeric helpers used by the Tightrope scoring
 * pipeline. Each function is referentially transparent so the same
 * implementation can run in the site, the API Worker, and the ingest Worker
 * and always return the same number.
 */

/** Population mean. Returns 0 for empty input -- callers should filter first. */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Population standard deviation. Returns 0 when fewer than 2 samples. */
export function stddev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) {
    const d = x - m;
    acc += d * d;
  }
  return Math.sqrt(acc / xs.length);
}

/** z-score of `value` against a baseline sample. Returns 0 if baseline is degenerate. */
export function zScore(value: number, baseline: readonly number[]): number {
  const m = mean(baseline);
  const s = stddev(baseline);
  if (s === 0) return 0;
  return (value - m) / s;
}

/**
 * Empirical cumulative distribution function: the share of baseline samples
 * at or below `value`, returned as a probability in [0,1].
 *
 * Baseline is assumed to be an arbitrary unordered set of observations --
 * we sort internally. We use the midpoint convention for ties so an exact
 * match to the baseline centre returns exactly 0.5 when symmetric.
 */
export function ecdf(value: number, baseline: readonly number[]): number {
  if (baseline.length === 0) return 0.5;
  const sorted = [...baseline].sort((a, b) => a - b);
  let below = 0;
  let equal = 0;
  for (const b of sorted) {
    if (b < value) below += 1;
    else if (b === value) equal += 1;
    else break;
  }
  return (below + equal / 2) / sorted.length;
}

/**
 * Map a raw indicator value to a pressure score in [0, 100] using the ECDF.
 *
 * @param value     the current raw reading
 * @param baseline  historical samples (excluding outlier windows)
 * @param risingIsBad when true, higher raw value implies higher pressure.
 *                    When false, the direction is flipped so a higher raw
 *                    reading produces a lower pressure score.
 */
export function normalisedScore(
  value: number,
  baseline: readonly number[],
  risingIsBad: boolean,
): number {
  const p = ecdf(value, baseline);
  const pressure = risingIsBad ? p : 1 - p;
  return clamp(pressure * 100, 0, 100);
}

/** Clamp `n` to the inclusive range [lo, hi]. */
export function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/** Weighted arithmetic mean. Throws if weights sum to zero. */
export function weightedArithmeticMean(values: readonly number[], weights: readonly number[]): number {
  if (values.length !== weights.length) {
    throw new Error(`weightedArithmeticMean: values(${values.length}) and weights(${weights.length}) must match`);
  }
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    const w = weights[i]!;
    num += v * w;
    den += w;
  }
  if (den === 0) throw new Error("weightedArithmeticMean: weights sum to zero");
  return num / den;
}

/**
 * Weighted geometric mean of a set of positive values. We offset by a tiny
 * epsilon so a single pillar score of 0 does not force the headline to 0 --
 * the geometric mean is still highly sensitive to small values but remains
 * numerically stable.
 */
export function weightedGeometricMean(values: readonly number[], weights: readonly number[]): number {
  if (values.length !== weights.length) {
    throw new Error(`weightedGeometricMean: values(${values.length}) and weights(${weights.length}) must match`);
  }
  const EPS = 1e-6;
  let logSum = 0;
  let weightSum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    const w = weights[i]!;
    if (v < 0) throw new Error(`weightedGeometricMean: negative value at index ${i}`);
    logSum += w * Math.log(v + EPS);
    weightSum += w;
  }
  if (weightSum === 0) throw new Error("weightedGeometricMean: weights sum to zero");
  return Math.exp(logSum / weightSum) - EPS;
}

/**
 * Rank-style scalar useful for sparkline trend arrows: +1 if overall rising,
 * -1 if overall falling, 0 if flat within `epsilon`.
 */
export function trendSign(series: readonly number[], epsilon = 0.5): 1 | 0 | -1 {
  if (series.length < 2) return 0;
  const first = series[0]!;
  const last = series[series.length - 1]!;
  const delta = last - first;
  if (Math.abs(delta) < epsilon) return 0;
  return delta > 0 ? 1 : -1;
}
