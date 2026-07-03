import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureRow, GateId, VerificationReport } from "../types";
import { decideAndPersist, isShadowMode } from "../pipeline/publish";
import { makeEnv, makeFakeDb, observationSpec, type FakeCaptureRow } from "./helpers";

function report(overrides: Partial<Record<GateId, boolean>> = {}): VerificationReport {
  const ids: GateId[] = ["G1", "G2", "G3", "G4", "G5", "G6"];
  const gates = ids.map((gate) => ({ gate, passed: overrides[gate] ?? true, detail: "" }));
  return { gates, confidence: 0.95, passed: gates.every((g) => g.passed) };
}

function row(over: Partial<CaptureRow> = {}): CaptureRow {
  return {
    sourceId: "sp_global_pmi",
    indicatorId: "services_pmi",
    kind: "observation",
    capturedAt: "2026-07-01T05:00:00Z",
    sourceUrl: "https://example.test/pmi",
    contentSha256: "abcdef0123456789",
    rawR2Key: "curator/x",
    observedAt: "2026-06-30",
    releasedAt: "2026-07-03",
    value: 48.8,
    payload: JSON.stringify({ unit: "index" }),
    quote: "The UK Services PMI registered 48.8 in June 2026.",
    confidence: null,
    verification: null,
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    publishedObservationKey: null,
    modelId: "m",
    promptVersion: "v1",
    ...over,
  };
}

function pendingCapture(over: Partial<FakeCaptureRow>): FakeCaptureRow {
  return {
    id: 1, source_id: "sp_global_pmi", indicator_id: "services_pmi", kind: "observation",
    captured_at: "2026-06-01T00:00:00Z", source_url: "x", content_sha256: "old", raw_r2_key: null,
    observed_at: "2026-06-30", released_at: null, value: 47, payload: null, quote: null, confidence: null,
    verification: null, status: "pending", decided_by: null, decided_at: null,
    published_observation_key: null, model_id: null, prompt_version: "v1", created_at: "2026-06-01T00:00:00Z",
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("decideAndPersist", () => {
  it("isShadowMode defaults on (anything but an explicit 'live' is shadow)", () => {
    expect(isShadowMode({})).toBe(true); // unset -> shadow
    expect(isShadowMode({ CURATOR_MODE: "shadow" })).toBe(true);
    expect(isShadowMode({ CURATOR_MODE: "LIVE" })).toBe(false);
    expect(isShadowMode({ CURATOR_MODE: "live" })).toBe(false);
  });

  it("shadow mode forces status 'shadow' and publishes nothing even when gates pass", async () => {
    const db = makeFakeDb();
    const env = makeEnv({ db, extra: { CURATOR_MODE: "shadow" } });
    const out = await decideAndPersist(env, observationSpec({ allowAutoPublish: true }), row(), report());
    expect(out.status).toBe("shadow");
    expect(db.observationWrites).toHaveLength(0);
    expect(db.captures).toHaveLength(1);
    expect(db.captures[0]!.decided_by).toContain("intended=auto_published");
  });

  it("auto-publishes when live + gates pass + allowAutoPublish, writing an ai:-prefixed observation", async () => {
    const db = makeFakeDb();
    const env = makeEnv({ db }); // live
    const out = await decideAndPersist(env, observationSpec({ allowAutoPublish: true }), row(), report());
    expect(out.status).toBe("auto_published");
    expect(out.publishedObservationKey).toBe("services_pmi|2026-06-30");
    expect(db.observationWrites).toHaveLength(1);
    expect(db.observationWrites[0]!.payloadHash).toBe("ai:abcdef0123456789");
    expect(db.observationWrites[0]!.sourceId).toBe("sp_global_pmi");
  });

  it("stays pending (not published) when allowAutoPublish is false", async () => {
    const db = makeFakeDb();
    const out = await decideAndPersist(makeEnv({ db }), observationSpec({ allowAutoPublish: false }), row(), report());
    expect(out.status).toBe("pending");
    expect(db.observationWrites).toHaveLength(0);
  });

  it("quarantines + alerts on a G3 range failure (even alerts under shadow)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      calls.push(init.body);
      return new Response("ok");
    });
    const db = makeFakeDb();
    const env = makeEnv({ db, extra: { ALERT_WEBHOOK_URL: "https://hook.test" } });
    const out = await decideAndPersist(env, observationSpec({ allowAutoPublish: true }), row(), report({ G3: false }));
    expect(out.status).toBe("quarantined");
    expect(db.observationWrites).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("quarantine");
  });

  it("writes a public corrections row when it revises a different published value", async () => {
    const db = makeFakeDb({ publishedByKey: new Map([["services_pmi|2026-06-30", 47.5]]) });
    const env = makeEnv({ db });
    await decideAndPersist(env, observationSpec({ allowAutoPublish: true }), row({ value: 48.8 }), report());
    expect(db.corrections).toHaveLength(1);
    expect(db.corrections[0]!.affected_indicator).toBe("services_pmi");
    expect(db.corrections[0]!.original_value).toBe("47.5");
    expect(db.corrections[0]!.corrected_value).toBe("48.8");
  });

  it("does NOT write a correction when the published value is unchanged", async () => {
    const db = makeFakeDb({ publishedByKey: new Map([["services_pmi|2026-06-30", 48.8]]) });
    await decideAndPersist(makeEnv({ db }), observationSpec({ allowAutoPublish: true }), row({ value: 48.8 }), report());
    expect(db.corrections).toHaveLength(0);
  });

  it("supersedes older unpublished captures for the same (indicator, observed_at) on publish", async () => {
    const db = makeFakeDb({ captures: [pendingCapture({ id: 1 })] });
    await decideAndPersist(makeEnv({ db }), observationSpec({ allowAutoPublish: true }), row(), report());
    expect(db.captures.find((c) => c.id === 1)!.status).toBe("superseded");
  });
});
