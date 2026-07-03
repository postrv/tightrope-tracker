import { describe, expect, it } from "vitest";
import type { CaptureArtifact, CaptureSpec, ExtractionResult } from "../types";
import { verifyExtraction, unitCompatible } from "../pipeline/verify";
import { makeAi, makeEnv, makeFakeDb, observationSpec, type FakeLatestObservation } from "./helpers";

const PMI_TEXT =
  "S&P Global UK Services PMI. The UK Services PMI registered 48.8 in June 2026, down from 49.1 in May. Business activity contracted for a second month.";

function artifact(text: string, spec: CaptureSpec): CaptureArtifact {
  return { spec, url: spec.urls[0]!, fetchedAt: "2026-07-01T05:00:00Z", contentSha256: "abc123def456", rawR2Key: "curator/x", text };
}

function extraction(over: Partial<ExtractionResult["values"][number]> = {}, releasedAt: string | null = "2026-07-03"): ExtractionResult {
  return {
    values: [
      {
        indicatorId: "services_pmi",
        value: 48.8,
        unit: "index",
        observedAt: "2026-06-30",
        quote: "The UK Services PMI registered 48.8 in June 2026, down from 49.1 in May.",
        ...over,
      },
    ],
    releasedAt,
    draft: null,
  };
}

/** Fake AI that answers the G5 second extraction with a chosen value (default: agrees). */
function envWith(secondValue = 48.8, latest: FakeLatestObservation[] = []) {
  const db = makeFakeDb({ latestObservations: latest });
  const ai = makeAi({
    run: () =>
      JSON.stringify({
        values: [{ indicatorId: "services_pmi", value: secondValue, unit: "index", observedAt: "2026-06-30", quote: "The UK Services PMI registered 48.8 in June 2026, down from 49.1 in May." }],
        releasedAt: null,
        draft: null,
      }),
  });
  return { db, env: makeEnv({ db, ai: ai.AI }), ai };
}

function gate(report: { gates: Array<{ gate: string; passed: boolean }> }, id: string): boolean {
  return report.gates.find((g) => g.gate === id)!.passed;
}

describe("verify — gate matrix", () => {
  it("passes every gate on a clean extraction and scores confidence 1.0", async () => {
    const { env } = envWith(48.8);
    const report = await verifyExtraction(env, observationSpec(), artifact(PMI_TEXT, observationSpec()), extraction());
    expect(report.passed).toBe(true);
    for (const id of ["G1", "G2", "G3", "G4", "G5", "G6"]) expect(gate(report, id)).toBe(true);
    expect(report.confidence).toBe(1);
  });

  it("G1 fails when the quote is paraphrased rather than verbatim", async () => {
    const { env } = envWith(48.8);
    const ext = extraction({ quote: "Services PMI came in around forty-nine in June, a slight fall." });
    const report = await verifyExtraction(env, observationSpec(), artifact(PMI_TEXT, observationSpec()), ext);
    expect(gate(report, "G1")).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("G1 is whitespace-insensitive (a re-wrapped verbatim quote still matches)", async () => {
    const { env } = envWith(48.8);
    const ext = extraction({ quote: "The UK Services PMI registered\n   48.8 in June 2026,\tdown from 49.1 in May." });
    const report = await verifyExtraction(env, observationSpec(), artifact(PMI_TEXT, observationSpec()), ext);
    expect(gate(report, "G1")).toBe(true);
  });

  it("G2 fails on a unit shift (bps where the indicator is a percentage)", async () => {
    // dd_failure_rate is a '%' indicator; a 'bps' unit is a different family.
    const spec = observationSpec({ sourceId: "ons_dd_failure", indicatorIds: ["dd_failure_rate"], plausibility: { dd_failure_rate: { min: 0, max: 5, maxDelta: 0.4 } } });
    const text = "The direct debit failure rate was 2.34% in May 2026.";
    const ext: ExtractionResult = {
      values: [{ indicatorId: "dd_failure_rate", value: 2.34, unit: "bps", observedAt: "2026-05-31", quote: "The direct debit failure rate was 2.34% in May 2026." }],
      releasedAt: null,
      draft: null,
    };
    const db = makeFakeDb();
    const ai = makeAi({ run: () => JSON.stringify({ values: [{ indicatorId: "dd_failure_rate", value: 2.34, unit: "%", observedAt: "2026-05-31", quote: "The direct debit failure rate was 2.34% in May 2026." }], releasedAt: null, draft: null }) });
    const report = await verifyExtraction(makeEnv({ db, ai: ai.AI }), spec, artifact(text, spec), ext);
    expect(gate(report, "G2")).toBe(false);
  });

  it("G3 fails when the value is out of the plausible range", async () => {
    const { env } = envWith(200);
    const ext = extraction({ value: 200 });
    const report = await verifyExtraction(env, observationSpec(), artifact(PMI_TEXT.replace("48.8", "200"), observationSpec()), ext);
    expect(gate(report, "G3")).toBe(false);
  });

  it("G4 fails when the delta vs the latest published observation exceeds maxDelta", async () => {
    const latest: FakeLatestObservation[] = [{ indicator_id: "services_pmi", source_id: "sp_global_pmi", observed_at: "2026-05-31", value: 48, ingested_at: "2026-06-05T00:00:00Z", released_at: null }];
    const { env } = envWith(60, latest);
    const ext = extraction({ value: 60 });
    const report = await verifyExtraction(env, observationSpec(), artifact(PMI_TEXT.replace("48.8", "60"), observationSpec()), ext);
    expect(gate(report, "G4")).toBe(false);
    expect(gate(report, "G6")).toBe(true); // 2026-06-30 is newer than 2026-05-31
  });

  it("G5 fails when the independent second extraction disagrees beyond tolerance", async () => {
    const { env } = envWith(55); // second pass says 55, first says 48.8, tol 0.5
    const report = await verifyExtraction(env, observationSpec(), artifact(PMI_TEXT, observationSpec()), extraction());
    expect(gate(report, "G5")).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("G6 fails on a future period", async () => {
    const { env } = envWith(48.8);
    const ext = extraction({ observedAt: "2099-01-31" });
    const report = await verifyExtraction(env, observationSpec(), artifact(PMI_TEXT, observationSpec()), ext);
    expect(gate(report, "G6")).toBe(false);
  });

  it("G6 fails when the period is not newer than the last published (value present but wrong period)", async () => {
    const latest: FakeLatestObservation[] = [{ indicator_id: "services_pmi", source_id: "sp_global_pmi", observed_at: "2026-06-30", value: 48.5, ingested_at: "2026-07-01T00:00:00Z", released_at: null }];
    const { env } = envWith(48.8, latest);
    const ext = extraction({ observedAt: "2026-05-31" }); // older than published 2026-06-30
    const report = await verifyExtraction(env, observationSpec(), artifact(PMI_TEXT, observationSpec()), ext);
    expect(gate(report, "G6")).toBe(false);
    expect(gate(report, "G4")).toBe(true); // value itself is fine
  });

  it("confidence drops to 0.9 when G5 agrees only at the tolerance edge", async () => {
    const { env } = envWith(49.3); // |49.3 - 48.8| = 0.5 == tolerance → a5 = 0.5 → conf = 0.9
    const report = await verifyExtraction(env, observationSpec(), artifact(PMI_TEXT, observationSpec()), extraction());
    expect(gate(report, "G5")).toBe(true);
    expect(report.confidence).toBe(0.9);
  });
});

describe("unitCompatible", () => {
  it("accepts same-family synonyms", () => {
    expect(unitCompatible("index", "index")).toBe(true);
    expect(unitCompatible("points", "index")).toBe(true);
    expect(unitCompatible("per cent", "%")).toBe(true);
    expect(unitCompatible("£bn", "GBPbn")).toBe(true);
  });
  it("rejects a bps vs percent shift", () => {
    expect(unitCompatible("bps", "%")).toBe(false);
    expect(unitCompatible("basis points", "%")).toBe(false);
  });
  it("fails open when either unit is unclassifiable", () => {
    expect(unitCompatible("", "%")).toBe(true);
    expect(unitCompatible("widgets", "index")).toBe(true);
  });
});
