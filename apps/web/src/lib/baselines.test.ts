/**
 * Coverage for the baseline-summary loader (web side).
 *
 *   - KV-first read when fresh
 *   - D1-fallback on KV miss
 *   - 24h freshness gate forces a rebuild
 *   - empty-payload fallback when env bindings are missing
 *   - the rebuilt payload is a structurally valid MethodologyBaselinesPayload
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { loadBaselineSummaries, emptyBaselines } from "./page-data.js";
import type { MethodologyBaselinesPayload } from "./db.js";

interface BaselineRow { indicator_id: string; value: number }

interface KvStub {
  get: <T>(key: string, type?: "json") => Promise<T | null>;
  put: (key: string, value: string, opts?: { expirationTtl?: number }) => Promise<void>;
}
interface DbStub {
  prepare: (sql: string) => {
    bind: (...args: unknown[]) => { all: () => Promise<{ results: BaselineRow[] }> };
  };
}

function makeLocals(opts: {
  cached: MethodologyBaselinesPayload | null;
  rows: BaselineRow[];
}): App.Locals {
  const kv: KvStub = {
    get: async <T,>(key: string) => {
      if (key !== "methodology:baselines") return null;
      return opts.cached as unknown as T | null;
    },
    put: async () => undefined,
  };
  const db: DbStub = {
    prepare: () => ({
      bind: () => ({ all: async () => ({ results: opts.rows }) }),
    }),
  };
  return { runtime: { env: { KV: kv, DB: db } as unknown as Env } } as unknown as App.Locals;
}

describe("loadBaselineSummaries", () => {
  afterEach(() => vi.useRealTimers());

  it("returns the cached payload when fresh", async () => {
    const now = new Date("2026-04-27T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const cached: MethodologyBaselinesPayload = {
      schemaVersion: 1,
      generatedAt: "2026-04-27T11:30:00Z",
      baselineStart: "2019-01-01T00:00:00Z",
      baselineEnd: "2026-04-27T11:30:00Z",
      excludeStart: "2020-04-01T00:00:00Z",
      excludeEnd: "2020-06-30T23:59:59Z",
      baselines: { gilt_10y: { knots: [{ p: 0, v: 1 }, { p: 1, v: 5 }], n: 100 } },
    };
    const locals = makeLocals({ cached, rows: [] });
    const result = await loadBaselineSummaries(locals);
    expect(result.baselines.gilt_10y!.n).toBe(100);
  });

  it("rebuilds from D1 when the cache is missing", async () => {
    const rows: BaselineRow[] = [
      { indicator_id: "x", value: 1 },
      { indicator_id: "x", value: 2 },
      { indicator_id: "x", value: 3 },
    ];
    const locals = makeLocals({ cached: null, rows });
    const result = await loadBaselineSummaries(locals);
    expect(result.baselines.x!.n).toBe(3);
    expect(result.schemaVersion).toBe(1);
  });

  it("rebuilds when the cache is older than 24 hours", async () => {
    const now = new Date("2026-04-27T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const cached: MethodologyBaselinesPayload = {
      schemaVersion: 1,
      generatedAt: "2026-04-26T11:00:00Z", // 25h old
      baselineStart: "2019-01-01T00:00:00Z",
      baselineEnd: "2026-04-26T11:00:00Z",
      excludeStart: "2020-04-01T00:00:00Z",
      excludeEnd: "2020-06-30T23:59:59Z",
      baselines: {},
    };
    const rows: BaselineRow[] = [{ indicator_id: "y", value: 99 }];
    const locals = makeLocals({ cached, rows });
    const result = await loadBaselineSummaries(locals);
    // The rebuild used the D1 row, not the empty cached baselines.
    expect(result.baselines.y!.n).toBe(1);
  });

  it("returns an empty payload when env bindings are missing", async () => {
    const result = await loadBaselineSummaries({} as unknown as App.Locals);
    expect(result.baselines).toEqual({});
    expect(result.schemaVersion).toBe(1);
  });

  it("emptyBaselines returns the canonical empty shape", () => {
    const e = emptyBaselines();
    expect(e.schemaVersion).toBe(1);
    expect(e.baselines).toEqual({});
    expect(typeof e.generatedAt).toBe("string");
  });
});
