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
      // Latest observation per indicator. The query is the two-tier
      // selector documented in apps/api/src/lib/db.ts: live tier picks
      // MAX(ingested_at) over non-hist non-seed rows, hist tier picks
      // MAX(observed_at) over hist:% rows, then a final ROW_NUMBER ranks
      // the two candidates by (observed_at DESC, live-before-hist on
      // ties, ingested_at DESC). This stub emulates the algorithm
      // directly so the regression suite is honest about behaviour
      // rather than coupled to SQL surface text.
      if (sql.includes("FROM indicator_observations") && sql.includes("ROW_NUMBER")) {
        const isHist = (o: ObservationRow) => o.payload_hash !== null && o.payload_hash.startsWith("hist:");
        const isSeed = (o: ObservationRow) => o.payload_hash !== null && o.payload_hash.startsWith("seed");

        const liveCandidatePerIndicator = new Map<string, ObservationRow>();
        for (const o of observations) {
          if (isHist(o) || isSeed(o)) continue;
          const prev = liveCandidatePerIndicator.get(o.indicator_id);
          if (!prev || o.ingested_at > prev.ingested_at) {
            liveCandidatePerIndicator.set(o.indicator_id, o);
          }
        }
        const histCandidatePerIndicator = new Map<string, ObservationRow>();
        for (const o of observations) {
          if (!isHist(o)) continue;
          const prev = histCandidatePerIndicator.get(o.indicator_id);
          if (!prev || o.observed_at > prev.observed_at) {
            histCandidatePerIndicator.set(o.indicator_id, o);
          }
        }

        const indicatorIds = new Set<string>([
          ...liveCandidatePerIndicator.keys(),
          ...histCandidatePerIndicator.keys(),
        ]);
        const out: ObservationRow[] = [];
        for (const id of indicatorIds) {
          const live = liveCandidatePerIndicator.get(id);
          const hist = histCandidatePerIndicator.get(id);
          // Pick the row with newer observed_at; live wins on a tie.
          const winner = (() => {
            if (!live) return hist!;
            if (!hist) return live;
            if (hist.observed_at > live.observed_at) return hist;
            // Live wins observedAt ties; if both still tie, ingested_at
            // tiebreaker stays consistent with the SQL ORDER BY chain.
            if (live.observed_at > hist.observed_at) return live;
            if (live.ingested_at >= hist.ingested_at) return live;
            return hist;
          })();
          out.push(winner);
        }
        const shaped = out.map((o) => ({
          indicator_id: o.indicator_id,
          value: o.value,
          observed_at: o.observed_at,
          source_id: o.source_id,
        }));
        return { results: shaped as unknown as T[] };
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

  it("falls back gracefully when no live row exists — seeds still don't surface", async () => {
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

    const cb = snap.pillars.fiscal.contributions.find((c) => c.indicatorId === "cb_headroom");
    expect(cb, "no eligible row -> no contribution surfaces").toBeUndefined();
    // Sanity: the pillar object is still well-formed for every PILLAR_ORDER entry.
    for (const p of PILLAR_ORDER) {
      expect(snap.pillars[p]).toBeDefined();
    }
  });
});

// Fix C/D — backfill-supersede regression suite (audit 2026-04-29).
//
// When a live adapter is silently failing through to a stale-dated fixture
// (e.g. EIA Brent fall-through with observed_at=2026-04-17 written every
// 5-minute cron tick), the live tier MAX(ingested_at) selector locks onto
// that stale-dated row even though a backfill row carries a more recent
// observed_at. The two-tier selector documented in apps/api/src/lib/db.ts
// adds a hist tier (MAX observed_at) and surfaces whichever tier has the
// newer observed_at — restoring honest freshness without inventing values.
describe("buildSnapshotFromD1 — backfill-supersede regression (Fix C/D)", () => {
  it("surfaces a hist:* row when its observed_at is newer than the live row's stale-dated fixture write", async () => {
    // Reproduces the prod state on 2026-04-29: EIA live path had been
    // failing for ~12 days; every cron tick re-wrote the fixture's
    // 2026-04-17 row. A backfill on 2026-04-27 had populated rows up
    // to observed_at=2026-04-20. The fresher backfill row should win.
    const liveStale: ObservationRow = {
      indicator_id: "brent_gbp",
      source_id: "eia_brent",
      observed_at: "2026-04-17T00:00:00Z",
      value: 72.68,
      ingested_at: "2026-04-29T09:30:53.000Z",
      payload_hash: "abc-fixture-fallback",
    };
    const histFresh: ObservationRow = {
      indicator_id: "brent_gbp",
      source_id: "eia_brent",
      observed_at: "2026-04-20T00:00:00Z",
      value: 76.46,
      ingested_at: "2026-04-27T18:02:55.000Z",
      payload_hash: "hist:brent_gbp:2026-04-20",
    };

    const env = makeEnv([liveStale, histFresh]);
    const snap = await buildSnapshotFromD1(env);

    const brent = snap.pillars.market.contributions.find((c) => c.indicatorId === "brent_gbp");
    expect(brent, "brent_gbp contribution should surface").toBeDefined();
    expect(brent!.rawValue, "newer hist row must beat stale-dated live fixture").toBe(76.46);
    expect(brent!.observedAt).toBe("2026-04-20T00:00:00Z");
  });

  it("keeps the live row when it has the same observed_at as the freshest hist row", async () => {
    // When live and backfill agree on the day (both at observed_at=X),
    // live wins on the tiebreaker so a real-time print is preferred over
    // its backfill counterpart for the same period.
    const live: ObservationRow = {
      indicator_id: "ftse_250",
      source_id: "lseg",
      observed_at: "2026-04-29T16:30:00Z",
      value: 22850,
      ingested_at: "2026-04-29T17:00:00.000Z",
      payload_hash: "live-eodhd-sha",
    };
    const hist: ObservationRow = {
      indicator_id: "ftse_250",
      source_id: "lseg",
      observed_at: "2026-04-29T16:30:00Z",
      value: 22845,
      ingested_at: "2026-04-29T16:45:00.000Z",
      payload_hash: "hist:ftse_250:2026-04-29",
    };

    const env = makeEnv([live, hist]);
    const snap = await buildSnapshotFromD1(env);

    const ftse = snap.pillars.market.contributions.find((c) => c.indicatorId === "ftse_250");
    expect(ftse!.rawValue, "live wins observedAt ties").toBe(22850);
  });

  it("keeps the live row when its observed_at is newer than the freshest hist row", async () => {
    // The healthy steady state: live adapter publishes a fresh print
    // and earlier backfill rows cover prior days. Live must win.
    const live: ObservationRow = {
      indicator_id: "gilt_10y",
      source_id: "boe_yields",
      observed_at: "2026-04-28T16:00:00Z",
      value: 5.01,
      ingested_at: "2026-04-29T07:00:00.000Z",
      payload_hash: "live-boe-sha",
    };
    const hist: ObservationRow = {
      indicator_id: "gilt_10y",
      source_id: "boe_yields",
      observed_at: "2026-04-25T16:00:00Z",
      value: 4.97,
      ingested_at: "2026-04-27T18:02:55.000Z",
      payload_hash: "hist:gilt_10y:2026-04-25",
    };

    const env = makeEnv([live, hist]);
    const snap = await buildSnapshotFromD1(env);

    const gilt = snap.pillars.market.contributions.find((c) => c.indicatorId === "gilt_10y");
    expect(gilt!.rawValue, "live row wins when its observedAt is newer").toBe(5.01);
    expect(gilt!.observedAt).toBe("2026-04-28T16:00:00Z");
  });

  it("surfaces a hist row when no live row exists at all (e.g. before the live path has ever succeeded)", async () => {
    const histOnly: ObservationRow = {
      indicator_id: "brent_gbp",
      source_id: "eia_brent",
      observed_at: "2026-04-20T00:00:00Z",
      value: 76.46,
      ingested_at: "2026-04-27T18:02:55.000Z",
      payload_hash: "hist:brent_gbp:2026-04-20",
    };

    const env = makeEnv([histOnly]);
    const snap = await buildSnapshotFromD1(env);

    const brent = snap.pillars.market.contributions.find((c) => c.indicatorId === "brent_gbp");
    expect(brent, "hist alone is enough to surface a contribution").toBeDefined();
    expect(brent!.rawValue).toBe(76.46);
  });

  it("preserves OBR EFO supersede: stale live row with later observedAt must lose to current live row with earlier observedAt", async () => {
    // Re-asserts the fixture-supersede invariant under the new SQL: the
    // tier-1 selector still uses MAX(ingested_at) within the live class.
    // A stale live row (observed_at later, ingested earlier) must not win
    // over a current live row (observed_at earlier, ingested later).
    const stale: ObservationRow = {
      indicator_id: "cb_headroom",
      source_id: "obr_efo",
      observed_at: "2026-03-26T00:00:00Z",
      value: 9.9,
      ingested_at: "2026-04-15T02:00:00.000Z",
      payload_hash: "abc-stale",
    };
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

    const cb = snap.pillars.fiscal.contributions.find((c) => c.indicatorId === "cb_headroom");
    expect(cb!.rawValue, "tier-1 MAX(ingested_at) within live class still wins on OBR EFO supersede").toBe(23.6);
  });
});
