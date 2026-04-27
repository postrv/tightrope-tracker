import { INACTIVE_INGEST_SOURCES } from "@tightrope/shared";
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
    const audit = await getLastIngestionAudit(env);
    // Drop retired adapters (boe_sonia, ice_gas, lseg_housebuilders,
    // twelve_data_housebuilders) and their historical-backfill suffix
    // siblings. Their audit rows exist for forensic reasons but are
    // misleading on the public health surface — the adapters are no
    // longer wired into any pipeline so a stale `last_success` is
    // expected, not a failure.
    const ingestionLastSuccess: Record<string, string> = {};
    for (const [sourceId, startedAt] of Object.entries(audit)) {
      const baseId = sourceId.endsWith(":historical")
        ? sourceId.slice(0, -":historical".length)
        : sourceId;
      if (INACTIVE_INGEST_SOURCES.has(baseId)) continue;
      ingestionLastSuccess[sourceId] = startedAt;
    }
    return json({ ok: true, updatedAt, ingestionLastSuccess });
  } catch (err) {
    // Health should not 500 if the audit table is unreachable — return an
    // explicitly degraded signal so operators can wire it into uptime checks.
    console.error("health audit fetch failed", err);
    return json({ ok: false, updatedAt, ingestionLastSuccess: {}, code: "DB_ERROR" }, 503);
  }
}
