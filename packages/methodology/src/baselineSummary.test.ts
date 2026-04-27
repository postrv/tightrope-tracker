import { describe, it, expect } from "vitest";
import { ecdf } from "./normalise.js";
import {
  summariseBaseline,
  ecdfFromSummary,
  normalisedFromSummary,
  type BaselineSummary,
} from "./baselineSummary.js";

describe("summariseBaseline", () => {
  it("returns an empty summary for empty input", () => {
    const s = summariseBaseline([]);
    expect(s).toEqual({ knots: [], n: 0 });
  });

  it("preserves the full baseline when knots >= n", () => {
    const baseline = [3, 1, 4, 1, 5, 9, 2, 6];
    const s = summariseBaseline(baseline, 100);
    expect(s.n).toBe(8);
    // Knots are unique probabilities, sorted by value via the index map.
    const vs = s.knots.map((k) => k.v);
    expect(vs).toEqual([...vs].slice().sort((a, b) => a - b));
  });

  it("produces sorted, monotonically non-decreasing knots", () => {
    const baseline = makeRandomBaseline(500, 42);
    const s = summariseBaseline(baseline);
    for (let i = 1; i < s.knots.length; i++) {
      expect(s.knots[i]!.p).toBeGreaterThanOrEqual(s.knots[i - 1]!.p);
      expect(s.knots[i]!.v).toBeGreaterThanOrEqual(s.knots[i - 1]!.v);
    }
  });

  it("produces 101 knots by default for a long baseline", () => {
    const s = summariseBaseline(makeRandomBaseline(2000, 7));
    expect(s.knots.length).toBe(101);
    expect(s.knots[0]!.p).toBe(0);
    expect(s.knots[100]!.p).toBe(1);
  });
});

describe("ecdfFromSummary", () => {
  it("returns 0.5 for empty summary", () => {
    expect(ecdfFromSummary(42, { knots: [], n: 0 })).toBe(0.5);
  });

  it("returns 0 below the min and 1 above the max", () => {
    const s = summariseBaseline([10, 20, 30, 40, 50]);
    expect(ecdfFromSummary(0, s)).toBe(0);
    expect(ecdfFromSummary(100, s)).toBe(1);
  });

  it("matches the full-baseline ecdf within 0.02 across the support", () => {
    const baseline = makeRandomBaseline(1500, 1234);
    const summary = summariseBaseline(baseline);
    const probes = [
      ...sampleQuantiles(baseline, 25),
      // also poke the gaps between samples
      ...interpolatedProbes(baseline, 50),
    ];
    let maxAbsDiff = 0;
    for (const v of probes) {
      const truth = ecdf(v, baseline);
      const approx = ecdfFromSummary(v, summary);
      maxAbsDiff = Math.max(maxAbsDiff, Math.abs(truth - approx));
    }
    // 101-knot summary over a 1500-sample uniform-ish baseline should be
    // tight within ~1% in probability terms.
    expect(maxAbsDiff).toBeLessThan(0.02);
  });

  it("is monotonically non-decreasing across the support", () => {
    const baseline = makeRandomBaseline(800, 99);
    const summary = summariseBaseline(baseline);
    const min = Math.min(...baseline);
    const max = Math.max(...baseline);
    let prev = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const v = min + ((max - min) * i) / 200;
      const p = ecdfFromSummary(v, summary);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = p;
    }
  });

  it("handles a degenerate single-value baseline", () => {
    const summary: BaselineSummary = summariseBaseline([5, 5, 5, 5]);
    expect(ecdfFromSummary(4, summary)).toBe(0);
    expect(ecdfFromSummary(6, summary)).toBe(1);
    // Exactly equal to the only value: implementation may return any probability
    // in [0, 1] for a flat distribution; assert it's bounded.
    const eq = ecdfFromSummary(5, summary);
    expect(eq).toBeGreaterThanOrEqual(0);
    expect(eq).toBeLessThanOrEqual(1);
  });

  it("returns 1/(2n) at the minimum sample (midpoint convention) and 1-1/(2n) at the maximum", () => {
    // Tiny baseline magnifies the boundary mass: with n=4, the minimum
    // sample's ECDF should be 1/(2*4) = 0.125, NOT 0. Previously the
    // function returned 0 at value === knots[0].v, dropping 12.5pp of
    // mass on a small baseline (and ~0.03pp on a 1500-sample one).
    const summary = summariseBaseline([10, 20, 30, 40]);
    expect(ecdfFromSummary(10, summary)).toBeCloseTo(0.125, 5);
    expect(ecdfFromSummary(40, summary)).toBeCloseTo(1 - 0.125, 5);
    // Strictly outside the support continues to return the limits.
    expect(ecdfFromSummary(5, summary)).toBe(0);
    expect(ecdfFromSummary(50, summary)).toBe(1);
  });

  it("matches the reference ecdf at the boundary samples", () => {
    // Direct cross-check against `ecdf()` from normalise.ts so any future
    // refactor of either side trips the test rather than silently drifting.
    const baseline = [3, 7, 10, 14, 19];
    const summary = summariseBaseline(baseline);
    expect(ecdfFromSummary(3, summary)).toBeCloseTo(ecdf(3, baseline), 5);
    expect(ecdfFromSummary(19, summary)).toBeCloseTo(ecdf(19, baseline), 5);
  });
});

describe("normalisedFromSummary", () => {
  it("flips direction when risingIsBad is false", () => {
    const baseline = makeRandomBaseline(400, 11);
    const summary = summariseBaseline(baseline);
    const sorted = [...baseline].sort((a, b) => a - b);
    const median = sorted[200]!;
    const top = sorted[399]!;
    // High value, risingIsBad: high pressure.
    expect(normalisedFromSummary(top, summary, true)).toBeGreaterThan(95);
    // High value, risingIsBad=false: low pressure.
    expect(normalisedFromSummary(top, summary, false)).toBeLessThan(5);
    // Median: pressure ~ 50 either way.
    expect(Math.abs(normalisedFromSummary(median, summary, true) - 50)).toBeLessThan(2);
    expect(Math.abs(normalisedFromSummary(median, summary, false) - 50)).toBeLessThan(2);
  });

  it("clamps to [0, 100]", () => {
    const summary = summariseBaseline([1, 2, 3, 4, 5]);
    expect(normalisedFromSummary(-1000, summary, true)).toBe(0);
    expect(normalisedFromSummary(1000, summary, true)).toBe(100);
  });
});

// ---------- helpers ----------

function makeRandomBaseline(n: number, seed: number): number[] {
  // Deterministic LCG so test output is stable.
  let s = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    // Map to roughly N(50, 15) via two uniforms (Irwin-Hall-ish).
    s = (s * 1664525 + 1013904223) >>> 0;
    const u1 = (s & 0xffff) / 0xffff;
    s = (s * 1664525 + 1013904223) >>> 0;
    const u2 = (s & 0xffff) / 0xffff;
    out.push(50 + 15 * (u1 + u2 - 1));
  }
  return out;
}

function sampleQuantiles(baseline: readonly number[], k: number): number[] {
  const sorted = [...baseline].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.floor((i * sorted.length) / k);
    out.push(sorted[idx]!);
  }
  return out;
}

function interpolatedProbes(baseline: readonly number[], k: number): number[] {
  const sorted = [...baseline].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.floor((i * (sorted.length - 1)) / k);
    out.push((sorted[idx]! + sorted[idx + 1]!) / 2);
  }
  return out;
}
