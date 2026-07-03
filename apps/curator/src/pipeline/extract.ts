import type { Env } from "../env";
import type { CaptureArtifact, CaptureSpec, ExtractionResult } from "../types";

/**
 * Stage 2 — extract.
 *
 * Contract (AUTOMATION_PLAN Phase 3):
 * - Run the spec's extraction prompt against artifact.text via Workers AI
 *   JSON-schema mode (response_format json_schema matching
 *   ExtractionResult). Workers AI documents schema compliance as
 *   best-effort, so: validate the response shape by hand (repo idiom — no
 *   zod) and retry up to 2 times on schema-invalid output before failing.
 * - The prompt MUST require, for every value: the verbatim source sentence
 *   (`quote`), the period it refers to, and the unit. No quote → the value
 *   is unusable downstream (gate G1), so instruct the model accordingly.
 * - Prompts are keyed by sourceId + spec.promptVersion. Bump promptVersion
 *   on ANY prompt change.
 * - Editorial kinds (delivery_milestone / delivery_commitment /
 *   timeline_event) fill `draft` (cited draft copy / field patch) and leave
 *   `values` empty.
 */
export async function extractFromArtifact(
  env: Env,
  spec: CaptureSpec,
  artifact: CaptureArtifact,
): Promise<ExtractionResult> {
  void env;
  void spec;
  void artifact;
  throw new Error("TODO: implement extraction stage");
}
