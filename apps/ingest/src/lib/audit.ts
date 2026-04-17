import type { D1Database } from "@cloudflare/workers-types";

export interface AuditRowInit {
  sourceId: string;
  sourceUrl: string;
}

/** Opaque token used to close an audit row. */
export interface AuditHandle {
  id: string;
  sourceId: string;
  sourceUrl: string;
  startedAt: string;
}

function uuid(): string {
  // `crypto.randomUUID()` is available in Workers and Node >=20.
  return globalThis.crypto.randomUUID();
}

export async function openAudit(db: D1Database, init: AuditRowInit): Promise<AuditHandle> {
  const id = uuid();
  const startedAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO ingestion_audit (id, source_id, started_at, status, rows_written, source_url)
       VALUES (?, ?, ?, 'started', 0, ?)`,
    )
    .bind(id, init.sourceId, startedAt, init.sourceUrl)
    .run();
  return { id, sourceId: init.sourceId, sourceUrl: init.sourceUrl, startedAt };
}

export async function closeAuditSuccess(
  db: D1Database,
  handle: AuditHandle,
  opts: { rowsWritten: number; payloadHash: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE ingestion_audit
       SET status = 'success',
           completed_at = ?,
           rows_written = ?,
           payload_hash = ?,
           error = NULL
       WHERE id = ?`,
    )
    .bind(new Date().toISOString(), opts.rowsWritten, opts.payloadHash, handle.id)
    .run();
}

export async function closeAuditFailure(
  db: D1Database,
  handle: AuditHandle,
  error: unknown,
): Promise<void> {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : typeof error === "string" ? error : "unknown error";
  await db
    .prepare(
      `UPDATE ingestion_audit
       SET status = 'failure',
           completed_at = ?,
           error = ?
       WHERE id = ?`,
    )
    .bind(new Date().toISOString(), message.slice(0, 2000), handle.id)
    .run();
}
