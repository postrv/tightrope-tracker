import type { Env } from "./env.js";
import { computeSourceCadence, computeSourceHealth, type SourceCadenceEntry } from "@tightrope/shared";
import { readLatestObservations } from "@tightrope/snapshot";
import { timingSafeEqual } from "./admin.js";
import { adminAuthGate } from "./lib/adminBackoff.js";

/**
 * GET /admin/health — per-adapter ingestion health, protected by ADMIN_TOKEN.
 *
 * Returns, for every `source_id` that has ever shown up in `ingestion_audit`:
 *   - last attempt timestamp + status + rows_written + error
 *   - last successful attempt timestamp (if any)
 *   - minutes since last success (null if never)
 *
 * Unlike the public `/api/v1/health` on the API worker — which only surfaces
 * last-success times — this endpoint exposes failure messages and 'partial'
 * closures, and is intended for on-call. Keep it token-protected.
 *
 * Response shape:
 *   {
 *     ok: boolean,                // false if an active source has an actionable failure
 *     checkedAt: ISO8601,
 *     adapters: [
 *       {
 *         sourceId, name,
 *         lastAttemptAt, lastAttemptStatus, lastAttemptRows, lastAttemptError,
 *         lastSuccessAt, minutesSinceLastSuccess,
 *       }, ...
 *     ]
 *   }
 */
export async function handleAdminHealth(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }
  const expected = env.ADMIN_TOKEN;
  if (!expected) return json({ error: "ADMIN_TOKEN not configured" }, 503);
  // SEC-13: per-IP exponential backoff on failed auth (see admin.ts).
  const auth = await adminAuthGate(env, req, {
    verifyToken: (provided) => provided !== null && timingSafeEqual(provided, expected),
  });
  if (!auth.ok) return auth.response;

  const [latestAttempts, lastSuccesses, latestObservations] = await Promise.all([
    env.DB
      .prepare(
        `SELECT i.source_id, i.started_at, i.status, i.rows_written, i.error
         FROM ingestion_audit i
         JOIN (
           SELECT source_id, MAX(started_at) AS ts FROM ingestion_audit GROUP BY source_id
         ) m ON i.source_id = m.source_id AND i.started_at = m.ts`,
      )
      .all<{
        source_id: string;
        started_at: string;
        status: string;
        rows_written: number;
        error: string | null;
      }>(),
    env.DB
      .prepare(
        // 'unchanged' is a healthy fetch (same payload as last time).
        // Include it so sources that publish less often than they're
        // polled don't appear to be failing between real updates.
        `SELECT source_id, MAX(started_at) AS last_success
         FROM ingestion_audit WHERE status IN ('success', 'unchanged') GROUP BY source_id`,
      )
      .all<{ source_id: string; last_success: string }>(),
    // Latest observation per indicator, for the predictive cadence chip (§2.1).
    readLatestObservations(env.DB),
  ]);

  const successBy: Record<string, string> = {};
  for (const r of lastSuccesses.results) successBy[r.source_id] = r.last_success;

  const nowDate = new Date();
  const now = nowDate.getTime();
  // Per-source release-cadence state, keyed by source id for the join below.
  const cadenceBySource = new Map<string, SourceCadenceEntry>();
  for (const c of computeSourceCadence(
    latestObservations.map((r) => ({ sourceId: r.source_id, observedAt: r.observed_at, releasedAt: r.released_at })),
    nowDate,
  )) {
    cadenceBySource.set(c.sourceId, c);
  }

  const adapters = latestAttempts.results
    .map((r) => {
      const lastSuccess = successBy[r.source_id];
      const minutesSinceLastSuccess = lastSuccess
        ? Math.round((now - Date.parse(lastSuccess)) / 60000)
        : null;
      const cadence = cadenceBySource.get(r.source_id);
      // The curator records a disabled spec as an `unchanged` audit with an
      // explicit skip reason. Its old observation is still useful history,
      // but a red cadence chip would imply that the disabled fetch is late.
      // Other adapters (including the hand-refreshed RICS fixture) still
      // surface their own audit failures normally.
      const disabledSkip = r.status === "unchanged" && r.error?.startsWith("skipped: disabled") === true;
      return {
        sourceId: r.source_id,
        lastAttemptAt: r.started_at,
        lastAttemptStatus: r.status,
        lastAttemptRows: r.rows_written,
        lastAttemptError: r.error,
        lastSuccessAt: lastSuccess ?? null,
        minutesSinceLastSuccess,
        // null for sources with no observations / no declared cadence.
        cadenceState: disabledSkip ? null : cadence?.state ?? null,
        expectedCadence: cadence?.cadence ?? null,
      };
    })
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));

  // Use the same actionable-source filter as the public health surface:
  // unknown DLQ plumbing rows, retired adapters and one-off historical
  // backfills remain visible above for forensics but must not fail the
  // aggregate years after they ran.
  const ok = computeSourceHealth(
    latestAttempts.results.map((r) => ({ sourceId: r.source_id, startedAt: r.started_at, status: r.status })),
    successBy,
    now,
  ).length === 0;

  return json({ ok, checkedAt: new Date().toISOString(), adapters });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
