import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawObservation } from "@tightrope/data-sources";
import { writeObservations } from "../lib/observations.js";
import type { Env } from "../env.js";

/**
 * D1 + KV stub covering the query shapes writeObservations issues:
 *   - readPreviousLive SELECT (ROW_NUMBER … indicator_observations) with
 *     (indicatorId, strictly-older cutoff) bind pairs → seeded previous values
 *   - db.batch(...) → the survivor INSERT OR REPLACE writes
 *   - curator_captures INSERT … ON CONFLICT DO NOTHING (quarantine row; the
 *     stub simulates the partial-unique conflict via `existing`)
 *   - KV get/put → the 24h alert-dedupe window (separate from the row dedupe)
 */
function makeEnv(opts: {
  previous?: Array<{ indicator_id: string; value: number; observed_at: string }>;
  existingQuarantineHashes?: Set<string>;
  webhook?: string;
  curatorPublicUrl?: string;
  failQuarantineInsert?: boolean;
} = {}): {
  env: Env;
  batched: RawObservation[][];
  quarantineInserts: Array<{ sql: string; bindings: readonly unknown[] }>;
  kvStore: Map<string, string>;
} {
  const previous = opts.previous ?? [];
  const existing = opts.existingQuarantineHashes ?? new Set<string>();
  const batched: RawObservation[][] = [];
  const quarantineInserts: Array<{ sql: string; bindings: readonly unknown[] }> = [];
  const kvStore = new Map<string, string>();

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
        if (opts.failQuarantineInsert) throw new Error("d1 quarantine insert exploded");
        // Simulate ON CONFLICT (source_id, content_sha256) DO NOTHING.
        const contentSha256 = bindings[4] as string;
        if (!existing.has(contentSha256)) {
          quarantineInserts.push({ sql, bindings });
          existing.add(contentSha256);
        }
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
        // bindings are (indicatorId, strictly-older cutoff) pairs.
        const results: typeof previous = [];
        for (let i = 0; i + 1 < bindings.length; i += 2) {
          const ind = bindings[i] as string;
          const cutoff = bindings[i + 1] as string;
          const candidates = previous
            .filter((p) => p.indicator_id === ind && p.observed_at < cutoff)
            .sort((a, b) => (a.observed_at < b.observed_at ? 1 : -1)); // observed_at DESC
          if (candidates[0]) results.push(candidates[0]);
        }
        return { results: results as unknown as T[] };
      }
      return { results: [] as T[] };
    },
  });

  const env = {
    DB: {
      prepare: (sql: string) => makeStmt(sql),
      batch: async (stmts: Array<{ bindings: RawObservation[] }>) => {
        batched.push(stmts.map((s) => s.bindings as unknown as RawObservation));
        return [];
      },
    },
    KV: {
      get: async (k: string) => kvStore.get(k) ?? null,
      put: async (k: string, v: string) => void kvStore.set(k, v),
      delete: async (k: string) => void kvStore.delete(k),
    },
    ALERT_WEBHOOK_URL: opts.webhook,
    ...(opts.curatorPublicUrl ? { CURATOR_PUBLIC_URL: opts.curatorPublicUrl } : {}),
  } as unknown as Env;

  return { env, batched, quarantineInserts, kvStore };
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
  it("writes a plausible observation and returns it as a survivor", async () => {
    const { env, batched, quarantineInserts } = makeEnv();
    const res = await writeObservations(env, [obs()]);
    expect(res.written).toHaveLength(1);
    expect(res.written[0]!.indicatorId).toBe("gilt_10y");
    expect(res.quarantined).toBe(0);
    expect(batched).toHaveLength(1);
    expect(batched[0]).toHaveLength(1);
    expect(quarantineInserts).toHaveLength(0);
  });

  it("quarantines an out-of-range value: no observation write, curator row inserted, webhook fired", async () => {
    const fetchMock = vi.fn((_url: unknown, _init?: RequestInit) => Promise.resolve(new Response("ok")));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const { env, batched, quarantineInserts } = makeEnv({ webhook: "https://hooks.test/x" });

    const res = await writeObservations(env, [obs({ value: 6700, indicatorId: "planning_consents", sourceId: "mhclg" })]);

    expect(res.written).toHaveLength(0);
    expect(res.quarantined).toBe(1);
    expect(batched).toHaveLength(0); // nothing written to indicator_observations
    expect(quarantineInserts).toHaveLength(1);
    const ins = quarantineInserts[0]!;
    expect(ins.sql).toContain("INSERT INTO curator_captures");
    expect(ins.sql).toContain("'quarantined'");
    expect(ins.sql).toContain("ON CONFLICT");
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
    const res = await writeObservations(env, [
      obs({ indicatorId: "gilt_10y", value: 4.8, sourceId: "boe_yields" }),
      obs({ indicatorId: "gilt_30y", value: 999, sourceId: "boe_yields" }), // > max 10
      obs({ indicatorId: "gbp_usd", value: 1.24, sourceId: "boe_fx" }),
    ]);
    expect(res.written).toHaveLength(2);
    expect(res.quarantined).toBe(1);
    expect(batched).toHaveLength(1);
    expect(batched[0]).toHaveLength(2);
    expect(quarantineInserts).toHaveLength(1);
  });

  it("flags an implausible day-over-day jump against the previous (strictly-older) live value", async () => {
    const { env, batched, quarantineInserts } = makeEnv({
      previous: [{ indicator_id: "gilt_10y", value: 4.8, observed_at: "2026-07-02T00:00:00Z" }],
    });
    // 4.8 → 9.6 in one day, max 0.8/day.
    const res = await writeObservations(env, [obs({ value: 9.6 })]);
    expect(res.written).toHaveLength(0);
    expect(res.quarantined).toBe(1);
    expect(batched).toHaveLength(0);
    expect(quarantineInserts).toHaveLength(1);
    const verification = JSON.parse(quarantineInserts[0]!.bindings[8] as string);
    expect(verification.bound).toBe("maxJumpPerDay");
  });

  it("is a no-op on an empty batch (no DB reads)", async () => {
    const { env, batched, quarantineInserts } = makeEnv();
    const res = await writeObservations(env, []);
    expect(res.written).toHaveLength(0);
    expect(res.quarantined).toBe(0);
    expect(batched).toHaveLength(0);
    expect(quarantineInserts).toHaveLength(0);
  });
});

describe("writeObservations — F2: same-period revisions are not jump-gated against themselves", () => {
  it("writes a same-period revision within range even when it moves far from the row it replaces", async () => {
    // The only live row for gilt_10y is at the SAME observed_at as the incoming
    // revision. A jump gate that compared against it (Δ 3.2 over a 0-day gap)
    // would quarantine a legitimate correction; the strictly-older lookup finds
    // no prior row, so the jump gate is skipped and the range gate passes.
    const { env, batched, quarantineInserts } = makeEnv({
      previous: [{ indicator_id: "gilt_10y", value: 4.8, observed_at: "2026-07-03T00:00:00Z" }],
    });
    const res = await writeObservations(env, [obs({ value: 8.0, observedAt: "2026-07-03T00:00:00Z" })]);
    expect(res.written).toHaveLength(1);
    expect(res.quarantined).toBe(0);
    expect(batched).toHaveLength(1); // the revision was written to indicator_observations
    expect(quarantineInserts).toHaveLength(0);
  });

  it("quarantines a same-period revision that is out of RANGE — by range, not by jump", async () => {
    const { env, quarantineInserts } = makeEnv({
      previous: [{ indicator_id: "gilt_10y", value: 4.8, observed_at: "2026-07-03T00:00:00Z" }],
    });
    const res = await writeObservations(env, [obs({ value: 42, observedAt: "2026-07-03T00:00:00Z" })]); // > max 10
    expect(res.written).toHaveLength(0);
    expect(res.quarantined).toBe(1);
    const verification = JSON.parse(quarantineInserts[0]!.bindings[8] as string);
    expect(verification.bound).toBe("max"); // NOT maxJumpPerDay
  });

  it("still jump-gates a genuine cross-period spike (behaviour unchanged)", async () => {
    const { env, quarantineInserts } = makeEnv({
      previous: [
        { indicator_id: "gilt_10y", value: 4.8, observed_at: "2026-07-01T00:00:00Z" }, // older period
        { indicator_id: "gilt_10y", value: 4.9, observed_at: "2026-07-03T00:00:00Z" }, // same period (ignored as cutoff)
      ],
    });
    const res = await writeObservations(env, [obs({ value: 9.6, observedAt: "2026-07-03T00:00:00Z" })]);
    expect(res.written).toHaveLength(0);
    const verification = JSON.parse(quarantineInserts[0]!.bindings[8] as string);
    expect(verification.bound).toBe("maxJumpPerDay"); // compared against the 4.8 @ 07-01 strictly-older row
  });
});

describe("writeObservations — F5c: alert re-pages on a 24h window; row dedupe is permanent", () => {
  it("dedupes a stuck bad value: the second identical quarantine neither re-inserts nor re-alerts", async () => {
    const fetchMock = vi.fn((_url: unknown, _init?: RequestInit) => Promise.resolve(new Response("ok")));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const { env, quarantineInserts } = makeEnv({ webhook: "https://hooks.test/x" });

    const bad = obs({ value: 6700, indicatorId: "planning_consents", sourceId: "mhclg" });
    await writeObservations(env, [bad]);
    await writeObservations(env, [bad]); // identical repoll within the 24h window

    expect(quarantineInserts).toHaveLength(1); // ON CONFLICT dedupes the row permanently
    expect(fetchMock).toHaveBeenCalledTimes(1); // KV dedupes the alert within the window
  });

  it("re-pages the same stuck value once the 24h alert window expires (row still deduped)", async () => {
    const fetchMock = vi.fn((_url: unknown, _init?: RequestInit) => Promise.resolve(new Response("ok")));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const { env, quarantineInserts, kvStore } = makeEnv({ webhook: "https://hooks.test/x" });

    const bad = obs({ value: 6700, indicatorId: "planning_consents", sourceId: "mhclg" });
    await writeObservations(env, [bad]); // pages once, sets the KV window
    kvStore.clear(); // simulate the 24h alert-dedupe key expiring
    await writeObservations(env, [bad]); // window gone → re-page, but row already exists

    expect(quarantineInserts).toHaveLength(1); // still no duplicate row
    expect(fetchMock).toHaveBeenCalledTimes(2); // re-paged after expiry
  });

  it("C2: the review curl targets CURATOR_PUBLIC_URL when set", async () => {
    const fetchMock = vi.fn((_url: unknown, _init?: RequestInit) => Promise.resolve(new Response("ok")));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const { env } = makeEnv({ webhook: "https://hooks.test/x", curatorPublicUrl: "https://curator-preview.example.test/" });

    await writeObservations(env, [obs({ value: 6700, indicatorId: "planning_consents", sourceId: "mhclg" })]);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.text).toContain("https://curator-preview.example.test/admin/captures?status=quarantined");
  });
});

describe("writeObservations — F7: quarantine-path failure never fails the run", () => {
  it("commits survivors and returns the written count when the quarantine insert throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env, batched } = makeEnv({ failQuarantineInsert: true });

    const res = await writeObservations(env, [
      obs({ indicatorId: "gilt_10y", value: 4.8, sourceId: "boe_yields" }), // survivor
      obs({ indicatorId: "gilt_30y", value: 999, sourceId: "boe_yields" }), // quarantine path throws
    ]);

    // No throw; survivor committed; count reflects reality.
    expect(res.written).toHaveLength(1);
    expect(res.written[0]!.indicatorId).toBe("gilt_10y");
    expect(res.quarantined).toBe(1);
    expect(batched).toHaveLength(1);
    expect(batched[0]).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
