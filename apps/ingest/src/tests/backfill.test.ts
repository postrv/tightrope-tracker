import { describe, expect, it } from "vitest";
import { INDICATORS, PILLAR_ORDER } from "@tightrope/shared";
import { backfillHistoricalScores } from "../pipelines/backfill.js";
import type { Env } from "../env.js";
import type { ObservationRow } from "../lib/history.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Minimal D1 stub that routes the two queries our backfill issues
 * (readBaselineObservations + readRecentObservations) to canned observation
 * arrays, and records every batch() insert so tests can assert what got
 * written. Deliberately tiny — we are testing the pipeline, not D1.
 */
function makeEnv(observations: readonly ObservationRow[]): {
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
    all: () => Promise<{ results: ObservationRow[] }>;
    first: () => Promise<unknown>;
    run: () => Promise<{ success: true }>;
  }
  const makeStatement = (sql: string, bindings: readonly unknown[] = []): Stmt => {
    const all: ObservationRow[] = sql.includes("FROM indicator_observations")
      ? [...observations].sort((a, b) =>
          a.indicator_id < b.indicator_id ? -1
          : a.indicator_id > b.indicator_id ? 1
          : a.observed_at < b.observed_at ? -1 : a.observed_at > b.observed_at ? 1 : 0,
        )
      : [];
    // Mirror the SQL's own WHERE clause: both readRecentObservations and
    // readBaselineObservations apply `observed_at >= ?` as their first bind.
    const lowerBound = bindings.length > 0 ? String(bindings[0]) : null;
    const results = lowerBound === null ? all : all.filter((r) => r.observed_at >= lowerBound);
    return {
      sql,
      bindings,
      bind: (...b: unknown[]) => makeStatement(sql, b),
      all: async () => ({ results }),
      first: async () => null,
      run: async () => ({ success: true }),
    };
  };
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

/**
 * For each indicator in the pillar, emit an observation at the given day
 * and a 6-month baseline so ECDF has something to work with. Values drift
 * by indicator ordinal so the headline isn't trivially flat.
 */
function seedObservations(daysAgo: readonly number[]): ObservationRow[] {
  const today = Date.UTC(2026, 3, 18); // 2026-04-18 UTC
  const rows: ObservationRow[] = [];
  const indicatorIds = Object.keys(INDICATORS);

  // Baseline spanning ~6 months for each indicator, one sample per week.
  // This is what gives ECDF a distribution to map into [0, 100].
  for (const id of indicatorIds) {
    const base = hash(id) % 50 + 20;
    for (let wk = 26; wk >= 1; wk--) {
      const ts = new Date(today - wk * 7 * 86_400_000).toISOString();
      rows.push({ indicator_id: id, observed_at: ts, value: base + (wk % 5) });
    }
  }

  // Per-day observations: every indicator gets one observation for every
  // requested day. Values vary with day offset so scores differ across days.
  for (const offset of daysAgo) {
    const ts = new Date(today - offset * 86_400_000 + 12 * 3600_000).toISOString();
    for (const id of indicatorIds) {
      const base = hash(id) % 50 + 20;
      rows.push({ indicator_id: id, observed_at: ts, value: base + offset * 0.1 });
    }
  }
  return rows.sort((a, b) => a.observed_at < b.observed_at ? -1 : 1);
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

describe("backfillHistoricalScores", () => {
  it("writes one row per day per pillar plus one headline row, for days ending yesterday", async () => {
    const { env, batches, kvDeletes } = makeEnv(seedObservations([1, 2, 3, 4, 5]));
    const result = await backfillHistoricalScores(env, { days: 4, overwrite: true });

    expect(result.daysRequested).toBe(4);
    expect(result.daysWritten).toBe(4);
    expect(result.daysSkipped).toBe(0);
    expect(result.gaps).toEqual([]);
    // Every written day: 1 headline + 4 pillar inserts, one batch per day.
    expect(batches).toHaveLength(4);
    for (const batch of batches) {
      expect(batch).toHaveLength(1 + PILLAR_ORDER.length);
      expect(batch[0]!.sql).toContain("INSERT OR REPLACE INTO headline_scores");
      for (let i = 1; i <= PILLAR_ORDER.length; i++) {
        expect(batch[i]!.sql).toContain("INSERT OR REPLACE INTO pillar_scores");
      }
    }
    expect(kvDeletes).toContain("score:latest");
    expect(kvDeletes).toContain("score:history:90d");
  });

  it("excludes today — backfilled rows all predate today UTC", async () => {
    const { env, batches } = makeEnv(seedObservations([0, 1, 2]));
    await backfillHistoricalScores(env, { days: 2, overwrite: true });
    const todayPrefix = new Date().toISOString().slice(0, 10);
    for (const batch of batches) {
      for (const stmt of batch) {
        // Bindings: [observed_at, ...]. First binding is the ISO timestamp.
        const observedAt = String(stmt.bindings[stmt.sql.includes("pillar_scores") ? 1 : 0]);
        expect(observedAt.startsWith(todayPrefix)).toBe(false);
      }
    }
  });

  it("anchors every backfilled row at 23:59 UTC for deterministic per-day keys", async () => {
    const { env, batches } = makeEnv(seedObservations([1, 2, 3]));
    await backfillHistoricalScores(env, { days: 3, overwrite: true });
    for (const batch of batches) {
      for (const stmt of batch) {
        const observedAt = String(stmt.bindings[stmt.sql.includes("pillar_scores") ? 1 : 0]);
        expect(observedAt).toMatch(/T23:59:00\.000Z$/);
      }
    }
  });

  it("writes passing pillars and reports a gap when quorum fails elsewhere", async () => {
    // Non-market indicators get observations only from 2+ years ago (outside
    // the readRecentObservations window used by backfill), so their readings
    // for Day-1 are empty. Market indicators have fresh observations. The
    // fiscal/labour/delivery pillars fail quorum → headline is skipped AND
    // those pillars aren't written, but the market pillar score for that day
    // IS written so the sparkline has a backbone.
    const rows: ObservationRow[] = [];
    const today = Date.UTC(2026, 3, 18);
    const farPastMs = today - 800 * 86_400_000; // well beyond 365d lookback
    for (const id of Object.keys(INDICATORS)) {
      for (let wk = 26; wk >= 1; wk--) {
        rows.push({
          indicator_id: id,
          observed_at: new Date(farPastMs - wk * 7 * 86_400_000).toISOString(),
          value: 50,
        });
      }
    }
    const day1 = new Date(today - 86_400_000 + 12 * 3600_000).toISOString();
    for (const id of Object.keys(INDICATORS)) {
      if (INDICATORS[id]!.pillar === "market") {
        rows.push({ indicator_id: id, observed_at: day1, value: 50 });
      }
    }

    const { env, batches } = makeEnv(rows);
    const result = await backfillHistoricalScores(env, { days: 1, overwrite: true });

    // Headline was not written — fiscal/labour/delivery failed quorum.
    expect(result.daysWritten).toBe(0);
    // Partial day: market pillar wrote, headline did not.
    expect(result.daysPartial).toBe(1);
    expect(result.daysSkipped).toBe(0);
    expect(result.pillarRowsWritten).toBe(1);

    // One batch with exactly one pillar_scores statement for market.
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0]![0]!.sql).toContain("INSERT OR REPLACE INTO pillar_scores");
    expect(batches[0]![0]!.bindings[0]).toBe("market");

    const gap = result.gaps[0]!;
    expect(gap.stalePillars).toContain("fiscal");
    expect(gap.stalePillars).toContain("labour");
    expect(gap.stalePillars).toContain("delivery");
    expect(gap.stalePillars).not.toContain("market");
  });

  it("passes delivery quorum from housing_trajectory + planning_consents alone (editorial indicators are excluded)", async () => {
    // Real-world scenario: the only delivery indicators with defensible
    // historical data are housing_trajectory and planning_consents (both from
    // MHCLG). The other four — new_towns_milestones, bics_rollout,
    // industrial_strategy, smr_programme — are editorial interpretations of
    // political announcements and deliberately carry no historical series.
    // Backfill quorum must therefore count only `hasHistoricalSeries !== false`
    // indicators, so a day with the two MHCLG prints alone satisfies delivery.
    const rows: ObservationRow[] = [];
    const today = Date.UTC(2026, 3, 18);

    const EDITORIAL_DELIVERY = new Set(["new_towns_milestones", "bics_rollout", "industrial_strategy", "smr_programme"]);

    // Baseline + recent observations for every indicator EXCEPT the 4
    // editorial delivery ones — those have no history at all.
    for (const id of Object.keys(INDICATORS)) {
      if (EDITORIAL_DELIVERY.has(id)) continue;
      const base = hash(id) % 50 + 20;
      for (let wk = 26; wk >= 1; wk--) {
        const ts = new Date(today - wk * 7 * 86_400_000).toISOString();
        rows.push({ indicator_id: id, observed_at: ts, value: base + (wk % 5) });
      }
    }

    const day1 = new Date(today - 86_400_000 + 12 * 3600_000).toISOString();
    for (const id of Object.keys(INDICATORS)) {
      if (EDITORIAL_DELIVERY.has(id)) continue;
      rows.push({ indicator_id: id, observed_at: day1, value: 50 });
    }

    const { env, batches } = makeEnv(rows);
    const result = await backfillHistoricalScores(env, { days: 1, overwrite: true });

    // Headline written: every pillar (incl. delivery) passed quorum.
    expect(result.daysWritten).toBe(1);
    expect(result.daysPartial).toBe(0);
    expect(result.daysSkipped).toBe(0);
    expect(result.gaps).toEqual([]);

    // Exactly one batch: 1 headline + 4 pillar rows (delivery included).
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1 + PILLAR_ORDER.length);
    const pillarInserts = batches[0]!.filter((s) => s.sql.includes("INSERT OR REPLACE INTO pillar_scores"));
    expect(pillarInserts.map((s) => String(s.bindings[0])).sort()).toEqual(["delivery", "fiscal", "labour", "market"]);
  });

  it("respects overwrite: false → INSERT OR IGNORE", async () => {
    const { env, batches } = makeEnv(seedObservations([1, 2]));
    await backfillHistoricalScores(env, { days: 1, overwrite: false });
    for (const batch of batches) {
      for (const stmt of batch) expect(stmt.sql).toContain("INSERT OR IGNORE");
    }
  });

  it("is deterministic — same input produces identical output on re-run", async () => {
    const obs = seedObservations([1, 2, 3]);
    const run1 = makeEnv(obs);
    const run2 = makeEnv(obs);
    const r1 = await backfillHistoricalScores(run1.env, { days: 3, overwrite: true });
    const r2 = await backfillHistoricalScores(run2.env, { days: 3, overwrite: true });
    expect(r1.daysWritten).toBe(r2.daysWritten);
    // Bindings drive the written values; if they match, the scores match.
    for (let i = 0; i < run1.batches.length; i++) {
      const b1 = run1.batches[i]!;
      const b2 = run2.batches[i]!;
      expect(b1.length).toBe(b2.length);
      for (let j = 0; j < b1.length; j++) {
        expect(b1[j]!.bindings).toEqual(b2[j]!.bindings);
      }
    }
  });

  it("clamps days to [1, 365]", async () => {
    const { env } = makeEnv([]);
    const r1 = await backfillHistoricalScores(env, { days: 999, overwrite: true });
    expect(r1.daysRequested).toBe(365);
    const r2 = await backfillHistoricalScores(env, { days: 0, overwrite: true });
    expect(r2.daysRequested).toBe(1);
  });

  /**
   * Lookahead-bias regression.
   *
   * ONS PSF is published with a ~45-day lag: the March 2025 figure appears
   * as `observed_at=2025-03-31` in the observation row, but the actual
   * release date is ~22 April 2025. A naive cutoff check (`observed_at <=
   * end-of-day(D)`) would therefore include the March figure in a backfill
   * score for any day in the first three weeks of April, using data that
   * was not yet public on that day. That's lookahead bias, and it
   * systematically flatters the backfilled historical scores for monthly
   * ONS indicators.
   *
   * After the `released_at` fix, the cutoff comparison is
   * `COALESCE(released_at, observed_at) <= end-of-day(D)`, so the March
   * observation is correctly excluded from any day before the release.
   */
  it("respects released_at: an observation whose release postdates the backfill day is excluded", async () => {
    // Scenario: fiscal indicators have exactly one recent observation each,
    // whose `released_at` is AFTER the target backfill day's cutoff (the
    // canonical PSF-lag: March data released in April). Non-fiscal pillars
    // have pre-release observations so they score normally. The fix under
    // test must drop the fiscal observation on the target day → fiscal
    // fails quorum → no fiscal pillar row and the day's headline is
    // suppressed. Timestamps are anchored to the real current day because
    // `backfillHistoricalScores` uses `new Date()` internally.
    const nowLocal = new Date();
    const todayStartMs = Date.UTC(
      nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate(),
    );
    const today = todayStartMs;
    const backfillOffset = 10;
    const backfillDayMs = today - backfillOffset * DAY_MS;
    const rows: ObservationRow[] = [];

    // Baseline + recent for NON-fiscal indicators so their pillars score.
    for (const id of Object.keys(INDICATORS)) {
      const def = INDICATORS[id]!;
      if (def.pillar === "fiscal") continue;
      if (def.hasHistoricalSeries === false) continue;
      const base = hash(id) % 50 + 20;
      for (let wk = 26; wk >= 1; wk--) {
        const ts = new Date(today - wk * 7 * DAY_MS).toISOString();
        rows.push({ indicator_id: id, observed_at: ts, value: base + (wk % 5), released_at: ts });
      }
      rows.push({
        indicator_id: id,
        observed_at: new Date(backfillDayMs - DAY_MS).toISOString(),
        value: 50,
        released_at: new Date(backfillDayMs - DAY_MS).toISOString(),
      });
    }

    // Fiscal: exactly ONE observation per indicator, observed-on-backfill-day
    // but released 2 days AFTER the target day. No baseline — so once
    // released_at filtering removes the single observation, fiscal has
    // nothing to score against.
    const fiscalIds = Object.values(INDICATORS).filter((d) => d.pillar === "fiscal").map((d) => d.id);
    const releasedAfterCutoffMs = today - (backfillOffset - 2) * DAY_MS; // published 2 days later
    for (const id of fiscalIds) {
      rows.push({
        indicator_id: id,
        observed_at: new Date(backfillDayMs).toISOString(),
        value: 999, // sentinel - any leak of this into scoring is obvious
        released_at: new Date(releasedAfterCutoffMs).toISOString(),
      });
    }

    const { env, batches } = makeEnv(rows);
    const result = await backfillHistoricalScores(env, { days: backfillOffset, overwrite: true });

    // The specific day we care about (backfill offset=10) must record
    // fiscal as stale — its only "recent" observations are released AFTER
    // that day. Other pillars should pass.
    const targetDayIso = new Date(backfillDayMs).toISOString().slice(0, 10);
    const gap = result.gaps.find((g) => g.day === targetDayIso);
    expect(gap).toBeDefined();
    expect(gap!.stalePillars).toContain("fiscal");
    expect(gap!.stalePillars).not.toContain("market");

    // Hard evidence the sentinel value never leaked into scoring: no
    // written pillar_scores value for fiscal on the target day. Iterate all
    // batches to guarantee no fiscal row for that observed_at.
    const targetObservedAt = `${targetDayIso}T23:59:00.000Z`;
    for (const batch of batches) {
      for (const stmt of batch) {
        if (stmt.sql.includes("pillar_scores")
            && stmt.bindings[0] === "fiscal"
            && stmt.bindings[1] === targetObservedAt) {
          throw new Error(`fiscal pillar row written for ${targetObservedAt} despite release date after cutoff`);
        }
      }
    }
  });
});
