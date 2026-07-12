/**
 * Derived-indicator capture: applyDerivation (lib/derive.ts), its integration
 * into the extraction retry loop (extract.ts parseAndValidate), the
 * component-substituted prompt brief (lib/prompts.ts), and gate behaviour on
 * derived values (pipeline/verify.ts G1 per-component anchoring; G5
 * derived-vs-derived agreement).
 */
import { describe, expect, it } from "vitest";
import type { CaptureArtifact, CaptureSpec, ExtractionResult } from "../types";
import { applyDerivation } from "../lib/derive";
import { extractFromArtifact } from "../pipeline/extract";
import { verifyExtraction } from "../pipeline/verify";
import { derivedSpec, isSecondaryFraming, makeAi, makeEnv, makeFakeDb } from "./helpers";

// Two-section artefact text mirroring capture.ts's real "=== SOURCE ==="
// assembly for a two-URL spec.
const HOUSING_TEXT = [
  "=== SOURCE: https://example.test/housing ===",
  "Housing supply: indicators of new supply, England: January to March 2026. In January to March 2026, 37,170 new build dwellings were completed (seasonally adjusted).",
  "",
  "=== SOURCE: https://example.test/planning ===",
  "Planning applications in England: January to March 2026. In the quarter, 900 major residential decisions were granted. Meanwhile, 5,800 minor residential decisions were granted by district level planning authorities.",
].join("\n");

const COMPLETIONS_QUOTE = "In January to March 2026, 37,170 new build dwellings were completed (seasonally adjusted).";
const MAJOR_QUOTE = "In the quarter, 900 major residential decisions were granted.";
const MINOR_QUOTE = "Meanwhile, 5,800 minor residential decisions were granted by district level planning authorities.";

function componentValues(): ExtractionResult["values"] {
  return [
    { indicatorId: "completions_q", value: 37_170, unit: "dwellings", observedAt: "2026-03-31", quote: COMPLETIONS_QUOTE },
    { indicatorId: "major_granted", value: 900, unit: "decisions", observedAt: "2026-03-31", quote: MAJOR_QUOTE },
    { indicatorId: "minor_granted", value: 5_800, unit: "decisions", observedAt: "2026-03-31", quote: MINOR_QUOTE },
  ];
}

function modelJson(values: ExtractionResult["values"]): string {
  return JSON.stringify({ values, releasedAt: "2026-06-19", draft: null });
}

function artifact(spec: CaptureSpec, text = HOUSING_TEXT): CaptureArtifact {
  return { spec, url: spec.urls[0]!, fetchedAt: "2026-07-12T05:00:00Z", contentSha256: "deadbeef", rawR2Key: "curator/mhclg", text };
}

describe("applyDerivation — pure function", () => {
  it("computes both derived values and attaches components", () => {
    const out = applyDerivation(derivedSpec(), componentValues());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.values).toHaveLength(2);
    const ht = out.values.find((v) => v.indicatorId === "housing_trajectory")!;
    expect(ht.value).toBeCloseTo(49.56, 2);
    expect(ht.unit).toBe("%"); // from the shared INDICATORS registry
    expect(ht.observedAt).toBe("2026-03-31");
    expect(ht.components).toHaveLength(1);
    expect(ht.quote).toBe(COMPLETIONS_QUOTE);
    const pc = out.values.find((v) => v.indicatorId === "planning_consents")!;
    expect(pc.value).toBeCloseTo(58.26, 2);
    expect(pc.components?.map((c) => c.key)).toEqual(["major_granted", "minor_granted"]);
    expect(pc.quote).toBe(`${MAJOR_QUOTE}\n${MINOR_QUOTE}`);
  });

  it("passes non-derive specs through untouched", () => {
    // exactOptionalPropertyTypes forbids `derive: undefined` — drop the key.
    const { derive: _drop, ...spec } = derivedSpec();
    const vals = componentValues();
    const out = applyDerivation(spec as CaptureSpec, vals);
    expect(out).toEqual({ ok: true, values: vals });
  });

  it("fails loud, naming the component, when one is missing", () => {
    const out = applyDerivation(derivedSpec(), componentValues().slice(0, 2)); // minor_granted missing
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/DERIVE_MISSING_COMPONENT: planning_consents\.minor_granted/);
  });

  it("fails on a duplicated component", () => {
    const vals = [...componentValues(), { indicatorId: "major_granted", value: 901, unit: "decisions", observedAt: "2026-03-31", quote: MAJOR_QUOTE }];
    const out = applyDerivation(derivedSpec(), vals);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/DERIVE_DUPLICATE_COMPONENT: planning_consents\.major_granted/);
  });

  it("fails when components of one indicator disagree on observedAt", () => {
    const vals = componentValues();
    vals[2] = { ...vals[2]!, observedAt: "2025-12-31" };
    const out = applyDerivation(derivedSpec(), vals);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/DERIVE_OBSERVEDAT_MISMATCH: planning_consents/);
    expect(out.error).toContain("minor_granted");
  });

  it("fails fast on an out-of-bounds component (the ×4 annualised misread)", () => {
    const vals = componentValues();
    vals[0] = { ...vals[0]!, value: 148_680 }; // 37,170 × 4 — must NOT fit the [5k, 100k] bound
    const out = applyDerivation(derivedSpec(), vals);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/DERIVE_COMPONENT_OUT_OF_BOUNDS: housing_trajectory\.completions_q = 148680/);
  });

  it("DROPS a model-emitted value carrying a derived id — the computed value is the only carrier", () => {
    const fabricated = { indicatorId: "housing_trajectory", value: 95, unit: "%", observedAt: "2026-03-31", quote: COMPLETIONS_QUOTE };
    const out = applyDerivation(derivedSpec(), [...componentValues(), fabricated]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const hts = out.values.filter((v) => v.indicatorId === "housing_trajectory");
    expect(hts).toHaveLength(1);
    expect(hts[0]!.value).toBeCloseTo(49.56, 2); // computed, not the fabricated 95
    expect(hts[0]!.components).toBeDefined();
  });
});

describe("derivation inside the extraction loop", () => {
  it("happy path: component model output becomes two derived values", async () => {
    const ai = makeAi({ run: () => modelJson(componentValues()) });
    const spec = derivedSpec();
    const res = await extractFromArtifact(makeEnv({ db: makeFakeDb(), ai: ai.AI }), spec, artifact(spec));
    expect(res.values).toHaveLength(2);
    expect(res.values.map((v) => v.indicatorId).sort()).toEqual(["housing_trajectory", "planning_consents"]);
    expect(ai.calls).toHaveLength(1);
  });

  it("a derivation failure consumes schema retries and does NOT trigger the schema-free rescue", async () => {
    // Model persistently omits minor_granted: 3 schema attempts, no 4th
    // rescue call (DERIVE_* is a validation miss, not a 5024).
    const ai = makeAi({ run: () => modelJson(componentValues().slice(0, 2)) });
    const spec = derivedSpec();
    await expect(extractFromArtifact(makeEnv({ db: makeFakeDb(), ai: ai.AI }), spec, artifact(spec)))
      .rejects.toThrow(/DERIVE_MISSING_COMPONENT/);
    expect(ai.calls).toHaveLength(3);
  });

  it("a retry recovers when the model completes the component set on attempt 2", async () => {
    let call = 0;
    const ai = makeAi({
      run: () => {
        call++;
        return call === 1 ? modelJson(componentValues().slice(0, 2)) : modelJson(componentValues());
      },
    });
    const spec = derivedSpec();
    const res = await extractFromArtifact(makeEnv({ db: makeFakeDb(), ai: ai.AI }), spec, artifact(spec));
    expect(res.values).toHaveLength(2);
    expect(ai.calls).toHaveLength(2);
  });

  it("coerces a thousands-separated component string in the schema-free rescue", async () => {
    const quoted = JSON.stringify({
      values: [
        { indicatorId: "completions_q", value: "37,170", unit: "dwellings", observedAt: "2026-03-31", quote: COMPLETIONS_QUOTE },
        { indicatorId: "major_granted", value: 900, unit: "decisions", observedAt: "2026-03-31", quote: MAJOR_QUOTE },
        { indicatorId: "minor_granted", value: "5,800", unit: "decisions", observedAt: "2026-03-31", quote: MINOR_QUOTE },
      ],
      releasedAt: null,
      draft: null,
    });
    const ai = makeAi({
      run: (_model, inputs) => {
        if (inputs.response_format) throw new Error("5024: JSON Model couldn't be met");
        return quoted;
      },
    });
    const spec = derivedSpec();
    const res = await extractFromArtifact(makeEnv({ db: makeFakeDb(), ai: ai.AI }), spec, artifact(spec));
    const ht = res.values.find((v) => v.indicatorId === "housing_trajectory")!;
    expect(ht.value).toBeCloseTo(49.56, 2);
    expect(ai.calls).toHaveLength(4); // 3 schema attempts + 1 rescue
  });

  it("prompts list the components, never the derived ids, with the do-not-sum block — both framings", async () => {
    const ai = makeAi({ run: () => modelJson(componentValues()) });
    const spec = derivedSpec();
    const env = makeEnv({ db: makeFakeDb(), ai: ai.AI });
    await extractFromArtifact(env, spec, artifact(spec));
    await verifyExtraction(env, spec, artifact(spec), {
      values: (applyDerivation(spec, componentValues()) as { ok: true; values: ExtractionResult["values"] }).values,
      releasedAt: null,
      draft: null,
    });
    // ai.calls[0] = primary extraction; the verify call runs the secondary framing.
    const primary = ai.calls[0]!.messages.map((m) => m.content).join("\n");
    const secondary = ai.calls.find((c) => isSecondaryFraming(c.messages))!.messages.map((m) => m.content).join("\n");
    for (const prompt of [primary, secondary]) {
      expect(prompt).toContain("completions_q");
      expect(prompt).toContain("major_granted");
      expect(prompt).toContain("minor_granted");
      expect(prompt).toContain("Do NOT sum figures");
      // The derived ids must not be presented as extraction targets. They
      // only ever appear if a component description mentions them — ours don't.
      expect(prompt).not.toContain("housing_trajectory");
      expect(prompt).not.toContain("planning_consents");
    }
  });
});

describe("derived capture persistence", () => {
  it("persists one row per derived indicator with components in the payload and the joined quote", async () => {
    const { extractVerifyPersist } = await import("../lib/sweep");
    const ai = makeAi({ run: () => modelJson(componentValues()) });
    const db = makeFakeDb();
    const env = makeEnv({ db, ai: ai.AI });
    const spec = derivedSpec({ allowAutoPublish: false });

    const rows = await extractVerifyPersist(env, spec, artifact(spec));
    expect(rows).toBe(2);
    expect(db.captures).toHaveLength(2);

    const pcRow = db.captures.find((c) => c.indicator_id === "planning_consents")!;
    expect(pcRow.value).toBeCloseTo(58.26, 2);
    expect(pcRow.quote).toBe(`${MAJOR_QUOTE}\n${MINOR_QUOTE}`);
    const payload = JSON.parse(pcRow.payload!) as { unit: string; components: Array<{ key: string; value: number; quote: string }> };
    expect(payload.unit).toBe("%");
    expect(payload.components.map((c) => c.key)).toEqual(["major_granted", "minor_granted"]);
    expect(payload.components[0]!.quote).toBe(MAJOR_QUOTE);

    const htRow = db.captures.find((c) => c.indicator_id === "housing_trajectory")!;
    const htPayload = JSON.parse(htRow.payload!) as { components: unknown[] };
    expect(htPayload.components).toHaveLength(1);
  });
});

describe("gates on derived values", () => {
  function derivedExtraction(): ExtractionResult {
    const out = applyDerivation(derivedSpec(), componentValues());
    if (!out.ok) throw new Error("fixture derivation failed");
    return { values: out.values, releasedAt: "2026-06-19", draft: null };
  }

  it("G1 passes when every component quote locates; whole report passes with confidence 1.0", async () => {
    const ai = makeAi({ run: () => modelJson(componentValues()) }); // G5 second pass agrees
    const env = makeEnv({ db: makeFakeDb(), ai: ai.AI });
    const spec = derivedSpec();
    const report = await verifyExtraction(env, spec, artifact(spec), derivedExtraction());
    expect(report.gates.find((g) => g.gate === "G1")!.passed).toBe(true);
    expect(report.gates.find((g) => g.gate === "G1")!.detail).toContain("component quote(s) located");
    expect(report.gates.find((g) => g.gate === "G5")!.passed).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.confidence).toBe(1);
  });

  it("G1 fails naming the exact component whose quote is paraphrased", async () => {
    const ai = makeAi({ run: () => modelJson(componentValues()) });
    const env = makeEnv({ db: makeFakeDb(), ai: ai.AI });
    const spec = derivedSpec();
    const ext = derivedExtraction();
    const pc = ext.values.find((v) => v.indicatorId === "planning_consents")!;
    pc.components = pc.components!.map((c) =>
      c.key === "minor_granted" ? { ...c, quote: "About five point eight thousand minor consents went through." } : c,
    );
    const report = await verifyExtraction(env, spec, artifact(spec), ext);
    const g1 = report.gates.find((g) => g.gate === "G1")!;
    expect(g1.passed).toBe(false);
    expect(g1.detail).toContain("planning_consents.minor_granted");
    expect(report.passed).toBe(false);
  });

  it("G5 compares derived-vs-derived: a disagreeing second extraction fails the gate", async () => {
    // Second pass reads completions as 40,000 → derived 53.3 vs primary 49.56
    // — outside the 0.5 tolerance.
    const disagreeing = componentValues().map((v) =>
      v.indicatorId === "completions_q" ? { ...v, value: 40_000 } : v,
    );
    const ai = makeAi({ run: () => modelJson(disagreeing) });
    const env = makeEnv({ db: makeFakeDb(), ai: ai.AI });
    const spec = derivedSpec();
    const report = await verifyExtraction(env, spec, artifact(spec), derivedExtraction());
    const g5 = report.gates.find((g) => g.gate === "G5")!;
    expect(g5.passed).toBe(false);
    expect(report.passed).toBe(false);
  });
});
