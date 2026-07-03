import { describe, expect, it, vi } from "vitest";
import { AdapterError, type AdapterResult, type DataSourceAdapter } from "@tightrope/data-sources";
import { runAdapter, runAdapterSafe } from "../pipelines/runAdapter.js";
import type { Env } from "../env.js";

/**
 * Minimal D1 + DLQ stub. Records every run() so we can assert the audit row
 * was closed success vs failure, and captures DLQ sends.
 */
function makeEnv(): {
  env: Env;
  runs: Array<{ sql: string; bindings: readonly unknown[] }>;
  dlqSends: unknown[];
} {
  const runs: Array<{ sql: string; bindings: readonly unknown[] }> = [];
  const dlqSends: unknown[] = [];

  interface Stmt {
    sql: string;
    bindings: readonly unknown[];
    bind: (...b: unknown[]) => Stmt;
    run: () => Promise<{ success: true }>;
    first: <T>() => Promise<T | null>;
  }
  const makeStmt = (sql: string, bindings: readonly unknown[] = []): Stmt => ({
    sql,
    bindings,
    bind: (...b: unknown[]) => makeStmt(sql, b),
    run: async () => {
      runs.push({ sql, bindings });
      return { success: true };
    },
    // lastSuccessPayloadHash lookup → no prior success.
    first: async <T>() => null as unknown as T | null,
  });

  const env = {
    DB: {
      prepare: (sql: string) => makeStmt(sql),
      batch: async () => [],
    },
    DLQ: { send: async (m: unknown) => { dlqSends.push(m); } },
  } as unknown as Env;
  return { env, runs, dlqSends };
}

function makeAdapter(fetch: DataSourceAdapter["fetch"]): DataSourceAdapter {
  return { id: "test_source", name: "Test source", fetch };
}

const OK_RESULT: AdapterResult = {
  observations: [],
  emitsNoObservations: true,
  sourceUrl: "https://example.test/feed",
  fetchedAt: "2026-07-03T00:00:00Z",
};

function retryableError(): AdapterError {
  return new AdapterError({ sourceId: "test_source", sourceUrl: "u", status: 503, message: "boom 503", retryable: true });
}
function parseError(): AdapterError {
  return new AdapterError({ sourceId: "test_source", sourceUrl: "u", message: "schema drift" });
}

const noSleep = { retryDelayMs: 10_000, sleep: vi.fn(async () => undefined) };

describe("runAdapter — bounded network retry", () => {
  it("retries once on a retryable failure and succeeds on the second attempt", async () => {
    const { env, runs } = makeEnv();
    const fetch = vi.fn()
      .mockRejectedValueOnce(retryableError())
      .mockResolvedValueOnce(OK_RESULT);
    const sleep = vi.fn(async () => undefined);

    const result = await runAdapter(env, makeAdapter(fetch as unknown as DataSourceAdapter["fetch"]), { retryDelayMs: 10_000, sleep });

    expect(result).toBe(OK_RESULT);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(10_000);
    // Audit closed as success (closeAuditSuccess binds status; closeAuditFailure
    // hard-codes status = 'failure').
    expect(runs.some((r) => r.sql.includes("status = 'failure'"))).toBe(false);
    expect(runs.some((r) => r.sql.includes("UPDATE ingestion_audit"))).toBe(true);
  });

  it("does NOT retry a parse/validation AdapterError", async () => {
    const { env, runs, dlqSends } = makeEnv();
    const fetch = vi.fn().mockRejectedValue(parseError());

    await expect(
      runAdapter(env, makeAdapter(fetch as unknown as DataSourceAdapter["fetch"]), noSleep),
    ).rejects.toThrow(/schema drift/);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(noSleep.sleep).not.toHaveBeenCalled();
    // One honest failure row + one DLQ send.
    expect(runs.some((r) => r.sql.includes("status = 'failure'"))).toBe(true);
    expect(dlqSends).toHaveLength(1);
    noSleep.sleep.mockClear();
  });

  it("retries a retryable failure then gives up on a second failure (one audit row, one DLQ send)", async () => {
    const { env, runs, dlqSends } = makeEnv();
    const fetch = vi.fn().mockRejectedValue(retryableError());
    const sleep = vi.fn(async () => undefined);

    await expect(
      runAdapter(env, makeAdapter(fetch as unknown as DataSourceAdapter["fetch"]), { sleep }),
    ).rejects.toThrow(/boom 503/);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(runs.filter((r) => r.sql.includes("status = 'failure'"))).toHaveLength(1);
    expect(dlqSends).toHaveLength(1);
  });

  it("does not retry a 4xx (client error) AdapterError", async () => {
    const { env } = makeEnv();
    const clientErr = new AdapterError({ sourceId: "test_source", sourceUrl: "u", status: 404, message: "not found", retryable: false });
    const fetch = vi.fn().mockRejectedValue(clientErr);
    const sleep = vi.fn(async () => undefined);

    await expect(
      runAdapter(env, makeAdapter(fetch as unknown as DataSourceAdapter["fetch"]), { sleep }),
    ).rejects.toThrow(/not found/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("runAdapterSafe — forwards retry options and swallows failures", () => {
  it("returns null on failure and forwards the injected sleep", async () => {
    const { env } = makeEnv();
    const fetch = vi.fn().mockRejectedValue(retryableError());
    const sleep = vi.fn(async () => undefined);

    const result = await runAdapterSafe(env, makeAdapter(fetch as unknown as DataSourceAdapter["fetch"]), { sleep });

    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
