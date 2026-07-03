import type { Env } from "../env.js";

/**
 * Low-level alert poster: POST `{ text }` to the configured webhook (Slack-
 * shaped). Shared by the source-health alerts, the plausibility-quarantine
 * alerts (§2.2), and the cron-miss alerts (§2.3).
 *
 * No-op (returns false) when ALERT_WEBHOOK_URL is unset. Webhook failures are
 * swallowed and logged — an alert path must never block or throw into an
 * ingest/recompute run.
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
