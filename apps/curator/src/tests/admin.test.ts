import { describe, expect, it } from "vitest";
import { handleFetch } from "../lib/admin";
import { makeEnv, makeFakeDb, makeKv, type FakeCaptureRow } from "./helpers";

const TOKEN = "s3cr3t-admin-token-value";

function pendingObs(over: Partial<FakeCaptureRow> = {}): FakeCaptureRow {
  return {
    id: 7, source_id: "sp_global_pmi", indicator_id: "services_pmi", kind: "observation",
    captured_at: "2026-07-01T05:00:00Z", source_url: "https://example.test/pmi", content_sha256: "abcdef0123456789",
    raw_r2_key: "curator/x", observed_at: "2026-06-30", released_at: "2026-07-03", value: 48.8,
    payload: JSON.stringify({ unit: "index" }), quote: "The UK Services PMI registered 48.8 in June 2026.",
    confidence: 0.95, verification: JSON.stringify([{ gate: "G1", passed: true }]), status: "pending",
    decided_by: null, decided_at: null, published_observation_key: null, model_id: "m", prompt_version: "v1",
    created_at: "2026-07-01T05:00:00Z", ...over,
  };
}

function req(path: string, opts: { method?: string; token?: string | null; ip?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "cf-connecting-ip": opts.ip ?? "9.9.9.9" };
  if (opts.token) headers["x-admin-token"] = opts.token;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://curator.test${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

function env(db = makeFakeDb()) {
  return { env: makeEnv({ db, kv: makeKv().kv, extra: { ADMIN_TOKEN: TOKEN } }), db };
}

describe("admin review endpoints", () => {
  it("/__healthz is unauthenticated and returns 200", async () => {
    const res = await handleFetch(req("/__healthz"), env().env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("rejects a missing/wrong token with 401", async () => {
    const res = await handleFetch(req("/admin/captures", { token: "wrong" }), env().env);
    expect(res.status).toBe(401);
  });

  it("locks the IP out with 429 after repeated failures (shared backoff)", async () => {
    const e = env().env;
    for (let i = 0; i < 3; i++) await handleFetch(req("/admin/captures", { token: "wrong", ip: "5.5.5.5" }), e);
    const locked = await handleFetch(req("/admin/captures", { token: TOKEN, ip: "5.5.5.5" }), e);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("lists captures by status for an authorised caller", async () => {
    const db = makeFakeDb({ captures: [pendingObs(), pendingObs({ id: 8, status: "quarantined" })] });
    const res = await handleFetch(req("/admin/captures?status=pending", { token: TOKEN }), env(db).env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; captures: Array<{ id: number }> };
    expect(body.count).toBe(1);
    expect(body.captures[0]!.id).toBe(7);
  });

  it("returns detail with a diff vs the currently-published value", async () => {
    const db = makeFakeDb({ captures: [pendingObs()], publishedByKey: new Map([["services_pmi|2026-06-30", 47.5]]) });
    const res = await handleFetch(req("/admin/captures/7", { token: TOKEN }), env(db).env);
    const body = (await res.json()) as { capture: { value: number }; diff: { publishedValue: number; candidateValue: number } };
    expect(body.capture.value).toBe(48.8);
    expect(body.diff).toEqual({ publishedValue: 47.5, candidateValue: 48.8 });
  });

  it("approve publishes the observation and marks the capture approved", async () => {
    const db = makeFakeDb({ captures: [pendingObs()] });
    const res = await handleFetch(req("/admin/captures/7/approve", { method: "POST", token: TOKEN }), env(db).env);
    expect(res.status).toBe(200);
    expect(db.observationWrites).toHaveLength(1);
    expect(db.observationWrites[0]!.payloadHash).toBe("ai:abcdef0123456789");
    expect(db.captures.find((c) => c.id === 7)!.status).toBe("approved");
  });

  it("reject records the reason and sets status rejected without publishing", async () => {
    const db = makeFakeDb({ captures: [pendingObs()] });
    const res = await handleFetch(req("/admin/captures/7/reject", { method: "POST", token: TOKEN, body: { reason: "wrong month" } }), env(db).env);
    expect(res.status).toBe(200);
    const row = db.captures.find((c) => c.id === 7)!;
    expect(row.status).toBe("rejected");
    expect(row.decided_by).toContain("wrong month");
    expect(db.observationWrites).toHaveLength(0);
  });

  it("409s an approve on an already-decided capture", async () => {
    const db = makeFakeDb({ captures: [pendingObs({ status: "approved" })] });
    const res = await handleFetch(req("/admin/captures/7/approve", { method: "POST", token: TOKEN }), env(db).env);
    expect(res.status).toBe(409);
  });

  it("405s an unknown path", async () => {
    const res = await handleFetch(req("/nope"), env().env);
    expect(res.status).toBe(405);
  });
});
