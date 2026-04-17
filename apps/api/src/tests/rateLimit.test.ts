import { describe, expect, it } from "vitest";
import { clientIp, decide, enforceRateLimit } from "../lib/rateLimit.js";

function makeStubEnv(store: Map<string, string> = new Map()): Env {
  return {
    KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v); },
    },
  } as unknown as Env;
}

describe("decide", () => {
  it("allows up to the limit inclusive", () => {
    expect(decide(0, { limit: 3, windowSeconds: 60 })).toEqual({ allowed: true, remaining: 2 });
    expect(decide(2, { limit: 3, windowSeconds: 60 })).toEqual({ allowed: true, remaining: 0 });
  });
  it("denies above the limit", () => {
    expect(decide(3, { limit: 3, windowSeconds: 60 })).toEqual({ allowed: false, remaining: 0 });
    expect(decide(9999, { limit: 3, windowSeconds: 60 })).toEqual({ allowed: false, remaining: 0 });
  });
});

describe("enforceRateLimit", () => {
  it("counts per-bucket and allows within the limit", async () => {
    const env = makeStubEnv();
    const opts = { limit: 3, windowSeconds: 60 };
    const t = 1_700_000_000_000;
    const a = await enforceRateLimit(env, "1.2.3.4", t, opts);
    const b = await enforceRateLimit(env, "1.2.3.4", t, opts);
    const c = await enforceRateLimit(env, "1.2.3.4", t, opts);
    const d = await enforceRateLimit(env, "1.2.3.4", t, opts);
    expect([a.allowed, b.allowed, c.allowed, d.allowed]).toEqual([true, true, true, false]);
    expect(d.remaining).toBe(0);
    expect(d.resetAt).toBeGreaterThan(t);
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
    const t2 = t1 + 60_000; // next bucket
    const first = await enforceRateLimit(env, "1.1.1.1", t1, opts);
    const blocked = await enforceRateLimit(env, "1.1.1.1", t1, opts);
    const nextWindow = await enforceRateLimit(env, "1.1.1.1", t2, opts);
    expect(first.allowed).toBe(true);
    expect(blocked.allowed).toBe(false);
    expect(nextWindow.allowed).toBe(true);
  });
});

describe("clientIp", () => {
  it("prefers cf-connecting-ip", () => {
    const req = new Request("https://x", {
      headers: { "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" },
    });
    expect(clientIp(req)).toBe("1.2.3.4");
  });
  it("falls back to first x-forwarded-for entry", () => {
    const req = new Request("https://x", { headers: { "x-forwarded-for": "2.2.2.2, 3.3.3.3" } });
    expect(clientIp(req)).toBe("2.2.2.2");
  });
  it("defaults to 'unknown'", () => {
    const req = new Request("https://x");
    expect(clientIp(req)).toBe("unknown");
  });
});
