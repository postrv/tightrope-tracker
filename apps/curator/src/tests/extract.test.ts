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
