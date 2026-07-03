import type { Env } from "../env";
import type { CaptureArtifact, CaptureSpec } from "../types";

/**
 * Stage 1 — capture.
 *
 * Contract (AUTOMATION_PLAN Phase 3):
 * - Fetch the spec's artefact(s). Plain `fetch` with the same browser-ish
 *   UA discipline as packages/data-sources/src/lib/errors.ts::fetchOrThrow.
 * - sha256 the raw bytes. If the hash equals the previous capture's
 *   content_sha256 for this source (idx_curator_captures_dedupe) and
 *   `force` is false, return "unchanged" — no extraction, no AI spend.
 * - Archive raw bytes to R2: curator/{sourceId}/{yyyy-mm-dd}-{sha8}.{ext}.
 * - Produce the text form for the model: HTML → stripped text (hand-rolled,
 *   match repo idiom — no cheerio); PDF → markdown via the Workers AI
 *   conversion utility (env.AI.toMarkdown — verify availability at
 *   implementation time; if unavailable, document the chosen fallback in
 *   this header).
 *
 * Failure mode: throw — the sweep runner wraps each spec (one source's
 * failure never aborts the sweep) and records a failed capture row.
 */
export async function captureSource(
  env: Env,
  spec: CaptureSpec,
  opts: { force: boolean },
): Promise<CaptureArtifact | "unchanged"> {
  void env;
  void spec;
  void opts;
  throw new Error("TODO: implement capture stage");
}
