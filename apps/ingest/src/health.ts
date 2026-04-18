import type { Env } from "./env.js";
import { timingSafeEqual } from "./admin.js";

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
 *     ok: boolean,                // false if anything is in failure/partial/dlq
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
  const provided = req.headers.get("x-admin-token");
  if (!provided || !timingSafeEqual(provided, expected)) {
    return json({ error: "unauthorised" }, 401);
  }

  const [latestAttempts, lastSuccesses] = await Promise.all([
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
        `SELECT source_id, MAX(started_at) AS last_success
         FROM ingestion_audit WHERE status = 'success' GROUP BY source_id`,
      )
      .all<{ source_id: string; last_success: string }>(),
  ]);

  const successBy: Record<string, string> = {};
  for (const r of lastSuccesses.results) successBy[r.source_id] = r.last_success;

  const now = Date.now();
  const adapters = latestAttempts.results
    .map((r) => {
      const lastSuccess = successBy[r.source_id];
      const minutesSinceLastSuccess = lastSuccess
        ? Math.round((now - Date.parse(lastSuccess)) / 60000)
        : null;
      return {
        sourceId: r.source_id,
        lastAttemptAt: r.started_at,
        lastAttemptStatus: r.status,
        lastAttemptRows: r.rows_written,
        lastAttemptError: r.error,
        lastSuccessAt: lastSuccess ?? null,
        minutesSinceLastSuccess,
      };
    })
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));

  const ok = adapters.every((a) => a.lastAttemptStatus === "success");

  return json({ ok, checkedAt: new Date().toISOString(), adapters });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
