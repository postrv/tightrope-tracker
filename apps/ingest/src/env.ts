import type { D1Database, KVNamespace, R2Bucket, Queue } from "@cloudflare/workers-types";

/**
 * Cloudflare bindings + vars consumed by the ingest Worker. Bindings must
 * match the names declared in `AGENT_CONTRACTS.md`.
 */
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ARCHIVE: R2Bucket;
  DLQ?: Queue;
  ENVIRONMENT?: string;
  /** Shared secret required on the `/admin/run` endpoint. */
  ADMIN_TOKEN?: string;
  /**
   * Optional Slack Incoming Webhook (or other webhook accepting a JSON
   * POST with {text}). When set, the recompute pipeline posts an alert
   * if any ingestion source has been in failure/partial state for more
   * than one cadence-window. Alerts are de-duped via KV so we don't
   * spam on every 5-minute tick.
   */
  ALERT_WEBHOOK_URL?: string;
}
