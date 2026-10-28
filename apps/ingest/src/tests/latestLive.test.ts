/**
 * Unit tests for `filterStaleLiveRows`.
 *
 * It exists to fix a fixture/current-row selector bug: an editorial fixture
 * whose `observed_at` moves backwards leaves the previously-written live row
 * in D1. The filter drops that invalid later date while retaining genuine
 * earlier publications for scoring baselines and sparklines. The two-tier
 * latest-observation selector that used to be tested here now lives in
 * `@tightrope/snapshot` — see packages/snapshot/src/observations.test.ts.
 */
import { describe, expect, it } from "vitest";
import { computePillarScore } from "@tightrope/methodology";
import {
  filterStaleLiveRows,
  type ObservationRow,
} from "../lib/history.js";

describe("filterStaleLiveRows", () => {
  it("drops an invalid later reference date after a fixture date correction", () => {
    const stale: ObservationRow = {
      indicator_id: "cb_headroom",
      source_id: "obr_efo",
      observed_at: "2026-03-26T00:00:00Z",
      value: 9.9,
      payload_hash: "abc-stale",
      ingested_at: "2026-04-15T02:00:00Z",
    };
    const current: ObservationRow = {
      indicator_id: "cb_headroom",
      source_id: "obr_efo",
      observed_at: "2026-03-03T00:00:00Z",
      value: 23.6,
      payload_hash: "def-current",
      ingested_at: "2026-04-25T02:00:00Z",
    };

    const filtered = filterStaleLiveRows([stale, current]);

    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toBe(current);
  });

  it("keeps the complete daily live history as new closes arrive", () => {
    const rows: ObservationRow[] = [24, 25, 26].map((day, i) => ({
      indicator_id: "ilg_share", source_id: "dmo",
      observed_at: `2026-10-${day}T00:00:00Z`, value: 24 + i,
      payload_hash: `daily-sha-${day}`, ingested_at: `2026-10-${day + 1}T02:00:00Z`,
    }));
    expect(filterStaleLiveRows(rows)).toEqual(rows);
    const score = computePillarScore("fiscal", {
      readings: [{ indicatorId: "ilg_share", value: 26, observedAt: rows[2]!.observed_at, baseline: filterStaleLiveRows(rows).map((row) => row.value) }],
      sparkline30d: [],
    });
    // Rising index-linked exposure must rank against all three daily prints,
    // rather than collapsing to a single observation's neutral 50 score.
    expect(score.contributions[0]!.normalised).toBeCloseTo(100 / 6);
  });

  it("retains valid older vintages when a current fixture corrects its date backwards", () => {
    const prior: ObservationRow = {
      indicator_id: "cb_headroom", source_id: "obr_efo",
      observed_at: "2025-11-26T00:00:00Z", value: 22,
      payload_hash: "older-real-vintage", ingested_at: "2025-11-27T02:00:00Z",
    };
    const stale: ObservationRow = {
      ...prior, observed_at: "2026-03-26T00:00:00Z", value: 9.9,
      payload_hash: "wrong-date", ingested_at: "2026-04-15T02:00:00Z",
    };
    const corrected: ObservationRow = {
      ...prior, observed_at: "2026-03-03T00:00:00Z", value: 23.6,
      payload_hash: "corrected", ingested_at: "2026-04-25T02:00:00Z",
    };
    expect(filterStaleLiveRows([prior, stale, corrected])).toEqual([prior, corrected]);
  });

  it("a late historical revision never rolls back the current live ceiling", () => {
    const current: ObservationRow = {
      indicator_id: "gilt_10y", source_id: "boe_yields",
      observed_at: "2026-10-26T16:00:00Z", value: 5.3259,
      payload_hash: "current", ingested_at: "2026-10-27T09:00:00Z",
    };
    const revised: ObservationRow = {
      ...current, observed_at: "2026-09-01T16:00:00Z", value: 4.8,
      payload_hash: "hist:revised-september", ingested_at: "2026-10-28T09:00:00Z",
    };
    expect(filterStaleLiveRows([current, revised])).toEqual([current, revised]);
  });

  it("preserves all dates in a live batch with the same ingest timestamp", () => {
    const rows: ObservationRow[] = [26, 27].map((day) => ({
      indicator_id: "housebuilder_idx", source_id: "eodhd_housebuilders",
      observed_at: `2026-10-${day}T16:30:00Z`, value: day,
      payload_hash: `sha-${day}`, ingested_at: "2026-10-28T09:00:00Z",
    }));
    expect(filterStaleLiveRows(rows)).toEqual(rows);
  });

  it("never drops historical-backfill (`hist:*`) rows even if they share an indicator with a live row", () => {
    const live: ObservationRow = {
      indicator_id: "housing_trajectory",
      source_id: "mhclg",
      observed_at: "2025-12-31T00:00:00Z",
      value: 49.0,
      payload_hash: "live-sha",
      ingested_at: "2026-04-26T02:30:00Z",
    };
    const hist1: ObservationRow = {
      indicator_id: "housing_trajectory",
      source_id: "mhclg",
      observed_at: "2024-09-30T00:00:00Z",
      value: 47.2,
      payload_hash: "hist:housing_trajectory:2024-09-30",
      ingested_at: "2026-04-26T02:30:01Z",
    };
    const hist2: ObservationRow = {
      indicator_id: "housing_trajectory",
      source_id: "mhclg",
      observed_at: "2024-12-31T00:00:00Z",
      value: 48.1,
      payload_hash: "hist:housing_trajectory:2024-12-31",
      ingested_at: "2026-04-26T02:30:02Z",
    };

    const filtered = filterStaleLiveRows([hist1, hist2, live]);

    // All three retained — historical rows are not deduped, only live ones are.
    expect(filtered).toHaveLength(3);
    expect(filtered).toContain(live);
    expect(filtered).toContain(hist1);
    expect(filtered).toContain(hist2);
  });

  it("scopes dedupe to (indicator_id, source_id) — two adapters can legitimately produce the same indicator", () => {
    const eodhd: ObservationRow = {
      indicator_id: "housebuilder_idx",
      source_id: "eodhd_housebuilders",
      observed_at: "2026-04-24T16:30:00Z",
      value: 51.2,
      payload_hash: "eodhd-sha",
      ingested_at: "2026-04-27T02:00:00Z",
    };
    const fixtureFallback: ObservationRow = {
      indicator_id: "housebuilder_idx",
      source_id: "lseg_housebuilders",
      observed_at: "2026-04-23T16:30:00Z",
      value: 63.5,
      payload_hash: "lseg-sha",
      ingested_at: "2026-04-22T07:46:00Z",
    };

    const filtered = filterStaleLiveRows([eodhd, fixtureFallback]);

    // Both kept — different source_id means independent live snapshots.
    // Downstream code picks which one it trusts via `INDICATORS[id].sourceId`.
    expect(filtered).toHaveLength(2);
  });

  it("drops superseded seed* rows... wait, no — seed rows pass through untouched", () => {
    // Seed rows are not "live" in the supersede sense; they're a historical
    // back-anchor. The downstream live-selector excludes them explicitly,
    // so the filter doesn't need to.
    const seed: ObservationRow = {
      indicator_id: "cb_headroom",
      source_id: "obr_efo",
      observed_at: "2026-04-17T14:02:00.000Z",
      value: 23.6,
      payload_hash: "seed_cb_headroom",
      ingested_at: "2026-04-17T14:02:00.000Z",
    };
    const live: ObservationRow = {
      indicator_id: "cb_headroom",
      source_id: "obr_efo",
      observed_at: "2026-03-03T00:00:00Z",
      value: 23.4,
      payload_hash: "real-sha",
      ingested_at: "2026-04-25T02:00:00Z",
    };

    const filtered = filterStaleLiveRows([seed, live]);

    expect(filtered).toContain(seed);
    expect(filtered).toContain(live);
  });

  it("treats payload_hash NULL as live (legacy rows pre-dating the prefix convention)", () => {
    const legacy: ObservationRow = {
      indicator_id: "x",
      source_id: "y",
      observed_at: "2025-01-01T00:00:00Z",
      value: 1,
      payload_hash: null,
      ingested_at: "2025-01-01T00:00:00Z",
    };
    const newer: ObservationRow = {
      indicator_id: "x",
      source_id: "y",
      observed_at: "2024-12-01T00:00:00Z",
      value: 2,
      payload_hash: "sha",
      ingested_at: "2026-01-01T00:00:00Z",
    };

    const filtered = filterStaleLiveRows([legacy, newer]);

    // Newer (despite earlier observed_at) wins — the whole point of the fix.
    expect(filtered).toEqual([newer]);
  });

  it("preserves input order for kept rows", () => {
    const a: ObservationRow = {
      indicator_id: "i1", source_id: "s",
      observed_at: "2026-01-01T00:00:00Z", value: 1,
      payload_hash: "sha1", ingested_at: "2026-01-01T00:00:00Z",
    };
    const b: ObservationRow = {
      indicator_id: "i2", source_id: "s",
      observed_at: "2026-01-01T00:00:00Z", value: 2,
      payload_hash: "sha2", ingested_at: "2026-01-01T00:00:00Z",
    };
    const c: ObservationRow = {
      indicator_id: "i3", source_id: "s",
      observed_at: "2026-01-01T00:00:00Z", value: 3,
      payload_hash: "sha3", ingested_at: "2026-01-01T00:00:00Z",
    };

    const filtered = filterStaleLiveRows([a, b, c]);

    expect(filtered).toEqual([a, b, c]);
  });
});
