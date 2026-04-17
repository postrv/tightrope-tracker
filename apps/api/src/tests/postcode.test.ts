import { describe, expect, it } from "vitest";
import { normalisePostcode } from "../handlers/mp.js";

describe("normalisePostcode", () => {
  it("accepts canonical form with space", () => {
    expect(normalisePostcode("EX4 4QJ")).toEqual({ full: "EX4 4QJ", outward: "EX4" });
  });

  it("accepts lowercase with no space", () => {
    expect(normalisePostcode("ex44qj")).toEqual({ full: "EX4 4QJ", outward: "EX4" });
  });

  it("accepts mixed case with extra whitespace", () => {
    expect(normalisePostcode("  sW1a 1aA ")).toEqual({ full: "SW1A 1AA", outward: "SW1A" });
  });

  it("handles single-letter outward", () => {
    expect(normalisePostcode("M1 1AE")).toEqual({ full: "M1 1AE", outward: "M1" });
  });

  it("handles four-char outward (letters-digit-letter)", () => {
    expect(normalisePostcode("EC1A 1BB")).toEqual({ full: "EC1A 1BB", outward: "EC1A" });
  });

  it("rejects garbage", () => {
    expect(normalisePostcode("")).toBeNull();
    expect(normalisePostcode("hello")).toBeNull();
    expect(normalisePostcode("99999")).toBeNull();
    // Missing inward digit prefix.
    expect(normalisePostcode("EX4 QJA")).toBeNull();
  });

  it("rejects non-string input", () => {
    // @ts-expect-error - defensive check
    expect(normalisePostcode(undefined)).toBeNull();
  });
});
