import type { D1Database } from "@cloudflare/workers-types";
import type { RawObservation } from "@tightrope/data-sources";
import { checkPlausibility } from "@tightrope/shared";
import { openAudit, closeAuditFailure, closeAuditSuccess } from "../lib/audit.js";
import { sha256Hex } from "../lib/hash.js";

/** Explicit source-definition repair. Normal historical backfills continue
 * protecting every live row; this path only changes verified EXISTING BE keys
 * after matching the complete archived before-state. Never adds dates or
 * rewrites published score history. It is not exposed by an admin endpoint. */
export interface BreakevenBeforeRow {
  indicator_id: string;
  source_id: string;
  observed_at: string;
  value: number;
  released_at: string | null;
  payload_hash: string;
  ingested_at: string;
}

export interface BreakevenCorrectionPlan {
  sourceUrl: string;
  sourceCsvSha256: string;
  beforeSha256: string;
  updates: { before: BreakevenBeforeRow; value: number; payloadHash: string }[];
}

const BEFORE_SQL = `SELECT indicator_id,source_id,observed_at,value,released_at,payload_hash,ingested_at
  FROM indicator_observations WHERE indicator_id = 'breakeven_5y' ORDER BY observed_at`;

async function beforeDigest(rows: readonly BreakevenBeforeRow[]): Promise<string> {
  return sha256Hex(JSON.stringify([...rows].sort((a, b) => a.observed_at.localeCompare(b.observed_at))));
}

export async function prepareBreakevenCorrection(
  before: readonly BreakevenBeforeRow[],
  officialInflation: readonly RawObservation[],
  source: { url: string; csvSha256: string },
): Promise<BreakevenCorrectionPlan> {
  if (!/^[a-f0-9]{64}$/.test(source.csvSha256)) throw new Error("Official source CSV SHA-256 required");
  if (before.length === 0) throw new Error("Existing breakeven archive is empty");
  const byDay = new Map<string, number>();
  for (const o of officialInflation) {
    if (o.indicatorId !== "breakeven_5y" || o.sourceId !== "boe_yields"
      || !checkPlausibility(o).ok) throw new Error("Invalid official inflation observation");
    const day = o.observedAt.slice(0, 10);
    if (byDay.has(day) && byDay.get(day) !== o.value) throw new Error(`Conflicting official inflation for ${day}`);
    byDay.set(day, o.value);
  }
  const keys = new Set<string>();
  const updates = [];
  for (const row of before) {
    if (row.indicator_id !== "breakeven_5y" || row.source_id !== "boe_yields"
      || !Number.isFinite(row.value) || !Number.isFinite(Date.parse(row.observed_at))
      || Date.parse(row.observed_at) >= Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())
      || !row.payload_hash || keys.has(row.observed_at)) throw new Error("Invalid or duplicate archived breakeven key");
    keys.add(row.observed_at);
    const value = byDay.get(row.observed_at.slice(0, 10));
    if (value === undefined) throw new Error(`No official inflation reading for existing key ${row.observed_at}`);
    const digest = await sha256Hex(`IUDSIZC:${source.csvSha256}:${row.observed_at}:${value}`);
    // Keep the historical/live selection tier, while making the replacement
    // explicitly identifiable as a source correction rather than old evidence.
    const payloadHash = row.payload_hash.startsWith("hist:") ? `hist:${digest}` : `source-correction:${digest}`;
    updates.push({ before: row, value, payloadHash });
  }
  return { sourceUrl: source.url, sourceCsvSha256: source.csvSha256, beforeSha256: await beforeDigest(before), updates };
}

export async function applyBreakevenCorrection(db: D1Database, plan: BreakevenCorrectionPlan): Promise<{ rowsWritten: number; appliedAt: string }> {
  const current = await db.prepare(BEFORE_SQL).all<BreakevenBeforeRow>();
  if (current.results.length !== plan.updates.length || await beforeDigest(current.results) !== plan.beforeSha256) {
    throw new Error("Production breakeven state changed since archive; no writes attempted");
  }
  const updatesJson = JSON.stringify(plan.updates);
  // D1 permits a bound string up to 2MB. Keep margin and never split an
  // economic-definition repair into batches visible as mixed definitions.
  if (new TextEncoder().encode(updatesJson).byteLength > 1_900_000) throw new Error("Correction plan exceeds atomic D1 parameter budget");
  const handle = await openAudit(db, { sourceId: "boe_breakevens:correction", sourceUrl: plan.sourceUrl });
  const appliedAt = new Date().toISOString();
  let rowsWritten = 0;
  try {
    // The MATERIALIZED guard compares EVERY archived field in the same SQL
    // statement as the update. Even a write after the initial digest check
    // cancels the complete repair. A reader sees the old or corrected series.
    const result = await db.prepare(`WITH expected AS MATERIALIZED (
      SELECT json_extract(value, '$.before.observed_at') AS observed_at,
             json_extract(value, '$.before.source_id') AS source_id,
             json_extract(value, '$.before.value') AS before_value,
             json_extract(value, '$.before.payload_hash') AS before_hash,
             json_extract(value, '$.before.ingested_at') AS before_ingested_at,
             json_extract(value, '$.before.released_at') AS before_released_at,
             json_extract(value, '$.value') AS corrected_value,
             json_extract(value, '$.payloadHash') AS corrected_hash
      FROM json_each(?)
    ), verified AS MATERIALIZED (
      SELECT (SELECT COUNT(*) FROM indicator_observations WHERE indicator_id = 'breakeven_5y') = ?
        AND (SELECT COUNT(*) FROM expected e JOIN indicator_observations o
          ON o.indicator_id = 'breakeven_5y' AND o.observed_at = e.observed_at
          AND o.source_id = e.source_id AND o.value = e.before_value
          AND o.payload_hash = e.before_hash AND o.ingested_at = e.before_ingested_at
          AND o.released_at IS e.before_released_at) = ? AS ok
    ) UPDATE indicator_observations AS o
      SET value = e.corrected_value, payload_hash = e.corrected_hash, ingested_at = ?
      FROM expected e, verified v
      WHERE o.indicator_id = 'breakeven_5y' AND o.observed_at = e.observed_at AND v.ok = 1`)
      .bind(updatesJson, plan.updates.length, plan.updates.length, appliedAt).run();
    rowsWritten = result.meta?.changes ?? 0;
    if (rowsWritten !== plan.updates.length) throw new Error("Concurrent change detected by atomic guard; no correction rows applied");
    await closeAuditSuccess(db, handle, { rowsWritten, payloadHash: plan.sourceCsvSha256, sourceUrl: plan.sourceUrl });
    return { rowsWritten, appliedAt };
  } catch (err) {
    await closeAuditFailure(db, handle, err);
    throw err;
  }
}
