import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawObservation } from "@tightrope/data-sources";
import { writeObservations } from "../lib/observations.js";
import type { Env } from "../env.js";

/**
 * D1 stub covering the three query shapes writeObservations issues:
 *   - readPreviousLive SELECT (ROW_NUMBER … indicator_observations) → seeded
 *     previous values
 *   - db.batch(...) → the survivor INSERT OR REPLACE writes
 *   - curator_captures existence SELECT + INSERT (quarantine path)
 */
function makeEnv(opts: {
  previous?: Array<{ indicator_id: string; value: number; observed_at: string }>;
  existingQuarantineHashes?: Set<string>;
  webhook?: string;
} = {}): {
  env: Env;
  batched: RawObservation[][];
  quarantineInserts: Array<{ sql: string; bindings: readonly unknown[] }>;
} {
  const previous = opts.previous ?? [];
  const existing = opts.existingQuarantineHashes ?? new Set<string>();
  const batched: RawObservation[][] = [];
  const quarantineInserts: Array<{ sql: string; bindings: readonly unknown[] }> = [];

  interface Stmt {
    sql: string;
    bindings: readonly unknown[];
    bind: (...b: unknown[]) => Stmt;
    run: () => Promise<{ success: true }>;
    first: <T>() => Promise<T | null>;
    all: <T>() => Promise<{ results: T[] }>;
  }
  const makeStmt = (sql: string, bindings: readonly unknown[] = []): Stmt => ({
    sql,
    bindings,
    bind: (...b: unknown[]) => makeStmt(sql, b),
    run: async () => {
      if (sql.includes("INSERT INTO curator_captures")) {
        quarantineInserts.push({ sql, bindings });
        existing.add(bindings[4] as string); // content_sha256
      }
      return { success: true };
    },
    first: async <T>() => {
      if (sql.includes("FROM curator_captures")) {
        const contentSha256 = bindings[1] as string;
        return (existing.has(contentSha256) ? { one: 1 } : null) as unknown as T | null;
      }
      return null as unknown as T | null;
    },
    all: async <T>() => {
      if (sql.includes("ROW_NUMBER") && sql.includes("indicator_observations")) {
        const wanted = new Set(bindings as string[]);
        return { results: previous.filter((p) => wanted.has(p.indicator_id)) as unknown as T[] };
      }
      return { results: [] as T[] };
    },
  });

  const env = {
    DB: {
      prepare: (sql: string) => makeStmt(sql),
      batch: async (stmts: Array<{ bindings: RawObservation[] }>) => {
        // Each survivor stmt was bound with (indicatorId, observedAt, value, …);
        // record the whole batch as the written rows for assertions.
        batched.push(stmts.map((s) => s.bindings as unknown as RawObservation));
        return [];
      },
    },
    ALERT_WEBHOOK_URL: opts.webhook,
  } as unknown as Env;

  return { env, batched, quarantineInserts };
}

function obs(over: Partial<RawObservation> = {}): RawObservation {
  return {
    indicatorId: "gilt_10y",
    value: 4.8,
    observedAt: "2026-07-03T00:00:00Z",
    sourceId: "boe_yields",
    payloadHash: "abc123",
    ...over,
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("writeObservations — plausibility gate", () => {
  it("writes a plausible observation and returns the written count", async () => {
    const { env, batched, quarantineInserts } = makeEnv();
    const written = await writeObservations(env, [obs()]);
    expect(written).toBe(1);
    expect(batched).toHaveLength(1);
    expect(batched[0]).toHaveLength(1);
    expect(quarantineInserts).toHaveLength(0);
  });

  it("quarantines an out-of-range value: no observation write, curator row inserted, webhook fired", async () => {
    const fetchMock = vi.fn((_url: unknown, _init?: RequestInit) => Promise.resolve(new Response("ok")));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const { env, batched, quarantineInserts } = makeEnv({ webhook: "https://hooks.test/x" });

    const written = await writeObservations(env, [obs({ value: 6700, indicatorId: "planning_consents", sourceId: "mhclg" })]);

    expect(written).toBe(0);
    expect(batched).toHaveLength(0); // nothing written to indicator_observations
    expect(quarantineInserts).toHaveLength(1);
    const ins = quarantineInserts[0]!;
    expect(ins.sql).toContain("INSERT INTO curator_captures");
    expect(ins.sql).toContain("'quarantined'");
    expect(ins.sql).toContain("'observation'");
    // verification JSON (last bind) names the bound that tripped.
    const verification = JSON.parse(ins.bindings[8] as string);
    expect(verification.bound).toBe("max");
    // Alert fired once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.text).toContain("planning_consents");
    expect(body.text).toContain("6700");
  });

  it("isolates siblings: a bad value is quarantined while its good peers still write", async () => {
    const { env, batched, quarantineInserts } = makeEnv();
    const written = await writeObservations(env, [
      obs({ indicatorId: "gilt_10y", value: 4.8, sourceId: "boe_yields" }),
      obs({ indicatorId: "gilt_30y", value: 999, sourceId: "boe_yields" }), // > max 10
      obs({ indicatorId: "gbp_usd", value: 1.24, sourceId: "boe_fx" }),
    ]);
    expect(written).toBe(2);
    expect(batched).toHaveLength(1);
    expect(batched[0]).toHaveLength(2);
    expect(quarantineInserts).toHaveLength(1);
  });

  it("flags an implausible day-over-day jump against the previous live value", async () => {
    const { env, batched, quarantineInserts } = makeEnv({
      previous: [{ indicator_id: "gilt_10y", value: 4.8, observed_at: "2026-07-02T00:00:00Z" }],
    });
    // 4.8 → 9.6 in one day, max 0.8/day.
    const written = await writeObservations(env, [obs({ value: 9.6 })]);
    expect(written).toBe(0);
    expect(batched).toHaveLength(0);
    expect(quarantineInserts).toHaveLength(1);
    const verification = JSON.parse(quarantineInserts[0]!.bindings[8] as string);
    expect(verification.bound).toBe("maxJumpPerDay");
  });

  it("dedupes a stuck bad value: the second identical quarantine is skipped and does not re-alert", async () => {
    const fetchMock = vi.fn((_url: unknown, _init?: RequestInit) => Promise.resolve(new Response("ok")));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const existingQuarantineHashes = new Set<string>();
    const { env, quarantineInserts } = makeEnv({ webhook: "https://hooks.test/x", existingQuarantineHashes });

    const bad = obs({ value: 6700, indicatorId: "planning_consents", sourceId: "mhclg" });
    await writeObservations(env, [bad]);
    await writeObservations(env, [bad]); // identical repoll

    expect(quarantineInserts).toHaveLength(1); // only the first inserts
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the first alerts
  });

  it("is a no-op on an empty batch (no DB reads)", async () => {
    const { env, batched, quarantineInserts } = makeEnv();
    const written = await writeObservations(env, []);
    expect(written).toBe(0);
    expect(batched).toHaveLength(0);
    expect(quarantineInserts).toHaveLength(0);
  });
});
