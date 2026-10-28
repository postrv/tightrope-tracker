import { describe, expect, it } from "vitest";
import type {
  AdapterContext,
  DataSourceAdapter,
  HistoricalFetchOptions,
  HistoricalFetchResult,
  RawObservation,
} from "@tightrope/data-sources";
import { historicalPayloadHash } from "@tightrope/data-sources";
import { backfillObservations } from "../pipelines/backfillObservations.js";
import {
  historicalPayloadHash as writerHash,
  writeHistoricalObservations,
} from "../lib/observations.js";
import type { Env } from "../env.js";

/**
 * Minimal D1 stub. Records every batch() insert so we can assert what was
 * written, plus first()/run() stubs for audit open/close statements.
 */
function makeEnv(fxRows: Array<{ value: number; observed_at: string }> = []): {
  env: Env;
  batches: Array<Array<{ sql: string; bindings: readonly unknown[] }>>;
  auditRows: Array<{ sql: string; bindings: readonly unknown[] }>;
  selects: Array<{ sql: string; bindings: readonly unknown[] }>;
} {
  const batches: Array<Array<{ sql: string; bindings: readonly unknown[] }>> = [];
  const auditRows: Array<{ sql: string; bindings: readonly unknown[] }> = [];
  const selects: Array<{ sql: string; bindings: readonly unknown[] }> = [];
  interface Stmt {
    sql: string;
    bindings: readonly unknown[];
    bind: (...b: unknown[]) => Stmt;
    first: <T>() => Promise<T | null>;
    run: () => Promise<{ success: true }>;
    all: () => Promise<{ results: unknown[] }>;
  }
  const makeStatement = (sql: string, bindings: readonly unknown[] = []): Stmt => ({
    sql,
    bindings,
    bind: (...b: unknown[]) => makeStatement(sql, b),
    first: async <T>() => null as T,
    run: async () => {
      if (/INSERT|UPDATE/.test(sql)) auditRows.push({ sql, bindings });
      return { success: true };
    },
    all: async () => {
      selects.push({ sql, bindings });
      return { results: sql.includes("SELECT value, observed_at FROM indicator_observations") ? fxRows : [] };
    },
  });
  const env = {
    DB: {
      prepare: (sql: string) => makeStatement(sql),
      batch: async (stmts: Array<Stmt>) => {
        batches.push(stmts.map((s) => ({ sql: s.sql, bindings: s.bindings })));
        return stmts.map(() => ({ success: true }));
      },
    },
    KV: {
      delete: async () => undefined,
    },
  } as unknown as Env;
  return { env, batches, auditRows, selects };
}

async function mockAdapter(): Promise<DataSourceAdapter> {
  return {
    id: "mock",
    name: "Mock",
    async fetch() {
      throw new Error("live fetch not used in historical test");
    },
    async fetchHistorical(_fetchImpl, opts: HistoricalFetchOptions): Promise<HistoricalFetchResult> {
      const observations: RawObservation[] = [];
      const fromMs = Date.UTC(opts.from.getUTCFullYear(), opts.from.getUTCMonth(), opts.from.getUTCDate());
      const toMs = Date.UTC(opts.to.getUTCFullYear(), opts.to.getUTCMonth(), opts.to.getUTCDate());
      let earliest: string | null = null;
      let latest: string | null = null;
      for (let ms = fromMs; ms <= toMs; ms += 86_400_000) {
        const observedAt = new Date(ms).toISOString().replace(/\.\d{3}Z$/, ".000Z");
        const value = 50 + ((ms / 86_400_000) % 7);
        observations.push({
          indicatorId: "mock_series",
          value,
          observedAt,
          sourceId: "mock",
          payloadHash: await historicalPayloadHash("mock_series", observedAt, value),
        });
        if (earliest === null) earliest = observedAt;
        latest = observedAt;
      }
      return {
        observations,
        sourceUrl: "https://example.com/mock",
        fetchedAt: new Date().toISOString(),
        earliestObservedAt: earliest,
        latestObservedAt: latest,
      };
    },
  };
}

describe("backfillObservations pipeline", () => {
  it("passes EIA credentials and a bounded D1 FX series into historical adapters", async () => {
    const { env, selects } = makeEnv([
      { value: 1.25, observed_at: "2026-05-01T16:00:00Z" },
    ]);
    env.EIA_API_KEY = "test-eia-key";
    let observedContext: AdapterContext | undefined;
    const adapter: DataSourceAdapter = {
      id: "context-probe",
      name: "Context probe",
      async fetch() { throw new Error("live fetch not used"); },
      async fetchHistorical(_fetchImpl, _opts, ctx) {
        observedContext = ctx;
        const rows = await ctx?.getObservationsInRange?.(
          "gbp_usd", "boe_fx", "2026-04-26T00:00:00Z", "2026-05-02T00:00:00Z",
        );
        expect(rows).toEqual([{ value: 1.25, observedAt: "2026-05-01T16:00:00Z" }]);
        return {
          observations: [], sourceUrl: "https://example.com", fetchedAt: new Date().toISOString(),
          earliestObservedAt: null, latestObservedAt: null,
        };
      },
    };
    await backfillObservations(env, adapter, {
      from: new Date("2026-05-01T00:00:00Z"), to: new Date("2026-05-01T23:59:59Z"),
      dryRun: true, overwrite: false,
    });
    expect(observedContext?.secrets?.EIA_API_KEY).toBe("test-eia-key");
    expect(selects).toHaveLength(1);
    expect(selects[0]?.bindings).toEqual([
      "gbp_usd", "boe_fx", "2026-04-26T00:00:00Z", "2026-05-02T00:00:00Z",
    ]);
  });

  it("fetches from the adapter, writes via writeHistoricalObservations, and opens+closes an audit row", async () => {
    const { env, batches, auditRows } = makeEnv();
    const adapter = await mockAdapter();
    const from = new Date(Date.UTC(2026, 0, 1));
    const to = new Date(Date.UTC(2026, 0, 5)); // 5 days, all in past for today=2026-04-18

    const result = await backfillObservations(env, adapter, {
      from, to, dryRun: false, overwrite: true,
    });

    expect(result.adapter).toBe("mock");
    expect(result.observationsFetched).toBe(5);
    expect(result.rowsWritten).toBe(5);
    expect(result.rowsRejected).toEqual([]);

    // One batch written (5 < HIST_BATCH_SIZE).
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(5);
    expect(batches[0]![0]!.sql).toContain("ON CONFLICT(indicator_id, observed_at) DO UPDATE");
    expect(batches[0]![0]!.sql).toContain("payload_hash LIKE 'hist:%'");
    expect(batches[0]![0]!.sql).not.toContain("INSERT OR REPLACE");

    // Audit open + close. closeAuditSuccess parameterises `status = ?` so
    // it can downgrade to 'partial' for zero-row adapters; the status value
    // is in the bindings, not the SQL string. Verify the update happened
    // and the status binding is 'success'.
    const auditInserts = auditRows.filter((r) => r.sql.includes("INSERT INTO ingestion_audit"));
    expect(auditInserts).toHaveLength(1);
    const auditUpdates = auditRows.filter((r) => r.sql.includes("UPDATE ingestion_audit"));
    expect(auditUpdates).toHaveLength(1);
    const updateSql = auditUpdates[0]!.sql;
    expect(updateSql).toMatch(/status\s*=\s*(?:\?|'success')/);
    // rowsWritten > 0 in this test -> status binding should be 'success'.
    const statusBinding = auditUpdates[0]!.bindings?.[0];
    if (statusBinding !== undefined) expect(statusBinding).toBe("success");
  });

  it("dry-run reports counts without any batch()", async () => {
    const { env, batches } = makeEnv();
    const adapter = await mockAdapter();
    const result = await backfillObservations(env, adapter, {
      from: new Date(Date.UTC(2026, 0, 1)),
      to: new Date(Date.UTC(2026, 0, 3)),
      dryRun: true,
      overwrite: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.rowsWritten).toBe(0);
    expect(result.observationsFetched).toBe(3);
    expect(batches).toHaveLength(0);
  });

  it("idempotent: re-running produces identical logical bindings (same payloadHash)", async () => {
    const adapter = await mockAdapter();
    const run = async () => {
      const { env, batches } = makeEnv();
      await backfillObservations(env, adapter, {
        from: new Date(Date.UTC(2026, 0, 1)),
        to: new Date(Date.UTC(2026, 0, 5)),
        dryRun: false,
        overwrite: true,
      });
      // Strip index 4 (ingested_at) — it's the write-time stamp and is
      // expected to float between runs. Everything else is the logical row.
      return batches.map((batch) =>
        batch.map((stmt) => ({
          sql: stmt.sql,
          bindings: [stmt.bindings[0], stmt.bindings[1], stmt.bindings[2], stmt.bindings[3], stmt.bindings[5]],
        })),
      );
    };
    const b1 = await run();
    const b2 = await run();
    expect(b1).toEqual(b2);
  });

  it("writeHistoricalObservations rejects today-UTC and non-hist: payload_hash", async () => {
    const { env, batches } = makeEnv();
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const observations: RawObservation[] = [
      {
        indicatorId: "x",
        value: 1,
        observedAt: today.toISOString().replace(/\.\d{3}Z$/, ".000Z"),
        sourceId: "x",
        payloadHash: await writerHash("x", today.toISOString(), 1),
      },
      {
        indicatorId: "y",
        value: 2,
        observedAt: "2025-01-01T00:00:00.000Z",
        sourceId: "y",
        payloadHash: "deadbeef", // missing hist: prefix
      },
      {
        indicatorId: "z",
        value: Number.NaN,
        observedAt: "2025-01-01T00:00:00.000Z",
        sourceId: "z",
        payloadHash: await writerHash("z", "2025-01-01T00:00:00.000Z", 0),
      },
    ];
    const result = await writeHistoricalObservations(env.DB, observations, { dryRun: false, overwrite: true });
    expect(result.written).toBe(0);
    expect(result.rejected).toHaveLength(3);
    const reasons = result.rejected.map((r) => r.reason);
    expect(reasons).toContain("observed_at is today-UTC or later");
    expect(reasons).toContain("payload_hash missing 'hist:' prefix");
    expect(reasons).toContain("non-finite value");
    expect(batches).toHaveLength(0);
  });

  it("respects overwrite: false -> INSERT OR IGNORE", async () => {
    const { env, batches } = makeEnv();
    const adapter = await mockAdapter();
    await backfillObservations(env, adapter, {
      from: new Date(Date.UTC(2026, 0, 1)),
      to: new Date(Date.UTC(2026, 0, 2)),
      dryRun: false,
      overwrite: false,
    });
    expect(batches[0]![0]!.sql).toContain("INSERT OR IGNORE INTO indicator_observations");
  });

  it("reports zero written when D1 ignores an existing historical observation", async () => {
    const db = {
      prepare: () => ({ bind: () => ({}) }),
      batch: async () => [{ success: true, meta: { changes: 0 } }],
    } as unknown as Env["DB"];
    const observation: RawObservation = {
      indicatorId: "brent_gbp",
      value: 95,
      observedAt: "2026-05-01T00:00:00Z",
      sourceId: "eia_brent",
      payloadHash: "hist:existing",
    };
    const result = await writeHistoricalObservations(db, [observation], {
      dryRun: false,
      overwrite: false,
    });
    expect(result.attempted).toBe(1);
    expect(result.written).toBe(0);
  });

  it("throws on adapter with no fetchHistorical", async () => {
    const { env } = makeEnv();
    const adapter: DataSourceAdapter = { id: "nohist", name: "nohist", async fetch() { throw new Error("x"); } };
    await expect(
      backfillObservations(env, adapter, {
        from: new Date("2026-01-01T00:00:00Z"),
        to: new Date("2026-01-02T00:00:00Z"),
        dryRun: false,
        overwrite: true,
      }),
    ).rejects.toThrow(/no fetchHistorical/);
  });
});
