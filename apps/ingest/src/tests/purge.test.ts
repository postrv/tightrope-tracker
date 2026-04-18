import { describe, expect, it } from "vitest";
import { purgeSyntheticHistory } from "../pipelines/purge.js";
import type { Env } from "../env.js";

function makeEnv(counts: { headline: number; pillar: number; observations: number }): {
  env: Env;
  batches: Array<Array<{ sql: string; bindings: readonly unknown[] }>>;
  kvDeletes: string[];
} {
  const batches: Array<Array<{ sql: string; bindings: readonly unknown[] }>> = [];
  const kvDeletes: string[] = [];
  interface Stmt {
    sql: string;
    bindings: readonly unknown[];
    bind: (...b: unknown[]) => Stmt;
    first: <T>() => Promise<T | null>;
    run: () => Promise<{ success: true }>;
  }
  const makeStatement = (sql: string, bindings: readonly unknown[] = []): Stmt => ({
    sql,
    bindings,
    bind: (...b: unknown[]) => makeStatement(sql, b),
    first: async <T>() => {
      if (sql.includes("FROM headline_scores")) return { n: counts.headline } as T;
      if (sql.includes("FROM pillar_scores")) return { n: counts.pillar } as T;
      if (sql.includes("FROM indicator_observations")) return { n: counts.observations } as T;
      return null as T;
    },
    run: async () => ({ success: true }),
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
      delete: async (k: string) => { kvDeletes.push(k); },
    },
  } as unknown as Env;
  return { env, batches, kvDeletes };
}

describe("purgeSyntheticHistory", () => {
  it("dry-run reports counts without deleting", async () => {
    const { env, batches, kvDeletes } = makeEnv({ headline: 90, pillar: 360, observations: 840 });
    const result = await purgeSyntheticHistory(env, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.headlineDeleted).toBe(90);
    expect(result.pillarDeleted).toBe(360);
    expect(result.observationsDeleted).toBe(840);
    expect(batches).toEqual([]);
    expect(kvDeletes).toEqual([]);
  });

  it("non-dry-run deletes and invalidates KV caches", async () => {
    const { env, batches, kvDeletes } = makeEnv({ headline: 90, pillar: 360, observations: 840 });
    await purgeSyntheticHistory(env, { dryRun: false });

    expect(batches).toHaveLength(1);
    const sqls = batches[0]!.map((s) => s.sql);
    expect(sqls.some((s) => s.includes("DELETE FROM headline_scores"))).toBe(true);
    expect(sqls.some((s) => s.includes("DELETE FROM pillar_scores"))).toBe(true);
    expect(sqls.some((s) => s.includes("DELETE FROM indicator_observations"))).toBe(true);
    expect(kvDeletes).toContain("score:latest");
    expect(kvDeletes).toContain("score:history:90d");
  });

  it("cutoff is start of today UTC", async () => {
    const { env, batches } = makeEnv({ headline: 1, pillar: 1, observations: 1 });
    const result = await purgeSyntheticHistory(env, { dryRun: false });
    expect(result.cutoff).toMatch(/T00:00:00\.000Z$/);
    const today = new Date().toISOString().slice(0, 10);
    expect(result.cutoff.startsWith(today)).toBe(true);
    // And the DELETE bindings use the same cutoff.
    const deleteStmts = batches[0]!.filter((s) => s.sql.startsWith("DELETE"));
    for (const stmt of deleteStmts) {
      if (stmt.bindings.length > 0) {
        expect(stmt.bindings[0]).toBe(result.cutoff);
      }
    }
  });

  it("observation DELETE filters by seed payload_hash prefix, preserving live rows", async () => {
    const { env, batches } = makeEnv({ headline: 0, pillar: 0, observations: 50 });
    await purgeSyntheticHistory(env, { dryRun: false });
    const obsDelete = batches[0]!.find((s) =>
      s.sql.includes("DELETE FROM indicator_observations"),
    );
    expect(obsDelete).toBeDefined();
    expect(obsDelete!.sql).toContain("payload_hash LIKE 'seed%'");
  });
});
