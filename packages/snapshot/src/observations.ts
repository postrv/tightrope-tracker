import type { D1Database } from "@cloudflare/workers-types";

/**
 * A single latest observation as selected by the two-tier selector.
 *
 * Superset of the columns each consumer needs: the api/web snapshot path
 * reads `value` / `observed_at` / `source_id`; the ingest recompute path
 * reads `value` / `observed_at`. `ingested_at` is carried for callers that
 * want the write-time tiebreaker. This shape is what the ingest worker
 * previously exported as `LatestLiveObservation`.
 */
export interface LatestObservationRow {
  indicator_id: string;
  source_id: string;
  observed_at: string;
  value: number;
  ingested_at: string;
  /**
   * Upstream publication instant (ONS `updateDate`, OBR vintage date), NULL
   * for feeds where published ≈ observed (daily BoE/FX). Carried so the
   * cadence registry (§2.1) can anchor on the real release time rather than
   * the reference period. Additive projection — existing consumers ignore it.
   */
  released_at: string | null;
}

/**
 * For each indicator, return the single freshest observation under the
 * canonical two-tier selector.
 *
 * THIS IS THE ONLY COPY of this SQL. It previously existed as three
 * hand-synced copies — `apps/api/src/lib/db.ts`, `apps/web/src/lib/db.ts`,
 * and `apps/ingest/src/lib/history.ts::readLatestLiveObservations`.
 * Reconciliation note (2026-07-03): the three copies were byte-identical in
 * tier logic and ordering; they differed only in the outer column
 * projection (api/web omitted `ingested_at`, the ingest copy included it).
 * The api version carried the canonical 2026-04-29 audit semantics; this
 * function reproduces those semantics verbatim and returns the superset
 * projection so every consumer is served from one rule — keeping the KV
 * snapshot (written by recompute) and the D1-fallback path (api/web) in
 * permanent agreement on which row is "current".
 *
 *  TIER 1 (live):  MAX(ingested_at) over rows whose payload_hash is not
 *                  'hist:%' and not 'seed%'. Live adapters write a sha256
 *                  (no prefix); the NULL fallback covers pre-payload_hash
 *                  rows. Picking by ingested_at — not observed_at —
 *                  protects against a previously-written fixture row whose
 *                  observed_at lingers (OBR EFO synthetic date superseded
 *                  by an EFO whose real publication date is earlier).
 *  TIER 2 (hist):  MAX(observed_at) over hist:% rows. Backfill rows are
 *                  real prints we trust; tier 2 only wins the outer ranking
 *                  when its observed_at is strictly newer than tier 1's —
 *                  surfacing backfill when a live adapter is silently
 *                  falling through to a stale-dated fixture.
 *  Final ordering (per indicator):
 *      observed_at DESC                        — freshest reading wins
 *      is_hist ASC (live before hist on ties)  — live overrides backfill
 *      ingested_at DESC                        — last writer breaks ties
 *
 *  Audit fix 2026-04-29 (Fix C/D, "Brent + FTSE 250 silent stale"): before
 *  the hist tier existed, the FTSE 250 fixture-fall-through row at
 *  observed_at=2026-04-23 won over the backfill row at 2026-04-24 because
 *  MAX(ingested_at) anchored on the most-recent fixture write. Surfacing the
 *  backfill row is honestly fresher data without inventing editorial values.
 *  See packages/snapshot/src/observations.test.ts and
 *  apps/api/src/tests/snapshot-fixture-supersede.test.ts for the regression
 *  suite this preserves.
 */
export async function readLatestObservations(
  db: D1Database,
): Promise<LatestObservationRow[]> {
  const res = await db
    .prepare(
      `SELECT indicator_id, source_id, observed_at, value, ingested_at, released_at FROM (
         SELECT indicator_id, source_id, observed_at, value, ingested_at, released_at, payload_hash,
                ROW_NUMBER() OVER (
                  PARTITION BY indicator_id
                  ORDER BY observed_at DESC,
                           CASE WHEN payload_hash LIKE 'hist:%' THEN 1 ELSE 0 END ASC,
                           ingested_at DESC
                ) AS rn
         FROM (
           SELECT o.indicator_id, o.source_id, o.observed_at, o.value, o.ingested_at, o.released_at, o.payload_hash
           FROM indicator_observations o
           JOIN (
             SELECT indicator_id, MAX(ingested_at) AS ts
             FROM indicator_observations
             WHERE payload_hash IS NULL
                OR (payload_hash NOT LIKE 'hist:%' AND payload_hash NOT LIKE 'seed%')
             GROUP BY indicator_id
           ) m ON o.indicator_id = m.indicator_id AND o.ingested_at = m.ts
              AND (o.payload_hash IS NULL
                   OR (o.payload_hash NOT LIKE 'hist:%' AND o.payload_hash NOT LIKE 'seed%'))
           UNION ALL
           SELECT o.indicator_id, o.source_id, o.observed_at, o.value, o.ingested_at, o.released_at, o.payload_hash
           FROM indicator_observations o
           JOIN (
             SELECT indicator_id, MAX(observed_at) AS oa
             FROM indicator_observations
             WHERE payload_hash LIKE 'hist:%'
             GROUP BY indicator_id
           ) m ON o.indicator_id = m.indicator_id AND o.observed_at = m.oa
              AND o.payload_hash LIKE 'hist:%'
         ) candidates
       ) ranked WHERE rn = 1`,
    )
    .all<LatestObservationRow>();
  return res.results ?? [];
}
