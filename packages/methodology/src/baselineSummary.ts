/**
 * Compact serialisable summaries of an indicator's historical baseline,
 * sized for shipping to the browser. The live methodology computes a
 * pressure score by running the raw value through an empirical CDF
 * (`ecdf` in normalise.ts) over the full baseline -- typically a few
 * thousand daily observations going back to 2019. Sending those arrays
 * to the browser would inflate the page weight by ~200KB across all
 * indicators; instead we ship a fixed-size quantile sketch from which
 * the ECDF can be reproduced to within rounding.
 *
 * The summary is a sorted array of (probability, value) pairs spaced
 * at uniform probability intervals. Reproducing the ECDF for a query
 * value is a binary search + linear interpolation:
 *
 *   - if value <= summary[0].value     -> probability 0
 *   - if value >= summary[N-1].value   -> probability 1
 *   - otherwise locate the bracketing  -> linear interp on probabilities
 *
 * `KNOTS = 101` (every percentile) is more than enough; the reproduction
 * error vs the full-baseline `ecdf()` is bounded by the within-knot
 * sampling resolution which for 1500-sample baselines is ~15 samples
 * worth -- well below the 0.5pt rounding threshold the UI applies.
 */

export interface BaselineSummary {
  /** Sorted ascending. Always at least 2 entries (min, max). */
  readonly knots: readonly { p: number; v: number }[];
  /** Number of underlying baseline samples the summary was built from. */
  readonly n: number;
}

const DEFAULT_KNOTS = 101;

/**
 * Build a quantile summary from a baseline array. Empty input returns
 * `{ knots: [], n: 0 }` -- callers must treat this as "no summary
 * available" and fall back to e.g. a linear approximation.
 *
 * The knot count is an upper bound: if the baseline has fewer samples
 * than `knots`, every sample becomes its own knot (so the summary is
 * losslessly equivalent to the full baseline).
 */
export function summariseBaseline(
  baseline: readonly number[],
  knots: number = DEFAULT_KNOTS,
): BaselineSummary {
  if (baseline.length === 0) {
    return { knots: [], n: 0 };
  }
  const sorted = [...baseline].sort((a, b) => a - b);
  const n = sorted.length;
  // Cap knots at sample count -- no benefit to more knots than samples.
  const k = Math.min(knots, n);
  if (k <= 1) {
    return { knots: [{ p: 0.5, v: sorted[0]! }], n };
  }
  const out: { p: number; v: number }[] = [];
  for (let i = 0; i < k; i++) {
    const p = i / (k - 1); // 0, 1/(k-1), ..., 1
    // Match the midpoint convention of ecdf(): for sample at sorted index j,
    // its empirical probability is (j + 0.5) / n. Invert: target index
    // = p*n - 0.5, then linearly interpolate between flanking samples.
    const target = clamp(p * n - 0.5, 0, n - 1);
    const lo = Math.floor(target);
    const hi = Math.ceil(target);
    const frac = target - lo;
    const v = sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
    out.push({ p, v });
  }
  return { knots: out, n };
}

/**
 * Reproduce the empirical CDF probability for `value` using a quantile
 * summary. Mirrors `ecdf()` from normalise.ts to within rounding.
 *
 * Edge cases:
 *   - empty summary returns 0.5 (matching `ecdf([])`)
 *   - value below the min knot returns 0
 *   - value above the max knot returns 1
 *   - everything else: binary search on `v`, linear interp on `p`.
 */
export function ecdfFromSummary(value: number, summary: BaselineSummary): number {
  const knots = summary.knots;
  if (knots.length === 0) return 0.5;
  if (knots.length === 1) {
    if (value < knots[0]!.v) return 0;
    if (value > knots[0]!.v) return 1;
    return knots[0]!.p;
  }
  // Match the midpoint convention used by `ecdf()` in normalise.ts:
  //   - strictly below the min sample: p = 0
  //   - exactly at the min sample:     p = 1 / (2n)        ((below + 0.5)/n with below=0, equal=1)
  //   - exactly at the max sample:     p = 1 - 1 / (2n)
  //   - strictly above the max sample: p = 1
  // The previous implementation returned 0 for `value <= knots[0].v` and 1
  // for `value >= knots[last].v`, which silently dropped the midpoint mass
  // at the boundary. Invisible for n >> 1 (1/(2n) is sub-percent for any
  // baseline with hundreds of samples) but a 25pp error on a baseline of 2.
  const n = summary.n;
  const minMidpoint = n > 0 ? 0.5 / n : 0;
  const maxMidpoint = n > 0 ? 1 - 0.5 / n : 1;
  if (value < knots[0]!.v) return 0;
  if (value === knots[0]!.v) return minMidpoint;
  if (value > knots[knots.length - 1]!.v) return 1;
  if (value === knots[knots.length - 1]!.v) return maxMidpoint;
  // Binary search for the largest index whose v <= value.
  let lo = 0;
  let hi = knots.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (knots[mid]!.v <= value) lo = mid;
    else hi = mid;
  }
  const a = knots[lo]!;
  const b = knots[hi]!;
  const span = b.v - a.v;
  if (span === 0) return (a.p + b.p) / 2;
  const frac = (value - a.v) / span;
  return a.p + frac * (b.p - a.p);
}

/**
 * Map a raw value to a [0, 100] pressure score via the summary. The
 * `risingIsBad` direction matches `normalisedScore` from normalise.ts.
 */
export function normalisedFromSummary(
  value: number,
  summary: BaselineSummary,
  risingIsBad: boolean,
): number {
  const p = ecdfFromSummary(value, summary);
  const pressure = risingIsBad ? p : 1 - p;
  return clamp(pressure * 100, 0, 100);
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
