import { describe, expect, it } from "vitest";
import { timingSafeEqual } from "../admin.js";

describe("timingSafeEqual", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqual("s3cr3t-token", "s3cr3t-token")).toBe(true);
  });

  it("returns false for different strings of equal length", () => {
    expect(timingSafeEqual("aaaaaaaa", "bbbbbbbb")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(timingSafeEqual("short", "much-longer-token")).toBe(false);
  });

  it("handles empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("", "a")).toBe(false);
  });

  it("handles prefix-vs-prefix comparisons safely", () => {
    // A prefix must not compare equal to the longer string even if every
    // byte it contains matches the start of the other.
    expect(timingSafeEqual("abcd", "abcdef")).toBe(false);
    expect(timingSafeEqual("abcdef", "abcd")).toBe(false);
  });
});
