/**
 * SEC-13: per-IP exponential backoff on failed admin-token attempts.
 *
 * The shared `ADMIN_TOKEN` is a 32-byte secret so an online brute-force is
 * already infeasible, but a per-IP backoff is cheap defence-in-depth: it
 * makes the cost of an attempt grow with each failure, surfaces sustained
 * probing in logs, and stops a misconfigured client from accidentally
 * burning through the rate limit on /admin/*.
 */
import { describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import {
  decideBackoff,
  recordFailure,
  isLockedOut,
  clearFailures,
  ADMIN_BACKOFF_KEY_PREFIX,
  adminAuthGate,
  clientIpForAdmin,
} from "./adminBackoff.js";

function makeKv(): { get: (k: string) => Promise<string | null>; put: (k: string, v: string, opts?: { expirationTtl?: number }) => Promise<void>; delete: (k: string) => Promise<void>; store: Map<string, { value: string; ttl?: number }> } {
  const store = new Map<string, { value: string; ttl?: number }>();
  return {
    store,
    async get(k: string) { return store.get(k)?.value ?? null; },
    async put(k: string, v: string, opts?: { expirationTtl?: number }) {
      const ttl = opts?.expirationTtl;
      const entry: { value: string; ttl?: number } = ttl !== undefined ? { value: v, ttl } : { value: v };
      store.set(k, entry);
    },
    async delete(k: string) { store.delete(k); },
  };
}

function makeEnv(kv: ReturnType<typeof makeKv>): Env {
  return { KV: kv } as unknown as Env;
}

describe("decideBackoff", () => {
  it("returns 0 for the first 2 failures (low-friction grace window)", () => {
    expect(decideBackoff(0).lockoutSeconds).toBe(0);
    expect(decideBackoff(1).lockoutSeconds).toBe(0);
    expect(decideBackoff(2).lockoutSeconds).toBe(0);
  });

  it("locks out for an exponentially-growing window from attempt 3 onwards", () => {
    expect(decideBackoff(3).lockoutSeconds).toBe(30);
    expect(decideBackoff(4).lockoutSeconds).toBe(60);
    expect(decideBackoff(5).lockoutSeconds).toBe(120);
    expect(decideBackoff(6).lockoutSeconds).toBe(300);
  });

  it("caps the lockout at 900s (15 minutes) so a benign misconfigured client recovers in under an hour", () => {
    expect(decideBackoff(7).lockoutSeconds).toBe(900);
    expect(decideBackoff(50).lockoutSeconds).toBe(900);
  });
});

describe("isLockedOut / recordFailure / clearFailures", () => {
  it("a fresh IP is not locked out and records 0 attempts", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    const state = await isLockedOut(env, "1.2.3.4", 1_700_000_000_000);
    expect(state.lockedUntil).toBe(null);
    expect(state.attempts).toBe(0);
  });

  it("recordFailure increments the per-IP attempt counter", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    const t = 1_700_000_000_000;
    await recordFailure(env, "1.2.3.4", t);
    await recordFailure(env, "1.2.3.4", t);
    const after = await isLockedOut(env, "1.2.3.4", t);
    expect(after.attempts).toBe(2);
    expect(after.lockedUntil).toBe(null);
  });

  it("the third failure locks the IP out for at least 30 seconds", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    const t = 1_700_000_000_000;
    await recordFailure(env, "1.2.3.4", t);
    await recordFailure(env, "1.2.3.4", t);
    await recordFailure(env, "1.2.3.4", t);
    const after = await isLockedOut(env, "1.2.3.4", t);
    expect(after.attempts).toBe(3);
    expect(after.lockedUntil).not.toBe(null);
    expect(after.lockedUntil! - t).toBeGreaterThanOrEqual(30_000);
  });

  it("isLockedOut returns lockedUntil=null after the lockout window expires", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    const t1 = 1_700_000_000_000;
    await recordFailure(env, "1.2.3.4", t1);
    await recordFailure(env, "1.2.3.4", t1);
    await recordFailure(env, "1.2.3.4", t1);
    const t2 = t1 + 31_000; // past the 30s window
    const after = await isLockedOut(env, "1.2.3.4", t2);
    expect(after.lockedUntil).toBe(null);
  });

  it("attempt counter is keyed per-IP (different IPs do not interfere)", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    const t = 1_700_000_000_000;
    await recordFailure(env, "1.1.1.1", t);
    await recordFailure(env, "1.1.1.1", t);
    await recordFailure(env, "1.1.1.1", t);
    const a = await isLockedOut(env, "1.1.1.1", t);
    const b = await isLockedOut(env, "2.2.2.2", t);
    expect(a.lockedUntil).not.toBe(null);
    expect(b.lockedUntil).toBe(null);
    expect(b.attempts).toBe(0);
  });

  it("clearFailures resets the counter so a successful auth ends the backoff", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    const t = 1_700_000_000_000;
    await recordFailure(env, "1.2.3.4", t);
    await recordFailure(env, "1.2.3.4", t);
    await clearFailures(env, "1.2.3.4");
    const after = await isLockedOut(env, "1.2.3.4", t);
    expect(after.attempts).toBe(0);
    expect(after.lockedUntil).toBe(null);
  });

  it("KV keys are namespaced under ADMIN_BACKOFF_KEY_PREFIX (don't collide with other rate-limit keys)", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    await recordFailure(env, "1.2.3.4", 1_700_000_000_000);
    const keys = Array.from(kv.store.keys());
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k.startsWith(ADMIN_BACKOFF_KEY_PREFIX)).toBe(true);
    }
  });
});

describe("clientIpForAdmin", () => {
  it("returns the cf-connecting-ip header when present", () => {
    const req = new Request("https://x", { headers: { "cf-connecting-ip": "1.2.3.4" } });
    expect(clientIpForAdmin(req)).toBe("1.2.3.4");
  });

  it("falls back to a stable 'no-ip' bucket when the header is missing — admin path fails closed", () => {
    // Unlike the public API (which fails open on missing header) the admin
    // path always applies backoff. Sharing one "no-ip" bucket is acceptable:
    // admin traffic is exclusively operator-driven and a brief shared
    // lockout is preferable to header-spoofed bypass.
    expect(clientIpForAdmin(new Request("https://x"))).toBe("no-ip");
  });

  it("ignores attacker-controlled x-forwarded-for (only cf-connecting-ip is trusted)", () => {
    const req = new Request("https://x", { headers: { "x-forwarded-for": "9.9.9.9" } });
    expect(clientIpForAdmin(req)).toBe("no-ip");
  });
});

describe("adminAuthGate", () => {
  function req(token: string | null, ip = "1.2.3.4"): Request {
    const headers: Record<string, string> = { "cf-connecting-ip": ip };
    if (token !== null) headers["x-admin-token"] = token;
    return new Request("https://ingest.example/admin/run", { method: "POST", headers });
  }

  it("returns ok=true when the token verifies", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    const r = await adminAuthGate(env, req("good"), { verifyToken: (t) => t === "good" });
    expect(r.ok).toBe(true);
  });

  it("returns 401 with no body field leakage when the token fails", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    const r = await adminAuthGate(env, req("bad"), { verifyToken: (t) => t === "good" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(401);
    const body = await r.response.json() as { error: string };
    expect(body.error).toBe("unauthorised");
  });

  it("returns 429 with Retry-After once the IP is locked out", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    const t = 1_700_000_000_000;
    const verify = { verifyToken: () => false };
    // Three failures triggers a 30s lockout.
    await adminAuthGate(env, req("bad"), verify, t);
    await adminAuthGate(env, req("bad"), verify, t);
    await adminAuthGate(env, req("bad"), verify, t);
    const fourth = await adminAuthGate(env, req("good"), verify, t + 100);
    expect(fourth.ok).toBe(false);
    if (fourth.ok) throw new Error("unreachable");
    expect(fourth.response.status).toBe(429);
    const retryAfter = fourth.response.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("a successful auth clears the failure counter (operators recover from a typo without lockout debt)", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    const t = 1_700_000_000_000;
    // Two failures (still in grace window).
    await adminAuthGate(env, req("bad"), { verifyToken: () => false }, t);
    await adminAuthGate(env, req("bad"), { verifyToken: () => false }, t);
    expect((await isLockedOut(env, "1.2.3.4", t)).attempts).toBe(2);
    // Successful auth wipes the slate.
    const ok = await adminAuthGate(env, req("good"), { verifyToken: () => true }, t);
    expect(ok.ok).toBe(true);
    expect((await isLockedOut(env, "1.2.3.4", t)).attempts).toBe(0);
  });
});
