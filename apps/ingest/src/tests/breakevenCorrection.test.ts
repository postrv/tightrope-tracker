import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { applyBreakevenCorrection, prepareBreakevenCorrection, type BreakevenBeforeRow } from "../pipelines/correctBreakevenSeries.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:" + "sqlite") as typeof import("node:sqlite");
const SOURCE = { url: "https://www.bankofengland.co.uk/series?SeriesCodes=IUDSIZC", csvSha256: "a".repeat(64) };
function setup(onAuditOpen?: (sqlite: InstanceType<typeof DatabaseSync>) => void) {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-28T18:00:00Z"));
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE indicator_observations (indicator_id TEXT,source_id TEXT,observed_at TEXT,value REAL,
    released_at TEXT,payload_hash TEXT,ingested_at TEXT,PRIMARY KEY(indicator_id,observed_at));
    CREATE TABLE ingestion_audit (id TEXT,source_id TEXT,started_at TEXT,completed_at TEXT,status TEXT,rows_written INTEGER,payload_hash TEXT,error TEXT,source_url TEXT);
    CREATE TABLE headline_scores (observed_at TEXT,value REAL);
    INSERT INTO headline_scores VALUES ('2026-10-28T17:50:00Z',39.1);
    INSERT INTO indicator_observations VALUES ('gilt_10y','boe_yields','2026-10-26T16:00:00Z',5,NULL,'untouched','2026-10-27T12:00:00Z');
    INSERT INTO indicator_observations VALUES ('breakeven_5y','boe_yields','2026-10-23T00:00:00Z',1.277,NULL,'hist:old-midnight','2026-10-27T12:00:00Z');
    INSERT INTO indicator_observations VALUES ('breakeven_5y','boe_yields','2026-10-23T16:00:00Z',1.277,NULL,'hist:old-close','2026-10-27T12:00:00Z');
    INSERT INTO indicator_observations VALUES ('breakeven_5y','boe_yields','2026-10-26T16:00:00Z',1.2673,NULL,'old-live','2026-10-27T12:00:00Z');`);
  const prepare = (sql: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => prepare(sql, next),
    all: async () => ({ results: sqlite.prepare(sql).all(...params as []) }),
    first: async () => sqlite.prepare(sql).get(...params as []) ?? null,
    run: async () => {
      const changes = Number(sqlite.prepare(sql).run(...params as []).changes);
      if (/INSERT INTO ingestion_audit/.test(sql)) onAuditOpen?.(sqlite);
      return { success: true, meta: { changes } };
    },
  });
  const db = { prepare, batch: async (statements: ReturnType<typeof prepare>[]) => Promise.all(statements.map((s) => s.run())) } as unknown as D1Database;
  const rows = () => sqlite.prepare("SELECT * FROM indicator_observations WHERE indicator_id='breakeven_5y' ORDER BY observed_at").all() as unknown as BreakevenBeforeRow[];
  const official = [
    { indicatorId: "breakeven_5y", sourceId: "boe_yields", observedAt: "2026-10-23T16:00:00Z", value: 3.6843, payloadHash: "hist:official" },
    { indicatorId: "breakeven_5y", sourceId: "boe_yields", observedAt: "2026-10-26T16:00:00Z", value: 3.6941, payloadHash: "hist:official" },
    { indicatorId: "breakeven_5y", sourceId: "boe_yields", observedAt: "2024-01-02T16:00:00Z", value: 3.4266, payloadHash: "hist:official-extra-date" },
  ];
  return { sqlite, db, rows, official };
}
afterEach(() => vi.useRealTimers());

describe("explicit existing-key breakeven source correction", () => {
  it("corrects archived live and historical keys without adding source dates or rewriting published scores", async () => {
    const { sqlite, db, rows, official } = setup();
    try {
      const before = rows();
      const plan = await prepareBreakevenCorrection(before, official, SOURCE);
      expect(rows()).toEqual(before); // planning is genuinely read only
      const result = await applyBreakevenCorrection(db, plan);
      expect(result.rowsWritten).toBe(3);
      expect(rows().map((r) => r.observed_at)).toEqual(before.map((r) => r.observed_at));
      expect(rows().map((r) => r.value)).toEqual([3.6843,3.6843,3.6941]);
      expect(rows()[0]!.payload_hash).toMatch(/^hist:/);
      expect(rows()[2]!.payload_hash).toMatch(/^source-correction:/);
      expect(rows().map((r) => r.released_at)).toEqual(before.map((r) => r.released_at));
      expect(sqlite.prepare("SELECT value,payload_hash FROM indicator_observations WHERE indicator_id='gilt_10y'").get())
        .toMatchObject({ value: 5, payload_hash: "untouched" });
      expect(sqlite.prepare("SELECT * FROM headline_scores").all()).toEqual([{ observed_at: "2026-10-28T17:50:00Z", value: 39.1 }]);
      expect(sqlite.prepare("SELECT status,rows_written,source_url FROM ingestion_audit").get())
        .toMatchObject({ status: "success", rows_written: 3, source_url: SOURCE.url });
    } finally { sqlite.close(); }
  });

  it("refuses the entire operation if any existing day lacks independent official inflation evidence", async () => {
    const { sqlite, rows, official } = setup();
    try {
      const before = rows();
      await expect(prepareBreakevenCorrection(before, official.slice(0,1), SOURCE)).rejects.toThrow("No official inflation reading");
      expect(rows()).toEqual(before);
    } finally { sqlite.close(); }
  });

  it("rejects a stale archive before opening an audit or changing any observation", async () => {
    const { sqlite, db, rows, official } = setup();
    try {
      const plan = await prepareBreakevenCorrection(rows(), official, SOURCE);
      sqlite.prepare("UPDATE indicator_observations SET value=1.3 WHERE payload_hash='old-live'").run();
      const concurrent = rows();
      await expect(applyBreakevenCorrection(db, plan)).rejects.toThrow("state changed since archive");
      expect(rows()).toEqual(concurrent);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM ingestion_audit").get()?.n).toBe(0);
    } finally { sqlite.close(); }
  });

  it("atomically cancels EVERY correction when a source row changes after the initial archive check", async () => {
    const { sqlite, db, rows, official } = setup((database) => {
      database.prepare("UPDATE indicator_observations SET ingested_at='2026-10-28T18:00:01Z' WHERE payload_hash='old-live'").run();
    });
    try {
      const before = rows();
      const plan = await prepareBreakevenCorrection(before, official, SOURCE);
      await expect(applyBreakevenCorrection(db, plan)).rejects.toThrow("atomic guard");
      expect(rows().map((r) => ({ value: r.value, hash: r.payload_hash })))
        .toEqual(before.map((r) => ({ value: r.value, hash: r.payload_hash })));
      expect(rows().at(-1)!.ingested_at).toBe("2026-10-28T18:00:01Z"); // concurrent write preserved
      expect(sqlite.prepare("SELECT status,error FROM ingestion_audit").get())
        .toMatchObject({ status: "failure", error: expect.stringContaining("no correction rows applied") });
    } finally { sqlite.close(); }
  });
});
