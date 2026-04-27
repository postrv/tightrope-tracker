import { describe, expect, it } from "vitest";
import { clientIp, decide, enforceRateLimit } from "./rateLimit.js";

function makeStubEnv(store: Map<string, string> = new Map()): Env {
  return {
    KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v); },
    },
  } as unknown as Env;
}

describe("decide", () => {
  it("allows up to the limit inclusive, denies above", () => {
    expect(decide(0, { limit: 3, windowSeconds: 60 })).toEqual({ allowed: true, remaining: 2 });
    expect(decide(2, { limit: 3, windowSeconds: 60 })).toEqual({ allowed: true, remaining: 0 });
    expect(decide(3, { limit: 3, windowSeconds: 60 })).toEqual({ allowed: false, remaining: 0 });
  });
});

describe("enforceRateLimit", () => {
  it("uses a tighter default than the API (60 req/min) — share-card endpoints are not human-driven", async () => {
    // Defence-in-depth: even on cache miss an attacker should not be able to
    // burst more than ~60 renders/min before the limiter trips.
    const env = makeStubEnv();
    const t = 1_700_000_000_000;
    let lastRemaining = -1;
    for (let i = 0; i < 60; i++) {
      const r = await enforceRateLimit(env, "1.2.3.4", t);
      expect(r.allowed, `request ${i + 1} should be allowed`).toBe(true);
      lastRemaining = r.remaining;
    }
    expect(lastRemaining).toBe(0);
    const blocked = await enforceRateLimit(env, "1.2.3.4", t);
    expect(blocked.allowed).toBe(false);
    expect(blocked.limit).toBe(60);
  });

  it("keys per-IP (different IPs do not interfere)", async () => {
    const env = makeStubEnv();
    const opts = { limit: 2, windowSeconds: 60 };
    const t = 1_700_000_000_000;
    await enforceRateLimit(env, "1.1.1.1", t, opts);
    await enforceRateLimit(env, "1.1.1.1", t, opts);
    const blocked = await enforceRateLimit(env, "1.1.1.1", t, opts);
    const otherOk = await enforceRateLimit(env, "2.2.2.2", t, opts);
    expect(blocked.allowed).toBe(false);
    expect(otherOk.allowed).toBe(true);
  });

  it("rolls over when the window advances", async () => {
    const env = makeStubEnv();
    const opts = { limit: 1, windowSeconds: 60 };
    const t1 = 1_700_000_000_000;
    const t2 = t1 + 60_000;
    expect((await enforceRateLimit(env, "1.1.1.1", t1, opts)).allowed).toBe(true);
    expect((await enforceRateLimit(env, "1.1.1.1", t1, opts)).allowed).toBe(false);
    expect((await enforceRateLimit(env, "1.1.1.1", t2, opts)).allowed).toBe(true);
  });
});

describe("clientIp", () => {
  it("returns the cf-connecting-ip header when present", () => {
    const req = new Request("https://x", { headers: { "cf-connecting-ip": "1.2.3.4" } });
    expect(clientIp(req)).toBe("1.2.3.4");
  });

  it("returns null (NOT a literal 'unknown' string) when missing — fail-open contract", () => {
    // SEC-9: a literal "unknown" string would put every header-less caller into
    // the same KV bucket and rate-limit *all* of them collectively. That
    // creates a self-DoS on legitimate traffic if the header is ever absent
    // (e.g. a bypass route). null tells the caller to skip enforcement.
    const req = new Request("https://x");
    expect(clientIp(req)).toBe(null);
  });

  it("ignores attacker-controlled x-forwarded-for / x-real-ip", () => {
    const req = new Request("https://x", {
      headers: { "x-forwarded-for": "2.2.2.2, 3.3.3.3", "x-real-ip": "4.4.4.4" },
    });
    expect(clientIp(req)).toBe(null);
  });

  it("returns null for an empty cf-connecting-ip header", () => {
    const req = new Request("https://x", { headers: { "cf-connecting-ip": "" } });
    expect(clientIp(req)).toBe(null);
  });
});
