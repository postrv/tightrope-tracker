/**
 * Package-level tests for the single snapshot builder. The api/web workers
 * keep their own end-to-end suites (which now exercise this code through the
 * thin Env wrapper); these assert the builder directly against a D1 stub.
 *
 * The stub routes each SQL string to a canned result set and emulates the
 * downsampling JOINs + the two-tier selector algorithm in JS, so the shape
 * checks stay honest about behaviour rather than coupling to SQL surface text.
 */
import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { PILLAR_ORDER, type PillarId } from "@tightrope/shared";
import { buildSnapshotFromD1 } from "./snapshot.js";

interface PillarRow {
  pillar_id: PillarId;
  observed_at: string;
  value: number;
  band: string;
}

interface ObservationRow {
  indicator_id: string;
  source_id: string;
  observed_at: string;
  value: number;
  ingested_at: string;
  payload_hash: string | null;
}

function utcDay(ts: string): string { return ts.slice(0, 10); }

function makeDb(opts: {
  pillarRows?: readonly PillarRow[];
  observations?: readonly ObservationRow[];
}): D1Database {
  const pillarRows = opts.pillarRows ?? [];
  const observations = opts.observations ?? [];

  interface Stmt {
    all: <T = unknown>() => Promise<{ results: T[] }>;
    first: <T = unknown>() => Promise<T | null>;
    bind: (...args: unknown[]) => Stmt;
  }

  const make = (sql: string): Stmt => ({
    async all<T>(): Promise<{ results: T[] }> {
      // Two-tier latest-observation selector — emulate the algorithm.
      if (sql.includes("FROM indicator_observations") && sql.includes("ROW_NUMBER")) {
        const isHist = (o: ObservationRow) => o.payload_hash !== null && o.payload_hash.startsWith("hist:");
        const isSeed = (o: ObservationRow) => o.payload_hash !== null && o.payload_hash.startsWith("seed");
        const live = new Map<string, ObservationRow>();
        for (const o of observations) {
          if (isHist(o) || isSeed(o)) continue;
          const prev = live.get(o.indicator_id);
          if (!prev || o.ingested_at > prev.ingested_at) live.set(o.indicator_id, o);
        }
        const hist = new Map<string, ObservationRow>();
        for (const o of observations) {
          if (!isHist(o)) continue;
          const prev = hist.get(o.indicator_id);
          if (!prev || o.observed_at > prev.observed_at) hist.set(o.indicator_id, o);
        }
        const ids = new Set<string>([...live.keys(), ...hist.keys()]);
        const out: ObservationRow[] = [];
        for (const id of ids) {
          const l = live.get(id);
          const h = hist.get(id);
          const winner = !l ? h! : !h ? l : h.observed_at > l.observed_at ? h : l;
          out.push(winner);
        }
        return {
          results: out.map((o) => ({
            indicator_id: o.indicator_id, source_id: o.source_id,
            observed_at: o.observed_at, value: o.value, ingested_at: o.ingested_at,
          })) as unknown as T[],
        };
      }
      // Latest-per-pillar (MAX(observed_at) GROUP BY pillar_id).
      if (sql.includes("FROM pillar_scores") && sql.includes("MAX(observed_at) AS ts") && sql.includes("GROUP BY pillar_id") && !sql.includes("substr")) {
        const byPillar = new Map<PillarId, PillarRow>();
        for (const r of pillarRows) {
          const prev = byPillar.get(r.pillar_id);
          if (!prev || r.observed_at > prev.observed_at) byPillar.set(r.pillar_id, r);
        }
        return {
          results: [...byPillar.values()].map((r) => ({
            id: r.pillar_id, observed_at: r.observed_at, value: r.value, band: r.band,
          })) as unknown as T[],
        };
      }
      // Pillar history — downsample to one row per pillar per UTC day in window.
      if (sql.includes("FROM pillar_scores")) {
        const cutoff = Date.now() - 30 * 86_400_000;
        const windowed = pillarRows.filter((r) => new Date(r.observed_at).getTime() >= cutoff);
        const byKey = new Map<string, PillarRow>();
        for (const r of windowed) {
          const key = `${r.pillar_id}|${utcDay(r.observed_at)}`;
          const prev = byKey.get(key);
          if (!prev || r.observed_at > prev.observed_at) byKey.set(key, r);
        }
        const out = [...byKey.values()]
          .sort((a, b) =>
            a.pillar_id < b.pillar_id ? -1
            : a.pillar_id > b.pillar_id ? 1
            : a.observed_at < b.observed_at ? -1 : 1,
          )
          .map((r) => ({ id: r.pillar_id, observed_at: r.observed_at, value: r.value }));
        return { results: out as unknown as T[] };
      }
      // headline history + ingestion_audit rollups — empty.
      return { results: [] as T[] };
    },
    async first<T>(): Promise<T | null> {
      return null;
    },
    bind() { return this; },
  });

  return { prepare: (sql: string) => make(sql) } as unknown as D1Database;
}

function seedHeavyPillarRows(): PillarRow[] {
  const rows: PillarRow[] = [];
  const todayMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  for (let d = 29; d >= 0; d--) {
    for (let h = 0; h < 24; h += 2) {
      const ts = new Date(todayMs - d * 86_400_000 + h * 3_600_000).toISOString();
      for (const p of PILLAR_ORDER) {
        rows.push({ pillar_id: p, observed_at: ts, value: 50 + (d % 7), band: "heightened" });
      }
    }
  }
  return rows;
}

describe("buildSnapshotFromD1 (package)", () => {
  it("populates pillar labels and caps sparkline30d at one point per UTC day", async () => {
    const snap = await buildSnapshotFromD1(makeDb({ pillarRows: seedHeavyPillarRows() }));
    expect(snap.pillars.market.label).toBe("Market");
    expect(snap.pillars.delivery.label).toBe("Delivery");
    for (const p of PILLAR_ORDER) {
      const spark = snap.pillars[p].sparkline30d;
      expect(spark.length, `${p} sparkline30d`).toBeGreaterThan(0);
      expect(spark.length, `${p} sparkline30d`).toBeLessThanOrEqual(30);
    }
  });

  it("selects the most-recently-ingested live row (OBR EFO supersede), not the later observed_at", async () => {
    const stale: ObservationRow = {
      indicator_id: "cb_headroom", source_id: "obr_efo",
      observed_at: "2026-03-26T00:00:00Z", value: 9.9,
      ingested_at: "2026-04-15T02:00:00.000Z", payload_hash: "abc-stale",
    };
    const current: ObservationRow = {
      indicator_id: "cb_headroom", source_id: "obr_efo",
      observed_at: "2026-03-03T00:00:00Z", value: 23.6,
      ingested_at: "2026-04-25T02:00:00.000Z", payload_hash: "def-current",
    };
    const snap = await buildSnapshotFromD1(makeDb({ observations: [stale, current] }));
    const cb = snap.pillars.fiscal.contributions.find((c) => c.indicatorId === "cb_headroom");
    expect(cb?.rawValue).toBe(23.6);
    expect(cb?.observedAt).toBe("2026-03-03T00:00:00Z");
  });

  it("surfaces a fresher hist:* row over a stale-dated live fixture write (Fix C/D)", async () => {
    const liveStale: ObservationRow = {
      indicator_id: "brent_gbp", source_id: "eia_brent",
      observed_at: "2026-04-17T00:00:00Z", value: 72.68,
      ingested_at: "2026-04-29T09:30:53.000Z", payload_hash: "abc-fixture-fallback",
    };
    const histFresh: ObservationRow = {
      indicator_id: "brent_gbp", source_id: "eia_brent",
      observed_at: "2026-04-20T00:00:00Z", value: 76.46,
      ingested_at: "2026-04-27T18:02:55.000Z", payload_hash: "hist:brent_gbp:2026-04-20",
    };
    const snap = await buildSnapshotFromD1(makeDb({ observations: [liveStale, histFresh] }));
    const brent = snap.pillars.market.contributions.find((c) => c.indicatorId === "brent_gbp");
    expect(brent?.rawValue).toBe(76.46);
  });
});
