import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { runSweep, runTimelineTriage, TIMELINE_TRIAGE_SOURCE } from "../lib/sweep";
import { CAPTURE_SPECS } from "../sources/registry";
import { makeAi, makeEnv, makeFakeDb, makeKv, type FakeCaptureRow, type FakeDb } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

function govUkCandidate(over: Partial<FakeCaptureRow> = {}): FakeCaptureRow {
  return {
    id: 1, source_id: "gov_uk", indicator_id: null, kind: "timeline_event",
    captured_at: "2026-07-07T05:00:00Z", source_url: "https://www.gov.uk/x", content_sha256: "deadbeef",
    raw_r2_key: null, observed_at: null, released_at: null, value: null,
    payload: JSON.stringify({ id: "gov-1", title: "New Towns update", link: "https://www.gov.uk/x", publishedAt: "2026-07-06", summary: "12 new towns.", categorySlug: "mhclg" }),
    quote: null, confidence: null, verification: null, status: "pending",
    decided_by: null, decided_at: null, published_observation_key: null, model_id: null, prompt_version: null,
    created_at: "2026-07-07T05:00:00Z", ...over,
  };
}

const RELEVANT_DRAFT = { relevant: true, eventDate: "2026-07-06", title: "t", summary: "s", category: "delivery", sourceLabel: "gov.uk", sourceUrl: "https://www.gov.uk/x", quote: "q" };
const triageSpec = CAPTURE_SPECS.find((s) => s.sourceId === TIMELINE_TRIAGE_SOURCE)!;

/** Wrap a fake D1 so a write whose SQL matches `needle` and whose bindings satisfy `whenBind` throws at run(). */
function withThrowingWrite(fake: FakeDb, needle: string, whenBind: (b: unknown[]) => boolean): D1Database {
  const realPrepare = fake.db.prepare.bind(fake.db);
  return {
    prepare(sql: string) {
      const real = realPrepare(sql);
      if (!sql.includes(needle)) return real;
      return {
        bind: (...b: unknown[]) => {
          const stmt = (real as unknown as { bind: (...x: unknown[]) => Record<string, unknown> }).bind(...b);
          if (whenBind(b)) return { ...stmt, run: async () => { throw new Error(`simulated D1 write failure on ${needle}`); } };
          return stmt;
        },
        first: (real as unknown as { first: unknown }).first,
        all: (real as unknown as { all: unknown }).all,
        run: (real as unknown as { run: unknown }).run,
      };
    },
  } as unknown as D1Database;
}

/** Map every opened audit row (INSERT) to its close(s) (UPDATE) by the audit id, to prove exactly-once. */
function auditLedger(db: FakeDb): { opens: Array<{ id: string; sourceId: string }>; closesById: Map<string, string[]> } {
  const opens: Array<{ id: string; sourceId: string }> = [];
  const closesById = new Map<string, string[]>();
  for (const row of db.audit) {
    const b = row.bindings as unknown[];
    if (!row.update && String(row.sql).includes("INSERT INTO ingestion_audit") && !String(row.sql).includes("cron_miss")) {
      opens.push({ id: b[0] as string, sourceId: b[1] as string });
    } else if (row.update && String(row.sql).includes("UPDATE ingestion_audit")) {
      const id = b[5] as string; // status, completed_at, rows_written, payload_hash, error, id
      const status = b[0] as string;
      closesById.set(id, [...(closesById.get(id) ?? []), status]);
    }
  }
  return { opens, closesById };
}

describe("sweep audit invariant (every opened row closed exactly once)", () => {
  it("closes every spec's audit row exactly once even when every fetch fails", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("network down"); });
    const db = makeFakeDb();
    const env = makeEnv({ db, kv: makeKv().kv, ai: makeAi({ run: () => "{}" }).AI });

    await runSweep(env, { force: true });

    const { opens, closesById } = auditLedger(db);
    expect(opens.length).toBe(CAPTURE_SPECS.length);
    // EXACTLY ONE close per opened row — no dangling 'started', no double-close.
    for (const o of opens) {
      const closes = closesById.get(o.id) ?? [];
      expect(closes, `spec ${o.sourceId} closes`).toHaveLength(1);
    }
    // The 'started'-only defect would leave an open with no matching close.
    expect([...closesById.keys()].sort()).toEqual(opens.map((o) => o.id).sort());
  });

  it("timeline_triage closes its audit row (not left 'started') when a candidate write throws", async () => {
    // Two staged candidates; the FIRST candidate's updatePayload write throws.
    // Pre-fix this crashed the whole triage job and could dangle the audit row;
    // post-fix the batch continues and the audit row closes 'success' exactly once.
    vi.stubGlobal("fetch", async () => { throw new Error("network down"); });
    const fake = makeFakeDb({ captures: [govUkCandidate({ id: 1 }), govUkCandidate({ id: 2, content_sha256: "beefdead" })] });
    const brokenDb = withThrowingWrite(fake, "UPDATE curator_captures SET payload", (b) => b[1] === 1);
    const env = makeEnv({ db: { ...fake, db: brokenDb } as unknown as FakeDb, kv: makeKv().kv, ai: makeAi({ run: () => JSON.stringify({ values: [], releasedAt: null, draft: RELEVANT_DRAFT }) }).AI });

    const summary = await runSweep(env, { force: true });
    const triage = summary.results.find((r) => r.sourceId === TIMELINE_TRIAGE_SOURCE)!;
    expect(triage.status).toBe("success");

    const { opens, closesById } = auditLedger(fake);
    const triageOpen = opens.find((o) => o.sourceId === TIMELINE_TRIAGE_SOURCE)!;
    expect(triageOpen).toBeDefined();
    const closes = closesById.get(triageOpen.id) ?? [];
    expect(closes).toEqual(["success"]); // closed exactly once, as success
  });
});

describe("runTimelineTriage per-candidate isolation (the underlying crash fix)", () => {
  it("one candidate's write failure does not abort the batch", async () => {
    const fake = makeFakeDb({ captures: [govUkCandidate({ id: 1 }), govUkCandidate({ id: 2, content_sha256: "b2" }), govUkCandidate({ id: 3, content_sha256: "b3" })] });
    // The middle candidate's updatePayload write throws.
    const brokenDb = withThrowingWrite(fake, "UPDATE curator_captures SET payload", (b) => b[1] === 2);
    const env = makeEnv({ db: { ...fake, db: brokenDb } as unknown as FakeDb, kv: makeKv().kv, ai: makeAi({ run: () => JSON.stringify({ values: [], releasedAt: null, draft: RELEVANT_DRAFT }) }).AI });

    // Must NOT throw; every candidate is attempted; the two healthy ones are enriched.
    const processed = await runTimelineTriage(env, triageSpec);
    expect(processed).toBe(3); // all three extracted (processed counts extraction success)
    expect(fake.captures.find((c) => c.id === 1)!.payload).toContain("draft");
    expect(fake.captures.find((c) => c.id === 3)!.payload).toContain("draft");
  });

  it("auto-rejects immaterial candidates and enriches material ones", async () => {
    const material = govUkCandidate({ id: 1, payload: JSON.stringify({ id: "gov-1", title: "New Towns update", link: "https://www.gov.uk/x", publishedAt: "2026-07-06", summary: "12 new towns", categorySlug: "mhclg" }) });
    const routine = govUkCandidate({ id: 2, content_sha256: "b2", payload: JSON.stringify({ id: "gov-2", title: "Weekly bulletin", link: "https://www.gov.uk/y", publishedAt: "2026-07-06", summary: "routine notice", categorySlug: "misc" }) });
    const fake = makeFakeDb({ captures: [material, routine] });
    const env = makeEnv({ db: fake, kv: makeKv().kv, ai: makeAi({
      run: (_m, inputs) => {
        const draft = inputs.messages.some((m) => m.content.includes("routine notice")) ? { relevant: false } : RELEVANT_DRAFT;
        return JSON.stringify({ values: [], releasedAt: null, draft });
      },
    }).AI });
    const processed = await runTimelineTriage(env, triageSpec);
    expect(processed).toBe(2);
    expect(fake.captures.find((c) => c.id === 2)!.status).toBe("rejected");
    expect(fake.captures.find((c) => c.id === 1)!.payload).toContain("draft");
  });
});
