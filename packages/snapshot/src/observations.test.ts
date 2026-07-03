/**
 * SQL-contract tests for the single two-tier latest-observation selector.
 *
 * Relocated from apps/ingest/src/tests/latestLive.test.ts during the
 * 2026-07-03 tri-writer consolidation (assertions preserved verbatim): the
 * selector now lives here as the ONLY copy, so its contract is tested here.
 *
 * The live tier anchors on MAX(ingested_at) over non-hist/non-seed rows so
 * fixture supersedes work when observed_at moves backwards; the hist tier
 * uses MAX(observed_at) so fresher backfill can surface when the live path
 * stalls on an old fixture.
 */
import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { readLatestObservations, type LatestObservationRow } from "./observations.js";

function makeDb(rows: readonly LatestObservationRow[], capturedSql: { value: string }): D1Database {
  return {
    prepare(sql: string) {
      capturedSql.value = sql;
      return {
        all: async () => ({ results: rows }),
        first: async () => null,
        bind() { return this; },
      } as unknown as ReturnType<D1Database["prepare"]>;
    },
  } as unknown as D1Database;
}

describe("readLatestObservations — SQL contract", () => {
  it("uses MAX(ingested_at) for the live tier and MAX(observed_at) for the hist tier", async () => {
    // Audit fix 2026-04-29 (Fix C/D): the selector has two tiers. The live
    // tier still anchors on MAX(ingested_at) (preserving the OBR EFO supersede
    // protection); the hist tier uses MAX(observed_at) so backfill rows with
    // newer observed_at can win when a live adapter is silently falling
    // through to a stale-dated fixture.
    const captured = { value: "" };
    const db = makeDb([], captured);
    await readLatestObservations(db);

    expect(captured.value).toMatch(/MAX\s*\(\s*ingested_at\s*\)/i);
    expect(captured.value).toMatch(/MAX\s*\(\s*observed_at\s*\)/i);
    // The outer ranking sorts by observed_at DESC so the freshest reading
    // surfaces; the CASE expression breaks ties live-before-hist.
    expect(captured.value).toMatch(/ROW_NUMBER\s*\(\s*\)\s*OVER/i);
    expect(captured.value).toMatch(/ORDER BY\s+observed_at\s+DESC/i);
  });

  it("filters out hist:* and seed* rows on both sides of the JOIN", async () => {
    const captured = { value: "" };
    const db = makeDb([], captured);
    await readLatestObservations(db);

    // The exclusion must be applied on the inner aggregation AND the outer
    // join. A WHERE on the inner alone would let an outer-side row with the
    // same ingested_at sneak through. Non-greedy `[\s\S]*?` so we count
    // each `payload_hash ... NOT LIKE 'hist:%'` occurrence separately
    // rather than collapsing them.
    const histExcludes = (captured.value.match(/payload_hash[\s\S]*?NOT LIKE\s*'hist:%'/gi) ?? []).length;
    const seedExcludes = (captured.value.match(/payload_hash[\s\S]*?NOT LIKE\s*'seed%'/gi) ?? []).length;
    expect(histExcludes, "hist:* exclusion appears in inner + outer").toBeGreaterThanOrEqual(2);
    expect(seedExcludes, "seed* exclusion appears in inner + outer").toBeGreaterThanOrEqual(2);
  });

  it("returns the rows D1 hands back, unchanged", async () => {
    const rows: LatestObservationRow[] = [
      { indicator_id: "cb_headroom", source_id: "obr_efo", observed_at: "2026-03-03T00:00:00Z", value: 23.6, ingested_at: "2026-04-25T02:00:00Z" },
    ];
    const db = makeDb(rows, { value: "" });

    const got = await readLatestObservations(db);
    expect(got).toEqual(rows);
  });

  it("returns [] when D1 yields a null results set", async () => {
    const db = {
      prepare() {
        return {
          all: async () => ({ results: null }),
          first: async () => null,
          bind() { return this; },
        } as unknown as ReturnType<D1Database["prepare"]>;
      },
    } as unknown as D1Database;

    const got = await readLatestObservations(db);
    expect(got).toEqual([]);
  });
});
