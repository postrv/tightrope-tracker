import type { SourceHealthEntry } from "@tightrope/shared";
import type { Env } from "../env.js";

/**
 * Post a concise alert to the configured webhook when one or more
 * sources have failed their most recent ingestion and either (a) have
 * never succeeded or (b) have been failing longer than an hour. Alerts
 * are de-duped per source via KV so we don't spam on every 5-minute
 * recompute tick.
 *
 * No-op if ALERT_WEBHOOK_URL is unset. Webhook failures are swallowed:
 * the alert path must never block a recompute.
 */
export async function maybeAlertSourceHealth(
  env: Env,
  sourceHealth: readonly SourceHealthEntry[],
): Promise<void> {
  const webhook = env.ALERT_WEBHOOK_URL;
  if (!webhook) return;
  if (sourceHealth.length === 0) return;

  const now = Date.now();
  const STALE_MS = 60 * 60_000; // 1 hour
  const DEDUPE_TTL_SEC = 6 * 60 * 60; // 6 hours

  const toAlert: SourceHealthEntry[] = [];
  for (const entry of sourceHealth) {
    // Skip "partial" with a fresh last-success -- transient hiccups.
    const lastSuccessMs = entry.lastSuccessAt ? Date.parse(entry.lastSuccessAt) : null;
    const isStale = lastSuccessMs === null || now - lastSuccessMs > STALE_MS;
    if (!isStale) continue;
    // De-dupe: only alert once per source per dedupe window.
    const key = `alert:source:${entry.sourceId}`;
    const already = await kvGet(env, key);
    if (already) continue;
    toAlert.push(entry);
    // Best-effort mark; don't block if KV write errors.
    await kvPut(env, key, new Date().toISOString(), DEDUPE_TTL_SEC);
  }
  if (toAlert.length === 0) return;

  const lines = toAlert.map((e) => {
    const last = e.lastSuccessAt
      ? `last success ${e.lastSuccessAt.slice(0, 16).replace("T", " ")}Z`
      : "never succeeded";
    return `• \`${e.sourceId}\` — ${e.status} — ${last}`;
  });
  const text = [
    `*Tightrope ingestion alert* (${new Date().toISOString().slice(0, 16).replace("T", " ")}Z)`,
    `Sources failing for >1h:`,
    ...lines,
    `Triage: \`curl -H "x-admin-token: $ADMIN_TOKEN" https://ingest.tightropetracker.uk/admin/health\``,
  ].join("\n");

  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.warn(`alert webhook post failed: ${(err as Error)?.message ?? String(err)}`);
  }
}

async function kvGet(env: Env, key: string): Promise<string | null> {
  try {
    return await env.KV.get(key);
  } catch {
    return null;
  }
}
async function kvPut(env: Env, key: string, value: string, ttlSec: number): Promise<void> {
  try {
    await env.KV.put(key, value, { expirationTtl: ttlSec });
  } catch { /* best-effort */ }
}
