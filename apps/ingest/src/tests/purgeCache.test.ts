/**
 * Tests for `POST /admin/run?source=purge-cache`.
 *
 * Five KV keys back the public site: `score:latest`, `score:history:90d`,
 * `delivery:latest`, `timeline:latest`, `movements:today`. Three of them
 * (`delivery:latest`, `timeline:latest`, `movements:today`) are
 * write-on-miss with no freshness predicate, so an editorial change to
 * the underlying tables (corrections published, delivery commitments
 * updated, timeline entry inserted via the gov.uk DLQ flow) takes up
 * to 6 hours to surface unless an operator explicitly invalidates them.
 *
 * `purge-cache` is the operator escape hatch — auth-gated, idempotent,
 * and reports which keys it deleted so the caller can confirm.
 */
import { describe, expect, it } from "vitest";
import { handleAdminRun } from "../admin.js";
import type { Env } from "../env.js";

interface KvStub {
  delete: (key: string) => Promise<void>;
}

function makeEnv(opts: { token?: string } = {}): { env: Env; kvDeletes: string[] } {
  const kvDeletes: string[] = [];
  const env = {
    ADMIN_TOKEN: opts.token ?? "secret-token",
    KV: {
      delete: async (key: string) => { kvDeletes.push(key); },
    } as KvStub,
  } as unknown as Env;
  return { env, kvDeletes };
}

function makeReq(token: string): { req: Request; url: URL } {
  const url = new URL("https://ingest.tightropetracker.uk/admin/run?source=purge-cache");
  const req = new Request(url, {
    method: "POST",
    headers: { "x-admin-token": token },
  });
  return { req, url };
}

describe("handleAdminRun — source=purge-cache", () => {
  it("requires the admin token (401 without)", async () => {
    const { env, kvDeletes } = makeEnv();
    const url = new URL("https://ingest.tightropetracker.uk/admin/run?source=purge-cache");
    const req = new Request(url, { method: "POST" });
    const res = await handleAdminRun(req, env, url);
    expect(res.status).toBe(401);
    expect(kvDeletes).toEqual([]);
  });

  it("deletes the five public KV keys and reports them in the response", async () => {
    const { env, kvDeletes } = makeEnv();
    const { req, url } = makeReq("secret-token");
    const res = await handleAdminRun(req, env, url);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; purged: string[] };
    expect(body.ok).toBe(true);
    expect(new Set(body.purged)).toEqual(new Set([
      "score:latest",
      "score:history:90d",
      "delivery:latest",
      "timeline:latest",
      "movements:today",
    ]));
    expect(new Set(kvDeletes)).toEqual(new Set(body.purged));
  });

  it("is idempotent — re-running succeeds even after the keys are already gone", async () => {
    const { env, kvDeletes } = makeEnv();
    const { req: req1, url: url1 } = makeReq("secret-token");
    const res1 = await handleAdminRun(req1, env, url1);
    expect(res1.status).toBe(200);

    const { req: req2, url: url2 } = makeReq("secret-token");
    const res2 = await handleAdminRun(req2, env, url2);
    expect(res2.status).toBe(200);
    // Each call deleted all five keys; total of 10 delete events.
    expect(kvDeletes.length).toBe(10);
  });

  it("rejects non-POST methods", async () => {
    const { env, kvDeletes } = makeEnv();
    const url = new URL("https://ingest.tightropetracker.uk/admin/run?source=purge-cache");
    const req = new Request(url, { method: "GET", headers: { "x-admin-token": "secret-token" } });
    const res = await handleAdminRun(req, env, url);
    expect(res.status).toBe(405);
    expect(kvDeletes).toEqual([]);
  });

  it("swallows individual KV.delete failures so a single missing key doesn't fail the whole purge", async () => {
    const kvDeletes: string[] = [];
    const env = {
      ADMIN_TOKEN: "secret-token",
      KV: {
        delete: async (key: string) => {
          if (key === "delivery:latest") throw new Error("simulated kv outage on this key");
          kvDeletes.push(key);
        },
      },
    } as unknown as Env;
    const { req, url } = makeReq("secret-token");
    const res = await handleAdminRun(req, env, url);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; purged: string[]; failed?: string[] };
    expect(body.purged).toContain("score:latest");
    expect(body.purged).toContain("timeline:latest");
    expect(body.failed).toContain("delivery:latest");
  });
});
