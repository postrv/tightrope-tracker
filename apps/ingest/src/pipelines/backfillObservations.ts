import type {
  DataSourceAdapter,
  HistoricalFetchResult,
  RawObservation,
} from "@tightrope/data-sources";
import type { Env } from "../env.js";
import { closeAuditFailure, closeAuditSuccess, openAudit } from "../lib/audit.js";
import { combineHashes } from "../lib/hash.js";
import {
  writeHistoricalObservations,
  type HistoricalWriteResult,
} from "../lib/observations.js";

export interface BackfillObservationsOptions {
  from: Date;
  to: Date;
  dryRun: boolean;
  overwrite: boolean;
}

export interface BackfillObservationsResult {
  adapter: string;
  sourceUrl: string;
  fetchedAt: string;
  from: string;
  to: string;
  observationsFetched: number;
  rowsAttempted: number;
  rowsWritten: number;
  rowsRejected: HistoricalWriteResult["rejected"];
  earliestObservedAt: string | null;
  latestObservedAt: string | null;
  notes: string[];
  dryRun: boolean;
}

/**
 * Orchestrate a single adapter's historical backfill:
 *   1. Open `ingestion_audit` row with `source_id = "<adapter.id>:historical"`.
 *   2. Call `adapter.fetchHistorical(globalThis.fetch, { from, to })`.
 *   3. Hand the observations to `writeHistoricalObservations` (idempotent,
 *      with `dryRun` and `overwrite` honoured).
 *   4. Close the audit row with the combined payload hash of everything
 *      written, or fail it with the thrown error.
 *
 * KV caches are NOT invalidated here. The backfill rebuilds observations, not
 * scores; the caller follows up with `/admin/run?source=backfill-scores` which
 * owns KV invalidation.
 */
export async function backfillObservations(
  env: Env,
  adapter: DataSourceAdapter,
  opts: BackfillObservationsOptions,
): Promise<BackfillObservationsResult> {
  if (!adapter.fetchHistorical) {
    throw new Error(`adapter '${adapter.id}' has no fetchHistorical method`);
  }
  const auditSourceId = `${adapter.id}:historical`;
  const handle = await openAudit(env.DB, {
    sourceId: auditSourceId,
    sourceUrl: `adapter:${adapter.id}`,
  });

  try {
    const result: HistoricalFetchResult = await adapter.fetchHistorical(
      globalThis.fetch,
      { from: opts.from, to: opts.to },
    );

    const write = await writeHistoricalObservations(env.DB, result.observations, {
      dryRun: opts.dryRun,
      overwrite: opts.overwrite,
    });

    const payloadHash = opts.dryRun
      ? "dry-run"
      : combineHashes(result.observations.map((o: RawObservation) => o.payloadHash));

    await closeAuditSuccess(env.DB, handle, {
      rowsWritten: write.written,
      payloadHash,
    });

    return {
      adapter: adapter.id,
      sourceUrl: result.sourceUrl,
      fetchedAt: result.fetchedAt,
      from: opts.from.toISOString(),
      to: opts.to.toISOString(),
      observationsFetched: result.observations.length,
      rowsAttempted: write.attempted,
      rowsWritten: write.written,
      rowsRejected: write.rejected,
      earliestObservedAt: result.earliestObservedAt,
      latestObservedAt: result.latestObservedAt,
      notes: result.notes ?? [],
      dryRun: write.dryRun,
    };
  } catch (err) {
    await closeAuditFailure(env.DB, handle, err);
    throw err;
  }
}
