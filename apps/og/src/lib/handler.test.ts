import { describe, expect, it } from "vitest";
import { handleOgRequest, type OgRouter } from "./handler.js";

function makeKvStore(): { get: (k: string) => Promise<string | null>; put: (k: string, v: string) => Promise<void>; store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, v); },
  };
}

function makeEnv(kv: ReturnType<typeof makeKvStore>): Env {
  return { KV: { get: kv.get, put: kv.put } } as unknown as Env;
}

function makeCtx(): ExecutionContext & { waited: Promise<unknown>[] } {
  const waited: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) { waited.push(p); },
    passThroughOnException() {},
    waited,
  } as unknown as ExecutionContext & { waited: Promise<unknown>[] };
}

function makeStubCache() {
  const store = new Map<string, Response>();
  return {
    store,
    matches: 0,
    puts: 0,
    async match(key: Request) {
      this.matches++;
      const found = store.get(new URL(key.url).pathname);
      return found ? found.clone() : undefined;
    },
    async put(key: Request, response: Response) {
      this.puts++;
      store.set(new URL(key.url).pathname, response.clone());
    },
  };
}

function pngResponse(label = "png-bytes"): Response {
  return new Response(label, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=600" },
  });
}

const TEST_RL = { limit: 3, windowSeconds: 60 };

describe("handleOgRequest", () => {
  it("rejects non-GET methods early without invoking the router", async () => {
    let invoked = 0;
    const router: OgRouter = async () => { invoked++; return pngResponse(); };
    const cache = makeStubCache();
    const env = makeEnv(makeKvStore());
    const ctx = makeCtx();
    const req = new Request("https://og.tightropetracker.uk/og/headline-score.png", { method: "POST" });
    const res = await handleOgRequest(req, env, ctx, router, { cache, rateLimitOptions: TEST_RL });
    expect(res.status).toBe(405);
    expect(invoked).toBe(0);
  });

  it("returns 404 for non-/og/ paths without consulting the cache or router", async () => {
    let invoked = 0;
    const router: OgRouter = async () => { invoked++; return pngResponse(); };
    const cache = makeStubCache();
    const env = makeEnv(makeKvStore());
    const ctx = makeCtx();
    const req = new Request("https://og.tightropetracker.uk/admin", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    const res = await handleOgRequest(req, env, ctx, router, { cache, rateLimitOptions: TEST_RL });
    expect(res.status).toBe(404);
    expect(invoked).toBe(0);
    expect(cache.matches).toBe(0);
  });

  it("serves from cache on hit and never invokes the router", async () => {
    let invoked = 0;
    const router: OgRouter = async () => { invoked++; return pngResponse("fresh"); };
    const cache = makeStubCache();
    cache.store.set("/og/headline-score.png", pngResponse("cached"));
    const env = makeEnv(makeKvStore());
    const ctx = makeCtx();
    const req = new Request("https://og.tightropetracker.uk/og/headline-score.png?nonce=1", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    const res = await handleOgRequest(req, env, ctx, router, { cache, rateLimitOptions: TEST_RL });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("cached");
    expect(invoked).toBe(0);
  });

  it("treats query-string variants as the same cache entry (DoS amplifier defence)", async () => {
    // The whole point of SEC-1: an attacker spamming ?nonce=$RANDOM must not
    // create N distinct cache entries. The first call seeds the cache; every
    // variant after must be a hit.
    let invoked = 0;
    const router: OgRouter = async () => { invoked++; return pngResponse(`render-${invoked}`); };
    const cache = makeStubCache();
    const env = makeEnv(makeKvStore());
    const ctx = makeCtx();
    const ip = "1.2.3.4";
    for (const q of ["", "?a=1", "?a=2", "?nonce=99", "?cb=" + Math.random()]) {
      const req = new Request(`https://og.tightropetracker.uk/og/headline-score.png${q}`, {
        headers: { "cf-connecting-ip": ip },
      });
      const res = await handleOgRequest(req, env, ctx, router, { cache, rateLimitOptions: TEST_RL });
      expect(res.status).toBe(200);
      // First invocation seeds the cache via waitUntil. Drain pending writes
      // before the next request so the cache reflects the put.
      await Promise.all(ctx.waited.splice(0));
    }
    expect(invoked).toBe(1);
  });

  it("caches the rendered response on success (uses ctx.waitUntil)", async () => {
    const router: OgRouter = async () => pngResponse();
    const cache = makeStubCache();
    const env = makeEnv(makeKvStore());
    const ctx = makeCtx();
    const req = new Request("https://og.tightropetracker.uk/og/headline-score.png", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    await handleOgRequest(req, env, ctx, router, { cache, rateLimitOptions: TEST_RL });
    expect(ctx.waited.length).toBe(1);
    await Promise.all(ctx.waited);
    expect(cache.puts).toBe(1);
    expect(cache.store.has("/og/headline-score.png")).toBe(true);
  });

  it("does NOT cache non-2xx responses (avoids poisoning cache with errors)", async () => {
    const router: OgRouter = async () => new Response("boom", { status: 500 });
    const cache = makeStubCache();
    const env = makeEnv(makeKvStore());
    const ctx = makeCtx();
    const req = new Request("https://og.tightropetracker.uk/og/headline-score.png", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    const res = await handleOgRequest(req, env, ctx, router, { cache, rateLimitOptions: TEST_RL });
    expect(res.status).toBe(500);
    expect(ctx.waited.length).toBe(0);
    expect(cache.puts).toBe(0);
  });

  it("returns 429 with Retry-After when rate-limit trips on cache miss", async () => {
    const router: OgRouter = async () => pngResponse();
    const cache = makeStubCache();
    const env = makeEnv(makeKvStore());
    const ctx = makeCtx();
    const ip = "1.2.3.4";
    const opts = { limit: 2, windowSeconds: 60 };
    // Hit a unique pathname each time so the cache never serves; rate-limit
    // is the only gate.
    for (let i = 0; i < 2; i++) {
      const req = new Request(`https://og.tightropetracker.uk/og/headline-score-${i}.png`, {
        headers: { "cf-connecting-ip": ip },
      });
      const ok = await handleOgRequest(req, env, ctx, router, { cache, rateLimitOptions: opts });
      expect(ok.status).toBe(200);
    }
    const blockedReq = new Request("https://og.tightropetracker.uk/og/headline-score-X.png", {
      headers: { "cf-connecting-ip": ip },
    });
    const blocked = await handleOgRequest(blockedReq, env, ctx, router, { cache, rateLimitOptions: opts });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).not.toBe(null);
    expect(blocked.headers.get("X-RateLimit-Limit")).toBe("2");
  });

  it("fail-opens when cf-connecting-ip is missing (does NOT 429 a header-less caller)", async () => {
    // SEC-9 contract: a request without cf-connecting-ip should not be put
    // into a shared "unknown" bucket. We log a warning and let the request
    // through. Otherwise an upstream worker / debug bypass that strips the
    // header would self-DoS.
    const router: OgRouter = async () => pngResponse();
    const cache = makeStubCache();
    const env = makeEnv(makeKvStore());
    const ctx = makeCtx();
    const opts = { limit: 1, windowSeconds: 60 };
    for (let i = 0; i < 5; i++) {
      const req = new Request(`https://og.tightropetracker.uk/og/headline-${i}.png`);
      const res = await handleOgRequest(req, env, ctx, router, { cache, rateLimitOptions: opts });
      expect(res.status, `iter ${i}`).toBe(200);
    }
  });

  it("fail-opens when KV is broken (transient infra failure must not nuke the worker)", async () => {
    const router: OgRouter = async () => pngResponse();
    const cache = makeStubCache();
    const brokenKv = {
      get: async () => { throw new Error("kv down"); },
      put: async () => { throw new Error("kv down"); },
    };
    const env = { KV: brokenKv } as unknown as Env;
    const ctx = makeCtx();
    const req = new Request("https://og.tightropetracker.uk/og/headline-score.png", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    const res = await handleOgRequest(req, env, ctx, router, { cache, rateLimitOptions: TEST_RL });
    expect(res.status).toBe(200);
  });
});
