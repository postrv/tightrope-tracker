import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { DatabaseSync } = createRequire(import.meta.url)("node:" + "sqlite") as typeof import("node:sqlite");
import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { writeHistoricalObservations } from "../../../apps/ingest/src/lib/observations.js";
import { readLatestObservations } from "./observations.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../data-sources/src/fixtures");

interface FtseLive {
  observed_at: string;
  ftse_250: { value: number };
}

interface FtseHistory {
  points: Array<{ observed_at: string; value: number }>;
}

interface BoundStatement {
  sql: string;
  params: unknown[];
}

/**
 * D1 surface the shipped writer and selector actually call, backed by
 * node:sqlite so PRIMARY KEY conflicts are real.
 */
function asD1(sqlite: InstanceType<typeof DatabaseSync>): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const bound: BoundStatement = { sql, params };
          return bound;
        },
        async all() {
          return { results: sqlite.prepare(sql).all() };
        },
      };
    },
    async batch(statements: BoundStatement[]) {
      return statements.map((statement) => {
        const info = sqlite.prepare(statement.sql).run(...(statement.params as []));
        return { success: true, meta: { changes: Number(info.changes) } };
      });
    },
  } as unknown as D1Database;
}

function openObservations(): { sqlite: InstanceType<typeof DatabaseSync>; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE indicator_observations (
      indicator_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      value REAL NOT NULL,
      source_id TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      payload_hash TEXT,
      released_at TEXT,
      PRIMARY KEY (indicator_id, observed_at)
    )
  `);
  return { sqlite, db: asD1(sqlite) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("FTSE same-session live row survives a hist backfill", () => {
  it("keeps the live 24339.2 head when overwrite backfill hits that primary key", async () => {
    const live = JSON.parse(readFileSync(join(FIXTURES, "ftse-250.json"), "utf8")) as FtseLive;
    const history = JSON.parse(readFileSync(join(FIXTURES, "ftse-250-history.json"), "utf8")) as FtseHistory;
    const liveDay = live.observed_at.slice(0, 10);
    const hist = history.points.find((point) => point.observed_at.slice(0, 10) === liveDay);
    expect(hist, `history has no point on ${liveDay}`).toBeDefined();
    expect(hist!.observed_at).toBe(live.observed_at);
    expect(live.ftse_250.value).toBe(24339.2);
    expect(hist!.value).not.toBe(live.ftse_250.value);

    const { sqlite, db } = openObservations();
    const liveHash = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    sqlite.prepare(`
      INSERT INTO indicator_observations
        (indicator_id, source_id, observed_at, value, ingested_at, released_at, payload_hash)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
    `).run("ftse_250", "lseg", live.observed_at, live.ftse_250.value, "2026-10-13T16:00:00Z", liveHash);

    // The session date is today-UTC on the fixture's calendar day, and the
    // writer refuses today. Move the clock to the next UTC day so the
    // shipped overwrite path actually issues the insert.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T12:00:00.000Z"));

    const result = await writeHistoricalObservations(db, [{
      indicatorId: "ftse_250",
      value: hist!.value,
      observedAt: hist!.observed_at,
      sourceId: "lseg",
      payloadHash: `hist:ftse_250:${hist!.observed_at}`,
    }], { dryRun: false, overwrite: true });

    expect(result.rejected).toEqual([]);
    expect(result.written).toBe(0);

    const stored = sqlite.prepare(
      `SELECT value, payload_hash FROM indicator_observations WHERE indicator_id = 'ftse_250'`,
    ).get() as { value: number; payload_hash: string };
    expect(stored.value).toBe(24339.2);
    expect(stored.payload_hash).toBe(liveHash);

    const selected = await readLatestObservations(db);
    const winner = selected.find((row) => row.indicator_id === "ftse_250");
    expect(winner?.observed_at).toBe(live.observed_at);
    expect(winner?.value).toBe(24339.2);
    sqlite.close();
  });

  it("still replaces an older hist row when overwrite is true", async () => {
    const { sqlite, db } = openObservations();
    sqlite.prepare(`
      INSERT INTO indicator_observations
        (indicator_id, source_id, observed_at, value, ingested_at, released_at, payload_hash)
      VALUES ('ftse_250', 'lseg', '2026-09-01T15:30:00Z', 24000, '2026-09-01T16:00:00Z', NULL, 'hist:ftse_250:old')
    `).run();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T12:00:00.000Z"));

    const result = await writeHistoricalObservations(db, [{
      indicatorId: "ftse_250",
      value: 24111,
      observedAt: "2026-09-01T15:30:00Z",
      sourceId: "lseg",
      payloadHash: "hist:ftse_250:revised",
    }], { dryRun: false, overwrite: true });

    expect(result.rejected).toEqual([]);
    expect(result.written).toBe(1);
    const stored = sqlite.prepare(
      `SELECT value, payload_hash FROM indicator_observations WHERE indicator_id = 'ftse_250'`,
    ).get() as { value: number; payload_hash: string };
    expect(stored.value).toBe(24111);
    expect(stored.payload_hash).toBe("hist:ftse_250:revised");
    sqlite.close();
  });
});
