/**
 * Regression tests for `handleScoreHistory` — specifically the KV
 * freshness gate on `score:history:90d`.
 *
 * Pre-fix the readThrough cache had no freshness predicate, so a 90-day
 * history slice cached during an outage could keep serving until the
 * KV TTL (6h) expired even after recompute resumed. Now the handler
 * rejects a cached slice whose newest point is older than 30 minutes,
 * matching the live-snapshot freshness window.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScoreHistory } from "@tightrope/shared";
import { handleScoreHistory } from "../handlers/score.js";

interface KvStub {
  get: <T = unknown>(key: string, fmt?: "json") => Promise<T | null>;
  put: (key: string, value: string, opts?: { expirationTtl?: number }) => Promise<void>;
}

interface DbStub {
  prepare: (sql: string) => {
    bind: (...args: unknown[]) => { all: () => Promise<{ results: unknown[] }> };
    all: () => Promise<{ results: unknown[] }>;
  };
}

function makeHistory(latest: string, value: number): ScoreHistory {
  return {
    points: [
      { timestamp: "2026-01-27T12:00:00Z", headline: 50, pillars: { market: 50, fiscal: 50, labour: 50, delivery: 50 } },
      { timestamp: latest,                  headline: value, pillars: { market: value, fiscal: value, labour: value, delivery: value } },
    ],
    rangeDays: 90,
    scoreDirection: "higher_is_better",
    schemaVersion: 2,
  };
}

interface Counter { value: number }

function makeEnv(opts: {
  cached: ScoreHistory | null;
  /** Headline value the D1 fallback should report for its newest row. */
  d1Latest: number;
}): { env: Env; ctx: ExecutionContext; kvWrites: { key: string; body: ScoreHistory }[]; loaderCalls: Counter } {
  const kvWrites: { key: string; body: ScoreHistory }[] = [];
  // Wrapper object so callers see live increments — destructuring a primitive
  // would capture the initial 0 by value and mask test failures.
  const loaderCalls: Counter = { value: 0 };
  const kv: KvStub = {
    get: async <T,>(key: string) => {
      if (key !== "score:history:90d") return null;
      return opts.cached as unknown as T | null;
    },
    put: async (key: string, value: string) => {
      kvWrites.push({ key, body: JSON.parse(value) as ScoreHistory });
    },
  };
  const db: DbStub = {
    prepare: (_sql: string) => {
      loaderCalls.value++;
      return {
        bind: () => ({ all: async () => ({ results: [] }) }),
        all: async () => ({ results: [] }),
      };
    },
  };
  const env = { KV: kv, DB: db } as unknown as Env;
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { void p; },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return { env, ctx, kvWrites, loaderCalls };
}

function makeRequest(): Request {
  return new Request("https://api.tightropetracker.uk/api/v1/score/history?days=90");
}

describe("handleScoreHistory — KV freshness gate on score:history:90d", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves the KV slice when its newest point is within 30 minutes", async () => {
    const now = new Date("2026-04-27T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const cached = makeHistory("2026-04-27T11:50:00Z", 52.9);
    const { env, ctx, loaderCalls } = makeEnv({ cached, d1Latest: 99 });

    const res = await handleScoreHistory(makeRequest(), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as ScoreHistory;
    expect(body.points.at(-1)?.headline).toBe(52.9);
    expect(loaderCalls.value, "D1 should not be touched on a fresh cache hit").toBe(0);
  });

  it("falls through to D1 when the KV slice's newest point is older than 30 minutes", async () => {
    const now = new Date("2026-04-27T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // 31 minutes old.
    const cached = makeHistory("2026-04-27T11:29:00Z", 52.9);
    const { env, ctx, loaderCalls } = makeEnv({ cached, d1Latest: 60.4 });

    const res = await handleScoreHistory(makeRequest(), env, ctx);
    expect(res.status).toBe(200);
    expect(loaderCalls.value, "D1 should be queried when KV is stale").toBeGreaterThan(0);
  });

  it("falls through to D1 when KV is empty", async () => {
    const { env, ctx, loaderCalls } = makeEnv({ cached: null, d1Latest: 50 });
    await handleScoreHistory(makeRequest(), env, ctx);
    expect(loaderCalls.value).toBeGreaterThan(0);
  });

  it("falls through to D1 when the cached slice has zero points (degenerate cache)", async () => {
    const empty: ScoreHistory = { points: [], rangeDays: 90, scoreDirection: "higher_is_better", schemaVersion: 2 };
    const { env, ctx, loaderCalls } = makeEnv({ cached: empty, d1Latest: 50 });
    await handleScoreHistory(makeRequest(), env, ctx);
    // Empty points → no newest timestamp → treat as stale, force a rebuild.
    expect(loaderCalls.value).toBeGreaterThan(0);
  });

  it("falls through to D1 when the cached slice has wrong schema version", async () => {
    const now = new Date("2026-04-27T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const cached = makeHistory("2026-04-27T11:55:00Z", 52.9);
    (cached as unknown as { schemaVersion: number }).schemaVersion = 99;

    const { env, ctx, loaderCalls } = makeEnv({ cached, d1Latest: 60.4 });
    await handleScoreHistory(makeRequest(), env, ctx);
    expect(loaderCalls.value).toBeGreaterThan(0);
  });
});
