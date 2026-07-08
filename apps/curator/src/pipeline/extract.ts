import type { Env } from "../env";
import { isEditorialKind, type CaptureArtifact, type CaptureSpec, type ExtractionResult } from "../types";
import { runModelJson, runModelText } from "../lib/ai";
import { buildPrompt, type PromptFraming } from "../lib/prompts";
import { biasForFormat, isSchemaModeFailure, precheckArtefact, STRICT_MODEL_TEXT_BUDGET, truncateForModel } from "../lib/artefactText";

const MAX_RETRIES = 2; // ≤2 retries on schema-invalid output → 3 attempts total.

/**
 * Stage 2 — extract. Runs the spec's extraction prompt against artifact.text
 * via Workers AI JSON-schema mode, then validates the shape BY HAND (repo
 * idiom, no zod) and retries up to twice on schema-invalid output before
 * failing. Editorial kinds fill `draft` and leave `values` empty.
 */
export async function extractFromArtifact(
  env: Env,
  spec: CaptureSpec,
  artifact: CaptureArtifact,
): Promise<ExtractionResult> {
  return runExtraction(env, spec, artifact.text, "primary");
}

/**
 * Shared extraction runner — exported so verify.ts can drive the independent
 * G5 second pass with a genuinely different prompt framing, same schema.
 */
export async function runExtraction(
  env: Env,
  spec: CaptureSpec,
  text: string,
  framing: PromptFraming,
): Promise<ExtractionResult> {
  // PRE-CHECK (numeric specs only): distinguish "the model can't comply" from
  // "the numbers are not in this artefact" and fail FAST with a distinct string
  // before burning three schema-retries against structurally hopeless text
  // (a bot-challenge stub, or a dataset landing page whose figure is xlsx-only).
  if (!isEditorialKind(spec.kind)) {
    const pre = precheckArtefact(text);
    if (!pre.ok) throw new Error(`extraction pre-check failed for ${spec.sourceId}: ${pre.reason}`);
  }

  // The working text shrinks on a 5024 (see below); rebuild the prompt each
  // attempt so the shorter window actually reaches the model. The shrink keeps
  // the end the artefact's format puts the newest data at (xlsx → tail).
  const bias = biasForFormat(spec.discover?.releaseFormat ?? spec.format);
  let workingText = text;
  let lastError = "no attempts";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const { messages, schema } = buildPrompt(spec, workingText, framing);
    let raw: string;
    try {
      raw = await runModelJson(env, spec.modelId, messages, schema);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      lastError = `model call failed: ${message}`;
      // On a 5024 ("JSON Model couldn't be met") the dominant cause is an
      // over-long artefact, so the NEXT attempt uses a much shorter,
      // higher-relevance window rather than re-sending the identical text.
      if (isSchemaModeFailure(message) && workingText.length > STRICT_MODEL_TEXT_BUDGET) {
        workingText = truncateForModel(workingText, STRICT_MODEL_TEXT_BUDGET, bias);
      }
      continue;
    }
    const parsed = parseAndValidate(raw, spec);
    if (parsed.ok) return parsed.value;
    lastError = parsed.error;
  }

  // Every schema-mode attempt died inside the constrained decoder itself (a
  // 5024 is a generation give-up, not a validation miss — dense numeric tables
  // trigger it at any window size). One rescue attempt WITHOUT response_format,
  // with the shape stated in the prompt instead: parseAndValidate remains the
  // gate, so this loosens generation, never acceptance.
  if (isSchemaModeFailure(lastError)) {
    const { messages } = buildPrompt(spec, workingText, framing);
    messages.push({ role: "user", content: SHAPE_INSTRUCTION });
    try {
      const parsed = parseAndValidate(await runModelText(env, spec.modelId, messages), spec);
      if (parsed.ok) return parsed.value;
      lastError = `${lastError}; schema-free fallback: ${parsed.error}`;
    } catch (err) {
      lastError = `${lastError}; schema-free fallback: ${(err as Error)?.message ?? String(err)}`;
    }
  }
  throw new Error(`extraction failed after ${MAX_RETRIES + 1} attempts for ${spec.sourceId}: ${lastError}`);
}

/** Stated output shape for the schema-free rescue — normally `response_format` carries this. */
const SHAPE_INSTRUCTION = [
  "Respond with ONLY one JSON object — no prose, no code fences — of exactly this shape:",
  '{"values":[{"indicatorId":"<id>","value":<number>,"unit":"<unit>","observedAt":"YYYY-MM-DD","quote":"<verbatim sentence>"}],"releasedAt":"<ISO date or null>","draft":<object for editorial drafts, else null>}',
].join("\n");

type ValidateResult = { ok: true; value: ExtractionResult } | { ok: false; error: string };

/** Best-effort JSON extraction: Workers AI JSON mode is documented best-effort, so tolerate stray prose around the object. */
function extractJsonObject(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function parseAndValidate(raw: string, spec: CaptureSpec): ValidateResult {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, error: "response was not a JSON object" };
  }
  const o = obj as Record<string, unknown>;

  const releasedAt = o.releasedAt === null || o.releasedAt === undefined
    ? null
    : typeof o.releasedAt === "string"
      ? o.releasedAt
      : undefined;
  if (releasedAt === undefined) return { ok: false, error: "releasedAt must be a string or null" };

  const isEditorial = isEditorialKind(spec.kind);

  if (isEditorial) {
    const draft = o.draft;
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
      return { ok: false, error: "editorial kind requires a `draft` object" };
    }
    return { ok: true, value: { values: [], releasedAt, draft: draft as Record<string, unknown> } };
  }

  // Observation kind: validate the values array strictly.
  if (!Array.isArray(o.values)) return { ok: false, error: "`values` must be an array" };
  const values: ExtractionResult["values"] = [];
  for (const raw of o.values) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "value entry must be an object" };
    const v = raw as Record<string, unknown>;
    if (typeof v.indicatorId !== "string") return { ok: false, error: "value.indicatorId must be a string" };
    if (typeof v.value !== "number" || !Number.isFinite(v.value)) return { ok: false, error: "value.value must be a finite number" };
    if (typeof v.unit !== "string") return { ok: false, error: "value.unit must be a string" };
    if (typeof v.observedAt !== "string") return { ok: false, error: "value.observedAt must be a string" };
    if (typeof v.quote !== "string" || v.quote.trim().length === 0) return { ok: false, error: "value.quote must be a non-empty string" };
    values.push({
      indicatorId: v.indicatorId,
      value: v.value,
      unit: v.unit,
      observedAt: v.observedAt,
      quote: v.quote,
    });
  }
  if (values.length === 0) return { ok: false, error: "no values extracted" };
  const draft = o.draft && typeof o.draft === "object" && !Array.isArray(o.draft) ? (o.draft as Record<string, unknown>) : null;
  return { ok: true, value: { values, releasedAt, draft } };
}
