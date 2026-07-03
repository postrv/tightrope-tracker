import { describe, expect, it } from "vitest";
import { adminAuthGate, adminBucketKey, decideBackoff, timingSafeEqual, type AdminGateEnv } from "./adminGate.js";

/**
 * Home tests for the shared admin gate (the machinery lifted out of
 * apps/ingest). The ingest adminBackoff.test.ts still exercises the same
 * surface through its re-export; this pins the behaviour at its new home and
 * documents the structural KV contract.
 */

function makeEnv(): AdminGateEnv {
  const store = new Map<string, string>();
  return {
    KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    },
  };
}

function req(token: string | null, ip = "1.2.3.4"): Request {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (token !== null) headers["x-admin-token"] = token;
  return new Request("https://curator.example/admin/captures", { method: "GET", headers });
}

describe("shared admin gate", () => {
  it("timingSafeEqual is length- and content-sensitive", () => {
    expect(timingSafeEqual("token-abc", "token-abc")).toBe(true);
    expect(timingSafeEqual("token-abc", "token-abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("decideBackoff grants two grace failures then escalates to a 15-minute cap", () => {
    expect(decideBackoff(2).lockoutSeconds).toBe(0);
    expect(decideBackoff(3).lockoutSeconds).toBe(30);
    expect(decideBackoff(99).lockoutSeconds).toBe(900);
  });

  it("adminAuthGate green-lights a valid token and 401s a bad one", async () => {
    const env = makeEnv();
    expect((await adminAuthGate(env, req("good"), { verifyToken: (t) => t === "good" })).ok).toBe(true);
    const bad = await adminAuthGate(env, req("bad"), { verifyToken: (t) => t === "good" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.response.status).toBe(401);
  });

  it("adminAuthGate 429s once the per-IP backoff locks out", async () => {
    const env = makeEnv();
    const t = 1_700_000_000_000;
    const verify = { verifyToken: () => false };
    await adminAuthGate(env, req("bad", "7.7.7.7"), verify, t);
    await adminAuthGate(env, req("bad", "7.7.7.7"), verify, t);
    await adminAuthGate(env, req("bad", "7.7.7.7"), verify, t);
    const locked = await adminAuthGate(env, req("good", "7.7.7.7"), verify, t + 100);
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.response.status).toBe(429);
  });
});

describe("adminBucketKey (F6) — header-less bucketing", () => {
  it("buckets on the verified cf-connecting-ip when present (behaviour preserved)", async () => {
    const r = new Request("https://x/admin", { headers: { "cf-connecting-ip": "1.2.3.4" } });
    expect(await adminBucketKey(r)).toBe("1.2.3.4");
  });

  it("header-less BUT token-bearing → a distinct 'tok:' bucket, never 'no-ip'", async () => {
    const r = new Request("https://x/admin", { headers: { "x-admin-token": "secret-abc" } });
    const bucket = await adminBucketKey(r);
    expect(bucket).not.toBe("no-ip");
    expect(bucket).toMatch(/^tok:[0-9a-f]{8}$/);
  });

  it("header-less AND token-less → the shared 'no-ip' bucket", async () => {
    expect(await adminBucketKey(new Request("https://x/admin"))).toBe("no-ip");
  });

  it("distinct tokens land in distinct buckets", async () => {
    const a = await adminBucketKey(new Request("https://x", { headers: { "x-admin-token": "aaa" } }));
    const b = await adminBucketKey(new Request("https://x", { headers: { "x-admin-token": "bbb" } }));
    expect(a).not.toBe(b);
  });

  it("a 'no-ip' lockout does NOT block a header-less token-bearing caller", async () => {
    const env = makeEnv();
    const t = 1_700_000_000_000;
    const reject = { verifyToken: () => false };
    const noIpReq = () => new Request("https://x/admin", { method: "GET" }); // no cf-connecting-ip, no token
    // Three token-less probes lock the shared 'no-ip' bucket.
    await adminAuthGate(env, noIpReq(), reject, t);
    await adminAuthGate(env, noIpReq(), reject, t);
    await adminAuthGate(env, noIpReq(), reject, t);
    const lockedNoIp = await adminAuthGate(env, noIpReq(), reject, t + 100);
    expect(lockedNoIp.ok).toBe(false); // 'no-ip' is locked

    // A header-less caller presenting a valid token uses a separate 'tok:' bucket.
    const tokReq = new Request("https://x/admin", { method: "GET", headers: { "x-admin-token": "good" } });
    const gate = await adminAuthGate(env, tokReq, { verifyToken: (t2) => t2 === "good" }, t + 100);
    expect(gate.ok).toBe(true); // not blocked by the no-ip lockout
  });
});
