/**
 * SEC-14 home tests for the shared log-injection defence. The ingest
 * `sanitize.test.ts` still exercises the same surface through its re-export;
 * this pins the behaviour at its new home in `@tightrope/shared`.
 */
import { describe, expect, it } from "vitest";
import { sanitizeForLog } from "./sanitize.js";

describe("sanitizeForLog (shared home)", () => {
  it("returns plain printable text unchanged", () => {
    expect(sanitizeForLog("status=503 sourceId=ons_psf")).toBe("status=503 sourceId=ons_psf");
    expect(sanitizeForLog("£23.6bn — OBR forecast")).toBe("£23.6bn — OBR forecast");
  });

  it("strips CR / LF / TAB / ANSI so an attacker cannot forge log lines", () => {
    expect(sanitizeForLog("real\nspoofed")).not.toContain("\n");
    expect(sanitizeForLog("real\rspoofed")).not.toContain("\r");
    expect(sanitizeForLog("a\tb")).not.toContain("\t");
    expect(sanitizeForLog("\x1b[31mred\x1b[0m")).not.toContain("\x1b");
  });

  it("caps output length at 2 kB", () => {
    const out = sanitizeForLog("a".repeat(10_000));
    expect(out.length).toBeLessThanOrEqual(2048);
    expect(out.endsWith("…")).toBe(true);
  });

  it("stringifies non-string inputs (defence in depth)", () => {
    expect(sanitizeForLog(undefined as unknown as string)).toBe("undefined");
    expect(sanitizeForLog(42 as unknown as string)).toBe("42");
  });
});
