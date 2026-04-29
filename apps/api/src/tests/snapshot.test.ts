import { describe, expect, it } from "vitest";
import { PILLAR_ORDER, type PillarId } from "@tightrope/shared";
import { buildSnapshotFromD1 } from "../lib/db.js";

/**
 * Minimal D1 stub. Routes each SQL string to a canned result set so
 * buildSnapshotFromD1 can run end-to-end against in-memory data. The goal is
 * to exercise the *shape* of the returned snapshot — length of sparklines,
 * presence of labels — not the SQL itself (SQL is assumed correct when the
 * live query returns expected rows).
 *
 * To stay honest the stub must still honour the downsampling JOINs: we
 * emulate `MAX(observed_at) GROUP BY day` by running the same aggregation in
 * JS so the test shape-checks the real SQL after rewrite.
 */
interface PillarRow {
  pillar_id: PillarId;
  observed_at: string;
  value: number;
  band: string;
}

interface HeadlineRow {
  observed_at: string;
  value: number;
  band: string;
  dominant: string;
  editorial: string;
}

function utcDay(ts: string): string { return ts.slice(0, 10); }

function makeEnv(opts: {
  pillarRows: readonly PillarRow[];
  headlineRows: readonly HeadlineRow[];
}): Env {
  const { pillarRows, headlineRows } = opts;

  interface Stmt {
    all: <T = unknown>() => Promise<{ results: T[] }>;
    first: <T = unknown>() => Promise<T | null>;
    bind: (...args: unknown[]) => Stmt;
  }

  const make = (sql: string): Stmt => ({
    async all<T>(): Promise<{ results: T[] }> {
      // Latest headline row.
      if (sql.includes("FROM headline_scores") && sql.includes("LIMIT 1")) {
        return { results: [] as T[] };
      }
      // Headline 90-day sparkline — assume SQL already downsamples; return
      // latest per UTC day within the last 90 days. ASC by day.
      if (sql.includes("FROM headline_scores")) {
        const byDay = new Map<string, HeadlineRow>();
        for (const r of headlineRows) {
          const d = utcDay(r.observed_at);
          const prev = byDay.get(d);
          if (!prev || r.observed_at > prev.observed_at) byDay.set(d, r);
        }
        const rows = [...byDay.keys()].sort().map((d) => {
          const row = byDay.get(d)!;
          return { observed_at: row.observed_at, value: row.value };
        });
        return { results: rows as unknown as T[] };
      }
      // Latest-per-pillar (MAX(observed_at) GROUP BY pillar_id).
      if (sql.includes("FROM pillar_scores") && sql.includes("MAX(observed_at) AS ts") && sql.includes("GROUP BY pillar_id") && !sql.includes("substr")) {
        const byPillar = new Map<PillarId, PillarRow>();
        for (const r of pillarRows) {
          const prev = byPillar.get(r.pillar_id);
          if (!prev || r.observed_at > prev.observed_at) byPillar.set(r.pillar_id, r);
        }
        const out = [...byPillar.values()].map((r) => ({
          id: r.pillar_id, observed_at: r.observed_at, value: r.value, band: r.band,
        }));
        return { results: out as unknown as T[] };
      }
      // Pillar history — the under-test query. Emulate the SQL's `-30 days`
      // window honestly (so we also catch a missing WHERE clause) and, if the
      // SQL downsamples (JOIN + GROUP BY substr day), emulate the aggregation.
      if (sql.includes("FROM pillar_scores")) {
        const cutoff = Date.now() - 30 * 86_400_000;
        const windowed = pillarRows.filter((r) => new Date(r.observed_at).getTime() >= cutoff);
        if (sql.includes("GROUP BY pillar_id, substr(observed_at, 1, 10)")) {
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
        // Fallback: no downsampling — return everything in window (the bug path).
        const out = [...windowed]
          .sort((a, b) =>
            a.pillar_id < b.pillar_id ? -1
            : a.pillar_id > b.pillar_id ? 1
            : a.observed_at < b.observed_at ? -1 : 1,
          )
          .map((r) => ({ id: r.pillar_id, observed_at: r.observed_at, value: r.value }));
        return { results: out as unknown as T[] };
      }
      // Ingestion audit rollups — empty.
      return { results: [] as T[] };
    },
    async first<T>(): Promise<T | null> {
      if (sql.includes("FROM headline_scores")) {
        const sorted = [...headlineRows].sort((a, b) => (a.observed_at < b.observed_at ? 1 : -1));
        const latest = sorted[0];
        return (latest ? { ...latest } : null) as unknown as T | null;
      }
      return null;
    },
    bind() { return this; },
  });

  return {
    DB: { prepare: (sql: string) => make(sql) } as unknown as D1Database,
  } as unknown as Env;
}

function seedHeavyPillarRows(): PillarRow[] {
  // Cover the entire 30-day window ending now, with a row every 2 hours per
  // pillar (~360 rows/pillar in window). A downsampling SQL collapses these
  // to ≤30 rows; the broken SQL returns them all.
  const rows: PillarRow[] = [];
  const todayMs = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );
  for (let d = 29; d >= 0; d--) {
    for (let h = 0; h < 24; h += 2) {
      const ts = new Date(todayMs - d * 86_400_000 + h * 3_600_000).toISOString();
      for (const p of PILLAR_ORDER) {
        rows.push({
          pillar_id: p,
          observed_at: ts,
          value: 50 + (d % 7) + (p === "market" ? 3 : p === "fiscal" ? 1 : p === "labour" ? -1 : -3),
          band: "heightened",
        });
      }
    }
  }
  return rows;
}

describe("buildSnapshotFromD1", () => {
  it("caps pillars[].sparkline30d at one point per UTC day (≤ 30 values)", async () => {
    const env = makeEnv({ pillarRows: seedHeavyPillarRows(), headlineRows: [] });
    const snap = await buildSnapshotFromD1(env);

    for (const p of PILLAR_ORDER) {
      const spark = snap.pillars[p].sparkline30d;
      expect(spark.length, `${p} sparkline30d length`).toBeLessThanOrEqual(30);
      expect(spark.length, `${p} sparkline30d length`).toBeGreaterThan(0);
    }
  });

  it("populates pillars[].label from the pillar catalogue shortTitle", async () => {
    const env = makeEnv({ pillarRows: seedHeavyPillarRows(), headlineRows: [] });
    const snap = await buildSnapshotFromD1(env);

    expect(snap.pillars.market.label).toBe("Market");
    expect(snap.pillars.fiscal.label).toBe("Fiscal");
    expect(snap.pillars.labour.label).toBe("Labour");
    expect(snap.pillars.delivery.label).toBe("Delivery");
  });

  it("anchors pillar 7d delta on calendar days, not array index, when the daily downsample has gaps", async () => {
    // Build a downsampled history with three missing days (D-3, D-4, D-5)
    // for the market pillar — the kind of hole produced when pillar quorum
    // failed for a stretch. Latest is D, baseline-7-days-ago is D-7.
    // With positional indexing (`series.at(-7)`), the gaps shift the
    // baseline back to D-9 or D-10 — silently labelling the 9–10d delta
    // as "7d" on the homepage.
    const todayMs = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
    );
    const isoFor = (offsetDays: number) =>
      new Date(todayMs - offsetDays * 86_400_000).toISOString();

    // Market: D-7 = 50.0, D = 60.0 → calendar 7d delta = +10.
    // Fill in non-gap days so the baseline-shift assertion is meaningful.
    const market: PillarRow[] = [];
    for (let d = 14; d >= 0; d--) {
      if (d === 3 || d === 4 || d === 5) continue;
      const value = d === 7 ? 50.0 : d === 0 ? 60.0 : 50.0 + (14 - d) * 0.5;
      market.push({ pillar_id: "market", observed_at: isoFor(d), value, band: "strained" });
    }

    // Other pillars: dense daily coverage, latest matches D-7 so delta is 0
    // — keeps the assertion focused on the gap-affected pillar.
    const others: PillarRow[] = [];
    for (const p of PILLAR_ORDER) {
      if (p === "market") continue;
      for (let d = 14; d >= 0; d--) {
        others.push({ pillar_id: p, observed_at: isoFor(d), value: 50.0, band: "strained" });
      }
    }

    const env = makeEnv({ pillarRows: [...market, ...others], headlineRows: [] });
    const snap = await buildSnapshotFromD1(env);

    // Calendar-anchored 7d: 60 - 50 = +10. Positional `series.at(-7)` over
    // the 12-row gappy series would land on D-9 (= 50 + 5*0.5 = 52.5),
    // giving a 7.5 delta instead. Assert the calendar value.
    expect(snap.pillars.market.delta7d).toBe(10);
  });

  it("keeps D1 fallback trend/editorial flat at the exact 0.5 public delta boundary", async () => {
    const todayMs = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
    );
    const isoFor = (offsetDays: number) =>
      new Date(todayMs - offsetDays * 86_400_000).toISOString();

    const rows: PillarRow[] = [
      { pillar_id: "market", observed_at: isoFor(7), value: 50.0, band: "strained" },
      { pillar_id: "market", observed_at: isoFor(0), value: 50.5, band: "strained" },
    ];
    for (const p of PILLAR_ORDER) {
      if (p === "market") continue;
      rows.push(
        { pillar_id: p, observed_at: isoFor(7), value: 90.0, band: "slack" },
        { pillar_id: p, observed_at: isoFor(0), value: 90.0, band: "slack" },
      );
    }

    const env = makeEnv({ pillarRows: rows, headlineRows: [] });
    const snap = await buildSnapshotFromD1(env);

    expect(snap.pillars.market.delta7d).toBe(0.5);
    expect(snap.pillars.market.trend7d).toBe("flat");
    expect(snap.headline.editorial).toContain("Market Stability is the biggest drag");
    expect(snap.headline.editorial).toContain("broadly flat on the week");
    expect(snap.headline.editorial).not.toContain("up 0.5 on the week");
  });
});
