import type { Env } from "../env";
import type { CuratorJob } from "../index";
import { runSweep } from "./sweep";
import { runStalenessMonitor } from "../pipeline/staleness";
import { sendEditorialDigest } from "../pipeline/digest";
import { fireHeartbeat } from "./alert";

/**
 * The named curator jobs. Single source of truth for both the cron dispatcher
 * (index.ts) and the manual admin trigger (POST /admin/run). Kept as a plain
 * array so the admin endpoint can list + validate `?job=` without re-declaring
 * the set.
 */
export const CURATOR_JOBS = ["sweep", "poll", "digest", "staleness"] as const;

export function isCuratorJob(v: string): v is CuratorJob {
  return (CURATOR_JOBS as readonly string[]).includes(v);
}

/**
 * Run one curator job to completion and return a JSON-able summary. Shared by
 * the cron dispatcher (wrapped in `guard`, throws swallowed) and the manual
 * admin trigger (`POST /admin/run`, throws surfaced as HTTP 500), so a hand-run
 * reproduces cron behaviour EXACTLY — including the per-spec ingestion_audit
 * rows the sweep/poll write and the dead-man heartbeat the poll fires on
 * success. This mirrors ingest's `/admin/run` semantics (which runs the same
 * pipeline code a cron would, audit rows and all).
 *
 *   sweep     → runSweep(force: true)   full re-capture+verify of every spec
 *   poll      → runSweep(force: false)  hash-poll; extract only on change; then
 *                                       fire the dead-man heartbeat on success
 *   digest    → sendEditorialDigest
 *   staleness → runStalenessMonitor     cadence-state pass + amber→red alerts
 */
export async function runCuratorJob(env: Env, job: CuratorJob): Promise<Record<string, unknown>> {
  switch (job) {
    case "sweep": {
      const summary = await runSweep(env, { force: true });
      return { job, ran: summary.ran, results: summary.results };
    }
    case "poll": {
      const summary = await runSweep(env, { force: false });
      // Heartbeat only after a poll that completed without throwing — a wedged
      // poll deliberately leaves the dead-man switch silent.
      await fireHeartbeat(env);
      return { job, ran: summary.ran, results: summary.results };
    }
    case "digest": {
      await sendEditorialDigest(env);
      return { job, sent: true };
    }
    case "staleness": {
      const r = await runStalenessMonitor(env);
      return { job, ...r };
    }
  }
}
