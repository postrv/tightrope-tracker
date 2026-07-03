import { describe, expect, it } from "vitest";
import { adminAuthGate, decideBackoff, timingSafeEqual, type AdminGateEnv } from "./adminGate.js";

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
