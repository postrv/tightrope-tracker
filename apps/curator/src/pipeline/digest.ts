import type { Env } from "../env";

/**
 * Editorial readiness digest — Tue/Wed 06:30 UTC cron (AUTOMATION_PLAN
 * Phase 4). Posted to ALERT_WEBHOOK_URL ({text} JSON, same shape the ingest
 * alerts use). Content:
 *
 *   - headline + pillar scores with 7d deltas (read score:latest from KV)
 *   - indicators in amber/red cadence state (Phase 2.1 helper)
 *   - pending review-queue items, each with a ready-to-paste approve/reject
 *     curl command
 *   - upstream releases expected in the next 7 days (cadence registry)
 *   - any auto-published values since the last digest, with quote + link
 *
 * Keep the copy neutral: this is operational tooling — refer to the
 * schedule only as the "weekly editorial deadline".
 */
export async function sendEditorialDigest(env: Env): Promise<void> {
  void env;
  throw new Error("TODO: implement editorial readiness digest");
}
