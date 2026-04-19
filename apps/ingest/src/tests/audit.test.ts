import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import {
  closeAuditFailure,
  closeAuditSuccess,
  openAudit,
  type AuditHandle,
} from "../lib/audit.js";

/**
 * Detects whether `closeAuditSuccess` recognises a byte-identical re-fetch
 * (same payload_hash as the last successful run for this source) and marks
 * the row `status='unchanged'` instead of `status='success'`.
 *
 * Motivation: ONS PSF publishes monthly but the live adapter runs every
 * five minutes. Between publications the adapter hits the live URL,
 * receives the same JSON body, and — pre-fix — writes a `success` audit
 * row advancing `started_at`. The /methodology "Last successful ingestion
 * per source" table then shows "5 minutes ago" for a source that has not
 * actually delivered new data in weeks, which is the credibility kill the
 * guard exists to prevent. `unchanged` preserves the honest signal
 * without raising a false alarm.
 */

interface StubRow {
  payload_hash: string | null;
  status: string;
  completed_at: string;
}

type Binding = readonly unknown[];

/**
 * Minimal D1 stub that remembers inserted audit rows so we can verify
 * closeAuditSuccess queries the last-success payload_hash for the source.
 */
function makeDb(priorRows: Record<string, StubRow[]> = {}): {
  db: D1Database;
  writes: Array<{ sql: string; bindings: Binding }>;
} {
  const writes: Array<{ sql: string; bindings: Binding }> = [];
  interface Stmt {
    sql: string;
    bindings: Binding;
    bind: (...b: unknown[]) => Stmt;
    first: <T>() => Promise<T | null>;
    run: () => Promise<{ success: true }>;
  }
  const makeStmt = (sql: string, bindings: Binding = []): Stmt => ({
    sql,
    bindings,
    bind: (...b: unknown[]) => makeStmt(sql, b),
    first: async <T>() => {
      // Simulate a lookup like:
      //   SELECT payload_hash FROM ingestion_audit
      //     WHERE source_id = ? AND status = 'success' AND payload_hash IS NOT NULL
      //     ORDER BY completed_at DESC LIMIT 1
      if (/SELECT\s+payload_hash\s+FROM\s+ingestion_audit/i.test(sql)) {
        const sourceId = bindings[0] as string;
        const rows = priorRows[sourceId] ?? [];
        const row = rows[0] ?? null;
        return row ? (row as unknown as T) : null;
      }
      return null as T;
    },
    run: async () => {
      if (/INSERT|UPDATE/i.test(sql)) writes.push({ sql, bindings });
      return { success: true };
    },
  });
  return {
    db: { prepare: (sql: string) => makeStmt(sql) } as unknown as D1Database,
    writes,
  };
}

function withHandle(sourceId: string): AuditHandle {
  return {
    id: "audit-id-1",
    sourceId,
    sourceUrl: `adapter:${sourceId}`,
    startedAt: new Date().toISOString(),
  };
}

describe("closeAuditSuccess — stale-but-200 detection", () => {
  it("marks status='success' when no prior hash exists for this source", async () => {
    const { db, writes } = makeDb();
    const handle = withHandle("ons_psf");
    await closeAuditSuccess(db, handle, { rowsWritten: 2, payloadHash: "abc123" });
    const update = writes.find((w) => /UPDATE ingestion_audit/i.test(w.sql));
    expect(update, "should issue UPDATE").toBeDefined();
    expect(update!.bindings[0], "status binding").toBe("success");
  });

  it("marks status='unchanged' when the payload_hash matches the most recent successful run for this source", async () => {
    // Prior success had payload_hash='stable' — this re-fetch returned the
    // same body. Writer must flag that as unchanged so UI/ops can tell.
    const { db, writes } = makeDb({
      ons_psf: [{ payload_hash: "stable", status: "success", completed_at: "2026-04-18T00:00:00Z" }],
    });
    const handle = withHandle("ons_psf");
    await closeAuditSuccess(db, handle, { rowsWritten: 2, payloadHash: "stable" });
    const update = writes.find((w) => /UPDATE ingestion_audit/i.test(w.sql));
    expect(update, "should issue UPDATE").toBeDefined();
    expect(update!.bindings[0], "status binding").toBe("unchanged");
  });

  it("marks status='success' when payload_hash differs from the last successful run", async () => {
    const { db, writes } = makeDb({
      ons_psf: [{ payload_hash: "old", status: "success", completed_at: "2026-04-18T00:00:00Z" }],
    });
    const handle = withHandle("ons_psf");
    await closeAuditSuccess(db, handle, { rowsWritten: 2, payloadHash: "new" });
    const update = writes.find((w) => /UPDATE ingestion_audit/i.test(w.sql));
    expect(update!.bindings[0], "status binding").toBe("success");
  });

  it("keeps status='partial' when the adapter reported zero observations — unchanged logic is secondary to silent-failure detection", async () => {
    const { db, writes } = makeDb({
      ons_psf: [{ payload_hash: "stable", status: "success", completed_at: "2026-04-18T00:00:00Z" }],
    });
    const handle = withHandle("ons_psf");
    await closeAuditSuccess(db, handle, { rowsWritten: 0, payloadHash: "stable" });
    const update = writes.find((w) => /UPDATE ingestion_audit/i.test(w.sql));
    // Zero-row runs are still partial regardless of whether the bytes
    // match a prior run. "Unchanged AND zero observations" is ambiguous
    // and we'd rather err on the noisy side.
    expect(update!.bindings[0], "status binding").toBe("partial");
  });

  it("ignores prior hashes from other sources", async () => {
    // A coincidental payload_hash collision between two different sources
    // must not trigger 'unchanged' — the lookup must be scoped by source_id.
    const { db, writes } = makeDb({
      ons_psf: [{ payload_hash: "abc", status: "success", completed_at: "2026-04-18T00:00:00Z" }],
    });
    const handle = withHandle("boe_yields"); // different source
    await closeAuditSuccess(db, handle, { rowsWritten: 5, payloadHash: "abc" });
    const update = writes.find((w) => /UPDATE ingestion_audit/i.test(w.sql));
    expect(update!.bindings[0], "status binding").toBe("success");
  });

  it("openAudit + closeAuditFailure still behave unchanged", async () => {
    const { db, writes } = makeDb();
    const handle = await openAudit(db, { sourceId: "x", sourceUrl: "http://" });
    expect(handle.sourceId).toBe("x");
    await closeAuditFailure(db, handle, new Error("boom"));
    const update = writes.find((w) => /UPDATE ingestion_audit/i.test(w.sql));
    // 'failure' may be in the SQL text (hardcoded) or in bindings — both
    // are equivalent. Accept either to avoid over-specifying the shape.
    const blob = `${update!.sql} ${update!.bindings.join("|")}`;
    expect(blob).toContain("failure");
  });
});
