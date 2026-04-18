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
  opts: { rowsWritten: number; payloadHash: string; emitsNoObservations?: boolean },
): Promise<void> {
  // A "success" that wrote zero rows is usually a parse regression: the
  // adapter returned 200 OK and a body that parsed into an empty array.
  // That masks silent breakage until the staleness clock trips days later.
  // Mark it as "partial" with an explanatory error so /admin/health and
  // the source-health banner surface it immediately.
  //
  // Adapters that legitimately emit no observations (gov.uk RSS -> timeline
  // candidates, for instance) set `emitsNoObservations: true` on their
  // AdapterResult and are kept as success.
  const isSilentFailure = opts.rowsWritten === 0 && !opts.emitsNoObservations;
  const status = isSilentFailure ? "partial" : "success";
  const error = isSilentFailure
    ? "adapter returned 200 with zero observations -- probable parse regression or upstream schema drift"
    : null;
  await db
    .prepare(
      `UPDATE ingestion_audit
       SET status = ?,
           completed_at = ?,
           rows_written = ?,
           payload_hash = ?,
           error = ?
       WHERE id = ?`,
    )
    .bind(status, new Date().toISOString(), opts.rowsWritten, opts.payloadHash, error, handle.id)
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
