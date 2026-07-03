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
  /**
   * Global publish switch (AUTOMATION_PLAN Phase 5 rollout). "shadow" (the
   * default when unset) forces every capture to status 'shadow' — verified,
   * gate-scored, recorded, but never written to indicator_observations. Flip
   * to "live" per-source at deploy time to enable auto-publish. Shadow mode is
   * default-ON precisely so a mis-deploy can never publish an unvetted value.
   */
  CURATOR_MODE?: string;
  /**
   * Public base URL of this worker's own admin surface (the custom-domain
   * route in wrangler.toml). Threaded into the editorial digest and quarantine
   * alerts so the ready-to-paste approve/reject curls target the right host.
   * Falls back to the production custom domain when unset.
   */
  CURATOR_PUBLIC_URL?: string;
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

/** Production fallback for CURATOR_PUBLIC_URL (matches the custom-domain route). */
export const DEFAULT_CURATOR_PUBLIC_URL = "https://curator.tightropetracker.uk";

/**
 * Resolve the public admin base URL (no trailing slash) for the ready-to-paste
 * curls in the editorial digest and quarantine alerts. Preview/local runs set
 * CURATOR_PUBLIC_URL to the workers.dev host so their curls stay correct.
 */
export function curatorPublicUrl(env: Pick<Env, "CURATOR_PUBLIC_URL">): string {
  return (env.CURATOR_PUBLIC_URL ?? DEFAULT_CURATOR_PUBLIC_URL).replace(/\/$/, "");
}
