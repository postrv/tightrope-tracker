import type { D1Database } from "@cloudflare/workers-types";

/**
 * Curator-local audit writer against the shared `ingestion_audit` table.
 *
 * The ingest worker owns an equivalent helper (apps/ingest/src/lib/audit.ts)
 * but ingest is a Worker, not an importable package, so — per the plan's
 * explicit allowance — this is a minimal curator-local writer speaking the
 * same table + status vocabulary (started / success / partial / unchanged /
 * failure / cron_miss). One `ingestion_audit` row is opened per CaptureSpec run
 * so a spec that hard-crashes mid-sweep leaves a visible dangling `started`
 * row, exactly as ingest's does.
 *
 * `source_id` is the spec's own sourceId, so `/admin/health` attributes a
 * curator run to the same source key the ingest fixtures/adapters use.
 */

export interface CuratorAuditHandle {
  id: string;
  sourceId: string;
}

export type CuratorAuditStatus = "success" | "partial" | "unchanged" | "failure";

/** Options accepted by `closeAudit` — exported so the sweep can resolve the
 * outcome into a single value and close exactly once from its `finally`. */
export interface CloseAuditOpts {
  rowsWritten?: number;
  payloadHash?: string | null;
  error?: string | null;
}

export async function openAudit(db: D1Database, sourceId: string, sourceUrl: string): Promise<CuratorAuditHandle> {
  const id = globalThis.crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO ingestion_audit (id, source_id, started_at, status, rows_written, source_url)
       VALUES (?, ?, ?, 'started', 0, ?)`,
    )
    .bind(id, sourceId, new Date().toISOString(), sourceUrl)
    .run();
  return { id, sourceId };
}

export async function closeAudit(
  db: D1Database,
  handle: CuratorAuditHandle,
  status: CuratorAuditStatus,
  opts: CloseAuditOpts = {},
): Promise<void> {
  await db
    .prepare(
      `UPDATE ingestion_audit
         SET status = ?, completed_at = ?, rows_written = ?, payload_hash = ?, error = ?
       WHERE id = ?`,
    )
    .bind(
      status,
      new Date().toISOString(),
      opts.rowsWritten ?? 0,
      opts.payloadHash ?? null,
      opts.error ? opts.error.slice(0, 2000) : null,
      handle.id,
    )
    .run();
}

/**
 * Record an unrecognised cron pattern the same way ingest does: a `cron_miss`
 * audit row under source_id 'cron' so the schedule breaking surfaces in the
 * same place as real ingestion failures.
 */
export async function recordCronMiss(db: D1Database, cron: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO ingestion_audit
         (id, source_id, started_at, completed_at, status, rows_written, error, source_url)
       VALUES (?, 'cron', ?, ?, 'cron_miss', 0, ?, '')`,
    )
    .bind(globalThis.crypto.randomUUID(), now, now, `unknown cron pattern: ${cron}`.slice(0, 2000))
    .run();
}
