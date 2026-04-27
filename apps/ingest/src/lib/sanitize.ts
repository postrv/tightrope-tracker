/**
 * SEC-14: log-injection defence.
 *
 * Strip every control character (C0 0x00–0x1F and C1 0x7F–0x9F) from a
 * string before it reaches `console.error / warn / log`. Without this an
 * attacker who controls an adapter response can:
 *   - inject CR/LF into our log to forge a fake entry on the next line,
 *   - inject ANSI escapes to recolour or erase part of the visible log,
 *   - hide their entry behind backspace / form-feed sequences.
 *
 * We keep the visible *shape* of the input by replacing each stripped
 * control byte with U+FFFD (REPLACEMENT CHARACTER) — that way an
 * operator scanning the log can still see "something was here" without
 * the runtime being affected.
 *
 * Output is also length-capped at 2 kB. Adapter errors that overflow this
 * are truncated with an ellipsis; the full error is already (a) bound to
 * `ingestion_audit.error` (truncated to 2000 chars at the call site) and
 * (b) preserved by the runtime's structured-log capture if needed.
 */

const MAX_LEN = 2048;
// Keep TAB out of the strip list if you want — but we don't, because tabs
// inside a single-line log entry break operator rendering. Easier to ban.
const CONTROL_RANGE = /[\x00-\x1F\x7F-\x9F]/g;

export function sanitizeForLog(value: unknown): string {
  // Stringify safely. JSON.stringify on undefined returns undefined, so
  // route those through String() which yields "undefined" / "null" /
  // "[object Object]" — visible-but-harmless placeholders.
  const raw = typeof value === "string" ? value : String(value);
  const stripped = raw.replace(CONTROL_RANGE, "�");
  if (stripped.length <= MAX_LEN) return stripped;
  return stripped.slice(0, MAX_LEN - 1) + "…";
}
