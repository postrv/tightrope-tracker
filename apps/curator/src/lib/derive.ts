import { INDICATORS, sanitizeForLog } from "@tightrope/shared";
import type { CaptureSpec, ExtractionResult } from "../types";

/**
 * Derived-indicator computation over extracted raw components.
 *
 * Runs inside extract.ts's parseAndValidate (NOT as a separate pipeline
 * stage) so every extraction path inherits it identically: the schema-retry
 * loop, the 5024 shrink-window retries, the schema-free rescue, and —
 * critically — gate G5's independent second extraction, which calls
 * runExtraction directly and matches values by indicatorId. Deriving here
 * means both framings return values on the derived scale, so G5 compares
 * derived-vs-derived with zero changes to verify.ts's matching logic.
 *
 * A derivation failure is returned as a validation error (the DERIVE_*
 * strings below), which the retry loop treats exactly like schema-invalid
 * output: model non-compliance gets re-rolled. DERIVE_* errors are not
 * 5024s, so they never trigger the schema-free rescue — same behaviour as
 * any other validation miss.
 */

export type DerivationOutcome =
  | { ok: true; values: ExtractionResult["values"] }
  | { ok: false; error: string };

/**
 * Apply a spec's `derive` config to the model's validated values.
 *
 * Partitions the values three ways:
 *   - component values (indicatorId matches a ComponentSpec.key) — consumed
 *     by the derivation;
 *   - direct values (indicatorId ∈ spec.indicatorIds and not derive-covered)
 *     — passed through untouched, for future mixed specs;
 *   - everything else — DROPPED with a warn. This includes a model-emitted
 *     value carrying a derived id itself: passing it through would let a
 *     fabricated ratio ride in on a locatable-but-unrelated quote (G1 only
 *     checks the quote locates, not that the value appears in it), which is
 *     precisely the failure mode derived capture exists to kill. The
 *     computed value is the only carrier of a derived indicatorId.
 *
 * Per derived indicator: every component present exactly once, inside its
 * sanity bounds, sharing one observedAt; compute() must return a finite
 * number. Failures are loud, distinct, and name the component (the
 * PRECHECK_ idiom), so an audit row reads as a diagnosis.
 */
export function applyDerivation(
  spec: CaptureSpec,
  values: ExtractionResult["values"],
): DerivationOutcome {
  const derive = spec.derive;
  if (!derive || Object.keys(derive).length === 0) return { ok: true, values };

  // key → derived indicator id owning it. Registry tests enforce uniqueness.
  const componentOwner = new Map<string, string>();
  for (const [indicatorId, d] of Object.entries(derive)) {
    for (const c of d.components) componentOwner.set(c.key, indicatorId);
  }

  const componentValues = new Map<string, ExtractionResult["values"]>();
  const direct: ExtractionResult["values"] = [];
  for (const v of values) {
    if (componentOwner.has(v.indicatorId)) {
      const owner = componentOwner.get(v.indicatorId)!;
      componentValues.set(owner, [...(componentValues.get(owner) ?? []), v]);
    } else if (spec.indicatorIds.includes(v.indicatorId) && !derive[v.indicatorId]) {
      direct.push(v);
    } else {
      // SEC-14: indicatorId is model output — sanitise before it hits a log line.
      console.warn(
        `derive: dropping model value '${sanitizeForLog(v.indicatorId)}' for ${spec.sourceId} — ${derive[v.indicatorId] ? "derived ids are computed, never extracted" : "not a declared indicator or component"}`,
      );
    }
  }

  const derived: ExtractionResult["values"] = [];
  for (const [indicatorId, d] of Object.entries(derive)) {
    const got = componentValues.get(indicatorId) ?? [];
    const byKey: Record<string, number> = {};
    const components: NonNullable<ExtractionResult["values"][number]["components"]> = [];

    for (const c of d.components) {
      const matches = got.filter((v) => v.indicatorId === c.key);
      if (matches.length === 0) {
        return { ok: false, error: `DERIVE_MISSING_COMPONENT: ${indicatorId}.${c.key} not reported` };
      }
      if (matches.length > 1) {
        return { ok: false, error: `DERIVE_DUPLICATE_COMPONENT: ${indicatorId}.${c.key} reported ${matches.length} times` };
      }
      const m = matches[0]!;
      if ((c.min !== undefined && m.value < c.min) || (c.max !== undefined && m.value > c.max)) {
        return {
          ok: false,
          error: `DERIVE_COMPONENT_OUT_OF_BOUNDS: ${indicatorId}.${c.key} = ${m.value} outside [${c.min ?? "-∞"}, ${c.max ?? "∞"}]`,
        };
      }
      byKey[c.key] = m.value;
      components.push({ key: c.key, value: m.value, unit: m.unit, observedAt: m.observedAt, quote: m.quote });
    }

    // All components of ONE derived indicator must describe the same period.
    // (Different derived indicators may legitimately differ — the two MHCLG
    // collections have published weeks apart.)
    const observedAt = components[0]!.observedAt;
    const mismatch = components.find((c) => c.observedAt !== observedAt);
    if (mismatch) {
      return {
        ok: false,
        error: `DERIVE_OBSERVEDAT_MISMATCH: ${indicatorId} components disagree (${observedAt} vs ${mismatch.observedAt} for ${mismatch.key})`,
      };
    }

    const value = d.compute(byKey);
    if (!Number.isFinite(value)) {
      return { ok: false, error: `DERIVE_NON_FINITE: ${indicatorId} compute() returned ${value}` };
    }

    derived.push({
      indicatorId,
      value,
      // Unit comes from the shared registry — the derived scale is the
      // published indicator's scale by definition; no spec field to drift.
      unit: INDICATORS[indicatorId]?.unit ?? "%",
      observedAt,
      quote: components.map((c) => c.quote).join("\n"),
      components,
    });
  }

  return { ok: true, values: [...derived, ...direct] };
}
