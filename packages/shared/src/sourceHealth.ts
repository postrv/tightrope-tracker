import type { SourceHealthEntry } from "./types.js";
import { SOURCES } from "./indicators.js";

/** One row per source: that source's most recent ingestion attempt (any status). */
export interface LatestAttemptRow {
  sourceId: string;
  startedAt: string;
  status: string;
}

/**
 * Source IDs that historically appear in `ingestion_audit` but are no
 * longer wired into any active pipeline. They legitimately have stale
 * `last_success` timestamps because nothing is polling them; surfacing
 * those in the public health/source-health endpoints would be misleading
 * (operators would chase a "failure" that's actually intentional retirement).
 *
 * To retire a source: add its id here and stop registering its adapter
 * in apps/ingest/src/pipelines. Do **not** delete the historical audit
 * rows — they carry forensic value if the retirement is ever revisited.
 *
 *  - `boe_sonia`: SONIA-12m proxy was superseded by direct gilt yields;
 *     the adapter is registered (registry side-effect) but not wired
 *     into the market pipeline.
 *  - `ice_gas`:   front-month NBP gas proxy is no longer part of the
 *     market pillar's published indicator set.
 *  - `lseg_housebuilders`: editorial fixture replaced by the live
 *     `eodhd_housebuilders` adapter in the fiscal pipeline.
 *  - `twelve_data_housebuilders`: deprecated; Twelve Data free tier
 *     dropped LSE equity coverage. EODHD is the live successor.
 *  - `moneyfacts`: editorial 2y-fix fixture replaced by the live
 *     `boe_mortgage_rates` adapter (BoE IADB IUMBV34) in the labour
 *     pipeline. Adapter retired 2026-07; historical audit rows remain
 *     in prod D1 and must stay off the public health surface.
 */
export const INACTIVE_INGEST_SOURCES: ReadonlySet<string> = new Set([
  "boe_sonia",
  "ice_gas",
  "lseg_housebuilders",
  "twelve_data_housebuilders",
  "moneyfacts",
]);

export function isActiveIngestSource(sourceId: string): boolean {
  return !INACTIVE_INGEST_SOURCES.has(sourceId);
}

/**
 * How long a latest-attempt row may sit at 'started' before it counts as a
 * failure. A 'started' row younger than this is almost always a sweep IN
 * FLIGHT — the curator poll takes minutes per spec (model calls), and the
 * ingest recompute ticks every 5 minutes, so without this grace every sweep
 * window raced the recompute into a false "failure" alert for whichever specs
 * happened to be mid-extraction (observed 2026-07-12: sp_global_pmi +
 * gfk_confidence paged while their poll was still running). 20 minutes sits
 * above both the platform's 15-minute cron cap and the curator's 10-minute
 * sweep budget, so a row still 'started' past it is a genuinely dangling row
 * (killed isolate) and must surface as a failure.
 */
export const STARTED_IN_FLIGHT_GRACE_MS = 20 * 60_000;

/**
 * Derive the list of sources whose latest ingestion attempt did not succeed.
 *
 * Input shapes are deliberately close to what the D1 queries return, so both
 * apps/api and apps/web can hand the rows straight in. The function ignores
 * sources that have never been seen in the audit table -- we only flag a
 * source we've actively tried to ingest from and failed.
 */
export function computeSourceHealth(
  latestAttempts: readonly LatestAttemptRow[],
  lastSuccessBySource: Readonly<Record<string, string>>,
  nowMs: number = Date.now(),
): SourceHealthEntry[] {
  const out: SourceHealthEntry[] = [];
  for (const row of latestAttempts) {
    // 'unchanged' is closeAuditSuccess's status for a byte-identical repoll
    // (payload hash matches the most recent success). It's a successful run
    // by every meaningful definition -- we fetched, parsed, and confirmed
    // upstream hasn't moved -- so it must not feed the failure banner.
    // Mirrors the SQL filter for `lastSuccessAt` which also accepts both.
    if (row.status === "success" || row.status === "unchanged") continue;
    // A recent 'started' row is a run IN FLIGHT, not a failure -- the curator
    // sweep takes minutes and the recompute ticks every 5, so classifying it
    // as failed races every sweep into a false alert. Past the grace it's a
    // dangling row (isolate killed before the audit close) and does surface.
    if (row.status === "started") {
      const startedMs = Date.parse(row.startedAt);
      if (Number.isFinite(startedMs) && nowMs - startedMs < STARTED_IN_FLIGHT_GRACE_MS) continue;
    }
    // The ingest worker's DLQ handler writes ingestion_audit rows with
    // source_id = 'unknown' when a dead-lettered message carries no
    // sourceId. That row is an artefact of the DLQ plumbing, not a real
    // ingestion source a reader can act on -- suppress it here so the
    // public-facing banner stays focused on actual upstream failures.
    if (row.sourceId === "unknown") continue;
    // backfillObservations audits under source_id="<adapter>:historical".
    // Those rows aren't public-facing upstream feeds -- a 'partial' close
    // usually just means the requested date range pre-dated the curated
    // fixture. Backfill health is surfaced via /admin/health; keep the
    // public banner focused on the live polling lane.
    if (row.sourceId.endsWith(":historical")) continue;
    // Suppress retired adapters whose audit rows linger from before they
    // were unwired. See INACTIVE_INGEST_SOURCES for the canonical list.
    if (INACTIVE_INGEST_SOURCES.has(row.sourceId)) continue;
    const status = row.status === "partial" ? "partial" : "failure";
    const entry: SourceHealthEntry = {
      sourceId: row.sourceId,
      name: SOURCES[row.sourceId]?.name ?? row.sourceId,
      status,
      lastAttemptAt: row.startedAt,
    };
    const lastSuccess = lastSuccessBySource[row.sourceId];
    if (lastSuccess) entry.lastSuccessAt = lastSuccess;
    out.push(entry);
  }
  // Stable order by sourceId so the UI banner list doesn't flicker between requests.
  out.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  return out;
}
