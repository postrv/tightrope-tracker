/**
 * Freshness-gate regression tests for the OG worker's snapshot loader.
 *
 * The OG worker reads `score:latest` from KV when rendering share-card
 * images. Prior to this guard it accepted any cached snapshot regardless
 * of age, so a recompute outage ≥30 minutes long would have OG cards
 * silently render an out-of-date headline number until the KV TTL
 * expired (6 hours). The freshness gate matches the API and web
 * workers: trust KV only if `headline.updatedAt` is within the last
 * 30 minutes; otherwise fall through to D1.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScoreSnapshot } from "@tightrope/shared";
import { loadSnapshot } from "./data.js";

interface StubEnv {
  KV: {
    get: <T = unknown>(key: string, fmt?: "json") => Promise<T | null>;
  };
  DB: {
    prepare: (sql: string) => {
      first: <T = unknown>() => Promise<T | null>;
      all: <T = unknown>() => Promise<{ results: T[] }>;
      bind: (...args: unknown[]) => unknown;
    };
  };
}

function makeFreshSnapshot(updatedAt: string, value = 50): ScoreSnapshot {
  return {
    headline: {
      value,
      band: "strained",
      editorial: "test",
      updatedAt: updatedAt as ScoreSnapshot["headline"]["updatedAt"],
      dominantPillar: "market",
      sparkline90d: [],
      delta24h: 0,
      delta30d: 0,
      deltaYtd: 0,
    },
    pillars: {
      market:   { pillar: "market",   label: "Market",   value, band: "strained", weight: 0.4, contributions: [], trend7d: "flat", delta7d: 0, trend30d: "flat", delta30d: 0, sparkline30d: [] },
      fiscal:   { pillar: "fiscal",   label: "Fiscal",   value, band: "strained", weight: 0.3, contributions: [], trend7d: "flat", delta7d: 0, trend30d: "flat", delta30d: 0, sparkline30d: [] },
      labour:   { pillar: "labour",   label: "Labour",   value, band: "strained", weight: 0.2, contributions: [], trend7d: "flat", delta7d: 0, trend30d: "flat", delta30d: 0, sparkline30d: [] },
      delivery: { pillar: "delivery", label: "Delivery", value, band: "strained", weight: 0.1, contributions: [], trend7d: "flat", delta7d: 0, trend30d: "flat", delta30d: 0, sparkline30d: [] },
    },
    schemaVersion: 1,
  };
}

function makeEnv(opts: {
  kvSnapshot: ScoreSnapshot | null;
  /** Used as the fallback headline value when D1 is queried. */
  d1HeadlineValue?: number;
  d1HeadlineUpdatedAt?: string;
}): StubEnv {
  const kvGetCalls: string[] = [];
  const dbPreparedSqls: string[] = [];
  const env: StubEnv = {
    KV: {
      get: async <T,>(key: string) => {
        kvGetCalls.push(key);
        if (key !== "score:latest") return null;
        return opts.kvSnapshot as unknown as T | null;
      },
    },
    DB: {
      prepare: (sql: string) => {
        dbPreparedSqls.push(sql);
        return {
          first: async <T,>() => {
            if (sql.includes("FROM headline_scores")) {
              return {
                observed_at: opts.d1HeadlineUpdatedAt ?? new Date().toISOString(),
                value: opts.d1HeadlineValue ?? 0,
                band: "strained",
                dominant: "market",
                editorial: "from-d1",
              } as unknown as T;
            }
            return null;
          },
          all: async () => ({ results: [] }),
          bind() { return this; },
        };
      },
    },
  };
  // Expose for assertions.
  (env as StubEnv & { _kvGets: string[]; _dbSqls: string[] })._kvGets = kvGetCalls;
  (env as StubEnv & { _kvGets: string[]; _dbSqls: string[] })._dbSqls = dbPreparedSqls;
  return env;
}

describe("loadSnapshot — KV freshness gate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the KV snapshot when headline.updatedAt is within 30 minutes", async () => {
    const now = new Date("2026-04-27T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const cached = makeFreshSnapshot("2026-04-27T11:45:00Z", 52.9);
    const env = makeEnv({ kvSnapshot: cached, d1HeadlineValue: 99 });

    const snap = await loadSnapshot(env as unknown as Parameters<typeof loadSnapshot>[0]);

    expect(snap.headline.value, "should serve KV value, not D1 fallback").toBe(52.9);
    expect((env as unknown as { _dbSqls: string[] })._dbSqls.length, "D1 should not have been queried").toBe(0);
  });

  it("falls through to D1 when the KV snapshot is older than 30 minutes", async () => {
    const now = new Date("2026-04-27T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // 31 minutes old — past the freshness window.
    const cached = makeFreshSnapshot("2026-04-27T11:29:00Z", 52.9);
    const env = makeEnv({ kvSnapshot: cached, d1HeadlineValue: 60.4 });

    const snap = await loadSnapshot(env as unknown as Parameters<typeof loadSnapshot>[0]);

    expect(snap.headline.value, "should fall through to D1 (60.4), not serve stale KV (52.9)").toBe(60.4);
    expect((env as unknown as { _dbSqls: string[] })._dbSqls.length, "D1 should have been queried").toBeGreaterThan(0);
  });

  it("falls through to D1 when KV is empty", async () => {
    const env = makeEnv({ kvSnapshot: null, d1HeadlineValue: 50 });
    const snap = await loadSnapshot(env as unknown as Parameters<typeof loadSnapshot>[0]);
    expect(snap.headline.value).toBe(50);
  });

  it("falls through to D1 when KV snapshot has wrong schema version", async () => {
    const now = new Date("2026-04-27T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const cached = makeFreshSnapshot("2026-04-27T11:55:00Z", 52.9);
    (cached as unknown as { schemaVersion: number }).schemaVersion = 99;
    const env = makeEnv({ kvSnapshot: cached, d1HeadlineValue: 60.4 });

    const snap = await loadSnapshot(env as unknown as Parameters<typeof loadSnapshot>[0]);
    expect(snap.headline.value).toBe(60.4);
  });

  it("falls through to D1 when headline.updatedAt is unparseable", async () => {
    const cached = makeFreshSnapshot("not-a-real-iso-string", 52.9);
    const env = makeEnv({ kvSnapshot: cached, d1HeadlineValue: 60.4 });
    const snap = await loadSnapshot(env as unknown as Parameters<typeof loadSnapshot>[0]);
    expect(snap.headline.value).toBe(60.4);
  });
});
