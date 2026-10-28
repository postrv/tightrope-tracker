import type {
  AdapterContext,
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
  /**
   * Injectable network leg, defaulting to `globalThis.fetch`. The BoE relay
   * passes a replay fetch here (`/admin/relay?mode=backfill`): the IADB blocks
   * Cloudflare Workers egress, so the raw CSV arrives from a runner (or an
   * operator machine) and is replayed through the adapter's own
   * `fetchHistorical` parse path.
   */
  fetchImpl?: typeof globalThis.fetch;
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
 *   2. Call `adapter.fetchHistorical` with the requested range and a
 *      D1-backed context for sources that pair historical series.
 *   3. Hand the observations to `writeHistoricalObservations` (idempotent,
 *      with `dryRun` and `overwrite` honoured).
 *   4. Close the audit row with the combined payload hash of everything
 *      written, or fail it with the thrown error.
 *
 * KV caches are NOT invalidated here. Recompute current scores after a raw
 * backfill, then refresh any affected cached views. Rebuild historical scores
 * only after checking publication dates and existing live score snapshots:
 * that route can add synthetic end-of-day rows alongside authentic snapshots.
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
    const ctx: AdapterContext = {
      secrets: { EIA_API_KEY: env.EIA_API_KEY },
      getObservationsInRange: async (indicatorId, sourceId, fromIso, beforeIso) => {
        const rows = await env.DB.prepare(
          `SELECT value, observed_at FROM indicator_observations
           WHERE indicator_id = ? AND source_id = ?
             AND observed_at >= ? AND observed_at < ?
           ORDER BY observed_at ASC`,
        ).bind(indicatorId, sourceId, fromIso, beforeIso)
          .all<{ value: number; observed_at: string }>();
        return (rows.results ?? [])
          .filter((row) => typeof row.value === "number" && Number.isFinite(row.value))
          .map((row) => ({ value: row.value, observedAt: row.observed_at }));
      },
    };
    const result: HistoricalFetchResult = await adapter.fetchHistorical(
      opts.fetchImpl ?? globalThis.fetch,
      { from: opts.from, to: opts.to },
      ctx,
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
      sourceUrl: result.sourceUrl,
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
