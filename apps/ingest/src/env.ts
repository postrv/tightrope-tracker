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
}
