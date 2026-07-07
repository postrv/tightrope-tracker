import type { ExecutionContext, ScheduledController, Request as CfRequest, Response as CfResponse } from "@cloudflare/workers-types";
import type { Env } from "./env";
import { runCuratorJob } from "./lib/jobs";
import { recordCronMiss } from "./lib/audit";
import { postAlert } from "./lib/alert";
import { handleFetch } from "./lib/admin";
import { sanitizeForLog } from "@tightrope/shared";

/**
 * Curator Worker — AI capture/verify/publish for non-API data sources.
 *
 * Cron dispatch mirrors the ingest worker's pattern: CRON_BRANCHES maps the
 * literal cron expression to a named job, and schedule.test.ts asserts this map
 * stays in sync with wrangler.toml.
 */
export const CRON_BRANCHES: Record<string, "sweep" | "digest" | "poll" | "staleness"> = {
  "0 5 * * 2": "sweep",
  "0 5 * * 3": "sweep",
  "30 6 * * 2": "digest",
  "30 6 * * 3": "digest",
  "0 6 * * *": "poll",
  "0 7 * * *": "staleness",
};

export type CuratorJob = (typeof CRON_BRANCHES)[keyof typeof CRON_BRANCHES];

export function jobForCron(cron: string): CuratorJob | undefined {
  return CRON_BRANCHES[cron];
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(dispatchCron(controller.cron, env));
  },

  async fetch(request: CfRequest, env: Env, _ctx: ExecutionContext): Promise<CfResponse> {
    // The admin surface is written against the Web platform Request/Response.
    return handleFetch(request as unknown as Request, env) as unknown as Promise<CfResponse>;
  },
};

/**
 * Cron dispatcher. Each job is wrapped so a single spec's failure never aborts
 * the run (the sweep runner already isolates per-spec; this guard covers the
 * job boundary). An unknown cron records a `cron_miss` audit row + pages,
 * matching ingest's behaviour rather than throwing. The job bodies live in the
 * shared `runCuratorJob` so the manual `POST /admin/run` trigger runs the same
 * code (including the poll's heartbeat).
 */
export async function dispatchCron(cron: string, env: Env): Promise<void> {
  const job = jobForCron(cron);
  switch (job) {
    case "sweep":
    case "poll":
    case "digest":
    case "staleness":
      await guard(job, () => runCuratorJob(env, job));
      return;
    default:
      // SEC-14: `cron` is scheduler-controlled but sanitised defensively before
      // it reaches any log line, KV key, or webhook text (parity with ingest).
      console.error(`curator: unknown cron pattern '${sanitizeForLog(cron)}'`);
      try {
        await recordCronMiss(env.DB, cron);
        await maybeAlertCronMiss(env, cron);
      } catch (err) {
        console.error(`curator: cron_miss handling failed: ${sanitizeForLog((err as Error)?.message ?? String(err))}`);
      }
  }
}

/** Run a job, swallowing + logging any throw so the scheduled handler never rejects. */
async function guard<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(`curator job '${name}' threw: ${(err as Error)?.message ?? String(err)}`);
    return null;
  }
}

const CRON_MISS_DEDUPE_TTL_SEC = 6 * 60 * 60;

async function maybeAlertCronMiss(env: Env, cron: string): Promise<void> {
  // SEC-14: strip control bytes before the cron string reaches the KV key or
  // the webhook text (mirrors ingest's maybeAlertCronMiss).
  const safeCron = sanitizeForLog(cron);
  const key = `alert:cron_miss:${safeCron}`;
  try {
    if (await env.KV.get(key)) return;
  } catch {
    /* fall through and try to alert anyway */
  }
  const posted = await postAlert(
    env,
    [
      `*Tightrope curator cron miss* (${new Date().toISOString().slice(0, 16).replace("T", " ")}Z)`,
      `The scheduler fired an unrecognised cron pattern: \`${safeCron}\``,
      `Reconcile wrangler.toml crons with CRON_BRANCHES in apps/curator/src/index.ts.`,
    ].join("\n"),
  );
  if (posted) {
    try {
      await env.KV.put(key, new Date().toISOString(), { expirationTtl: CRON_MISS_DEDUPE_TTL_SEC });
    } catch {
      /* best-effort dedupe */
    }
  }
}
