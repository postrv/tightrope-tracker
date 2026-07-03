import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import type { TimelineEventCandidate } from "@tightrope/data-sources";
import { stageTimelineCandidates } from "../lib/timelineCaptures.js";

/**
 * Stub D1 modelling the curator_captures dedupe path (migration 0011):
 *   - existence SELECT keyed on (source_id, content_sha256)
 *   - INSERT, which advances the simulated table state so the next repoll
 *     of the same content dedupes.
 */
function makeDb(): {
  db: D1Database;
  inserts: Array<{ sql: string; bindings: readonly unknown[] }>;
  existingHashes: Set<string>;
} {
  const inserts: Array<{ sql: string; bindings: readonly unknown[] }> = [];
  const existingHashes = new Set<string>();

  interface Stmt {
    sql: string;
    bindings: readonly unknown[];
    bind: (...b: unknown[]) => Stmt;
    first: <T>() => Promise<T | null>;
    run: () => Promise<{ success: true }>;
  }
  const makeStmt = (sql: string, bindings: readonly unknown[] = []): Stmt => ({
    sql,
    bindings,
    bind: (...b: unknown[]) => makeStmt(sql, b),
    first: async <T>() => {
      // SELECT 1 ... WHERE source_id = ? AND content_sha256 = ?
      const contentSha256 = bindings[1] as string;
      return (existingHashes.has(contentSha256) ? { one: 1 } : null) as unknown as T | null;
    },
    run: async () => {
      inserts.push({ sql, bindings });
      // INSERT bind order: [source_id, captured_at, source_url, content_sha256, payload]
      existingHashes.add(bindings[3] as string);
      return { success: true };
    },
  });

  const db = { prepare: (sql: string) => makeStmt(sql) } as unknown as D1Database;
  return { db, inserts, existingHashes };
}

function candidate(over: Partial<TimelineEventCandidate> = {}): TimelineEventCandidate {
  return {
    id: "https://www.gov.uk/government/news/new-towns-taskforce-report",
    title: "New Towns Taskforce publishes final report",
    link: "https://www.gov.uk/government/news/new-towns-taskforce-report",
    publishedAt: "2026-06-30T09:30:00Z",
    summary: "The taskforce set out 12 sites.",
    categorySlug: "ministry-of-housing-communities-local-government",
    ...over,
  };
}

describe("stageTimelineCandidates", () => {
  it("inserts a pending timeline_event capture for a new candidate", async () => {
    const { db, inserts } = makeDb();
    const c = candidate();
    const res = await stageTimelineCandidates(db, [c]);

    expect(res).toEqual({ inserted: 1, skipped: 0 });
    expect(inserts).toHaveLength(1);
    const ins = inserts[0]!;
    expect(ins.sql).toContain("INSERT INTO curator_captures");
    expect(ins.sql).toContain("'timeline_event'");
    expect(ins.sql).toContain("'pending'");
    // bind order: [source_id, captured_at, source_url, content_sha256, payload]
    expect(ins.bindings[0]).toBe("gov_uk");
    expect(ins.bindings[2]).toBe(c.link);
    expect(JSON.parse(ins.bindings[4] as string)).toEqual(c);
  });

  it("skips a candidate whose (source_id, content_sha256) already exists (cross-run dedupe)", async () => {
    const { db, inserts } = makeDb();
    const c = candidate();

    const first = await stageTimelineCandidates(db, [c]);
    expect(first).toEqual({ inserted: 1, skipped: 0 });

    // A later delivery cron re-fetches the same announcement.
    const second = await stageTimelineCandidates(db, [c]);
    expect(second).toEqual({ inserted: 0, skipped: 1 });

    // Only the first run wrote a row.
    expect(inserts).toHaveLength(1);
  });

  it("dedupes two identical candidates within a single run", async () => {
    const { db, inserts } = makeDb();
    const c = candidate();
    const res = await stageTimelineCandidates(db, [c, { ...c }]);

    expect(res).toEqual({ inserted: 1, skipped: 1 });
    expect(inserts).toHaveLength(1);
  });

  it("stages distinct candidates independently", async () => {
    const { db, inserts } = makeDb();
    const a = candidate({ id: "a", link: "https://www.gov.uk/a" });
    const b = candidate({ id: "b", link: "https://www.gov.uk/b" });
    const res = await stageTimelineCandidates(db, [a, b]);

    expect(res).toEqual({ inserted: 2, skipped: 0 });
    expect(inserts).toHaveLength(2);
  });

  it("re-stages a materially edited announcement (different content hash)", async () => {
    const { db, inserts } = makeDb();
    const original = candidate();
    await stageTimelineCandidates(db, [original]);

    const edited = candidate({ summary: "The taskforce set out 14 sites (revised)." });
    const res = await stageTimelineCandidates(db, [edited]);

    expect(res).toEqual({ inserted: 1, skipped: 0 });
    expect(inserts).toHaveLength(2);
  });

  it("falls back to the feed URL when the candidate link is empty", async () => {
    const { db, inserts } = makeDb();
    await stageTimelineCandidates(db, [candidate({ link: "" })]);
    expect(inserts[0]!.bindings[2]).toBe("https://www.gov.uk/search/news-and-communications.atom");
  });

  it("no-ops on an empty candidate list", async () => {
    const { db, inserts } = makeDb();
    const res = await stageTimelineCandidates(db, []);
    expect(res).toEqual({ inserted: 0, skipped: 0 });
    expect(inserts).toHaveLength(0);
  });
});
