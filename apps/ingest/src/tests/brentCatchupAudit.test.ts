import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eiaBrentAdapter, type DataSourceAdapter, type RawObservation } from "@tightrope/data-sources";
import { backfillObservations } from "../pipelines/backfillObservations.js";
import type { Env } from "../env.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:" + "sqlite") as typeof import("node:sqlite");

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T02:00:00Z"));
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE ingestion_audit (id TEXT PRIMARY KEY, source_id TEXT, started_at TEXT, completed_at TEXT,
      status TEXT, rows_written INTEGER, source_url TEXT, payload_hash TEXT, error TEXT);
    CREATE TABLE indicator_observations (indicator_id TEXT, observed_at TEXT, value REAL, source_id TEXT,
      ingested_at TEXT, payload_hash TEXT, released_at TEXT, PRIMARY KEY(indicator_id, observed_at));
    INSERT INTO indicator_observations VALUES
      ('brent_gbp', '2026-10-27T00:00:00Z', 92.47, 'eia_brent', '2026-10-28T17:00:00Z', 'verified-live', NULL);
  `);
  const fixes = [["21", 1.3384], ["22", 1.3363], ["23", 1.3387], ["26", 1.3347], ["27", 1.3313], ["28", 1.3301]] as const;
  for (const [day, value] of fixes) {
    sqlite.prepare("INSERT INTO indicator_observations VALUES ('gbp_usd', ?, ?, 'boe_fx', '2026-10-29T01:00:00Z', 'fx', NULL)")
      .run(`2026-10-${day}T16:00:00Z`, value);
  }
  const prepare = (sql: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => prepare(sql, next),
    run: async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...params as []).changes) } }),
    first: async () => sqlite.prepare(sql).get(...params as []) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...params as []) }),
  });
  const env = {
    EIA_API_KEY: "test-key",
    DB: { prepare, batch: async (statements: ReturnType<typeof prepare>[]) => Promise.all(statements.map(s => s.run())) },
  } as unknown as Env;
  const rows = () => sqlite.prepare("SELECT * FROM indicator_observations ORDER BY indicator_id, observed_at").all();
  const lastAudit = () => sqlite.prepare("SELECT * FROM ingestion_audit ORDER BY rowid DESC LIMIT 1").get();
  return { env, sqlite, rows, lastAudit };
}

const range = { from: new Date("2026-10-21"), to: new Date("2026-10-28"), dryRun: false, overwrite: false };
const recordedPrices = [
  { period: "2026-10-21", value: "117.37" }, { period: "2026-10-22", value: "125.39" },
  { period: "2026-10-23", value: "128.30" }, { period: "2026-10-26", value: "128.12" },
  { period: "2026-10-27", value: "123.10" },
];

afterEach(() => vi.useRealTimers());

describe("Brent missing-only catchup audit", () => {
  it("marks a populated repeat as unchanged, preserves existing fields, then records a genuinely new print", async () => {
    const { env, sqlite, rows, lastAudit } = setup();
    let prices = recordedPrices;
    const fetchImpl = vi.fn(async () => Response.json({ response: { total: prices.length, data: prices } }));
    try {
      const initial = await backfillObservations(env, eiaBrentAdapter, { ...range, fetchImpl });
      expect(initial).toMatchObject({ observationsFetched: 5, rowsWritten: 4, rowsRejected: [] });
      expect(lastAudit()).toMatchObject({ status: "success", rows_written: 4, error: null });
      const beforeRepeat = rows();

      vi.setSystemTime(new Date("2026-10-29T03:00:00Z"));
      const repeat = await backfillObservations(env, eiaBrentAdapter, { ...range, fetchImpl });
      expect(repeat).toMatchObject({ observationsFetched: 5, rowsWritten: 0, rowsRejected: [] });
      expect(lastAudit()).toMatchObject({ status: "unchanged", rows_written: 0, error: null });
      expect(rows()).toEqual(beforeRepeat); // values, hashes, release and ingestion timestamps

      // Synthetic subsequent publication, to exercise recovery independently
      // of whether the real upstream has released its 28 October price yet.
      prices = [...recordedPrices, { period: "2026-10-28", value: "120.00" }];
      const recovery = await backfillObservations(env, eiaBrentAdapter, { ...range, fetchImpl });
      expect(recovery).toMatchObject({ observationsFetched: 6, rowsWritten: 1, rowsRejected: [] });
      expect(lastAudit()).toMatchObject({ status: "success", rows_written: 1, error: null });
      expect(rows().filter(row => row.observed_at !== "2026-10-28T00:00:00Z")).toEqual(beforeRepeat);
      expect(rows().find(row => row.indicator_id === "brent_gbp" && row.observed_at === "2026-10-28T00:00:00Z"))
        .toMatchObject({ value: 90.22, source_id: "eia_brent" });
    } finally { sqlite.close(); }
  });

  it.each(["empty", "rejected"] as const)("keeps a %s result degraded rather than hiding it as an idempotent run", async (kind) => {
    const { env, sqlite, rows, lastAudit } = setup();
    const invalid: RawObservation = {
      indicatorId: "brent_gbp", sourceId: "eia_brent", observedAt: "2026-10-22T00:00:00Z", value: 93.83, payloadHash: "missing-hist-prefix",
    };
    const adapter: DataSourceAdapter = {
      id: "eia_brent", name: "Malformed response regression",
      async fetch() { throw new Error("historical only"); },
      async fetchHistorical() { return {
        observations: kind === "empty" ? [] : [invalid], sourceUrl: "https://www.eia.gov/dnav/pet/hist/RBRTED.htm",
        fetchedAt: new Date().toISOString(), earliestObservedAt: null, latestObservedAt: null,
      }; },
    };
    try {
      const before = rows();
      await backfillObservations(env, adapter, range);
      expect(rows()).toEqual(before);
      expect(lastAudit()).toMatchObject({ status: "partial", rows_written: 0 });
      expect(lastAudit()?.error).toContain(kind === "empty" ? "zero observations" : "historical observations rejected");
    } finally { sqlite.close(); }
  });
});
