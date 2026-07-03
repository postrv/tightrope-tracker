import { INDICATORS } from "@tightrope/shared";
import type { Env } from "../env";
import type {
  CaptureArtifact,
  CaptureSpec,
  ExtractionResult,
  GateId,
  GateResult,
  VerificationReport,
} from "../types";
import { isEditorialKind } from "../types";
import { effectivePlausibility } from "../sources/registry";
import { runExtraction } from "./extract";
import { readLatestPublishedObservations } from "../lib/observations";

/**
 * Stage 3 — verify. Gates G1–G6 (AUTOMATION_PLAN Phase 3). Every gate is
 * deterministic except G5, which is a second, independently-framed extraction
 * compared numerically.
 *
 *   G1  quote-anchor: each value's `quote` occurs in artifact.text after
 *       whitespace normalisation (case-insensitive). A value whose quote can't
 *       be located is unpublishable, categorically.
 *   G2  schema/unit sanity: indicatorId is one the spec declares AND the
 *       extracted unit's family matches the indicator registry's unit family
 *       (a bps↔% shift is caught here). Unmapped units fail open on the unit
 *       sub-check — a classification gap must not block a real value — but the
 *       indicatorId check is always hard.
 *   G3  plausible range: spec.plausibility[indicatorId] min/max.
 *   G4  max-delta: |value − latest published observation| ≤ maxDelta (D1).
 *   G5  agreement: an independent second extraction (different prompt framing,
 *       same schema) reports a value within spec.agreementTolerance.
 *   G6  period sanity: observedAt parses, ≤ now, and strictly newer than the
 *       latest published observation's period.
 *
 * Multi-value specs (MHCLG) are AND-aggregated: a gate passes only if it
 * passes for every value; the recorded detail names the weakest value.
 *
 * CONFIDENCE FORMULA (deterministic, never model-self-reported):
 *
 *   confidence = 0.25·G1 + 0.15·G2 + 0.15·G3 + 0.15·G4 + 0.20·a5 + 0.10·G6
 *
 * where G1..G4, G6 ∈ {0,1} are the aggregate pass flags and a5 ∈ [0,1] grades
 * the G5 agreement: a5 = 0 if G5 failed, else 1 − 0.5·(worstDist/tolerance) —
 * so a pass at the tolerance edge scores 0.5, perfect agreement scores 1.0.
 * Weights sum to 1.0, so an all-pass with perfect agreement yields exactly 1.0.
 */

const GATE_WEIGHTS: Record<Exclude<GateId, "G5">, number> = { G1: 0.25, G2: 0.15, G3: 0.15, G4: 0.15, G6: 0.1 };
const G5_WEIGHT = 0.2;

export async function verifyExtraction(
  env: Env,
  spec: CaptureSpec,
  artifact: CaptureArtifact,
  extraction: ExtractionResult,
): Promise<VerificationReport> {
  if (isEditorialKind(spec.kind)) {
    return verifyEditorial(spec, artifact, extraction);
  }

  const normText = normWs(artifact.text);
  const perValue: Array<{ gates: Record<GateId, GateResult>; a5: number }> = [];

  // The G5 second extraction and the latest-published snapshot are independent,
  // so run them concurrently; and read the two-tier selector ONCE for the whole
  // verification (Map by indicator_id) rather than re-querying per value.
  const [second, latestByIndicator] = await Promise.all([
    secondExtraction(env, spec, artifact.text),
    readLatestPublishedObservations(env.DB),
  ]);

  for (const val of extraction.values) {
    const def = INDICATORS[val.indicatorId];
    const bound = effectivePlausibility(spec, val.indicatorId);
    const latest = latestByIndicator.get(val.indicatorId) ?? null;

    const quoteLocated = normText.includes(normWs(val.quote));
    const g1 = gate("G1", quoteLocated, `quote ${quoteLocated ? "located" : "NOT located"} in artefact for ${val.indicatorId}`);

    const idDeclared = spec.indicatorIds.includes(val.indicatorId);
    const unitOk = unitCompatible(val.unit, def?.unit);
    const g2 = gate(
      "G2",
      idDeclared && unitOk,
      !idDeclared
        ? `indicator ${val.indicatorId} not declared by spec`
        : unitOk
          ? `unit '${val.unit}' compatible with '${def?.unit}'`
          : `unit '${val.unit}' incompatible with indicator unit '${def?.unit}'`,
    );

    const inRange = bound ? val.value >= bound.min && val.value <= bound.max : true;
    const g3 = gate(
      "G3",
      inRange,
      bound ? `${val.value} ${inRange ? "within" : "outside"} [${bound.min}, ${bound.max}]` : `no range configured for ${val.indicatorId} (pass)`,
    );

    const delta = latest ? Math.abs(val.value - latest.value) : 0;
    const g4pass = bound ? !latest || delta <= bound.maxDelta : true;
    const g4 = gate(
      "G4",
      g4pass,
      latest ? `|Δ| ${round(delta)} vs published ${latest.value} (maxDelta ${bound?.maxDelta ?? "n/a"})` : "no prior published observation (pass)",
    );

    const g5r = evaluateG5(spec, val.indicatorId, val.value, second);
    perValue.push({
      gates: { G1: g1, G2: g2, G3: g3, G4: g4, G5: g5r.result, G6: g6PeriodSanity(val.observedAt, latest) },
      a5: g5r.a5,
    });
  }

  return aggregate(perValue);
}

function aggregate(perValue: Array<{ gates: Record<GateId, GateResult>; a5: number }>): VerificationReport {
  const ids: GateId[] = ["G1", "G2", "G3", "G4", "G5", "G6"];
  const gates: GateResult[] = [];
  const passFlags: Record<GateId, boolean> = { G1: true, G2: true, G3: true, G4: true, G5: true, G6: true };

  for (const id of ids) {
    const entries = perValue.map((pv) => pv.gates[id]);
    const allPass = entries.every((e) => e.passed);
    passFlags[id] = allPass;
    const failing = entries.find((e) => !e.passed);
    gates.push({ gate: id, passed: allPass, detail: failing ? failing.detail : entries[0]?.detail ?? "n/a" });
  }
  // Worst G5 agreement across values (0 if any value's G5 failed).
  const worstA5 = passFlags.G5 ? perValue.reduce((m, pv) => Math.min(m, pv.a5), 1) : 0;

  const confidence =
    (passFlags.G1 ? GATE_WEIGHTS.G1 : 0) +
    (passFlags.G2 ? GATE_WEIGHTS.G2 : 0) +
    (passFlags.G3 ? GATE_WEIGHTS.G3 : 0) +
    (passFlags.G4 ? GATE_WEIGHTS.G4 : 0) +
    G5_WEIGHT * (passFlags.G5 ? worstA5 : 0) +
    (passFlags.G6 ? GATE_WEIGHTS.G6 : 0);

  const passed = perValue.length > 0 && gates.every((g) => g.passed);
  return { gates, confidence: round(confidence), passed };
}

/** G5: does the second extraction agree on this indicator within tolerance? Returns the graded a5 factor ∈ [0,1]. */
function evaluateG5(
  spec: CaptureSpec,
  indicatorId: string,
  value: number,
  second: ExtractionResult | null,
): { result: GateResult; a5: number } {
  if (!second) {
    return { result: gate("G5", false, "second extraction unavailable"), a5: 0 };
  }
  const match = second.values.find((v) => v.indicatorId === indicatorId);
  if (!match) {
    return { result: gate("G5", false, `second extraction did not report ${indicatorId}`), a5: 0 };
  }
  const diff = Math.abs(value - match.value);
  const tol = spec.agreementTolerance;
  const passed = diff <= tol;
  const a5 = !passed ? 0 : tol > 0 ? 1 - 0.5 * (diff / tol) : 1;
  return {
    result: gate("G5", passed, `second extraction ${match.value} vs ${value} (|Δ| ${round(diff)}, tol ${tol})`),
    a5,
  };
}

function g6PeriodSanity(observedAt: string, latest: { observedAt: string } | null): GateResult {
  const ms = Date.parse(observedAt);
  if (!Number.isFinite(ms)) return gate("G6", false, `observedAt '${observedAt}' does not parse`);
  const now = Date.now();
  if (ms > now) return gate("G6", false, `observedAt '${observedAt}' is in the future`);
  if (latest) {
    const prevMs = Date.parse(latest.observedAt);
    if (Number.isFinite(prevMs) && ms <= prevMs) {
      return gate("G6", false, `observedAt '${observedAt}' not newer than published '${latest.observedAt}'`);
    }
  }
  return gate("G6", true, `period '${observedAt}' sane (≤ now, newer than last)`);
}

async function secondExtraction(env: Env, spec: CaptureSpec, text: string): Promise<ExtractionResult | null> {
  try {
    return await runExtraction(env, spec, text, "secondary");
  } catch (err) {
    console.warn(`G5 second extraction failed for ${spec.sourceId}: ${(err as Error)?.message ?? String(err)}`);
    return null;
  }
}

/** Editorial: G1 quote-anchor against the draft (best-effort); other gates n/a. Never auto-published anyway. */
function verifyEditorial(spec: CaptureSpec, artifact: CaptureArtifact, extraction: ExtractionResult): VerificationReport {
  const normText = normWs(artifact.text);
  const quote = typeof extraction.draft?.quote === "string" ? (extraction.draft.quote as string) : "";
  const located = quote.length > 0 && normText.includes(normWs(quote));
  const gates: GateResult[] = [
    gate("G1", located, quote ? `draft quote ${located ? "located" : "NOT located"}` : "no quote in draft"),
    gate("G2", true, "n/a — editorial draft (human-reviewed)"),
    gate("G3", true, "n/a — editorial draft"),
    gate("G4", true, "n/a — editorial draft"),
    gate("G5", true, "n/a — editorial draft"),
    gate("G6", true, "n/a — editorial draft"),
  ];
  void spec;
  // Confidence is informational for editorial (the decide stage forces 'pending').
  return { gates, confidence: located ? 0.5 : 0.25, passed: located };
}

function gate(id: GateId, passed: boolean, detail: string): GateResult {
  return { gate: id, passed, detail };
}

function normWs(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Unit-family compatibility. Maps many synonyms onto a canonical family; a
 * KNOWN-vs-KNOWN mismatch (e.g. bps vs %) fails, but an unmapped unit on either
 * side passes (fail-open on classification gaps — mirrors the plausibility
 * gate's philosophy). Exported for the gate unit tests.
 */
export function unitCompatible(extracted: string, registryUnit: string | undefined): boolean {
  const a = unitFamily(extracted);
  const b = unitFamily(registryUnit ?? "");
  if (a === "unknown" || b === "unknown") return true;
  return a === b;
}

function unitFamily(unit: string): string {
  const u = unit.trim().toLowerCase().replace(/[.]/g, "");
  if (u === "") return "unknown";
  if (/(^|[^a-z])(bps|bp|basis points?|basis point)([^a-z]|$)/.test(u)) return "bps";
  if (/percentage points?|(^|[^a-z])(pp|ppt)([^a-z]|$)/.test(u)) return "pp";
  if (/%|per ?cent|percent(age)?|net balance|balance/.test(u)) return "percent";
  if (/index|points?|pts|diffusion/.test(u)) return "index";
  if (/gbp|£|sterling|billion|(^|[^a-z])bn([^a-z]|$)|bbl/.test(u)) return "gbp";
  if (/ratio|ccy|currency/.test(u)) return "ratio";
  return "unknown";
}
