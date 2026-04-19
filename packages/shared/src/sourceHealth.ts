import type { SourceHealthEntry } from "./types.js";
import { SOURCES } from "./indicators.js";

/** One row per source: that source's most recent ingestion attempt (any status). */
export interface LatestAttemptRow {
  sourceId: string;
  startedAt: string;
  status: string;
}

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
): SourceHealthEntry[] {
  const out: SourceHealthEntry[] = [];
  for (const row of latestAttempts) {
    // 'unchanged' is closeAuditSuccess's status for a byte-identical repoll
    // (payload hash matches the most recent success). It's a successful run
    // by every meaningful definition -- we fetched, parsed, and confirmed
    // upstream hasn't moved -- so it must not feed the failure banner.
    // Mirrors the SQL filter for `lastSuccessAt` which also accepts both.
    if (row.status === "success" || row.status === "unchanged") continue;
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
