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
  let status: string;
  let error: string | null;
  if (isSilentFailure) {
    status = "partial";
    error = "adapter returned 200 with zero observations -- probable parse regression or upstream schema drift";
  } else {
    // Stale-but-200 detection: if the payload_hash matches the most recent
    // successful run for this source, flag the row as 'unchanged'. This is
    // an honest signal to ops ("we fetched, but upstream hasn't moved")
    // that the /methodology "Last successful ingestion" table can surface
    // distinctly from a genuine content refresh. ONS PSF / OBR EFO run on
    // 5-min crons but publish monthly/semi-annually — without this flag
    // the table misleadingly shows "updated 5 minutes ago" for sources
    // whose last real update was weeks back.
    const priorHash = await lastSuccessPayloadHash(db, handle.sourceId);
    status = priorHash !== null && priorHash === opts.payloadHash ? "unchanged" : "success";
    error = null;
  }
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

/**
 * Latest non-null payload_hash recorded for a source under status in
 * ('success', 'unchanged'). Returns `null` if the source has no prior
 * successful runs on record (first ingest).
 *
 * Exported for tests; production callers go through closeAuditSuccess.
 */
export async function lastSuccessPayloadHash(
  db: D1Database,
  sourceId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT payload_hash FROM ingestion_audit
        WHERE source_id = ?
          AND status IN ('success', 'unchanged')
          AND payload_hash IS NOT NULL
        ORDER BY completed_at DESC
        LIMIT 1`,
    )
    .bind(sourceId)
    .first<{ payload_hash: string | null }>();
  return row?.payload_hash ?? null;
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
