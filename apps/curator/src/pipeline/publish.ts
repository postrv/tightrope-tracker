import type { Env } from "../env";
import type { CaptureRow, CaptureSpec, VerificationReport } from "../types";

/**
 * Stage 4 — decide + persist + (maybe) publish.
 *
 * Decide (AUTOMATION_PLAN Phase 3):
 * - kind "observation" ∧ verification.passed ∧ spec.allowAutoPublish
 *   → publish immediately, status "auto_published".
 * - Editorial kinds, failed gates, or allowAutoPublish=false
 *   → status "pending" (review queue). Gate failures on range/delta
 *   (G3/G4) → status "quarantined" + immediate alert webhook.
 * - Shadow-mode rollout: a global flag (KV or var) forces status "shadow"
 *   regardless — verified but never publishable.
 *
 * Publish (observations):
 * - INSERT OR REPLACE INTO indicator_observations with
 *   payload_hash = "ai:" + contentSha256. The "ai:" prefix keeps the row in
 *   the live tier of the two-tier latest-observation selector (not
 *   "hist:%", not "seed%") while staying traceable.
 * - Mark any older non-published capture rows for the same
 *   (indicator, observed_at) as "superseded".
 * - If a DIFFERENT value was previously published for the same
 *   (indicator_id, observed_at): append a `corrections` row (match the
 *   shape/tone of db/patches/log-2026-04-29-*.sql) — revisions are public.
 * - No KV surgery: the ingest worker's 5-minute recompute cron picks the
 *   new observation up within ≤5 minutes.
 *
 * Publish (approved editorial):
 * - delivery_commitment → POST {env.INGEST_ADMIN_URL}/admin/delivery-commitment
 *   with INGEST_ADMIN_TOKEN (endpoint lands in AUTOMATION_PLAN 1.3).
 * - timeline_event → INSERT INTO timeline_events + purge "timeline:latest".
 * - delivery_milestone → publish the observation AND flag in the next
 *   digest that the fixture should be folded back for seed parity.
 */
export async function decideAndPersist(
  env: Env,
  spec: CaptureSpec,
  row: CaptureRow,
  verification: VerificationReport,
): Promise<CaptureRow> {
  void env;
  void spec;
  void row;
  void verification;
  throw new Error("TODO: implement decide/persist/publish stage");
}
