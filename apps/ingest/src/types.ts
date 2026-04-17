/**
 * Shared types for the ingest Worker.
 *
 * DLQ payload: whatever a producer sent to env.DLQ.send(...). Producers in this
 * repo are all ingest adapters wrapping fetch-to-parse pipelines, so the
 * payload is an opaque record with an indicator / source identifier and a
 * trimmed description of the failure. We never assume shape -- we just log.
 */
export interface DlqPayload {
  /** Indicator or source the failure relates to, where known. */
  sourceId?: string;
  /** Short machine-readable reason code, e.g. "fetch_timeout", "parse_error". */
  reason?: string;
  /** Free-form human message; NEVER include secrets. */
  message?: string;
  /** Upstream URL that was being fetched, if applicable. */
  sourceUrl?: string;
  /** Trimmed error detail -- bounded to avoid blowing up audit rows. */
  detail?: unknown;
  /** Timestamp the producer recorded the failure, ISO 8601. */
  occurredAt?: string;
}
