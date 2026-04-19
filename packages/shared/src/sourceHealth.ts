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
    if (row.status === "success") continue;
    // The ingest worker's DLQ handler writes ingestion_audit rows with
    // source_id = 'unknown' when a dead-lettered message carries no
    // sourceId. That row is an artefact of the DLQ plumbing, not a real
    // ingestion source a reader can act on -- suppress it here so the
    // public-facing banner stays focused on actual upstream failures.
    if (row.sourceId === "unknown") continue;
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
