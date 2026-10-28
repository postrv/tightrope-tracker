import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { INDICATORS, PILLAR_ORDER, type ScoreHistory, type ScoreSnapshot } from "@tightrope/shared";
import type { Env } from "../env.js";
import { recomputeScores } from "../pipelines/recompute.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:" + "sqlite") as typeof import("node:sqlite");
const NOW = "2026-10-28T13:30:00.000Z";
const BEFORE = "2026-10-28T13:25:00.000Z";
interface BoundStatement { sql: string; params: unknown[] }

/** Run the real recompute queries and writes against SQLite, with only the
 * D1 binding transport and KV transport adapted for the test. */
function setup(staleMarket = false) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE indicator_observations (
      indicator_id TEXT, observed_at TEXT, value REAL, source_id TEXT,
      ingested_at TEXT, payload_hash TEXT, released_at TEXT,
      PRIMARY KEY (indicator_id, observed_at)
    );
    CREATE TABLE headline_scores (observed_at TEXT PRIMARY KEY, value REAL, band TEXT, dominant TEXT, editorial TEXT);
    CREATE TABLE pillar_scores (pillar_id TEXT, observed_at TEXT, value REAL, band TEXT, PRIMARY KEY (pillar_id, observed_at));
    CREATE TABLE ingestion_audit (source_id TEXT, started_at TEXT, status TEXT);
  `);
  for (const [id, value] of [["gilt_10y", 5.3], ["cb_headroom", 23.6], ["unemployment", 4.7], ["housing_trajectory", 47.7]] as const) {
    const observedAt = staleMarket && id === "gilt_10y" ? "2026-10-01T16:00:00Z" : BEFORE;
    sqlite.prepare("INSERT INTO indicator_observations VALUES (?, ?, ?, ?, ?, ?, NULL)")
      .run(id, observedAt, value, INDICATORS[id]!.sourceId, BEFORE, `live-${id}`);
  }
  sqlite.prepare("INSERT INTO headline_scores VALUES (?, 38.3, 'acute', 'market', 'prior score')").run(BEFORE);
  for (const [index, p] of PILLAR_ORDER.entries()) {
    sqlite.prepare("INSERT INTO pillar_scores VALUES (?, ?, ?, 'acute')").run(p, BEFORE, 31 + index);
  }
  const kv = new Map<string, string>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return { sql, params, all: async () => ({ results: sqlite.prepare(sql).all(...(params as [])) }) };
        },
        all: async () => ({ results: sqlite.prepare(sql).all() }),
      };
    },
    batch: vi.fn(async (statements: BoundStatement[]) => statements.map((statement) => {
      const info = sqlite.prepare(statement.sql).run(...(statement.params as []));
      return { success: true, meta: { changes: Number(info.changes) } };
    })),
  };
  const env = {
    DB: db as unknown as D1Database,
    KV: { put: async (key: string, value: string) => { kv.set(key, value); } },
  } as unknown as Env;
  return { env, db, sqlite, kv };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("recompute cache consistency", () => {
  it("publishes the newly persisted headline and all pillar values to history in the same run", async () => {
    const { env, sqlite, kv } = setup();
    try {
      await recomputeScores(env);
      const snapshot = JSON.parse(kv.get("score:latest")!) as ScoreSnapshot;
      const history = JSON.parse(kv.get("score:history:90d")!) as ScoreHistory;
      const last = history.points.at(-1)!;
      expect(snapshot.headline.value).not.toBe(38.3);
      expect(last.timestamp).toBe(snapshot.headline.updatedAt);
      expect(last.headline).toBe(snapshot.headline.value);
      expect(snapshot.headline.sparkline90d.at(-1)).toBe(snapshot.headline.value);
      for (const p of PILLAR_ORDER) expect(last.pillars[p]).toBe(snapshot.pillars[p].value);
      expect(sqlite.prepare("SELECT value FROM headline_scores WHERE observed_at = ?").get(NOW)?.value).toBe(last.headline);
      // Same-day downsampling replaces the prior cache point rather than
      // appending a second point that would distort the chart's daily axis.
      expect(history.points).toHaveLength(1);
    } finally { sqlite.close(); }
  });

  it("keeps a stale computed headline and stale pillar out of persisted and cached history", async () => {
    const { env, sqlite, kv } = setup(true);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await recomputeScores(env);
      const snapshot = JSON.parse(kv.get("score:latest")!) as ScoreSnapshot;
      const history = JSON.parse(kv.get("score:history:90d")!) as ScoreHistory;
      expect(snapshot.headline.stale).toBe(true);
      expect(snapshot.pillars.market.stale).toBe(true);
      expect(history.points.at(-1)).toEqual({ timestamp: BEFORE, headline: 38.3, pillars: { market: 31, fiscal: 32, labour: 33, delivery: 34 } });
      expect(snapshot.headline.sparkline90d.at(-1)).toBe(38.3);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM headline_scores WHERE observed_at = ?").get(NOW)?.n).toBe(0);
      const persisted = sqlite.prepare("SELECT pillar_id FROM pillar_scores WHERE observed_at = ? ORDER BY pillar_id").all(NOW);
      expect(persisted.map((r) => r.pillar_id)).toEqual(["delivery", "fiscal", "labour"]);
    } finally { sqlite.close(); }
  });

  it("does not cache an unpersisted result if the D1 write fails", async () => {
    const { env, db, sqlite, kv } = setup();
    db.batch.mockRejectedValueOnce(new Error("D1 write unavailable"));
    try {
      await expect(recomputeScores(env)).rejects.toThrow("D1 write unavailable");
      expect(kv.has("score:latest")).toBe(false);
      expect(kv.has("score:history:90d")).toBe(false);
    } finally { sqlite.close(); }
  });
});
