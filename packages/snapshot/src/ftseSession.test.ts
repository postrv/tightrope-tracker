import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { DatabaseSync } = createRequire(import.meta.url)("node:" + "sqlite") as typeof import("node:sqlite");
import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { readLatestObservations } from "./observations.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../data-sources/src/fixtures");

interface FtseLive {
  observed_at: string;
  ftse_250: { value: number };
}

interface FtseHistory {
  points: Array<{ observed_at: string; value: number }>;
}

/** Run the selector SQL that `readLatestObservations` actually prepares. */
async function selectorSql(): Promise<string> {
  let sql = "";
  const db = {
    prepare(statement: string) {
      sql = statement;
      return { all: async () => ({ results: [] }) };
    },
  } as unknown as D1Database;
  await readLatestObservations(db);
  expect(sql).toMatch(/ORDER BY\s+observed_at\s+DESC/i);
  return sql;
}

describe("FTSE same-session live row beats the hist backfill", () => {
  it("keeps the live head when history shares that London close", async () => {
    const live = JSON.parse(readFileSync(join(FIXTURES, "ftse-250.json"), "utf8")) as FtseLive;
    const history = JSON.parse(readFileSync(join(FIXTURES, "ftse-250-history.json"), "utf8")) as FtseHistory;
    const liveDay = live.observed_at.slice(0, 10);
    const hist = history.points.find((point) => point.observed_at.slice(0, 10) === liveDay);
    expect(hist, `history has no point on ${liveDay}`).toBeDefined();
    expect(hist!.observed_at).toBe(live.observed_at);
    expect(hist!.value).not.toBe(live.ftse_250.value);

    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE indicator_observations (
        indicator_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        value REAL NOT NULL,
        ingested_at TEXT NOT NULL,
        released_at TEXT,
        payload_hash TEXT
      )
    `);
    const insert = sqlite.prepare(`
      INSERT INTO indicator_observations
        (indicator_id, source_id, observed_at, value, ingested_at, released_at, payload_hash)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
    `);
    // Hist is written later. The selector must still prefer the live row
    // when both stamps are the same London close.
    insert.run("ftse_250", "lseg", live.observed_at, live.ftse_250.value, "2026-10-13T16:00:00Z", "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899");
    insert.run("ftse_250", "lseg", hist!.observed_at, hist!.value, "2026-10-13T18:00:00Z", `hist:ftse_250:${hist!.observed_at}`);

    const selected = sqlite.prepare(await selectorSql()).all() as Array<{
      indicator_id: string;
      value: number;
      observed_at: string;
    }>;
    const winner = selected.find((row) => row.indicator_id === "ftse_250");
    expect(winner?.observed_at).toBe(live.observed_at);
    expect(winner?.value).toBe(live.ftse_250.value);
    sqlite.close();
  });
});
