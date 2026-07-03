import { INDICATORS } from "@tightrope/shared";
import { isEditorialKind, type CaptureSpec } from "../types";

/**
 * Extraction prompts, keyed by (sourceId, promptVersion).
 *
 * Design: the prompt text is DERIVED deterministically from the CaptureSpec
 * (its indicatorIds, kind, cadence) plus the indicator registry (units,
 * labels), so a source's prompt is fully reproducible from `(sourceId,
 * promptVersion)` — the two fields stamped on every capture row. Bump
 * `spec.promptVersion` on ANY wording change so historical rows stay
 * interpretable.
 *
 * Every prompt DEMANDS, per value: the verbatim source sentence (`quote`), the
 * period the value refers to (`observedAt`), and the unit — and forbids
 * inventing anything not present in the text. A value with no locatable quote
 * is unpublishable downstream (gate G1), so the instruction is load-bearing,
 * not decorative.
 */

export type PromptFraming = "primary" | "secondary";

export interface BuiltPrompt {
  messages: Array<{ role: string; content: string }>;
  schema: Record<string, unknown>;
}

/** JSON schema mirroring ExtractionResult (validated by hand in extract.ts too). */
function extractionSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      values: {
        type: "array",
        items: {
          type: "object",
          properties: {
            indicatorId: { type: "string" },
            value: { type: "number" },
            unit: { type: "string" },
            observedAt: { type: "string" },
            quote: { type: "string" },
          },
          required: ["indicatorId", "value", "unit", "observedAt", "quote"],
        },
      },
      releasedAt: { type: ["string", "null"] },
      draft: { type: ["object", "null"] },
    },
    required: ["values", "releasedAt", "draft"],
  };
}

function indicatorBrief(spec: CaptureSpec): string {
  return spec.indicatorIds
    .map((id) => {
      const def = INDICATORS[id];
      if (!def) return `- ${id}`;
      return `- ${id}: "${def.label}" measured in ${def.unit}. ${def.description}`;
    })
    .join("\n");
}

function cadenceHint(spec: CaptureSpec): string {
  switch (spec.cadence) {
    case "monthly":
      return "This source publishes monthly. observedAt is the reference month (use the last calendar day of that month, ISO date).";
    case "quarterly":
      return "This source publishes quarterly. observedAt is the last calendar day of the reference quarter (ISO date).";
    case "biannual":
      return "This source publishes roughly twice a year. observedAt is the reference period the figure forecasts or reports (ISO date).";
    case "trading-daily":
      return "This source publishes each trading day. observedAt is the trading date (ISO date).";
    case "event":
      return "This source publishes on an irregular event schedule. observedAt is the reference period the figure applies to (ISO date).";
  }
}

/** The shared instruction block that makes the quote/period/unit contract binding. */
function contractRules(): string {
  return [
    "RULES (non-negotiable):",
    "1. For every value, `quote` MUST be the exact, verbatim sentence from the text that contains the number — copied character-for-character, not paraphrased or summarised. If you cannot find a verbatim sentence containing the number, DO NOT emit that value.",
    "2. `observedAt` is the period the number refers to, as an ISO-8601 date (YYYY-MM-DD).",
    "3. `unit` is the unit as the source expresses it (e.g. 'index', '%', 'GBP bn').",
    "4. Invent NOTHING. Every field must be grounded in the supplied text. If the artefact does not clearly state a value for an indicator, omit it rather than guess.",
    "5. `releasedAt` is the artefact's own publication date if it states one, else null.",
  ].join("\n");
}

/** Editorial draft prompt: cited draft copy / field patch, no numeric `values`. */
function buildEditorialPrompt(spec: CaptureSpec, text: string): BuiltPrompt {
  const system = [
    "You are an editorial research assistant for a UK economic-accountability tracker.",
    "You read an official announcement / release and produce a CITED DRAFT for human review.",
    "You never publish; a human approves everything you draft. Cite the exact source sentence for every claim.",
    "Return `values` as an empty array and put your draft in `draft`. Invent nothing.",
  ].join(" ");

  const kindGuidance: Record<string, string> = {
    delivery_milestone:
      "Draft an updated editorial assessment for the delivery milestone(s) this source covers. In `draft`, include: {indicatorId, proposedValue (0-100 percent-of-milestones), rationale, quote (verbatim), sourceUrl}.",
    delivery_commitment:
      "Draft a field patch for a delivery-scorecard commitment. In `draft`, include: {id?, latest?, status? (on_track|slipping|missed|shipped), notes?, source_url?, source_label?, quote (verbatim)}. Only include fields the text supports.",
    timeline_event:
      "Assess whether this announcement is a material timeline event worth publishing, and if so draft it. In `draft`, include: {relevant (boolean), eventDate (ISO), title, summary, category, sourceLabel, sourceUrl, quote (verbatim)}. Set relevant=false for routine/immaterial items.",
  };

  const user = [
    kindGuidance[spec.kind] ?? "Draft a cited summary for review.",
    "",
    contractRules(),
    "",
    "SOURCE TEXT:",
    text,
  ].join("\n");

  return { messages: [{ role: "system", content: system }, { role: "user", content: user }], schema: extractionSchema() };
}

/** Numeric observation prompt. `framing` picks primary vs the G5 second pass. */
function buildObservationPrompt(spec: CaptureSpec, text: string, framing: PromptFraming): BuiltPrompt {
  const schema = extractionSchema();

  if (framing === "secondary") {
    // Genuinely different framing for gate G5: a terse, extraction-auditor
    // persona told to work backwards from the quote to the number, so an
    // agreement is not just the same prompt re-run. Same schema, same rules.
    const system =
      "You are a meticulous fact-checker. You are given the text of an official statistical release. Your job is to LOCATE the headline figure(s) for the named indicator(s) and report each one strictly as printed.";
    const user = [
      `Find, in the text below, the current headline figure for each of these indicators, and nothing else:`,
      indicatorBrief(spec),
      "",
      "Work quote-first: find the sentence that prints the number, copy it verbatim into `quote`, then read the number out of that sentence into `value`. Do not compute, round, or convert.",
      cadenceHint(spec),
      "",
      contractRules(),
      "",
      "TEXT:",
      text,
    ].join("\n");
    return { messages: [{ role: "system", content: system }, { role: "user", content: user }], schema };
  }

  const system = [
    "You are a data-extraction assistant for a UK economic-accountability tracker.",
    "You read an official statistical release and extract the current headline figure(s) for a fixed set of indicators, each anchored to a verbatim quote.",
    "You output strict JSON only. You invent nothing.",
  ].join(" ");
  const user = [
    "Extract the latest headline value for each of these indicators from the release text:",
    indicatorBrief(spec),
    "",
    cadenceHint(spec),
    "",
    contractRules(),
    "",
    "RELEASE TEXT:",
    text,
  ].join("\n");
  return { messages: [{ role: "system", content: system }, { role: "user", content: user }], schema };
}

/** Build the prompt for a spec + framing: editorial draft vs numeric observation. */
export function buildPrompt(spec: CaptureSpec, text: string, framing: PromptFraming): BuiltPrompt {
  if (isEditorialKind(spec.kind)) return buildEditorialPrompt(spec, text);
  return buildObservationPrompt(spec, text, framing);
}
