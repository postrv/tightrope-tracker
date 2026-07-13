import { AdapterError, type DataSourceAdapter, type AdapterResult, type AdapterContext } from "@tightrope/data-sources";
import { readLatestObservations } from "@tightrope/snapshot";
import type { Env } from "../env.js";
import { closeAuditFailure, closeAuditSuccess, openAudit } from "../lib/audit.js";
import { writeObservations } from "../lib/observations.js";
import { combineHashes } from "../lib/hash.js";
import { sanitizeForLog } from "../lib/sanitize.js";

/** Spacing before the single network-class retry. ~10s (BoE/ONS rate courtesy). */
const RETRY_DELAY_MS = 10_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The honest terminal outcome of a successful run, surfaced to callers that need it. */
export interface RunAdapterOutcome {
  /** 'success' | 'unchanged' | 'partial' — the status closeAuditSuccess wrote. */
  status: string;
  /** Observations that actually reached indicator_observations (survivors). */
  rowsWritten: number;
}

export interface RunAdapterOptions {
  /** Delay before the one bounded retry. Defaults to RETRY_DELAY_MS. */
  retryDelayMs?: number;
  /** Sleep implementation — injected so tests don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * The fetch implementation handed to `adapter.fetch`. Defaults to
   * `globalThis.fetch` (a real network call). The relay admin endpoint injects
   * a fetch that replays an already-fetched CSV payload, so the adapter runs
   * through the identical parse / plausibility / audit / DLQ machinery while the
   * network hop happens elsewhere (a GitHub Actions runner). The bounded retry
   * only fires on a retryable AdapterError, which a replay fetch never produces.
   */
  fetchImpl?: typeof globalThis.fetch;
  /**
   * Called once, only on the success path, right after the audit row is closed,
   * with the terminal status and the survivor row count. Lets a caller report
   * the outcome without re-querying the audit table (used by the relay endpoint).
   */
  onOutcome?: (outcome: RunAdapterOutcome) => void;
}

/**
 * Run a single adapter end-to-end:
 *   1. Open ingestion_audit row (status = 'started')
 *   2. Call adapter.fetch(globalThis.fetch) to produce observations, with one
 *      bounded retry (2 attempts total) for network-class failures only
 *   3. Batched INSERT OR REPLACE into indicator_observations
 *   4. Close audit row (success w/ rows_written + payload_hash, or failure)
 *   5. On failure, optionally enqueue to DLQ and re-throw.
 *
 * The audit row spans the whole operation (opened once, closed once) so a
 * retried fetch still produces a single honest row.
 */
export async function runAdapter(
  env: Env,
  adapter: DataSourceAdapter,
  opts: RunAdapterOptions = {},
): Promise<AdapterResult> {
  // We defer the sourceUrl until the adapter returns, but D1 requires a value
  // at INSERT time -- use the registry URL by convention.
  const handle = await openAudit(env.DB, { sourceId: adapter.id, sourceUrl: placeholderUrl(adapter) });
  const ctx: AdapterContext = {
    secrets: {
      EODHD_API_KEY: env.EODHD_API_KEY,
      EIA_API_KEY: env.EIA_API_KEY,
    },
    // D1-backed latest-observation lookup (the snapshot's two-tier selector).
    // eia_brent pairs its USD print with the relay-fed gbp_usd fix through
    // this instead of re-fetching the ASN-blocked BoE IADB endpoint.
    getLatestObservation: async (indicatorId) => {
      const rows = await readLatestObservations(env.DB);
      const row = rows.find((r) => r.indicator_id === indicatorId);
      return row && typeof row.value === "number" && Number.isFinite(row.value)
        ? { value: row.value, observedAt: row.observed_at }
        : null;
    },
  };
  try {
    const result = await fetchWithRetry(adapter, ctx, opts);
    // writeObservations runs the plausibility gate (§2.2): implausible values
    // are quarantined + alerted rather than written. rowsWritten and the payload
    // hash cover ONLY the observations that actually landed (F5a) — a quarantined
    // value must not colour the "did upstream change?" hash. A batch that both
    // wrote AND quarantined closes as 'partial' so /admin/health flags it (F5b).
    const { written, quarantined } = await writeObservations(env, result.observations);
    const payloadHash = combineHashes(written.map((o) => o.payloadHash));
    const { status } = await closeAuditSuccess(env.DB, handle, {
      rowsWritten: written.length,
      payloadHash,
      emitsNoObservations: result.emitsNoObservations === true,
      quarantinedCount: quarantined,
    });
    opts.onOutcome?.({ status, rowsWritten: written.length });
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
 * Call `adapter.fetch` with one bounded retry for network-class failures only
 * (a thrown fetch or an upstream 5xx, flagged `retryable` on the AdapterError
 * by fetchOrThrow). Parse/validation/4xx errors are re-thrown immediately: a
 * re-fetch would re-fail identically and the audit trail should show one
 * honest failure. A second attempt's failure — retryable or not — propagates.
 */
async function fetchWithRetry(
  adapter: DataSourceAdapter,
  ctx: AdapterContext,
  opts: RunAdapterOptions,
): Promise<AdapterResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  try {
    return await adapter.fetch(fetchImpl, ctx);
  } catch (err) {
    if (!isRetryable(err)) throw err;
    const sleep = opts.sleep ?? defaultSleep;
    await sleep(opts.retryDelayMs ?? RETRY_DELAY_MS);
    return await adapter.fetch(fetchImpl, ctx);
  }
}

function isRetryable(err: unknown): boolean {
  return err instanceof AdapterError && err.retryable === true;
}

/**
 * Like runAdapter, but catches and logs any failure instead of propagating.
 * Used by pipeline orchestrators (market/fiscal/labour/delivery) so a single
 * upstream outage doesn't halt sibling adapters or the downstream recompute.
 * The audit row and DLQ message are still written by runAdapter; callers rely
 * on those for observability, not on the thrown exception.
 */
export async function runAdapterSafe(
  env: Env,
  adapter: DataSourceAdapter,
  opts: RunAdapterOptions = {},
): Promise<AdapterResult | null> {
  try {
    return await runAdapter(env, adapter, opts);
  } catch (err) {
    // SEC-14: err.message often quotes upstream response text. Sanitise.
    console.warn(`runAdapterSafe: ${adapter.id} failed -- ${sanitizeForLog((err as Error)?.message ?? String(err))}`);
    return null;
  }
}

function placeholderUrl(adapter: DataSourceAdapter): string {
  return `adapter:${adapter.id}`;
}
