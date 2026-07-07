import { describe, expect, it } from "vitest";
import { buildAlertEmail } from "./mime";

const NOW = new Date("2026-07-07T06:30:00Z");
const TO = "operator@example.com";

describe("buildAlertEmail", () => {
  it("uses the first non-empty line, bold-stripped, as the subject", () => {
    const { subject } = buildAlertEmail("*Tightrope curator quarantine* (2026-07-07)\ndetail line", TO, NOW);
    expect(subject).toBe("Tightrope curator quarantine (2026-07-07)");
  });

  it("caps the subject at 78 chars and strips header-injection bytes", () => {
    const { subject, raw } = buildAlertEmail(`x${"y".repeat(200)}\r\nBcc: evil@example.com\nbody`, TO, NOW);
    expect(subject.length).toBeLessThanOrEqual(78);
    // The injection must never reach the HEADER block; the body may carry the
    // original text verbatim, where a "Bcc:" line is inert.
    const headerBlock = raw.split("\r\n\r\n")[0];
    expect(headerBlock).not.toContain("Bcc:");
    expect(headerBlock).not.toMatch(/Subject:.*\r\n\s*Bcc/);
  });

  it("produces CRLF line endings and a header/body separator", () => {
    const { raw } = buildAlertEmail("subject line\nbody line one\nbody line two", TO, NOW);
    expect(raw).toContain("\r\n\r\nsubject line\r\nbody line one\r\nbody line two\r\n");
    expect(raw).toContain('Content-Type: text/plain; charset="utf-8"');
    expect(raw).toContain("From: Tightrope Alerts <alerts@tightropetracker.uk>");
    expect(raw).toContain(`To: <${TO}>`);
  });

  it("falls back to a default subject for whitespace-only text", () => {
    const { subject } = buildAlertEmail("\n\n  \nactual body", TO, NOW);
    expect(subject).toBe("actual body");
  });
});
