import type { Env } from "../env";
import type { CaptureArtifact, CaptureSpec, ExtractionResult } from "../types";
import { runModelJson } from "../lib/ai";
import { buildPrompt, type PromptFraming } from "../lib/prompts";

const EDITORIAL_KINDS = new Set(["delivery_milestone", "delivery_commitment", "timeline_event"]);
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
  const { messages, schema } = buildPrompt(spec, text, framing);
  let lastError = "no attempts";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let raw: string;
    try {
      raw = await runModelJson(env, spec.modelId, messages, schema);
    } catch (err) {
      lastError = `model call failed: ${(err as Error)?.message ?? String(err)}`;
      continue;
    }
    const parsed = parseAndValidate(raw, spec);
    if (parsed.ok) return parsed.value;
    lastError = parsed.error;
  }
  throw new Error(`extraction failed after ${MAX_RETRIES + 1} attempts for ${spec.sourceId}: ${lastError}`);
}

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

  const isEditorial = EDITORIAL_KINDS.has(spec.kind);

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
