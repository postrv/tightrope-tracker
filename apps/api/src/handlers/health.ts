import { json } from "../lib/router.js";
import { getLastIngestionAudit } from "../lib/db.js";

export async function handleHealth(req: Request, env: Env): Promise<Response> {
  // Health is cheap — no query params accepted.
  const url = new URL(req.url);
  for (const key of url.searchParams.keys()) {
    return json({ error: `unknown query parameter: ${key}`, code: "BAD_QUERY" }, 400);
  }

  const updatedAt = new Date().toISOString();
  try {
    const ingestionLastSuccess = await getLastIngestionAudit(env);
    return json({ ok: true, updatedAt, ingestionLastSuccess });
  } catch (err) {
    // Health should not 500 if the audit table is unreachable — return an
    // explicitly degraded signal so operators can wire it into uptime checks.
    return json({ ok: false, updatedAt, ingestionLastSuccess: {}, code: "DB_ERROR" }, 503);
  }
}
