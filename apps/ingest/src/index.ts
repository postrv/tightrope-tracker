import type { ExecutionContext, MessageBatch, ScheduledEvent } from "@cloudflare/workers-types";
import type { Env } from "./env.js";
import type { DlqPayload } from "./types.js";
import { handleAdminRun } from "./admin.js";
import { handleCorrectionCreate } from "./corrections.js";
import { handleDeliveryCommitmentPatch } from "./deliveryCommitment.js";
import { handleRelay } from "./relay.js";
import { handleAdminHealth } from "./health.js";
import { ingestDelivery } from "./pipelines/delivery.js";
import { ingestFiscal } from "./pipelines/fiscal.js";
import { ingestLabour } from "./pipelines/labour.js";
import { ingestMarket } from "./pipelines/market.js";
import { recomputeScores } from "./pipelines/recompute.js";
import { updateTodayMovements } from "./pipelines/todayMovements.js";
import { sanitizeForLog } from "./lib/sanitize.js";
import { postAlert } from "./lib/alertWebhook.js";

export default {
  /**
   * HTTP entrypoint. The ingest Worker is cron-only in production; the only
   * useful HTTP surface is the admin run endpoint, guarded by a shared token.
   */
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/admin/run") {
      return handleAdminRun(req, env, url);
    }
    if (url.pathname === "/admin/correction") {
      return handleCorrectionCreate(req, env);
    }
    if (url.pathname === "/admin/delivery-commitment") {
      return handleDeliveryCommitmentPatch(req, env);
    }
    if (url.pathname === "/admin/relay") {
      return handleRelay(req, env, url);
    }
    if (url.pathname === "/admin/health") {
      return handleAdminHealth(req, env);
    }
    if (url.pathname === "/__healthz") {
      return new Response("ok", { status: 200 });
    }
    return new Response("method not allowed", { status: 405 });
  },

  /**
   * Cron dispatcher. Wrangler passes the matching cron expression on `event.cron`.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = event.cron;
    ctx.waitUntil(dispatchCron(cron, env, ctx));
  },

  /**
   * Queue consumer for the ingest DLQ. The producer-side of the same binding
   * receives messages when an adapter pipeline fails; this consumer is the end
   * of the line -- we log, write a best-effort audit row, and ack the batch so
   * nothing gets re-queued. If the audit write itself fails we still ack: the
   * log is the durable record of last resort.
   */
  async queue(batch: MessageBatch<DlqPayload>, env: Env): Promise<void> {
    await handleDlqBatch(batch, env);
  },
};

export async function handleDlqBatch(batch: MessageBatch<DlqPayload>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const body = msg.body ?? {};
    // SEC-14: every value reaching console.error here originates from an
    // adapter response or upstream exception. An attacker controlling an
    // adapter could inject CR/LF / ANSI escapes to forge fake log lines.
    // sanitizeForLog strips C0/C1 control bytes and replaces them with
    // U+FFFD so the log shape is preserved without structural injection.
    // Never log headers, tokens, or full payloads -- only the coarse fields
    // the producer explicitly marked safe.
    console.error(
      `ingest DLQ: id=${sanitizeForLog(msg.id)} attempts=${msg.attempts} source=${sanitizeForLog(body.sourceId ?? "unknown")} reason=${sanitizeForLog(body.reason ?? "unknown")} message=${sanitizeForLog(body.message ?? "")}`,
    );
    try {
      await recordDlqAudit(env, msg.id, body);
    } catch (err) {
      console.error(`ingest DLQ: audit write failed for id=${sanitizeForLog(msg.id)}: ${sanitizeForLog((err as Error)?.message ?? String(err))}`);
    }
  }
  batch.ackAll();
}

async function recordDlqAudit(env: Env, messageId: string, body: DlqPayload): Promise<void> {
  const now = new Date().toISOString();
  const sourceId = body.sourceId ?? "unknown";
  const sourceUrl = body.sourceUrl ?? "";
  const errorMsg = (body.message ?? body.reason ?? "dlq").slice(0, 2000);
  // The original payload is JSON-encoded into payload_hash so operators can
  // replay manually. Keep it small to protect the row size.
  const payloadJson = JSON.stringify(body).slice(0, 1800);
  await env.DB
    .prepare(
      `INSERT INTO ingestion_audit
         (id, source_id, started_at, completed_at, status, rows_written, payload_hash, error, source_url)
       VALUES (?, ?, ?, ?, 'dlq', 0, ?, ?, ?)`,
    )
    .bind(messageId, sourceId, now, now, payloadJson, errorMsg, sourceUrl)
    .run();
}

/**
 * Canonical map of cron pattern -> dispatch branch name. Each declared cron
 * in wrangler.toml MUST have a key here; the cron-dispatch test asserts the
 * two sets match so a wrangler edit can't silently break scheduling.
 */
export const CRON_BRANCHES = {
  "*/5 * * * *": "market+recompute+today",
  "0 2 * * *": "fiscal+recompute",
  "15 2 * * *": "labour+recompute",
  "30 2 * * *": "delivery+recompute",
} as const;

export type KnownCron = keyof typeof CRON_BRANCHES;

export function isKnownCron(cron: string): cron is KnownCron {
  return Object.prototype.hasOwnProperty.call(CRON_BRANCHES, cron);
}

export async function dispatchCron(cron: string, env: Env, ctx?: ExecutionContext): Promise<void> {
  switch (cron) {
    case "*/5 * * * *": {
      // Market ingest (throttled out of hours) + recompute + today strip.
      // Recompute MUST run even if ingest throws -- it's what carries forward
      // last-known values with a staleness flag so the site doesn't freeze on
      // a single upstream outage.
      await runStage("ingestMarket", () => ingestMarket(env));
      await runRecompute(env, ctx);
      await runStage("updateTodayMovements", () => updateTodayMovements(env));
      return;
    }
    case "0 2 * * *":
      await runStage("ingestFiscal", () => ingestFiscal(env));
      await runRecompute(env, ctx);
      return;
    case "15 2 * * *":
      await runStage("ingestLabour", () => ingestLabour(env));
      await runRecompute(env, ctx);
      return;
    case "30 2 * * *":
      await runStage("ingestDelivery", () => ingestDelivery(env));
      await runRecompute(env, ctx);
      return;
    default:
      // Unknown cron -- log loudly and record an audit row so the miss is
      // visible in the same surface as real ingestion failures.
      // SEC-14: cron value comes from the platform but sanitise defensively
      // so any future routing layer that injects user-controllable text
      // can't smuggle log structure.
      console.error(`ingest: unknown cron pattern '${sanitizeForLog(cron)}'`);
      try {
        await recordCronMiss(env, cron);
      } catch (err) {
        console.error(`ingest: cron_miss audit write failed: ${sanitizeForLog((err as Error)?.message ?? String(err))}`);
      }
  }
}

/**
 * Run a stage of the cron dispatch (ingest, recompute, etc.) and swallow any
 * exception. The individual stages already surface failures via the audit log
 * and DLQ; swallowing here is what guarantees the downstream stages still run.
 * If e.g. ingestMarket throws because a single upstream adapter slipped through,
 * recomputeScores must still run so last-known values are carried forward with
 * the stale flag set rather than the whole dashboard freezing.
 */
async function runStage<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    // SEC-14: err.message can contain whatever an upstream adapter
    // returned. Sanitise before logging.
    console.warn(`cron stage '${name}' threw: ${sanitizeForLog((err as Error)?.message ?? String(err))}`);
    return null;
  }
}

/**
 * Run recompute and, only on a *fully-successful* recompute (a non-null
 * snapshot — recomputeScores returns null when it skips, runStage returns null
 * when it throws), fire the dead-man heartbeat. A skipped/failed recompute
 * deliberately leaves the heartbeat silent so the external monitor notices.
 */
async function runRecompute(env: Env, ctx?: ExecutionContext): Promise<void> {
  const snapshot = await runStage("recomputeScores", () => recomputeScores(env));
  if (snapshot) fireHeartbeat(env, ctx);
}

/**
 * GET the heartbeat URL, best-effort. Scheduled via ctx.waitUntil so the ping
 * doesn't hold up the response; failures are logged, never thrown. No-op when
 * HEARTBEAT_URL is unset.
 */
function fireHeartbeat(env: Env, ctx?: ExecutionContext): void {
  const url = env.HEARTBEAT_URL;
  if (!url) return;
  const ping = (async () => {
    try {
      await fetch(url, { method: "GET" });
    } catch (err) {
      console.warn(`heartbeat ping failed: ${sanitizeForLog((err as Error)?.message ?? String(err))}`);
    }
  })();
  if (ctx) ctx.waitUntil(ping);
  else void ping;
}

async function recordCronMiss(env: Env, cron: string): Promise<void> {
  const now = new Date().toISOString();
  const id = globalThis.crypto.randomUUID();
  await env.DB
    .prepare(
      `INSERT INTO ingestion_audit
         (id, source_id, started_at, completed_at, status, rows_written, error, source_url)
       VALUES (?, 'cron', ?, ?, 'cron_miss', 0, ?, '')`,
    )
    .bind(id, now, now, `unknown cron pattern: ${cron}`.slice(0, 2000))
    .run();
  // A cron_miss means the schedule itself broke — that must page, not just sit
  // in the audit table. KV-deduped so a persistently-broken schedule pages
  // once per window, not on every discovery.
  await maybeAlertCronMiss(env, cron);
}

const CRON_MISS_DEDUPE_TTL_SEC = 6 * 60 * 60; // 6 hours

async function maybeAlertCronMiss(env: Env, cron: string): Promise<void> {
  const safeCron = sanitizeForLog(cron);
  const key = `alert:cron_miss:${safeCron}`;
  try {
    if (await env.KV.get(key)) return; // already paged this window
  } catch { /* KV read failed — fall through and try to alert anyway */ }

  const text = [
    `*Tightrope cron miss* (${new Date().toISOString().slice(0, 16).replace("T", " ")}Z)`,
    `The scheduler fired an unrecognised cron pattern: \`${safeCron}\``,
    `Ingestion for that schedule did not run — reconcile wrangler.toml crons with the dispatch switch (CRON_BRANCHES).`,
  ].join("\n");
  const posted = await postAlert(env, text);
  if (posted) {
    try {
      await env.KV.put(key, new Date().toISOString(), { expirationTtl: CRON_MISS_DEDUPE_TTL_SEC });
    } catch { /* best-effort dedupe mark */ }
  }
}
