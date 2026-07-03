import type { ExecutionContext, ScheduledController, Request as CfRequest, Response as CfResponse } from "@cloudflare/workers-types";
import type { Env } from "./env";

/**
 * Curator Worker — AI capture/verify/publish for non-API data sources.
 *
 * Cron dispatch mirrors the ingest worker's pattern: CRON_BRANCHES maps the
 * literal cron expression to a named job, and a test must assert this map
 * stays in sync with wrangler.toml (copy the ingest worker's
 * CRON_BRANCHES-vs-wrangler assertion test).
 */
export const CRON_BRANCHES: Record<string, "sweep" | "digest" | "poll" | "staleness"> = {
  "0 5 * * 2": "sweep",
  "0 5 * * 3": "sweep",
  "30 6 * * 2": "digest",
  "30 6 * * 3": "digest",
  "0 6 * * *": "poll",
  "0 7 * * *": "staleness",
};

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const job = CRON_BRANCHES[controller.cron];
    // TODO: mirror ingest's dispatch — unknown cron records an audit row
    // (status cron_miss) rather than throwing; each job wrapped so one
    // spec's failure never aborts the rest of the run.
    //
    //   sweep     -> runSweep(env, { force: true })   force = ignore the
    //                content-hash short-circuit; full capture+verify of
    //                every spec ahead of the weekly editorial deadline.
    //   poll      -> runSweep(env, { force: false })  hash-poll; extract
    //                only on change. On success, GET env.HEARTBEAT_URL.
    //   digest    -> sendEditorialDigest(env)
    //   staleness -> runStalenessMonitor(env)         cadence-state pass
    //                (AUTOMATION_PLAN 2.1) + alert on amber->red.
    void job;
    void env;
    void ctx;
    throw new Error("TODO: implement scheduled dispatch (AUTOMATION_PLAN Phase 3/4)");
  },

  async fetch(request: CfRequest, env: Env, ctx: ExecutionContext): Promise<CfResponse> {
    // Review-queue surface (AUTOMATION_PLAN Phase 3), ADMIN_TOKEN-gated with
    // the same timingSafeEqual + per-IP backoff pattern as
    // apps/ingest/src/lib/adminBackoff.ts — reuse or copy verbatim, do not
    // weaken:
    //
    //   GET  /admin/captures?status=pending
    //   GET  /admin/captures/:id
    //   POST /admin/captures/:id/approve
    //   POST /admin/captures/:id/reject     body: { reason }
    //   GET  /__healthz                     unauthenticated liveness probe
    //
    // Everything else: 405, matching the ingest worker's posture.
    void request;
    void env;
    void ctx;
    throw new Error("TODO: implement admin routes (AUTOMATION_PLAN Phase 3)");
  },
};
