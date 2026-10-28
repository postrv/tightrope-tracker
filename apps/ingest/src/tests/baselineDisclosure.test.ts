import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const { DatabaseSync } = createRequire(import.meta.url)("node:" + "sqlite") as typeof import("node:sqlite");
const template = readFileSync(new URL("../../../../db/patches/correct-2026-10-28-baseline-coverage.sql", import.meta.url), "utf8");
const START = "2026-10-28T19:00:00.000Z", END = "2026-10-28T19:02:00.000Z";
const sources = [
  ["boe_yields",2648], ["boe_fx",2732], ["boe_breakevens",1366], ["boe_mortgage_rates",65],
  ["ons_lms",335], ["ons_psf",134], ["ons_rti",66], ["mhclg",28], ["eia_brent",1396],
] as const;
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE ingestion_audit (source_id TEXT,started_at TEXT,completed_at TEXT,status TEXT,rows_written INTEGER);
    CREATE TABLE corrections (id TEXT PRIMARY KEY,published_at TEXT,affected_indicator TEXT,original_value TEXT,corrected_value TEXT,reason TEXT);
    CREATE TABLE timeline_events (id TEXT PRIMARY KEY,event_date TEXT,title TEXT,summary TEXT,category TEXT,source_label TEXT,source_url TEXT);`);
  for(const [source,count] of sources) db.prepare("INSERT INTO ingestion_audit VALUES (?, ?, ?, 'success', ?)")
    .run(`${source}:historical`, START, "2026-10-28T19:01:00.000Z", count);
  return db;
}
const resolved = () => template.replaceAll("__BASELINE_STARTED_AT_FROM_APPLIED_JSON__", START)
  .replaceAll("__BASELINE_COMPLETED_AT_FROM_APPLIED_JSON__", END);

describe("baseline coverage public disclosure", () => {
  it("publishes nothing while the actual application timestamps remain unresolved", () => {
    const db=setup();
    try {
      expect(() => db.exec(template)).toThrow(/malformed JSON/);
      expect(db.prepare("SELECT COUNT(*) AS n FROM corrections").get()?.n).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM timeline_events").get()?.n).toBe(0);
    } finally { db.close(); }
  });
  it("requires all nine successful source audits and all 8,770 inserted rows", () => {
    const db=setup();
    try {
      db.prepare("UPDATE ingestion_audit SET rows_written=1395 WHERE source_id='eia_brent:historical'").run();
      db.exec(resolved());
      expect(db.prepare("SELECT COUNT(*) AS n FROM corrections").get()?.n).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM timeline_events").get()?.n).toBe(0);
    } finally { db.close(); }
  });
  it("publishes at completion, marks coverage changes from the start, and states the controlled replay and source vintage", () => {
    const db=setup();
    try {
      db.exec(resolved());
      const correction=db.prepare("SELECT * FROM corrections").get()!;
      expect(correction.published_at).toBe(END);
      expect(correction.reason).toContain("39.4 to 36.9");
      expect(correction.reason).toContain("current-vintage official histories");
      expect(correction.corrected_value).toContain("8,375 baseline-eligible and 395 excluded");
      expect(db.prepare("SELECT event_date,category,summary FROM timeline_events").get())
        .toMatchObject({event_date:START,category:"methodology",summary:expect.stringContaining(`completed at ${END}`)});
      db.exec(resolved());
      expect(db.prepare("SELECT COUNT(*) AS n FROM corrections").get()?.n).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM timeline_events").get()?.n).toBe(1);
    } finally { db.close(); }
  });
});
