/**
 * Regression test for the "fixture-superseded live row" bug.
 *
 * Background: `indicator_observations` has PK (indicator_id, observed_at).
 * Adapters write live rows with `INSERT OR REPLACE`, which advances
 * `ingested_at` to NOW() for the matching PK. When an editorial fixture
 * is updated and its `observed_at` moves *backwards* (e.g. an OBR EFO
 * fixture is corrected from "2026-03-26 / £9.9bn" to "2026-03-03 / £23.6bn"),
 * the previously-written live row at the older `observed_at` lingers.
 * A `MAX(observed_at)` selector then returns the stale row (later
 * lexicographic date) instead of the most recently written row.
 *
 * The fix: select live observations by `MAX(ingested_at)` over rows that
 * are not historical backfill (`payload_hash LIKE 'hist:%'`) or seed
 * (`payload_hash LIKE 'seed%'`).
 *
 * This test stubs D1 with the production-shaped query and asserts the
 * contribution surfaced for `cb_headroom` reflects the most-recently
 * ingested live row, not the lexicographically-greater observed_at.
 */
import { describe, expect, it } from "vitest";
import { PILLAR_ORDER } from "@tightrope/shared";
import { buildSnapshotFromD1 } from "../lib/db.js";

interface ObservationRow {
  indicator_id: string;
  source_id: string;
  observed_at: string;
  value: number;
  ingested_at: string;
  payload_hash: string | null;
}

function makeEnv(observations: readonly ObservationRow[]): Env {
  interface Stmt {
    all: <T = unknown>() => Promise<{ results: T[] }>;
    first: <T = unknown>() => Promise<T | null>;
    bind: (...args: unknown[]) => Stmt;
  }

  const make = (sql: string): Stmt => ({
    async all<T>(): Promise<{ results: T[] }> {
      // Latest observation per indicator. The fix moves selection from
      // MAX(observed_at) to MAX(ingested_at) over non-hist/non-seed rows;
      // this stub honours whichever flavour the SQL asks for so the test
      // is honest about which selector is in effect.
      if (sql.includes("FROM indicator_observations") && sql.includes("GROUP BY indicator_id")) {
        const usesIngested = /MAX\s*\(\s*ingested_at\s*\)/i.test(sql);
        const filtersHistSeed = /payload_hash[\s\S]*NOT LIKE\s*'hist:%'/i.test(sql)
          && /payload_hash[\s\S]*NOT LIKE\s*'seed%'/i.test(sql);
        const eligible = filtersHistSeed
          ? observations.filter((o) =>
              o.payload_hash === null
              || (!o.payload_hash.startsWith("hist:") && !o.payload_hash.startsWith("seed")))
          : observations;
        const byIndicator = new Map<string, ObservationRow>();
        for (const o of eligible) {
          const prev = byIndicator.get(o.indicator_id);
          const key = (r: ObservationRow) => (usesIngested ? r.ingested_at : r.observed_at);
          if (!prev || key(o) > key(prev)) byIndicator.set(o.indicator_id, o);
        }
        const out = [...byIndicator.values()].map((o) => ({
          indicator_id: o.indicator_id,
          value: o.value,
          observed_at: o.observed_at,
          source_id: o.source_id,
        }));
        return { results: out as unknown as T[] };
      }
      // Other queries (headline_scores, pillar_scores, ingestion_audit) are
      // out of scope for this test — return empty so buildSnapshotFromD1
      // falls back to defaults for those sections.
      return { results: [] as T[] };
    },
    async first<T>(): Promise<T | null> {
      // Latest headline row — empty drives the empty-snapshot defaults.
      return null;
    },
    bind() { return this; },
  });

  return {
    DB: { prepare: (sql: string) => make(sql) } as unknown as D1Database,
  } as unknown as Env;
}

describe("buildSnapshotFromD1 — fixture-supersede regression", () => {
  it("picks cb_headroom by MAX(ingested_at), not MAX(observed_at) — surfacing the most recently-written live row", async () => {
    // The stale row: written when the OBR fixture was at the March 2025
    // crunch (£9.9bn) with observed_at='2026-03-26'. Survived the
    // editorial fixture update because of the PK shape.
    const stale: ObservationRow = {
      indicator_id: "cb_headroom",
      source_id: "obr_efo",
      observed_at: "2026-03-26T00:00:00Z",
      value: 9.9,
      ingested_at: "2026-04-15T02:00:00.000Z",
      payload_hash: "abc-stale",
    };
    // The current live row: matches the on-disk fixture (Spring 2026 EFO).
    // observed_at is *earlier* than the stale row — so MAX(observed_at)
    // would mis-select the £9.9bn value.
    const current: ObservationRow = {
      indicator_id: "cb_headroom",
      source_id: "obr_efo",
      observed_at: "2026-03-03T00:00:00Z",
      value: 23.6,
      ingested_at: "2026-04-25T02:00:00.000Z",
      payload_hash: "def-current",
    };

    const env = makeEnv([stale, current]);
    const snap = await buildSnapshotFromD1(env);

    const fiscal = snap.pillars.fiscal;
    const cb = fiscal.contributions.find((c) => c.indicatorId === "cb_headroom");
    expect(cb, "cb_headroom contribution should be present").toBeDefined();
    expect(cb!.rawValue, "cb_headroom rawValue should reflect current fixture (£23.6bn), not stale row (£9.9bn)").toBe(23.6);
    expect(cb!.observedAt, "observedAt should match the current fixture's reference period").toBe("2026-03-03T00:00:00Z");
  });

  it("excludes hist:* rows from the live selector, even if they have a more recent ingested_at than the live row", async () => {
    const live: ObservationRow = {
      indicator_id: "cb_headroom",
      source_id: "obr_efo",
      observed_at: "2026-03-03T00:00:00Z",
      value: 23.6,
      ingested_at: "2026-04-20T02:00:00.000Z",
      payload_hash: "live-sha",
    };
    // A historical backfill row, written more recently than the live one
    // — it must NOT win the "current live" selector.
    const histBackfill: ObservationRow = {
      indicator_id: "cb_headroom",
      source_id: "obr_efo",
      observed_at: "2025-11-26T00:00:00Z",
      value: 22.0,
      ingested_at: "2026-04-26T18:00:00.000Z",
      payload_hash: "hist:cb_headroom:2025-11-26",
    };

    const env = makeEnv([live, histBackfill]);
    const snap = await buildSnapshotFromD1(env);

    const cb = snap.pillars.fiscal.contributions.find((c) => c.indicatorId === "cb_headroom");
    expect(cb!.rawValue, "live row must win against hist:* row even when hist:* has later ingested_at").toBe(23.6);
  });

  it("excludes seed* rows from the live selector — the API never serves a seed row once a real adapter run has landed", async () => {
    const seed: ObservationRow = {
      indicator_id: "cb_headroom",
      source_id: "obr_efo",
      observed_at: "2026-04-17T14:02:00.000Z",
      value: 23.6,
      ingested_at: "2026-04-17T14:02:00.000Z",
      payload_hash: "seed_cb_headroom",
    };
    const live: ObservationRow = {
      indicator_id: "cb_headroom",
      source_id: "obr_efo",
      observed_at: "2026-03-03T00:00:00Z",
      value: 23.4,
      ingested_at: "2026-04-25T02:00:00.000Z",
      payload_hash: "real-sha",
    };

    const env = makeEnv([seed, live]);
    const snap = await buildSnapshotFromD1(env);

    const cb = snap.pillars.fiscal.contributions.find((c) => c.indicatorId === "cb_headroom");
    // Live row, even with the earlier observed_at and a marginal value
    // difference, must beat the seed row.
    expect(cb!.rawValue).toBe(23.4);
  });

  it("falls back gracefully when no live row exists — seeds and historical rows still don't surface as 'live'", async () => {
    const seedOnly: ObservationRow = {
      indicator_id: "cb_headroom",
      source_id: "obr_efo",
      observed_at: "2026-04-17T14:02:00.000Z",
      value: 23.6,
      ingested_at: "2026-04-17T14:02:00.000Z",
      payload_hash: "seed_cb_headroom",
    };

    const env = makeEnv([seedOnly]);
    const snap = await buildSnapshotFromD1(env);

    // No live observation -> no contribution. The pillar still exists
    // with default zeros (we test other indicators in other tests).
    const cb = snap.pillars.fiscal.contributions.find((c) => c.indicatorId === "cb_headroom");
    expect(cb, "no live row -> no contribution surfaces").toBeUndefined();
    // Sanity: the pillar object is still well-formed for every PILLAR_ORDER entry.
    for (const p of PILLAR_ORDER) {
      expect(snap.pillars[p]).toBeDefined();
    }
  });
});
