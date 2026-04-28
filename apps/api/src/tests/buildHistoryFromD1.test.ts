/**
 * SEC-7: assert that the history range filter is applied via a bound
 * parameter (a precomputed ISO timestamp) rather than the previous
 * `'-' || ?1 || ' days'` string-concat-inside-SQL form.
 *
 * The original pattern was safe in practice (the days argument is integer-
 * clamped before binding) but it's a fragile shape — any future caller that
 * skipped the clamp could ride the `||` concatenation past D1's parameter
 * binding. Switching to precomputed bound ISO strings removes the shape entirely.
 */
import { describe, expect, it, vi } from "vitest";
import { buildHistoryFromD1 } from "../lib/db.js";

interface BindCapture {
  sql: string;
  bindArgs: unknown[];
}

function makeStubEnv(captures: BindCapture[]): Env {
  const db = {
    prepare(sql: string) {
      const capture: BindCapture = { sql, bindArgs: [] };
      captures.push(capture);
      return {
        bind(...args: unknown[]) {
          capture.bindArgs = args;
          return {
            async all<T = unknown>() { return { results: [] as T[] }; },
          };
        },
      };
    },
  };
  return { DB: db } as unknown as Env;
}

describe("buildHistoryFromD1 — SEC-7 binding hardening", () => {
  it("uses bound ISO cutoff parameters (no '-' || ?1 || ' days' shape)", async () => {
    const captures: BindCapture[] = [];
    const env = makeStubEnv(captures);
    await buildHistoryFromD1(env, 90);
    expect(captures.length).toBeGreaterThan(0);
    for (const c of captures) {
      // The fragile shape is gone — no SQL-side string concat for the cutoff.
      expect(c.sql).not.toContain("'-' || ?1 || ' days'");
      expect(c.sql).not.toContain("|| ?1 ||");
      // It uses direct comparison against a bound value.
      expect(c.sql).toContain("WHERE observed_at >= ?1");
      // The pillar query binds the same cutoff twice: once for the requested
      // window and once to fetch the last pre-window carry-forward row.
      expect(c.bindArgs.length).toBeGreaterThanOrEqual(1);
      expect(c.bindArgs.length).toBeLessThanOrEqual(2);
      for (const arg of c.bindArgs) {
        expect(typeof arg).toBe("string");
        expect(Number.isFinite(Date.parse(arg as string))).toBe(true);
        expect(arg).toBe(c.bindArgs[0]);
      }
    }
  });

  it("computes the cutoff as exactly `days` whole days before now", async () => {
    const now = new Date("2026-04-27T22:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const captures: BindCapture[] = [];
      const env = makeStubEnv(captures);
      await buildHistoryFromD1(env, 90);
      const cutoff = captures[0]!.bindArgs[0] as string;
      // 90 days before 2026-04-27T22:00:00Z = 2026-01-27T22:00:00Z.
      expect(cutoff).toBe("2026-01-27T22:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps days to [1, 800] before computing the cutoff", async () => {
    const now = new Date("2026-04-27T22:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      // Negative -> 1 day
      const cap1: BindCapture[] = [];
      await buildHistoryFromD1(makeStubEnv(cap1), -50);
      expect(cap1[0]!.bindArgs[0]).toBe("2026-04-26T22:00:00.000Z");
      // 9999 -> clamped to 800
      const cap2: BindCapture[] = [];
      await buildHistoryFromD1(makeStubEnv(cap2), 9999);
      // 800 days before 2026-04-27T22:00:00Z
      const expected = new Date(Date.UTC(2026, 3, 27, 22) - 800 * 86_400_000).toISOString();
      expect(cap2[0]!.bindArgs[0]).toBe(expected);
    } finally {
      vi.useRealTimers();
    }
  });
});
