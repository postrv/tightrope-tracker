import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { readScoreHistory, resolveHistoryResolution } from "./history.js";
import { readLatestObservations } from "./observations.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:" + "sqlite") as typeof import("node:sqlite");
const opened: InstanceType<typeof DatabaseSync>[] = [];
function database() {
  const sqlite = new DatabaseSync(":memory:"); opened.push(sqlite);
  sqlite.exec(`CREATE TABLE headline_scores (observed_at TEXT PRIMARY KEY, value REAL);
    CREATE TABLE pillar_scores (pillar_id TEXT, observed_at TEXT, value REAL, PRIMARY KEY(pillar_id, observed_at));
    CREATE TABLE indicator_observations (indicator_id TEXT, source_id TEXT, observed_at TEXT, value REAL, ingested_at TEXT, released_at TEXT, payload_hash TEXT);`);
  const db = { prepare(sql: string) {
    const statement = (params: unknown[] = []) => ({
      bind: (...args: unknown[]) => statement(args),
      all: async () => ({ results: sqlite.prepare(sql).all(Object.fromEntries(params.map((value, i) => [`?${i + 1}`, value])) as Record<string, string | number>) }),
    });
    return statement();
  } } as unknown as D1Database;
  return { sqlite, db };
}
afterEach(() => { opened.splice(0).forEach(db => db.close()); vi.useRealTimers(); });

describe("recorded history on SQLite", () => {
  it("keeps a Monday-to-Sunday UTC week together across New Year", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2025-01-06T17:00:00Z"));
    const { sqlite, db } = database();
    sqlite.exec(`INSERT INTO headline_scores VALUES ('2024-12-31T12:00:00Z',40),('2025-01-01T12:00:00Z',41),('2025-01-05T12:00:00Z',42),('2025-01-06T12:00:00Z',43);
      INSERT INTO pillar_scores VALUES ('market','2024-12-01T00:00:00Z',30),('fiscal','2024-12-01T00:00:00Z',50),('labour','2024-12-01T00:00:00Z',60),('delivery','2024-12-01T00:00:00Z',40);`);
    const result = await readScoreHistory(db, 30, "weekly");
    expect(result.points.map(p => p.timestamp)).toEqual(["2025-01-05T12:00:00Z", "2025-01-06T12:00:00Z"]);
  });
  it("preserves intraday changes and aligns pillars as-of, including values from before the window", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-28T17:00:00Z"));
    const { sqlite, db } = database();
    sqlite.exec(`INSERT INTO headline_scores VALUES ('2026-10-28T12:00:00Z',40), ('2026-10-28T12:05:00Z',41), ('2026-10-28T16:35:00Z',42);
      INSERT INTO pillar_scores VALUES ('market','2026-10-28T11:00:00Z',30), ('market','2026-10-28T12:03:00Z',35), ('market','2026-10-28T16:30:00Z',38),
      ('fiscal','2026-10-20T00:00:00Z',50),('labour','2026-10-20T00:00:00Z',60),('delivery','2026-10-20T00:00:00Z',40);`);
    const raw = await readScoreHistory(db, 1);
    expect(raw.resolution).toBe("raw");
    expect(raw.points.map(p => p.pillars.market)).toEqual([30,35,38]);
    expect(raw.points[0]!.pillars.fiscal).toBe(50);
    const hourly = await readScoreHistory(db, 1, "hourly");
    expect(hourly.points.map(p => p.timestamp)).toEqual(["2026-10-28T12:05:00Z", "2026-10-28T16:35:00Z"]);
    expect(hourly.points[0]!.pillars.market).toBe(35);
    expect((await readScoreHistory(db, 1, "daily")).points.map(p => p.headline)).toEqual([42]);
    const allDaily = await readScoreHistory(db, 7305, "daily");
    expect(allDaily.resolution).toBe("daily");
    expect(allDaily.points).toHaveLength(1);
  });

  it("reports actual global coverage; excludes future, invalid and incomplete readings instead of fabricating zeros", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-28T17:00:00Z"));
    const { sqlite, db } = database();
    sqlite.exec(`INSERT INTO headline_scores VALUES ('2024-07-05T00:00:00Z',40), ('2026-10-28T12:00:00Z',42), ('2026-10-28T13:00:00Z',140), ('2026-10-29T00:00:00Z',43);
      INSERT INTO pillar_scores VALUES ('market','2026-10-28T11:00:00Z',30),('fiscal','2026-10-28T11:00:00Z',50),('labour','2026-10-28T11:00:00Z',60);`);
    const history = await readScoreHistory(db, 1);
    expect(history.points).toEqual([]);
    expect(history.excludedPoints).toBe(2);
    expect(history.availableFrom).toBe("2024-07-05T00:00:00Z");
    expect(history.availableTo).toBe("2026-10-28T13:00:00Z");
    expect(history.selectedFrom).toBeNull();
  });

  it("bounds high-resolution long windows and never silently clips to the old800-day ceiling", async () => {
    expect(resolveHistoryResolution(1, "auto")).toBe("raw");
    expect(resolveHistoryResolution(7, "auto")).toBe("hourly");
    expect(resolveHistoryResolution(365, "raw")).toBe("daily");
    expect(resolveHistoryResolution(7305, "daily")).toBe("weekly");
    const { db } = database();
    expect((await readScoreHistory(db, 9999)).rangeDays).toBe(7305);
  });

  it("discloses an invalid last bucket recording without silently substituting an earlier valid score", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-28T17:00:00Z"));
    const { sqlite, db } = database();
    sqlite.exec(`INSERT INTO headline_scores VALUES ('2026-10-28T12:00:00Z',50), ('2026-10-28T13:00:00Z',140);
      INSERT INTO pillar_scores VALUES ('market','2026-10-28T11:00:00Z',50),('fiscal','2026-10-28T11:00:00Z',50),('labour','2026-10-28T11:00:00Z',50),('delivery','2026-10-28T11:00:00Z',50);`);
    const raw = await readScoreHistory(db, 1, "raw");
    expect(raw.points.map(point => point.headline)).toEqual([50]);
    expect(raw.excludedPoints).toBe(1);
    const daily = await readScoreHistory(db, 1, "daily");
    expect(daily.points).toEqual([]);
    expect(daily.excludedPoints).toBe(1);
    expect(daily.sampling).toBe("last_recorded_in_bucket");
  });
});

describe("publication-cutoff reconstruction of latest stored vintages", () => {
  it("rejects later publication and seed rows but permits retrospectively ingested pre-event references", async () => {
    const { sqlite, db } = database();
    sqlite.exec(`INSERT INTO indicator_observations VALUES
      ('cb_headroom','obr_efo','2026-03-03T00:00:00Z',23.6,'2026-03-03 14:00:00','2026-03-03T13:00:00Z','old'),
      ('cb_headroom','obr_efo','2026-10-28T00:00:00Z',14.5,'2026-10-28 14:00:00','2026-10-28T13:29:19Z','new'),
      ('gilt_10y','boe_yields','2026-10-27T00:00:00Z',4.3,'2026-10-28 15:00:00',NULL,'hist:late'),
      ('ftse_250','lseg','2026-10-27T16:30:00Z',24000,'2026-10-27 17:00:00',NULL,'live'),
      ('ftse_250','lseg','2026-10-28T16:30:00Z',23900,'2026-10-28 17:00:00',NULL,'live2'),
      ('seed_only','x','2026-10-01T00:00:00Z',2,'2026-10-01 00:00:00',NULL,'seed:x');`);
    const before = await readLatestObservations(db,"2026-10-28T12:30:00Z");
    expect(before.map(r => [r.indicator_id,r.value])).toEqual([["cb_headroom",23.6],["ftse_250",24000],["gilt_10y",4.3]]);
    expect((await readLatestObservations(db)).find(r=>r.indicator_id==="cb_headroom")!.value).toBe(14.5);
  });
});
