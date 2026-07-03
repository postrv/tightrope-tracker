import type { D1Database } from "@cloudflare/workers-types";
import { readLatestObservations } from "@tightrope/snapshot";

/**
 * The latest PUBLISHED observation per indicator — the G4 delta baseline and
 * the G6 "strictly newer than last" reference, keyed by indicator_id.
 *
 * Deliberately defers to the canonical two-tier selector in
 * `@tightrope/snapshot` (readLatestObservations) rather than re-implementing
 * the SQL: that package exists precisely so this rule has ONE copy. Read ONCE
 * per verifyExtraction (not per value) and handed to every gate — a multi-value
 * spec (MHCLG) no longer re-queries the whole table for each indicator.
 */
export async function readLatestPublishedObservations(
  db: D1Database,
): Promise<Map<string, { value: number; observedAt: string }>> {
  const all = await readLatestObservations(db);
  const out = new Map<string, { value: number; observedAt: string }>();
  for (const r of all) out.set(r.indicator_id, { value: r.value, observedAt: r.observed_at });
  return out;
}

/** The exact currently-published value at (indicator, observed_at), if any. */
export async function readPublishedValueAt(
  db: D1Database,
  indicatorId: string,
  observedAt: string,
): Promise<number | null> {
  const row = await db
    .prepare("SELECT value FROM indicator_observations WHERE indicator_id = ? AND observed_at = ?")
    .bind(indicatorId, observedAt)
    .first<{ value: number }>();
  return row ? row.value : null;
}

export interface PublishObservationInput {
  indicatorId: string;
  observedAt: string;
  value: number;
  sourceId: string;
  /** "ai:" + contentSha256 — keeps the row in the LIVE tier of the selector. */
  payloadHash: string;
  releasedAt: string | null;
}

/**
 * INSERT OR REPLACE one observation into the LIVE tier. The "ai:" payload_hash
 * prefix (set by the caller) is neither 'hist:%' nor 'seed%', so the two-tier
 * selector treats it as a live row picked up by the next 5-minute recompute —
 * no KV surgery. Idempotent per (indicator_id, observed_at).
 */
export async function publishObservation(db: D1Database, input: PublishObservationInput): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO indicator_observations
         (indicator_id, observed_at, value, source_id, ingested_at, payload_hash, released_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.indicatorId,
      input.observedAt,
      input.value,
      input.sourceId,
      new Date().toISOString(),
      input.payloadHash,
      input.releasedAt,
    )
    .run();
}

export interface CorrectionInput {
  id: string;
  publishedAt: string;
  affectedIndicator: string;
  originalValue: string;
  correctedValue: string;
  reason: string;
}

/**
 * Append one row to the public corrections log — a revision of an
 * already-published value is public (matches db/patches/log-2026-04-29-*.sql).
 * INSERT OR IGNORE keyed on the deterministic id so a re-published-identical
 * correction is a no-op.
 */
export async function insertCorrection(db: D1Database, c: CorrectionInput): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO corrections
         (id, published_at, affected_indicator, original_value, corrected_value, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(c.id, c.publishedAt, c.affectedIndicator, c.originalValue, c.correctedValue, c.reason)
    .run();
}
