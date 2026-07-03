import type { Env } from "../env";
import type { CaptureArtifact, CaptureSpec, ExtractionResult, VerificationReport } from "../types";

/**
 * Stage 3 — verify. Every gate is deterministic except G5 (which is a
 * second, independently-prompted extraction — different framing, same
 * schema — compared numerically).
 *
 * Gates (AUTOMATION_PLAN Phase 3; results recorded gate-by-gate in the
 * capture row's `verification` JSON):
 *
 *   G1  quote-anchor: each value's `quote` occurs verbatim in
 *       artifact.text after whitespace normalisation. A value whose quote
 *       cannot be located is unpublishable, categorically.
 *   G2  schema/unit sanity: indicatorId is one the spec declares; unit
 *       matches the indicator registry's unit.
 *   G3  plausible range: spec.plausibility[indicatorId] min/max.
 *   G4  max-delta: |value − latest published observation| ≤ maxDelta.
 *   G5  agreement: independent second extraction within
 *       spec.agreementTolerance of the first.
 *   G6  period sanity: observedAt ≤ now, strictly newer than the latest
 *       published observation's period, and consistent with spec.cadence.
 *
 * confidence: deterministic function of gate outcomes + G5 agreement
 * distance — document the exact formula here when implementing; it must
 * not involve asking a model to self-report confidence.
 */
export async function verifyExtraction(
  env: Env,
  spec: CaptureSpec,
  artifact: CaptureArtifact,
  extraction: ExtractionResult,
): Promise<VerificationReport> {
  void env;
  void spec;
  void artifact;
  void extraction;
  throw new Error("TODO: implement verification gates G1-G6");
}
