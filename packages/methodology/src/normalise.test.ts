import { describe, expect, it } from "vitest";
import {
  clamp,
  ecdf,
  mean,
  normalisedScore,
  stddev,
  trendSign,
  weightedArithmeticMean,
  weightedGeometricMean,
  zScore,
} from "./normalise.js";

describe("mean", () => {
  it("returns 0 for empty input", () => {
    expect(mean([])).toBe(0);
  });
  it("computes the arithmetic mean", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });
  it("handles floating point precision reasonably", () => {
    expect(mean([0.1, 0.2, 0.3])).toBeCloseTo(0.2, 10);
  });
});

describe("stddev", () => {
  it("returns 0 for fewer than two samples", () => {
    expect(stddev([])).toBe(0);
    expect(stddev([7])).toBe(0);
  });
  it("computes the population std dev", () => {
    // [2,4,4,4,5,5,7,9] textbook example, population std dev = 2
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 10);
  });
  it("is zero for a constant series", () => {
    expect(stddev([5, 5, 5, 5])).toBe(0);
  });
});

describe("zScore", () => {
  it("returns 0 for a degenerate baseline", () => {
    expect(zScore(10, [])).toBe(0);
    expect(zScore(10, [5])).toBe(0);
    expect(zScore(10, [5, 5, 5])).toBe(0);
  });
  it("maps the mean to zero", () => {
    expect(zScore(3, [1, 2, 3, 4, 5])).toBeCloseTo(0, 10);
  });
  it("maps a plus-one-sigma observation to +1", () => {
    const baseline = [2, 4, 4, 4, 5, 5, 7, 9]; // mean 5, sd 2
    expect(zScore(7, baseline)).toBeCloseTo(1, 10);
  });
});

describe("ecdf", () => {
  it("returns 0.5 for empty baseline as a neutral prior", () => {
    expect(ecdf(42, [])).toBe(0.5);
  });
  it("returns share-at-or-below with midpoint tie handling", () => {
    const baseline = [1, 2, 3, 4, 5];
    expect(ecdf(0, baseline)).toBe(0);
    expect(ecdf(5.5, baseline)).toBe(1);
    // Middle hit with midpoint convention: 2 below + 1 equal / 2 = 0.5
    expect(ecdf(3, baseline)).toBe(0.5);
  });
  it("is monotonic non-decreasing in the input", () => {
    const baseline = [10, 20, 30, 40, 50];
    const samples = [0, 15, 25, 35, 45, 55];
    let last = -1;
    for (const s of samples) {
      const p = ecdf(s, baseline);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });
});

describe("normalisedScore", () => {
  it("rising-is-bad maps a tail observation high", () => {
    const baseline = Array.from({ length: 100 }, (_, i) => i + 1);
    const score = normalisedScore(98, baseline, true);
    expect(score).toBeGreaterThan(95);
  });
  it("rising-is-bad maps a low observation low", () => {
    const baseline = Array.from({ length: 100 }, (_, i) => i + 1);
    const score = normalisedScore(2, baseline, true);
    expect(score).toBeLessThan(5);
  });
  it("direction flip inverts the score for a rising-is-good indicator", () => {
    const baseline = Array.from({ length: 100 }, (_, i) => i + 1);
    const worse = normalisedScore(2, baseline, false);
    const better = normalisedScore(99, baseline, false);
    expect(worse).toBeGreaterThan(better);
    expect(worse).toBeGreaterThan(90);
    expect(better).toBeLessThan(10);
  });
  it("clamps to [0,100]", () => {
    const s = normalisedScore(1000, [1, 2, 3], true);
    expect(s).toBeLessThanOrEqual(100);
    expect(s).toBeGreaterThanOrEqual(0);
  });
});

describe("clamp", () => {
  it("passes values inside the range through", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it("clamps below and above", () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(100, 0, 10)).toBe(10);
  });
  it("maps NaN to the lower bound defensively", () => {
    expect(clamp(Number.NaN, 0, 10)).toBe(0);
  });
});

describe("weightedArithmeticMean", () => {
  it("equals the plain mean when weights are uniform", () => {
    expect(weightedArithmeticMean([10, 20, 30], [1, 1, 1])).toBe(20);
  });
  it("weights correctly", () => {
    expect(weightedArithmeticMean([10, 90], [0.5, 0.5])).toBe(50);
    expect(weightedArithmeticMean([10, 90], [0.9, 0.1])).toBeCloseTo(18, 10);
  });
  it("throws on length mismatch", () => {
    expect(() => weightedArithmeticMean([1, 2], [1])).toThrow();
  });
  it("throws on zero-sum weights", () => {
    expect(() => weightedArithmeticMean([1, 2, 3], [0, 0, 0])).toThrow();
  });
});

describe("weightedGeometricMean", () => {
  it("equals the unweighted geometric mean when weights are uniform", () => {
    expect(weightedGeometricMean([2, 8], [1, 1])).toBeCloseTo(4, 5);
  });
  it("pulls down when any value is small (geometric mean property)", () => {
    const g = weightedGeometricMean([10, 90, 90, 90], [0.25, 0.25, 0.25, 0.25]);
    const a = (10 + 90 + 90 + 90) / 4;
    expect(g).toBeLessThan(a);
  });
  it("handles a zero value by offsetting with epsilon rather than collapsing", () => {
    const g = weightedGeometricMean([0, 50, 50, 50], [0.4, 0.3, 0.2, 0.1]);
    expect(g).toBeGreaterThan(0);
    expect(g).toBeLessThan(1);
  });
  it("throws on negative values", () => {
    expect(() => weightedGeometricMean([-1, 2], [1, 1])).toThrow();
  });
  it("throws on length mismatch or zero-sum weights", () => {
    expect(() => weightedGeometricMean([1, 2], [1])).toThrow();
    expect(() => weightedGeometricMean([1, 2], [0, 0])).toThrow();
  });
});

describe("trendSign", () => {
  it("is zero for short or flat series", () => {
    expect(trendSign([])).toBe(0);
    expect(trendSign([10])).toBe(0);
    expect(trendSign([10, 10, 10], 0.5)).toBe(0);
  });
  it("detects rises and falls", () => {
    expect(trendSign([10, 12, 14])).toBe(1);
    expect(trendSign([14, 12, 10])).toBe(-1);
  });
  it("respects the epsilon for tiny moves", () => {
    expect(trendSign([10.0, 10.1], 0.5)).toBe(0);
    expect(trendSign([10.0, 11.0], 0.5)).toBe(1);
  });
});
