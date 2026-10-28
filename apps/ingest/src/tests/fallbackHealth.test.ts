import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lseFtse250Adapter, eodhdHousebuildersAdapter, obrEfoAdapter, type DataSourceAdapter } from "@tightrope/data-sources";
import { computeSourceHealth } from "@tightrope/shared";
import { runAdapter } from "../pipelines/runAdapter.js";
import type { Env } from "../env.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:" + "sqlite") as typeof import("node:sqlite");

function setup(sourceId: string, indicatorId: string, value: number) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-28T18:05:00Z"));
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE ingestion_audit (id TEXT PRIMARY KEY, source_id TEXT, started_at TEXT, completed_at TEXT,
      status TEXT, rows_written INTEGER, source_url TEXT, payload_hash TEXT, error TEXT);
    CREATE TABLE indicator_observations (indicator_id TEXT, observed_at TEXT, value REAL, source_id TEXT,
      ingested_at TEXT, payload_hash TEXT, released_at TEXT, PRIMARY KEY(indicator_id, observed_at));
  `);
  sqlite.prepare("INSERT INTO indicator_observations VALUES (?, '2026-10-27T16:30:00Z', ?, ?, '2026-10-27T18:05:00Z', 'verified-live', NULL)")
    .run(indicatorId, value, sourceId);
  function prepare(sql: string, params: unknown[] = []) {
    return {
      bind: (...next: unknown[]) => prepare(sql, next),
      run: async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...params as []).changes) } }),
      first: async () => sqlite.prepare(sql).get(...params as []) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...params as []) }),
    };
  }
  const env = { DB: { prepare, batch: async (statements: ReturnType<typeof prepare>[]) => Promise.all(statements.map((s) => s.run())) } } as unknown as Env;
  const observations = () => sqlite.prepare("SELECT * FROM indicator_observations ORDER BY observed_at").all();
  const lastAudit = () => sqlite.prepare("SELECT * FROM ingestion_audit ORDER BY started_at DESC, rowid DESC LIMIT 1").get()!;
  const health = () => {
    const row = lastAudit();
    return computeSourceHealth([{ sourceId: String(row.source_id), startedAt: String(row.started_at), status: String(row.status) }], {});
  };
  return { env, sqlite, observations, lastAudit, health };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("fixture fallback ingestion health", () => {
  it.each([
    [lseFtse250Adapter, "ftse_250", 24720],
    [eodhdHousebuildersAdapter, "housebuilder_idx", 56],
  ] as const)("keeps verified %s readings untouched and exposes missing credentials", async (adapter, indicatorId, value) => {
    const { env, sqlite, observations, lastAudit, health } = setup(adapter.id, indicatorId, value);
    try {
      const before = observations();
      const fetchImpl = vi.fn();
      await runAdapter(env, adapter, { fetchImpl });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(observations()).toEqual(before); // includes original value, hash and ingestion time
      expect(lastAudit()).toMatchObject({ status: "partial", rows_written: 0 });
      expect(lastAudit().error).toContain("no EODHD_API_KEY");
      expect(lastAudit().source_url).toMatch(/^local:fixtures\//);
      expect(health()).toMatchObject([{ sourceId: adapter.id, status: "partial" }]);
    } finally { sqlite.close(); }
  });

  it.each([
    [lseFtse250Adapter, "ftse_250", 24720, 24600, "https://eodhd.com/api/eod/FTMC.INDX"],
    [eodhdHousebuildersAdapter, "housebuilder_idx", 70, 71.7, "https://eodhd.com/api/eod/?exchange=LSE"],
  ] as const)("surfaces HTTP 429 then persists genuine %s recovery and clears the public degradation", async (adapter, indicatorId, value, recoveredValue, sourceUrl) => {
    const { env, sqlite, observations, lastAudit, health } = setup(adapter.id, indicatorId, value);
    env.EODHD_API_KEY = "test-only-secret";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const before = observations();
      await runAdapter(env, adapter, { fetchImpl: async () => new Response("Rate limited", { status: 429 }) });
      expect(observations()).toEqual(before);
      expect(lastAudit()).toMatchObject({ status: "partial", rows_written: 0 });
      expect(lastAudit().source_url).toMatch(/^local:fixtures\//);
      expect(lastAudit().error).toContain("HTTP 429");
      expect(health()).toHaveLength(1);

      vi.setSystemTime(new Date("2026-10-28T18:06:00Z"));
      await runAdapter(env, adapter, { fetchImpl: async (request) => {
        const symbol = String(request).match(/\/([^/]+)\.LSE\?/)?.[1];
        const close = symbol ? { PSN: 1248.5, BTRW: 421, TW: 118.2, BKG: 3912, VTY: 652 }[symbol] : 24600;
        return new Response(JSON.stringify([{ date: "2026-10-28", close }]));
      } });
      expect(observations()).toHaveLength(2);
      expect(observations().at(-1)).toMatchObject({ value: recoveredValue, observed_at: "2026-10-28T16:30:00Z" });
      expect(lastAudit()).toMatchObject({ status: "success", rows_written: 1, error: null, source_url: sourceUrl });
      expect(health()).toEqual([]);
    } finally { sqlite.close(); }
  });

  it("treats the deliberately maintained OBR vintage fixture as a healthy source", async () => {
    const { env, sqlite, lastAudit, health } = setup("obr_efo", "cb_headroom", 14.5);
    try {
      const result = await runAdapter(env, obrEfoAdapter, { fetchImpl: vi.fn() });
      expect(result.fallbackReason).toBeUndefined();
      expect(lastAudit()).toMatchObject({ status: "success", rows_written: 2, error: null });
      expect(health()).toEqual([]);
    } finally { sqlite.close(); }
  });

  it("redacts authenticated provenance and fallback errors while retaining a useful source URL", async () => {
    const { env, sqlite, lastAudit } = setup("lseg", "ftse_250", 24720);
    env.EODHD_API_KEY = "test-only-secret";
    const adapter: DataSourceAdapter = {
      id: "lseg", name: "test",
      fetch: async () => ({ observations: [], fetchedAt: new Date().toISOString(),
        sourceUrl: "https://user:password@example.test/series?api_token=test-only-secret&fmt=json#private",
        fallbackReason: "failed https://example.test?api_token=test-only-secret with test-only-secret" }),
    };
    try {
      await runAdapter(env, adapter);
      const audit = lastAudit();
      expect(audit.source_url).toBe("https://example.test/series?api_token=%5Bredacted%5D&fmt=json");
      expect(audit.error).toContain("[redacted]");
      expect(JSON.stringify(audit)).not.toContain("test-only-secret");
      expect(JSON.stringify(audit)).not.toContain("password");
    } finally { sqlite.close(); }
  });
});
