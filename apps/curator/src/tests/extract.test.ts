import { describe, expect, it } from "vitest";
import type { CaptureArtifact, CaptureSpec } from "../types";
import { extractFromArtifact } from "../pipeline/extract";
import { makeAi, makeEnv, makeFakeDb, observationSpec } from "./helpers";

function artifact(spec: CaptureSpec, text = "The UK Services PMI registered 48.8 in June 2026."): CaptureArtifact {
  return { spec, url: spec.urls[0]!, fetchedAt: "2026-07-01T05:00:00Z", contentSha256: "deadbeefcafe", rawR2Key: "curator/x", text };
}

const GOOD = JSON.stringify({
  values: [{ indicatorId: "services_pmi", value: 48.8, unit: "index", observedAt: "2026-06-30", quote: "The UK Services PMI registered 48.8 in June 2026." }],
  releasedAt: "2026-07-03",
  draft: null,
});

describe("extract — JSON mode + validation + retry", () => {
  it("returns a validated ExtractionResult on a good response", async () => {
    const ai = makeAi({ run: () => GOOD });
    const res = await extractFromArtifact(makeEnv({ db: makeFakeDb(), ai: ai.AI }), observationSpec(), artifact(observationSpec()));
    expect(res.values).toHaveLength(1);
    expect(res.values[0]!.value).toBe(48.8);
    expect(res.releasedAt).toBe("2026-07-03");
    expect(ai.calls).toHaveLength(1);
  });

  it("retries on malformed JSON and succeeds on the next attempt", async () => {
    let n = 0;
    const ai = makeAi({ run: () => (n++ === 0 ? "sorry, here you go: {broken" : GOOD) });
    const res = await extractFromArtifact(makeEnv({ db: makeFakeDb(), ai: ai.AI }), observationSpec(), artifact(observationSpec()));
    expect(res.values[0]!.value).toBe(48.8);
    expect(ai.calls).toHaveLength(2); // one malformed, one good
  });

  it("tolerates prose around a valid JSON object (best-effort extraction)", async () => {
    const ai = makeAi({ run: () => `Here is the result:\n${GOOD}\nHope that helps.` });
    const res = await extractFromArtifact(makeEnv({ db: makeFakeDb(), ai: ai.AI }), observationSpec(), artifact(observationSpec()));
    expect(res.values[0]!.value).toBe(48.8);
  });

  it("throws after exhausting retries on persistently invalid output", async () => {
    const ai = makeAi({ run: () => "{not valid" });
    await expect(
      extractFromArtifact(makeEnv({ db: makeFakeDb(), ai: ai.AI }), observationSpec(), artifact(observationSpec())),
    ).rejects.toThrow(/extraction failed after 3 attempts/);
    expect(ai.calls).toHaveLength(3); // 1 + 2 retries
  });

  it("rejects a value with a missing/empty quote (G1 would be impossible)", async () => {
    const ai = makeAi({ run: () => JSON.stringify({ values: [{ indicatorId: "services_pmi", value: 48.8, unit: "index", observedAt: "2026-06-30", quote: "" }], releasedAt: null, draft: null }) });
    await expect(
      extractFromArtifact(makeEnv({ db: makeFakeDb(), ai: ai.AI }), observationSpec(), artifact(observationSpec())),
    ).rejects.toThrow(/quote/);
  });

  it("fails FAST with a distinct pre-check error, before any AI call, on a numberless artefact", async () => {
    // A bot-challenge stub / JS-gated page: no figure can possibly be extracted,
    // so we must NOT burn three schema-retries against it.
    const ai = makeAi({ run: () => GOOD });
    const spec = observationSpec();
    await expect(
      extractFromArtifact(makeEnv({ db: makeFakeDb(), ai: ai.AI }), spec, artifact(spec, "This page requires JavaScript. Please enable cookies to continue.")),
    ).rejects.toThrow(/pre-check failed.*PRECHECK_NO_DIGITS/);
    expect(ai.calls).toHaveLength(0); // zero AI spend on a hopeless artefact
  });

  it("on a 5024, retries once with a SHORTER artefact window before the next attempt", async () => {
    const longText = [
      ...Array.from({ length: 400 }, (_, i) => `Row ${i}: services index ${40 + (i % 20)}.${i % 10} in June 2026`),
      "The UK Services PMI registered 48.8 in June 2026.",
    ].join("\n");
    let call = 0;
    const ai = makeAi({
      run: () => {
        call += 1;
        if (call === 1) throw new Error("5024: JSON Model couldn't be met");
        return GOOD;
      },
    });
    const spec = observationSpec();
    const res = await extractFromArtifact(makeEnv({ db: makeFakeDb(), ai: ai.AI }), spec, artifact(spec, longText));
    expect(res.values[0]!.value).toBe(48.8);
    expect(ai.calls).toHaveLength(2);
    const len = (c: (typeof ai.calls)[number]) => c.messages.map((m) => m.content).join("").length;
    expect(len(ai.calls[1]!)).toBeLessThan(len(ai.calls[0]!)); // window shrank after the 5024
  });

  it("rescues a persistent 5024 with a schema-free attempt, hand-validated", async () => {
    // The constrained decoder gives up on every schema-mode attempt (dense
    // numeric artefact); the same model complies once response_format is
    // dropped and the shape is stated in the prompt.
    const ai = makeAi({
      run: (_model, inputs) => {
        if (inputs.response_format) throw new Error("5024: JSON Model couldn't be met");
        return GOOD;
      },
    });
    const res = await extractFromArtifact(makeEnv({ db: makeFakeDb(), ai: ai.AI }), observationSpec(), artifact(observationSpec()));
    expect(res.values[0]!.value).toBe(48.8);
    expect(ai.calls).toHaveLength(4); // 3 schema-mode attempts + 1 rescue
    expect(ai.calls[3]!.response_format).toBeUndefined();
    // The rescue prompt states the shape response_format used to enforce.
    expect(ai.calls[3]!.messages.at(-1)!.content).toContain("ONLY one JSON object");
  });

  it("coerces a quoted thousands-separated value in the schema-free rescue (the mhclg_housing failure mode)", async () => {
    // Without response_format the model quotes the figure as the artefact
    // prints it — "199,500" — a formatting nit, not a wrong extraction.
    const quoted = JSON.stringify({
      values: [{ indicatorId: "services_pmi", value: "199,500", unit: "dwellings", observedAt: "2026-03-31", quote: "199,500 net additional homes were delivered." }],
      releasedAt: null,
      draft: null,
    });
    const ai = makeAi({
      run: (_model, inputs) => {
        if (inputs.response_format) throw new Error("5024: JSON Model couldn't be met");
        return quoted;
      },
    });
    const res = await extractFromArtifact(makeEnv({ db: makeFakeDb(), ai: ai.AI }), observationSpec(), artifact(observationSpec()));
    expect(res.values[0]!.value).toBe(199500);
  });

  it("still rejects a non-numeric value string (coercion is narrow, not a parser)", async () => {
    const junk = JSON.stringify({
      values: [{ indicatorId: "services_pmi", value: "about 200k", unit: "dwellings", observedAt: "2026-03-31", quote: "roughly two hundred thousand." }],
      releasedAt: null,
      draft: null,
    });
    const ai = makeAi({ run: () => junk });
    await expect(
      extractFromArtifact(makeEnv({ db: makeFakeDb(), ai: ai.AI }), observationSpec(), artifact(observationSpec())),
    ).rejects.toThrow(/value\.value must be a finite number/);
  });

  it("reports the rescue's own failure when the schema-free attempt is also invalid", async () => {
    const ai = makeAi({
      run: (_model, inputs) => {
        if (inputs.response_format) throw new Error("5024: JSON Model couldn't be met");
        return "{still broken";
      },
    });
    await expect(
      extractFromArtifact(makeEnv({ db: makeFakeDb(), ai: ai.AI }), observationSpec(), artifact(observationSpec())),
    ).rejects.toThrow(/schema-free fallback/);
    expect(ai.calls).toHaveLength(4);
  });

  it("does NOT run the schema-free rescue when the last failure was a validation miss, not a 5024", async () => {
    const ai = makeAi({ run: () => "{not valid" });
    await expect(
      extractFromArtifact(makeEnv({ db: makeFakeDb(), ai: ai.AI }), observationSpec(), artifact(observationSpec())),
    ).rejects.toThrow(/extraction failed after 3 attempts/);
    expect(ai.calls).toHaveLength(3); // no fourth call — the model complied, its output was just bad
  });

  it("re-truncates from the TAIL on a 5024 for an xlsx artefact (newest rows last)", async () => {
    // A workbook projection: every row is digit-bearing, headline in the LAST
    // row — exactly the ons_dd_failure shape. After the first 5024 the strict
    // window must keep the bottom of the table, not the top.
    const longText = [
      ...Array.from({ length: 400 }, (_, i) => `| 2022 plus ${i} months | rate ${(i % 30) / 10} | amount ${300 + (i % 50)} |`),
      "The direct debit failure rate registered 48.8 in June 2026.",
    ].join("\n");
    let call = 0;
    const ai = makeAi({
      run: () => {
        call += 1;
        if (call === 1) throw new Error("5024: JSON Model couldn't be met");
        return GOOD;
      },
    });
    const spec = observationSpec({ format: "xlsx" });
    const res = await extractFromArtifact(makeEnv({ db: makeFakeDb(), ai: ai.AI }), spec, artifact(spec, longText));
    expect(res.values[0]!.value).toBe(48.8);
    const secondText = ai.calls[1]!.messages.map((m) => m.content).join("");
    expect(secondText).toContain("plus 399 months"); // tail (newest) kept
    expect(secondText).not.toContain("plus 0 months"); // head (oldest) dropped
  });

  it("extracts a cited draft for an editorial kind (values empty)", async () => {
    const spec = observationSpec({ sourceId: "delivery_milestones", kind: "delivery_milestone", indicatorIds: ["new_towns_milestones"], plausibility: {} });
    const draft = { indicatorId: "new_towns_milestones", proposedValue: 70, rationale: "consultation closed", quote: "The consultation on the New Towns programme closed on 19 May 2026.", sourceUrl: "https://gov.uk/x" };
    const ai = makeAi({ run: () => JSON.stringify({ values: [], releasedAt: null, draft }) });
    const res = await extractFromArtifact(
      makeEnv({ db: makeFakeDb(), ai: ai.AI }),
      spec,
      artifact(spec, "The consultation on the New Towns programme closed on 19 May 2026."),
    );
    expect(res.values).toHaveLength(0);
    expect(res.draft).toMatchObject({ indicatorId: "new_towns_milestones", proposedValue: 70 });
  });
});
