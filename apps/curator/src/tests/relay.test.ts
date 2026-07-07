import { afterEach, describe, expect, it, vi } from "vitest";
import { handleFetch } from "../lib/admin";
import { runSweep } from "../lib/sweep";
import { makeAi, makeEnv, makeFakeDb, makeKv } from "./helpers";

const TOKEN = "s3cr3t-admin-token-value";
const DD_TEXT = "Direct Debit failure rate was 1.2% in June 2026, up from 1.1% in May.";
const DD_EXTRACTION = {
  values: [{ indicatorId: "dd_failure_rate", value: 1.2, unit: "%", observedAt: "2026-06-30", quote: DD_TEXT }],
  releasedAt: "2026-06-18",
  draft: null,
};

/** A curator env whose AI stub converts any doc to DD_TEXT and extracts the DD value. */
function relayEnv(db = makeFakeDb()) {
  const ai = makeAi({
    toMarkdown: () => ({ format: "markdown", data: DD_TEXT }),
    run: () => JSON.stringify(DD_EXTRACTION),
  });
  return { env: makeEnv({ db, kv: makeKv().kv, ai: ai.AI, extra: { ADMIN_TOKEN: TOKEN } }), db, ai };
}

function relayReq(query: string, opts: { token?: string | null; body?: Uint8Array; format?: string; method?: string } = {}): Request {
  const headers: Record<string, string> = { "cf-connecting-ip": "9.9.9.9" };
  if (opts.token) headers["x-admin-token"] = opts.token;
  if (opts.format) headers["x-artefact-format"] = opts.format;
  const method = opts.method ?? "POST";
  const bytes = opts.body ?? new Uint8Array([1, 2, 3, 4]);
  // Copy into a fresh ArrayBuffer (not ArrayBufferLike) — a valid, cleanly-typed
  // BodyInit that sidesteps the strict lib's SharedArrayBuffer variance.
  const ab = new ArrayBuffer(bytes.length);
  new Uint8Array(ab).set(bytes);
  return new Request(`https://curator.test/admin/relay-artefact${query}`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: ab }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("POST /admin/relay-artefact", () => {
  it("401s a missing/wrong token", async () => {
    const res = await handleFetch(relayReq("?spec=ons_dd_failure", { token: "wrong", format: "xlsx" }), relayEnv().env);
    expect(res.status).toBe(401);
  });

  it("400s a missing ?spec=", async () => {
    const res = await handleFetch(relayReq("", { token: TOKEN, format: "xlsx" }), relayEnv().env);
    expect(res.status).toBe(400);
  });

  it("404s a spec that is not relay-enabled (can't be used to probe spec ids)", async () => {
    const res = await handleFetch(relayReq("?spec=sp_global_pmi", { token: TOKEN, format: "html" }), relayEnv().env);
    expect(res.status).toBe(404);
  });

  it("404s an unknown spec", async () => {
    const res = await handleFetch(relayReq("?spec=nope", { token: TOKEN }), relayEnv().env);
    expect(res.status).toBe(404);
  });

  it("400s an empty body", async () => {
    const res = await handleFetch(relayReq("?spec=ons_dd_failure", { token: TOKEN, format: "xlsx", body: new Uint8Array([]) }), relayEnv().env);
    expect(res.status).toBe(400);
  });

  it("405s a GET", async () => {
    const res = await handleFetch(relayReq("?spec=ons_dd_failure", { token: TOKEN, format: "xlsx", method: "GET" }), relayEnv().env);
    expect(res.status).toBe(405);
  });

  it("runs the full capture→extract→verify→persist pipeline over relayed xlsx bytes", async () => {
    const { env, db } = relayEnv();
    const res = await handleFetch(relayReq("?spec=ons_dd_failure", { token: TOKEN, format: "xlsx" }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; spec: string; status: string; rows: number };
    expect(body).toMatchObject({ ok: true, spec: "ons_dd_failure", status: "success", rows: 1 });
    // A capture row landed (review-only spec → pending, not auto-published).
    const row = db.captures.find((c) => c.source_id === "ons_dd_failure");
    expect(row).toBeDefined();
    expect(row!.value).toBe(1.2);
    expect(["pending", "shadow"]).toContain(row!.status);
    // Exactly one audit row opened + closed (the invariant).
    const opens = db.audit.filter((a) => !a.update).length;
    const closes = db.audit.filter((a) => a.update).length;
    expect(opens).toBe(1);
    expect(closes).toBe(1);
  });

  it("short-circuits to 'unchanged' on a byte-identical repost (hash dedupe)", async () => {
    const { env } = relayEnv();
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    const first = await handleFetch(relayReq("?spec=ons_dd_failure", { token: TOKEN, format: "xlsx", body: bytes }), env);
    expect((await first.json() as { status: string }).status).toBe("success");
    // Same bytes again, no ?force → the capture stage's hash dedupe returns unchanged.
    const second = await handleFetch(relayReq("?spec=ons_dd_failure", { token: TOKEN, format: "xlsx", body: bytes }), env);
    expect((await second.json() as { status: string }).status).toBe("unchanged");
  });
});

describe("sweep skips fetchVia:'relay' specs (no 403, honest 'unchanged')", () => {
  it("obr_efo and ons_dd_failure record 'unchanged' — the Worker never fetches them", async () => {
    // Every fetch throws; a relay spec must still be 'unchanged' (skipped), not 'failure'.
    vi.stubGlobal("fetch", async () => { throw new Error("network down"); });
    const db = makeFakeDb();
    const env = makeEnv({ db, kv: makeKv().kv, ai: makeAi({ run: () => "{}" }).AI });
    const summary = await runSweep(env, { force: true });
    for (const id of ["obr_efo", "ons_dd_failure"]) {
      const r = summary.results.find((x) => x.sourceId === id);
      expect(r, id).toBeDefined();
      expect(r!.status, id).toBe("unchanged");
    }
  });
});
