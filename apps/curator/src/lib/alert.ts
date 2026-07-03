import type { Env } from "../env";

/**
 * Low-level alert poster: POST `{ text }` to ALERT_WEBHOOK_URL (the same
 * Slack-shaped webhook the ingest worker uses). No-op (returns false) when the
 * webhook is unset; failures are swallowed + logged — an alert path must never
 * block or throw into a sweep.
 *
 * Curator-local twin of apps/ingest/src/lib/alertWebhook.ts (ingest is a
 * Worker, not an importable package).
 */
export async function postAlert(env: Pick<Env, "ALERT_WEBHOOK_URL">, text: string): Promise<boolean> {
  const webhook = env.ALERT_WEBHOOK_URL;
  if (!webhook) return false;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return true;
  } catch (err) {
    console.warn(`alert webhook post failed: ${(err as Error)?.message ?? String(err)}`);
    return false;
  }
}

/**
 * Dead-man heartbeat: GET HEARTBEAT_URL, best-effort. Fired by the daily poll
 * on success (AUTOMATION_PLAN 2.3) — a second independent "the platform is
 * alive" signal alongside ingest recompute's. No-op when unset.
 */
export async function fireHeartbeat(env: Pick<Env, "HEARTBEAT_URL">): Promise<void> {
  const url = env.HEARTBEAT_URL;
  if (!url) return;
  try {
    await fetch(url, { method: "GET" });
  } catch (err) {
    console.warn(`heartbeat ping failed: ${(err as Error)?.message ?? String(err)}`);
  }
}
