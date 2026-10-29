/**
 * Tests for the page-data extension that loads 90-day score history.
 *
 * Covers:
 *   - loadHomepageData returns a non-empty `history` when D1 has rows
 *   - loadHomepageData returns emptyHistory() when D1 throws
 *   - the KV freshness gate: stale cached history falls through to D1
 *   - emptyHistory returns a typed-but-empty placeholder
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScoreHistory } from "@tightrope/shared";
import { loadHomepageData, loadHistory, emptyHistory } from "./page-data.js";

interface StubRow {
  observed_at: string;
  value: number;
  pillar_id?: string;
  band?: string;
  dominant?: string;
  editorial?: string;
}

interface StubEnv {
  KV: { get: (key: string, type?: string) => Promise<unknown>; put: (...args: unknown[]) => Promise<void> };
  DB: {
    prepare: (sql: string) => StubStatement;
  };
}

interface StubStatement {
  bind: (...args: unknown[]) => StubStatement;
  all: <T>() => Promise<{ results: T[] }>;
  first: <T>() => Promise<T | null>;
}

function buildEnv(opts: {
  headlineRows?: StubRow[];
  pillarRows?: StubRow[];
  kvHistory?: ScoreHistory | null;
  d1Throws?: boolean;
  historyFailures?: number;
  onHistoryRead?: () => void;
} = {}): StubEnv {
  const headlineRows = opts.headlineRows ?? [];
  const pillarRows = opts.pillarRows ?? [];
  let historyReads = 0;

  function execute(sql: string): Promise<{ results: unknown[] }> {
    if (opts.d1Throws) return Promise.reject(new Error("D1 boom"));
    const lower = sql.toLowerCase();
    if (lower.includes("with selected as")) {
      opts.onHistoryRead?.();
      if (historyReads++ < (opts.historyFailures ?? 0)) return Promise.reject(new Error("D1_ERROR: Network connection lost"));
      return Promise.resolve({ results: headlineRows.map(r => ({ ...r, market: 50, fiscal: 50, labour: 50, delivery: 50 })) });
    }
    if (lower.includes("min(observed_at) as first")) return Promise.resolve({ results: [{ first: headlineRows[0]?.observed_at ?? null, last: headlineRows.at(-1)?.observed_at ?? null }] });
    if (lower.includes("from headline_scores") && lower.includes("limit 1")) {
      const last = headlineRows[headlineRows.length - 1];
      return Promise.resolve({
        results: last ? [{ ...last, band: "strained", dominant: "market", editorial: "" }] : [],
      });
    }
    if (lower.includes("from headline_scores") && lower.includes("where observed_at >=")) {
      return Promise.resolve({ results: headlineRows });
    }
    if (lower.includes("from headline_scores")) {
      return Promise.resolve({ results: headlineRows.map((r) => ({ observed_at: r.observed_at, value: r.value })) });
    }
    if (lower.includes("from pillar_scores") && lower.includes("where observed_at >=")) {
      return Promise.resolve({
        results: pillarRows.map((r) => ({ id: r.pillar_id, observed_at: r.observed_at, value: r.value })),
      });
    }
    if (lower.includes("from pillar_scores") && lower.includes("group by pillar_id") && !lower.includes("substr")) {
      return Promise.resolve({
        results: ["market", "fiscal", "labour", "delivery"].map((id) => ({
          id, observed_at: "2026-04-20T12:00:00Z", value: 50, band: "strained",
        })),
      });
    }
    return Promise.resolve({ results: [] });
  }

  function first(sql: string): Promise<unknown> {
    return execute(sql).then((r) => r.results[0] ?? null);
  }

  return {
    KV: {
      get: (key: string, type?: string) => {
        if (key === "score:history:90d" && type === "json") return Promise.resolve(opts.kvHistory ?? null);
        return Promise.resolve(null);
      },
      put: () => Promise.resolve(),
    },
    DB: {
      prepare: (sql: string) => {
        const stmt: StubStatement = {
          bind: () => stmt,
          all: () => execute(sql) as Promise<{ results: never[] }>,
          first: () => first(sql) as Promise<null>,
        };
        return stmt;
      },
    },
  };
}

function locals(env: StubEnv): App.Locals {
  return { runtime: { env: env as unknown as Env } } as unknown as App.Locals;
}

describe("emptyHistory", () => {
  it("returns a 90-day placeholder with an empty points array", () => {
    const h = emptyHistory();
    expect(h.points).toEqual([]);
    expect(h.rangeDays).toBe(90);
    expect(h.schemaVersion).toBe(2);
  });
});

describe("loadHomepageData history wiring", () => {
  it("returns a non-empty history when D1 has rows", async () => {
    const headlineRows: StubRow[] = [];
    for (let i = 0; i < 5; i++) {
      const day = String(i + 1).padStart(2, "0");
      headlineRows.push({ observed_at: `2026-04-${day}T12:00:00Z`, value: 50 + i });
    }
    const env = buildEnv({ headlineRows });
    const data = await loadHomepageData(locals(env));
    expect(data.history.points.length).toBe(5);
    expect(data.history.points[0]?.headline).toBe(50);
    expect(data.history.points[4]?.headline).toBe(54);
  });

  it("returns an empty history when D1 throws", async () => {
    const env = buildEnv({ d1Throws: true });
    const data = await loadHomepageData(locals(env));
    expect(data.history.points).toEqual([]);
    expect(data.history.rangeDays).toBe(90);
  });

  it("uses fresh KV-cached history without hitting D1", async () => {
    const fresh: ScoreHistory = {
      points: [
        // Within 30 minutes of "now" — stamps current time so the freshness
        // gate accepts it regardless of when the test runs.
        { timestamp: new Date().toISOString(), headline: 64, pillars: { market: 70, fiscal: 60, labour: 50, delivery: 40 } },
      ],
      rangeDays: 90, resolution: "daily", sampling: "last_recorded_in_bucket",
      scoreDirection: "higher_is_better",
      schemaVersion: 2,
    };
    // d1Throws = true ensures the test fails if D1 is touched at all.
    const env = buildEnv({ kvHistory: fresh, d1Throws: true });
    const data = await loadHomepageData(locals(env));
    expect(data.history.points.length).toBe(1);
    expect(data.history.points[0]?.headline).toBe(64);
  });

  it("falls through to D1 when the KV-cached history is stale", async () => {
    const stale: ScoreHistory = {
      points: [
        // 6 hours old → past the 30-minute freshness gate.
        { timestamp: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), headline: 99, pillars: { market: 99, fiscal: 99, labour: 99, delivery: 99 } },
      ],
      rangeDays: 90, resolution: "daily", sampling: "last_recorded_in_bucket",
      scoreDirection: "higher_is_better",
      schemaVersion: 2,
    };
    const headlineRows: StubRow[] = [
      { observed_at: "2026-04-19T12:00:00Z", value: 50 },
      { observed_at: "2026-04-20T12:00:00Z", value: 52 },
    ];
    const env = buildEnv({ kvHistory: stale, headlineRows });
    const data = await loadHomepageData(locals(env));
    // D1 result was used, not the stale value of 99.
    expect(data.history.points.length).toBe(2);
    expect(data.history.points[1]?.headline).toBe(52);
  });
});

describe("loadHistory with explicit range", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("clamps invalid days down to a 1..7305 window when KV/D1 are missing", async () => {
    const result = await loadHistory({} as App.Locals, 9999);
    expect(result.points).toEqual([]);
    expect(result.rangeDays).toBe(7305);
    expect(result.loadFailed).toBe(true);
  });

  it("returns empty history with the requested rangeDays when D1 throws", async () => {
    const env = buildEnv({ d1Throws: true });
    const result = await loadHistory(locals(env), 30);
    expect(result.points).toEqual([]);
    expect(result.rangeDays).toBe(30);
    expect(result.loadFailed).toBe(true);
  });

  it("recovers an All/daily history read after one rejected D1 request", async () => {
    let reads = 0;
    const env = buildEnv({ historyFailures: 1, onHistoryRead: () => { reads++; }, headlineRows: [
      { observed_at: "2024-12-17T23:59:00Z", value: 40 },
      { observed_at: "2026-10-28T23:50:00Z", value: 36.9 },
    ] });
    const result = await loadHistory(locals(env), 7305, "daily");
    expect(reads).toBe(2);
    expect(result.loadFailed).toBeUndefined();
    expect(result.points.map(p => p.headline)).toEqual([40, 36.9]);
    expect(result.availableFrom).toBe("2024-12-17T23:59:00Z");
    expect(result.resolution).toBe("daily");
  });

  it("marks two rejected reads unavailable and stops retrying", async () => {
    let reads = 0;
    const result = await loadHistory(locals(buildEnv({ historyFailures: 2, onHistoryRead: () => { reads++; } })), 7305, "daily");
    expect(reads).toBe(2);
    expect(result.loadFailed).toBe(true);
    expect(result.rangeDays).toBe(7305);
    expect(result.requestedResolution).toBe("daily");
  });

  it("keeps a genuinely empty successful archive distinct and does not retry it", async () => {
    let reads = 0;
    const result = await loadHistory(locals(buildEnv({ onHistoryRead: () => { reads++; } })), 7305, "daily");
    expect(reads).toBe(1);
    expect(result.points).toEqual([]);
    expect(result.loadFailed).toBeUndefined();
  });
});
