/**
 * Artefact-text shaping + a cheap pre-flight check, shared by the capture stage
 * (which truncates before handing text to the model) and the extractor (which
 * pre-checks before burning AI retries and re-truncates harder on a 5024).
 */

/**
 * Documented budget for the text handed to the extraction model, in characters.
 * htmlToText / toMarkdown output can be hundreds of KB (a Trading Economics or
 * gov.uk page is ~300KB of HTML → tens of KB of text); over-long input is the
 * main driver of the Workers-AI "5024: JSON Model couldn't be met" failures.
 * 20k chars comfortably holds a statistical release's headline + tables while
 * staying well inside the model's context. The 5024 fallback re-truncates to
 * STRICT_MODEL_TEXT_BUDGET.
 */
export const MODEL_TEXT_BUDGET = 20_000;
export const STRICT_MODEL_TEXT_BUDGET = 8_000;

/** Lines carrying a digit, a month name, a quarter token, or a stats keyword — the headline number and its period live here. */
const RELEVANT_LINE =
  /[0-9]|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b|\bq[1-4]\b|per ?cent|%|index|balance|headroom|net\b/i;

/**
 * Truncate artefact text to `budget` chars using an extraction-RELEVANCE
 * heuristic rather than blind head-truncation: keep the lines that carry the
 * data (digits / month names / stats keywords) plus one line of context either
 * side (usually the section heading), in document order. Blind head-truncation
 * risks chopping the headline figure off the top of a long nav-heavy page; this
 * keeps the numbers and drops the boilerplate. Text already within budget is
 * returned unchanged. A page with no relevant lines falls back to a head slice
 * so we never return empty.
 */
export function truncateForModel(text: string, budget: number = MODEL_TEXT_BUDGET): string {
  if (text.length <= budget) return text;

  const lines = text.split("\n");
  const keep = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (RELEVANT_LINE.test(lines[i]!)) {
      if (i > 0) keep.add(i - 1);
      keep.add(i);
      if (i + 1 < lines.length) keep.add(i + 1);
    }
  }

  const out: string[] = [];
  let size = 0;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const line = lines[i]!;
    if (size + line.length + 1 > budget) break;
    out.push(line);
    size += line.length + 1;
  }
  if (out.length === 0) return text.slice(0, budget);
  return out.join("\n");
}

export type PrecheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Cheap pre-flight over artefact text, run BEFORE any AI call for numeric
 * (observation) specs. Distinguishes "the model can't comply" from "the numbers
 * are not in this artefact" so a junk artefact (a bot-challenge stub, or an ONS
 * dataset landing page whose figure lives only in the xlsx) fails FAST with a
 * distinct error string instead of burning three schema-retries against text
 * that structurally cannot yield a value.
 *
 * Gate: the text must be non-trivial, carry at least a handful of digits, and
 * anchor to a period (a 20xx year OR a month name). This is a floor, not a
 * guarantee the RIGHT number is present — verification's gates own that.
 */
export function precheckArtefact(text: string): PrecheckResult {
  const trimmed = text.trim();
  if (trimmed.length < 40) return { ok: false, reason: "PRECHECK_EMPTY: artefact text is empty or trivially short" };

  const digitCount = (trimmed.match(/[0-9]/g) ?? []).length;
  if (digitCount < 3) {
    return { ok: false, reason: `PRECHECK_NO_DIGITS: artefact carries ${digitCount} digit(s) — the figure is not in this text` };
  }

  const hasPeriod = /\b20\d{2}\b/.test(trimmed) || /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(trimmed) || /\bq[1-4]\b/i.test(trimmed);
  if (!hasPeriod) {
    return { ok: false, reason: "PRECHECK_NO_PERIOD: artefact has no year/month/quarter token to anchor observedAt" };
  }

  return { ok: true };
}

/** True when an error message looks like the Workers-AI JSON-schema-mode give-up (5024). */
export function isSchemaModeFailure(message: string): boolean {
  return /\b5024\b/.test(message) || /json (model|mode|schema)[^.]*couldn'?t be met/i.test(message);
}
