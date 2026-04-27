/**
 * Coverage for `/api/v1/methodology/baselines`. Verifies the KV-first
 * read path, the D1-fallback assembly, the freshness gate, the
 * unknown-query rejection, and the JSON shape clients depend on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMethodologyBaselines } from "../handlers/methodology.js";

interface BaselineRow { indicator_id: string; value: number }

interface KvStub {
  get: <T = unknown>(key: string, fmt?: "json") => Promise<T | null>;
  put: (key: string, value: string, opts?: { expirationTtl?: number }) => Promise<void>;
}
interface DbStub {
  prepare: (sql: string) => {
    bind: (...args: unknown[]) => { all: () => Promise<{ results: BaselineRow[] }> };
  };
}

interface Counter { value: number }

function makeEnv(opts: {
  cached: object | null;
  rows: BaselineRow[];
}): { env: Env; ctx: ExecutionContext; kvWrites: { key: string; body: unknown }[]; loaderCalls: Counter } {
  const kvWrites: { key: string; body: unknown }[] = [];
  const loaderCalls: Counter = { value: 0 };
  const kv: KvStub = {
    get: async <T,>(key: string) => {
      if (key !== "methodology:baselines") return null;
      return opts.cached as unknown as T | null;
    },
    put: async (key: string, value: string) => {
      kvWrites.push({ key, body: JSON.parse(value) });
    },
  };
  const db: DbStub = {
    prepare: () => ({
      bind: () => {
        loaderCalls.value++;
        return { all: async () => ({ results: opts.rows }) };
      },
    }),
  };
  const env = { KV: kv, DB: db } as unknown as Env;
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { void p; },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return { env, ctx, kvWrites, loaderCalls };
}

function makeRequest(query = ""): Request {
  return new Request(`https://api.tightropetracker.uk/api/v1/methodology/baselines${query}`);
}

describe("/api/v1/methodology/baselines", () => {
  afterEach(() => vi.useRealTimers());

  it("serves a fresh cached payload without touching D1", async () => {
    const now = new Date("2026-04-27T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const cached = {
      schemaVersion: 1,
      generatedAt: "2026-04-27T11:30:00Z",
      baselineStart: "2019-01-01T00:00:00Z",
      baselineEnd: "2026-04-27T11:30:00Z",
      excludeStart: "2020-04-01T00:00:00Z",
      excludeEnd: "2020-06-30T23:59:59Z",
      baselines: { gilt_10y: { knots: [{ p: 0, v: 1.0 }, { p: 1, v: 5.0 }], n: 1234 } },
    };
    const { env, ctx, loaderCalls } = makeEnv({ cached, rows: [] });

    const res = await handleMethodologyBaselines(makeRequest(), env, ctx);
    expect(res.status).toBe(200);
    expect(loaderCalls.value, "D1 should be untouched on fresh cache hit").toBe(0);
    const body = await res.json() as typeof cached;
    expect(body.baselines.gilt_10y!.n).toBe(1234);
  });

  it("rebuilds from D1 when the cache is missing", async () => {
    const rows: BaselineRow[] = [
      { indicator_id: "gilt_10y", value: 3.1 },
      { indicator_id: "gilt_10y", value: 3.5 },
      { indicator_id: "gilt_10y", value: 4.2 },
      { indicator_id: "cb_headroom", value: 9.9 },
      { indicator_id: "cb_headroom", value: 21.7 },
    ];
    const { env, ctx, kvWrites, loaderCalls } = makeEnv({ cached: null, rows });

    const res = await handleMethodologyBaselines(makeRequest(), env, ctx);
    expect(res.status).toBe(200);
    expect(loaderCalls.value).toBeGreaterThan(0);
    const body = await res.json() as { baselines: Record<string, { knots: { p: number; v: number }[]; n: number }> };
    expect(body.baselines.gilt_10y!.n).toBe(3);
    expect(body.baselines.cb_headroom!.n).toBe(2);
    // Knots are sorted ascending by value.
    const knots = body.baselines.gilt_10y!.knots;
    for (let i = 1; i < knots.length; i++) {
      expect(knots[i]!.v).toBeGreaterThanOrEqual(knots[i - 1]!.v);
    }
    // The handler primes KV after a miss.
    expect(kvWrites.find((w) => w.key === "methodology:baselines")).toBeDefined();
  });

  it("rebuilds when the cache exists but is older than 24 hours", async () => {
    const now = new Date("2026-04-27T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const cached = {
      schemaVersion: 1,
      generatedAt: "2026-04-26T11:00:00Z", // 25h old
      baselineStart: "2019-01-01T00:00:00Z",
      baselineEnd: "2026-04-26T11:00:00Z",
      excludeStart: "2020-04-01T00:00:00Z",
      excludeEnd: "2020-06-30T23:59:59Z",
      baselines: {},
    };
    const rows: BaselineRow[] = [{ indicator_id: "gilt_10y", value: 4.0 }];
    const { env, ctx, loaderCalls } = makeEnv({ cached, rows });

    await handleMethodologyBaselines(makeRequest(), env, ctx);
    expect(loaderCalls.value, "D1 should rebuild past the 24h gate").toBeGreaterThan(0);
  });

  it("rejects unknown query parameters", async () => {
    const { env, ctx } = makeEnv({ cached: null, rows: [] });
    const res = await handleMethodologyBaselines(makeRequest("?bogus=1"), env, ctx);
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("BAD_QUERY");
  });

  it("includes the COVID exclusion window in the response so clients can audit", async () => {
    const { env, ctx } = makeEnv({ cached: null, rows: [{ indicator_id: "x", value: 1 }] });
    const res = await handleMethodologyBaselines(makeRequest(), env, ctx);
    const body = await res.json() as { excludeStart: string; excludeEnd: string };
    expect(body.excludeStart).toBe("2020-04-01T00:00:00Z");
    expect(body.excludeEnd).toBe("2020-06-30T23:59:59Z");
  });

  it("drops rows with non-finite values", async () => {
    const rows: BaselineRow[] = [
      { indicator_id: "x", value: 1 },
      { indicator_id: "x", value: Number.NaN },
      { indicator_id: "x", value: 2 },
    ];
    const { env, ctx } = makeEnv({ cached: null, rows });
    const res = await handleMethodologyBaselines(makeRequest(), env, ctx);
    const body = await res.json() as { baselines: Record<string, { n: number }> };
    expect(body.baselines.x!.n).toBe(2);
  });
});
