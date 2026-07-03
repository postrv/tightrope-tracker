import type { Ai, D1Database, KVNamespace, R2Bucket } from "@cloudflare/workers-types";

/**
 * Cloudflare bindings + vars consumed by the curator Worker. Bindings must
 * match the names declared in `apps/curator/wrangler.toml`.
 */
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ARCHIVE: R2Bucket;
  /** Workers AI — extraction (JSON-schema mode) + independent verification pass. */
  AI: Ai;
  ENVIRONMENT?: string;
  /** Shared secret for the /admin/captures review endpoints. Distinct from ingest's token. */
  ADMIN_TOKEN?: string;
  /** Base URL of the ingest worker's admin surface (delivery-commitment approve path). */
  INGEST_ADMIN_URL?: string;
  /** Ingest worker admin token, used only by the approve path. */
  INGEST_ADMIN_TOKEN?: string;
  /** Same alert webhook the ingest worker posts to ({text} JSON POST). */
  ALERT_WEBHOOK_URL?: string;
  /** Dead-man-switch ping URL; GET on successful daily poll (AUTOMATION_PLAN 2.3). */
  HEARTBEAT_URL?: string;
}
