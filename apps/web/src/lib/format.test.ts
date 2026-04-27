import { describe, it, expect } from "vitest";
import { trendArrow, trendClass, trendDescriptor, signedDelta } from "./format.js";

const UP_ARROW = String.fromCharCode(0x25b2);
const DN_ARROW = String.fromCharCode(0x25bc);
const EM_DASH = String.fromCharCode(0x2014);

describe("trendArrow", () => {
  it("returns up arrow for positive delta above threshold", () => {
    expect(trendArrow(1.5)).toBe(UP_ARROW);
    expect(trendArrow(0.06)).toBe(UP_ARROW);
  });

  it("returns down arrow for negative delta beyond threshold", () => {
    expect(trendArrow(-1.5)).toBe(DN_ARROW);
    expect(trendArrow(-0.06)).toBe(DN_ARROW);
  });

  it("returns em dash within the flat threshold", () => {
    expect(trendArrow(0)).toBe(EM_DASH);
    expect(trendArrow(0.04)).toBe(EM_DASH);
    expect(trendArrow(-0.04)).toBe(EM_DASH);
  });

  it("respects a custom threshold", () => {
    expect(trendArrow(0.5, 1)).toBe(EM_DASH);
    expect(trendArrow(1.5, 1)).toBe(UP_ARROW);
  });
});

describe("trendClass", () => {
  it("returns up/dn/flat by sign", () => {
    expect(trendClass(2)).toBe("up");
    expect(trendClass(-2)).toBe("dn");
    expect(trendClass(0)).toBe("flat");
  });

  it("treats sub-threshold values as flat", () => {
    expect(trendClass(0.04)).toBe("flat");
    expect(trendClass(-0.04)).toBe("flat");
  });
});

describe("trendDescriptor", () => {
  it("calls a positive pressure-score delta 'worse'", () => {
    expect(trendDescriptor(2.1)).toBe("worse");
    expect(trendDescriptor(0.06)).toBe("worse");
  });

  it("calls a negative pressure-score delta 'better'", () => {
    expect(trendDescriptor(-2.1)).toBe("better");
    expect(trendDescriptor(-0.06)).toBe("better");
  });

  it("returns the empty string for sub-threshold flat moves", () => {
    expect(trendDescriptor(0)).toBe("");
    expect(trendDescriptor(0.04)).toBe("");
    expect(trendDescriptor(-0.04)).toBe("");
  });

  it("respects a custom threshold matching trendArrow", () => {
    expect(trendDescriptor(0.5, 1)).toBe("");
    expect(trendDescriptor(1.5, 1)).toBe("worse");
    expect(trendDescriptor(-1.5, 1)).toBe("better");
  });

  it("agrees in direction with trendClass on the same delta", () => {
    // The LFG complaint was about colour/direction mismatch — these three
    // helpers share a threshold and must never disagree on direction.
    const probes = [-3, -1, -0.06, -0.04, 0, 0.04, 0.06, 1, 3];
    for (const d of probes) {
      const cls = trendClass(d);
      const word = trendDescriptor(d);
      if (cls === "up") expect(word).toBe("worse");
      else if (cls === "dn") expect(word).toBe("better");
      else expect(word).toBe("");
    }
  });
});

describe("signedDelta", () => {
  it("prefixes positive values with '+'", () => {
    expect(signedDelta(2.1, 1)).toBe("+2.1");
  });

  it("renders negative values without a leading +", () => {
    expect(signedDelta(-2.1, 1)).toBe("-2.1");
  });

  it("renders zero as 0.0 with no sign", () => {
    expect(signedDelta(0, 1)).toBe("0.0");
  });
});
