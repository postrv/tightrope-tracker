import type { DataSourceAdapter, AdapterResult } from "@tightrope/data-sources";
import type { Env } from "../env.js";
import { closeAuditFailure, closeAuditSuccess, openAudit } from "../lib/audit.js";
import { writeObservations } from "../lib/observations.js";
import { combineHashes } from "../lib/hash.js";

/**
 * Run a single adapter end-to-end:
 *   1. Open ingestion_audit row (status = 'started')
 *   2. Call adapter.fetch(globalThis.fetch) to produce observations
 *   3. Batched INSERT OR REPLACE into indicator_observations
 *   4. Close audit row (success w/ rows_written + payload_hash, or failure)
 *   5. On failure, optionally enqueue to DLQ and re-throw.
 */
export async function runAdapter(env: Env, adapter: DataSourceAdapter): Promise<AdapterResult> {
  // We defer the sourceUrl until the adapter returns, but D1 requires a value
  // at INSERT time -- use the registry URL by convention.
  const handle = await openAudit(env.DB, { sourceId: adapter.id, sourceUrl: placeholderUrl(adapter) });
  try {
    const result = await adapter.fetch(globalThis.fetch);
    const rowsWritten = await writeObservations(env.DB, result.observations);
    const payloadHash = combineHashes(result.observations.map((o) => o.payloadHash));
    await closeAuditSuccess(env.DB, handle, { rowsWritten, payloadHash });
    return result;
  } catch (err) {
    await closeAuditFailure(env.DB, handle, err);
    if (env.DLQ) {
      try {
        await env.DLQ.send({ sourceId: adapter.id, error: (err as Error)?.message ?? String(err) });
      } catch { /* swallow -- DLQ is best-effort */ }
    }
    throw err;
  }
}

/**
 * Like runAdapter, but catches and logs any failure instead of propagating.
 * Used by pipeline orchestrators (market/fiscal/labour/delivery) so a single
 * upstream outage doesn't halt sibling adapters or the downstream recompute.
 * The audit row and DLQ message are still written by runAdapter; callers rely
 * on those for observability, not on the thrown exception.
 */
export async function runAdapterSafe(env: Env, adapter: DataSourceAdapter): Promise<AdapterResult | null> {
  try {
    return await runAdapter(env, adapter);
  } catch (err) {
    console.warn(`runAdapterSafe: ${adapter.id} failed -- ${(err as Error)?.message ?? String(err)}`);
    return null;
  }
}

function placeholderUrl(adapter: DataSourceAdapter): string {
  return `adapter:${adapter.id}`;
}
