/**
 * Minimal RFC 5322 message builder for plain-text alert emails. Hand-rolled on
 * purpose (repo convention: no new dependencies for what a few lines cover) —
 * a single-part text/plain message needs only headers + body.
 */

const FROM_ADDRESS = "alerts@tightropetracker.uk";
const FROM_DISPLAY = "Tightrope Alerts";
const SUBJECT_MAX = 78;

export interface AlertEmail {
  from: string;
  raw: string;
  subject: string;
}

/**
 * Subject = the first non-empty line of the alert text, with the Slack `*bold*`
 * markers stripped, hard-capped for header sanity. The full text (markers
 * intact — they read fine in plain text) becomes the body.
 */
export function buildAlertEmail(text: string, to: string, now: Date): AlertEmail {
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "Tightrope alert";
  const subject = sanitizeHeader(firstLine.replaceAll("*", "").trim()).slice(0, SUBJECT_MAX);

  const headers = [
    `From: ${FROM_DISPLAY} <${FROM_ADDRESS}>`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${now.getTime()}.${crypto.randomUUID()}@tightropetracker.uk>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
  ];

  // RFC 5322 wants CRLF line endings and a blank line between headers and body.
  const raw = headers.join("\r\n") + "\r\n\r\n" + text.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n") + "\r\n";
  return { from: FROM_ADDRESS, raw, subject };
}

/** Header values must not smuggle CR/LF (header injection) or control bytes. */
function sanitizeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
}
