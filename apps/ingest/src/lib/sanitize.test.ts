/**
 * SEC-14: anti log-injection. The DLQ consumer logs attacker-controlled
 * strings (adapter error messages, source URLs, payload text) via
 * console.error. Those logs flow into Cloudflare observability and from
 * there into operator dashboards / on-call alerts; an unsanitised CR/LF
 * or ANSI escape can fake a log line, hide entries, or break terminal
 * rendering.
 *
 * `sanitizeForLog` strips every control character (0x00–0x1F, 0x7F–0x9F)
 * and replaces it with U+FFFD (REPLACEMENT CHARACTER) so the visible
 * shape of the input is preserved without injecting structural bytes.
 */
import { describe, expect, it } from "vitest";
import { sanitizeForLog } from "./sanitize.js";

describe("sanitizeForLog", () => {
  it("returns plain printable ASCII unchanged", () => {
    expect(sanitizeForLog("hello world")).toBe("hello world");
    expect(sanitizeForLog("status=503 sourceId=ons_psf")).toBe("status=503 sourceId=ons_psf");
  });

  it("preserves UTF-8 letters / digits / punctuation outside the control range", () => {
    expect(sanitizeForLog("£23.6bn — OBR forecast")).toBe("£23.6bn — OBR forecast");
    expect(sanitizeForLog("häkkinen → 1998")).toBe("häkkinen → 1998");
  });

  it("strips CR / LF / TAB so an attacker cannot inject fake log lines", () => {
    // The classic vector: a malicious adapter returns
    // "real-error\n2026-04-27 INFO: spoofed entry"
    // and the second line shows up looking like a legitimate log.
    expect(sanitizeForLog("real-error\nspoofed entry")).not.toContain("\n");
    expect(sanitizeForLog("real-error\rspoofed entry")).not.toContain("\r");
    expect(sanitizeForLog("a\tb")).not.toContain("\t");
  });

  it("strips ANSI escape (U+001B) so terminal control sequences cannot recolour / clear lines", () => {
    expect(sanitizeForLog("\x1b[31mfake red\x1b[0m text")).not.toContain("\x1b");
  });

  it("strips C0 (0x00–0x1F) and C1 (0x7F–0x9F) control ranges", () => {
    const allControls = [];
    for (let cp = 0x00; cp <= 0x1f; cp++) allControls.push(String.fromCharCode(cp));
    for (let cp = 0x7f; cp <= 0x9f; cp++) allControls.push(String.fromCharCode(cp));
    const input = "x" + allControls.join("") + "y";
    const out = sanitizeForLog(input);
    expect(out.startsWith("x")).toBe(true);
    expect(out.endsWith("y")).toBe(true);
    // Every control byte was stripped or replaced; none remain.
    for (let cp = 0x00; cp <= 0x1f; cp++) {
      expect(out).not.toContain(String.fromCharCode(cp));
    }
    for (let cp = 0x7f; cp <= 0x9f; cp++) {
      expect(out).not.toContain(String.fromCharCode(cp));
    }
  });

  it("caps the output length so a megabyte adapter error can't blow the log entry", () => {
    const big = "a".repeat(10_000);
    const out = sanitizeForLog(big);
    expect(out.length).toBeLessThanOrEqual(2048);
    expect(out.endsWith("…")).toBe(true);
  });

  it("handles non-string inputs by stringifying first (defence in depth)", () => {
    expect(sanitizeForLog(undefined as unknown as string)).toBe("undefined");
    expect(sanitizeForLog(null as unknown as string)).toBe("null");
    expect(sanitizeForLog(42 as unknown as string)).toBe("42");
    expect(sanitizeForLog({ a: 1 } as unknown as string)).toBe("[object Object]");
  });
});
