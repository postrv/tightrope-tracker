import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { RawObservation } from "@tightrope/data-sources";

/**
 * Write a batch of raw observations with `INSERT OR REPLACE` semantics so a
 * re-run of the same ingest (same indicator + observed_at) overwrites the
 * previous value idempotently.
 */
export async function writeObservations(
  db: D1Database,
  observations: readonly RawObservation[],
): Promise<number> {
  if (observations.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO indicator_observations
       (indicator_id, observed_at, value, source_id, ingested_at, payload_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  const batch: D1PreparedStatement[] = observations.map((o) =>
    stmt.bind(o.indicatorId, o.observedAt, o.value, o.sourceId, now, o.payloadHash),
  );
  await db.batch(batch);
  return observations.length;
}
