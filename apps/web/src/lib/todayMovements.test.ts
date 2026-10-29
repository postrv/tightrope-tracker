import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { INDICATORS } from "@tightrope/shared";
import { getTodayMovements } from "./db.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:" + "sqlite") as typeof import("node:sqlite");

describe("getTodayMovements registered market boundary", () => {
  it("filters retired and non-market rows before ranking, retains quiet market readings, and preserves the archive", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(`CREATE TABLE today_movements (
        indicator_id TEXT PRIMARY KEY, label TEXT, latest_value REAL, display_value TEXT,
        change REAL, change_pct REAL, change_display TEXT, direction TEXT,
        worsening INTEGER, sparkline TEXT, gloss TEXT, observed_at TEXT
      )`);
      const insert = sqlite.prepare("INSERT INTO today_movements VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const marketIds = Object.values(INDICATORS).filter(i => i.pillar === "market").map(i => i.id);
      for (const [index, id] of marketIds.entries()) {
        insert.run(id, id, 4.2, "4.2", 0.01, index, "+1bp", "up", 1, "[4.1,4.2]", "Previous reading", "2026-10-28T16:30:00Z");
      }
      // These persisted records ranked first in the live UI before the fix.
      for (const id of ["breakeven_10y", "real_yield_10y", "cb_headroom", "unregistered_legacy"]) {
        insert.run(id, id, 99, "99", 99, 99999, "+99999%", "up", 1, "[1,99]", "Archived", "2026-04-21T00:00:00Z");
      }
      const before = sqlite.prepare("SELECT * FROM today_movements ORDER BY indicator_id").all();
      const env = {
        DB: { prepare: (sql: string) => {
          let params: unknown[] = [];
          const statement = {
            bind: (...values: unknown[]) => { params = values; return statement; },
            all: async () => ({ results: sqlite.prepare(sql).all(...params as []) }),
          };
          return statement;
        } },
      } as unknown as Parameters<typeof getTodayMovements>[0];

      const movements = await getTodayMovements(env);
      expect(movements.map(m => m.indicatorId)).toEqual([...marketIds].reverse());
      expect(movements).toHaveLength(marketIds.length);
      expect(movements.slice(0, 8).every(m => INDICATORS[m.indicatorId]?.pillar === "market")).toBe(true);
      expect(movements.find(m => m.indicatorId === "gilt_10y")?.sourceId).toBe(INDICATORS.gilt_10y!.sourceId);
      expect(movements.find(m => m.indicatorId === "gilt_10y")?.unit).toBe(INDICATORS.gilt_10y!.unit);
      expect(sqlite.prepare("SELECT * FROM today_movements ORDER BY indicator_id").all()).toEqual(before);
    } finally {
      sqlite.close();
    }
  });
});
