/**
 * Tests for the OBR headroom-vintage reader.
 *
 * The Fiscal-pillar detail chart needs ≥2 vintages to render its
 * forecast-headroom-by-vintage trendline. The OBR EFO source is unique:
 *   - There is no live API; the adapter is fixture-backed.
 *   - The live `fetch()` only emits the head (most-recent) vintage.
 *   - The historical-backfill path emits ALL vintages with the `hist:`
 *     payload_hash prefix.
 *
 * The previous filter excluded `hist:%` rows along with `seed%` rows. For
 * indicators with a real live feed (gilt yields, FX, etc.) that's right —
 * `hist:` rows there are synthetic carry-forwards. But for `cb_headroom`,
 * every row is an authentic OBR forecast vintage; filtering them out left
 * the chart with one point and triggered the empty-state hint, even though
 * the database held the full series. This regression caused Pillar 2 to
 * silently render no trendline despite the backfill having succeeded.
 *
 * The fix keeps the `seed%` exclusion (those are dev placeholders) but
 * stops excluding `hist:%` rows. The Hero (which uses `[0]` after the
 * observed-at-DESC sort) is unaffected: the most-recent vintage is the most
 * recent regardless of payload_hash prefix.
 */
import { describe, expect, it } from "vitest";
import { getHeadroomVintages } from "./db.js";

interface ObservationRow {
  indicator_id: string;
  value: number;
  observed_at: string;
  payload_hash: string | null;
}

/**
 * Tiny D1 stub that returns rows the supplied SQL would select. The stub
 * inspects the WHERE clause for the two payload_hash predicates we care
 * about (`NOT LIKE 'hist:%'`, `NOT LIKE 'seed%'`) so the test exercises the
 * real SQL the function emits.
 */
function buildEnvWith(rows: ObservationRow[]) {
  function execute(sql: string, bound: unknown[]): { results: { value: number; observed_at: string }[] } {
    const lower = sql.toLowerCase();
    const indicatorMatch = /indicator_id\s*=\s*'([^']+)'/i.exec(sql);
    const indicatorId = indicatorMatch?.[1] ?? "";
    const excludeHist = /not\s+like\s+'hist:%'/i.test(lower);
    const excludeSeed = /not\s+like\s+'seed%'/i.test(lower);
    const limit = typeof bound[0] === "number" ? bound[0] : Infinity;

    const filtered = rows
      .filter((r) => r.indicator_id === indicatorId)
      .filter((r) => {
        if (r.payload_hash === null) return true;
        if (excludeSeed && r.payload_hash.startsWith("seed")) return false;
        if (excludeHist && r.payload_hash.startsWith("hist:")) return false;
        return true;
      })
      .sort((a, b) => b.observed_at.localeCompare(a.observed_at))
      .slice(0, limit)
      .map((r) => ({ value: r.value, observed_at: r.observed_at }));

    return { results: filtered };
  }

  return {
    DB: {
      prepare: (sql: string) => {
        let bound: unknown[] = [];
        const stmt = {
          bind: (...args: unknown[]) => {
            bound = args;
            return stmt;
          },
          all: () => Promise.resolve(execute(sql, bound)),
        };
        return stmt;
      },
    },
  } as unknown as Parameters<typeof getHeadroomVintages>[0];
}

describe("getHeadroomVintages", () => {
  it("returns vintages from BOTH live (head) and hist:* (backfilled prior vintages) rows so the OBR-vintage chart trendline renders", async () => {
    // Reproduces the production state: backfill emitted four vintages with
    // `hist:` payload_hash; the daily live `fetch()` then overwrote the head
    // row's payload_hash with a normal sha. Three hist: rows + one live row.
    const rows: ObservationRow[] = [
      { indicator_id: "cb_headroom", value: 9.9,  observed_at: "2024-10-30T00:00:00Z", payload_hash: "hist:obr:autumn24" },
      { indicator_id: "cb_headroom", value: 9.9,  observed_at: "2025-03-26T00:00:00Z", payload_hash: "hist:obr:spring25" },
      { indicator_id: "cb_headroom", value: 22.0, observed_at: "2025-11-26T00:00:00Z", payload_hash: "hist:obr:autumn25" },
      { indicator_id: "cb_headroom", value: 23.6, observed_at: "2026-03-03T00:00:00Z", payload_hash: "abc123-live-sha" },
    ];

    const vintages = await getHeadroomVintages(buildEnvWith(rows), 4);

    expect(vintages.map((v) => v.value)).toEqual([23.6, 22.0, 9.9, 9.9]);
    expect(vintages[0]?.observedAt).toBe("2026-03-03T00:00:00Z");
    expect(vintages[3]?.observedAt).toBe("2024-10-30T00:00:00Z");
  });

  it("still excludes seed* rows so dev seeds never bleed into the live vintage chart", async () => {
    const rows: ObservationRow[] = [
      { indicator_id: "cb_headroom", value: 50.0, observed_at: "2023-01-01T00:00:00Z", payload_hash: "seed-dev" },
      { indicator_id: "cb_headroom", value: 9.9,  observed_at: "2025-03-26T00:00:00Z", payload_hash: "hist:obr:spring25" },
      { indicator_id: "cb_headroom", value: 23.6, observed_at: "2026-03-03T00:00:00Z", payload_hash: "abc123-live-sha" },
    ];

    const vintages = await getHeadroomVintages(buildEnvWith(rows), 4);

    expect(vintages).toHaveLength(2);
    expect(vintages.every((v) => v.value !== 50.0)).toBe(true);
  });

  it("filters out unrelated indicators — only cb_headroom rows are returned", async () => {
    const rows: ObservationRow[] = [
      { indicator_id: "gilt_10y",    value: 4.5,  observed_at: "2026-04-01T00:00:00Z", payload_hash: "hist:gilt" },
      { indicator_id: "cb_headroom", value: 23.6, observed_at: "2026-03-03T00:00:00Z", payload_hash: "abc123-live-sha" },
    ];

    const vintages = await getHeadroomVintages(buildEnvWith(rows), 4);

    expect(vintages).toHaveLength(1);
    expect(vintages[0]?.value).toBe(23.6);
  });

  it("returns the requested number of vintages, latest first", async () => {
    const rows: ObservationRow[] = [
      { indicator_id: "cb_headroom", value: 1, observed_at: "2024-01-01T00:00:00Z", payload_hash: "hist:a" },
      { indicator_id: "cb_headroom", value: 2, observed_at: "2025-01-01T00:00:00Z", payload_hash: "hist:b" },
      { indicator_id: "cb_headroom", value: 3, observed_at: "2026-01-01T00:00:00Z", payload_hash: "hist:c" },
      { indicator_id: "cb_headroom", value: 4, observed_at: "2026-04-01T00:00:00Z", payload_hash: "live" },
    ];

    const vintages = await getHeadroomVintages(buildEnvWith(rows), 2);

    expect(vintages).toHaveLength(2);
    expect(vintages[0]?.value).toBe(4);
    expect(vintages[1]?.value).toBe(3);
  });
});
