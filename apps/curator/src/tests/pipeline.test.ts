import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSource } from "../pipeline/capture";
import { extractFromArtifact } from "../pipeline/extract";
import { verifyExtraction } from "../pipeline/verify";
import { decideAndPersist } from "../pipeline/publish";
import { runSweep } from "../lib/sweep";
import { CAPTURE_SPECS } from "../sources/registry";
import { isSecondaryFraming, makeAi, makeEnv, makeFakeDb, makeKv, observationSpec } from "./helpers";

const PMI_HTML =
  "<html><body><p>The UK Services PMI registered 48.8 in June 2026, down from 49.1 in May.</p></body></html>";

const EXTRACTION = {
  values: [{ indicatorId: "services_pmi", value: 48.8, unit: "index", observedAt: "2026-06-30", quote: "The UK Services PMI registered 48.8 in June 2026, down from 49.1 in May." }],
  releasedAt: "2026-07-03",
  draft: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("pipeline integration (capture -> extract -> verify -> publish)", () => {
  it("captures, extracts, verifies and auto-publishes a clean observation end-to-end (live mode)", async () => {
    vi.stubGlobal("fetch", async () => new Response(PMI_HTML, { status: 200 }));
    const ai = makeAi({
      // Same numeric answer for both framings so G5 agrees.
      run: (_m, inputs) => JSON.stringify(isSecondaryFraming(inputs.messages) ? EXTRACTION : EXTRACTION),
    });
    const db = makeFakeDb();
    const env = makeEnv({ db, kv: makeKv().kv, ai: ai.AI }); // CURATOR_MODE live
    const spec = observationSpec({ allowAutoPublish: true });

    const cap = await captureSource(env, spec, { force: true });
    if (cap === "unchanged") throw new Error("unexpected unchanged");
    const extraction = await extractFromArtifact(env, spec, cap);
    const verification = await verifyExtraction(env, spec, cap, extraction);
    expect(verification.passed).toBe(true);

    const persisted = await decideAndPersist(env, spec, {
      sourceId: spec.sourceId, indicatorId: "services_pmi", kind: "observation", capturedAt: cap.fetchedAt,
      sourceUrl: cap.url, contentSha256: cap.contentSha256, rawR2Key: cap.rawR2Key, observedAt: "2026-06-30",
      releasedAt: extraction.releasedAt, value: 48.8, payload: JSON.stringify({ unit: "index" }),
      quote: extraction.values[0]!.quote, confidence: null, verification: null, status: "pending",
      decidedBy: null, decidedAt: null, publishedObservationKey: null, modelId: spec.modelId, promptVersion: spec.promptVersion,
    }, verification);

    expect(persisted.status).toBe("auto_published");
    expect(db.observationWrites).toHaveLength(1);
    expect(db.observationWrites[0]).toMatchObject({ indicatorId: "services_pmi", value: 48.8, payloadHash: `ai:${cap.contentSha256}` });
  });

  it("runSweep isolates per-spec failures: a fetch outage fails every spec but the run completes with audit rows", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const ai = makeAi({ run: () => "{}" });
    const db = makeFakeDb();
    const env = makeEnv({ db, kv: makeKv().kv, ai: ai.AI });

    const summary = await runSweep(env, { force: true });
    expect(summary.ran).toBe(CAPTURE_SPECS.length);
    // Every fetch-backed spec failed; timeline_triage (no fetch) succeeded with 0 rows.
    const failures = summary.results.filter((r) => r.status === "failure");
    expect(failures.length).toBeGreaterThan(0);
    expect(summary.results.find((r) => r.sourceId === "timeline_triage")!.status).toBe("success");
    // One started + one closing audit row per spec.
    expect(db.audit.length).toBeGreaterThanOrEqual(CAPTURE_SPECS.length);
  });

  it("C4: bounded-concurrency sweep returns results in deterministic CAPTURE_SPECS order", async () => {
    // Each spec resolves after a jittered delay so completion order != input
    // order; the pooled runner must still return results in registry order.
    vi.stubGlobal("fetch", async () => {
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5)));
      throw new Error("network down");
    });
    const ai = makeAi({ run: () => "{}" });
    const db = makeFakeDb();
    const env = makeEnv({ db, kv: makeKv().kv, ai: ai.AI });

    const summary = await runSweep(env, { force: false });
    expect(summary.results.map((r) => r.sourceId)).toEqual(CAPTURE_SPECS.map((s) => s.sourceId));
  });
});
