import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { RawObservation } from "@tightrope/data-sources";
import { historicalPayloadHash as sharedHistoricalPayloadHash } from "@tightrope/data-sources";

/** Re-export so the ingest worker can reach it via a single import path. */
export const historicalPayloadHash = sharedHistoricalPayloadHash;

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

export interface HistoricalWriteRejection {
  reason: string;
  indicatorId: string;
  observedAt: string;
  value: number;
}

export interface HistoricalWriteResult {
  attempted: number;
  written: number;
  rejected: HistoricalWriteRejection[];
  dryRun: boolean;
}

/**
 * Write historical observations with defensive guardrails:
 *
 *   - refuses rows dated today-UTC or later (live path owns today);
 *   - refuses NaN / ±Infinity values;
 *   - refuses rows whose `payloadHash` is missing the `hist:` prefix, so the
 *     writer can never be tricked into emitting a row that SQL treats as live;
 *   - batches writes at `HIST_BATCH_SIZE` to stay comfortably under D1's
 *     100-statement batch limit;
 *   - supports dry-run: returns the rejection list and a preview count
 *     without issuing any SQL.
 *
 * `overwrite` controls the verb: `true` → `INSERT OR REPLACE` (default, for
 * idempotent reruns); `false` → `INSERT OR IGNORE` (freeze a vintage, reject
 * later upstream revisions).
 */
const HIST_BATCH_SIZE = 50;

export async function writeHistoricalObservations(
  db: D1Database,
  observations: readonly RawObservation[],
  opts: { dryRun: boolean; overwrite: boolean },
): Promise<HistoricalWriteResult> {
  const rejected: HistoricalWriteRejection[] = [];
  const filtered: RawObservation[] = [];
  const today = new Date();
  const todayUtcStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  for (const o of observations) {
    const ts = Date.parse(o.observedAt);
    if (!Number.isFinite(ts)) {
      rejected.push({ reason: "invalid observed_at", indicatorId: o.indicatorId, observedAt: o.observedAt, value: o.value });
      continue;
    }
    if (ts >= todayUtcStart) {
      rejected.push({ reason: "observed_at is today-UTC or later", indicatorId: o.indicatorId, observedAt: o.observedAt, value: o.value });
      continue;
    }
    if (!Number.isFinite(o.value)) {
      rejected.push({ reason: "non-finite value", indicatorId: o.indicatorId, observedAt: o.observedAt, value: o.value });
      continue;
    }
    if (!o.payloadHash.startsWith("hist:")) {
      rejected.push({ reason: "payload_hash missing 'hist:' prefix", indicatorId: o.indicatorId, observedAt: o.observedAt, value: o.value });
      continue;
    }
    filtered.push(o);
  }

  if (opts.dryRun || filtered.length === 0) {
    return { attempted: observations.length, written: 0, rejected, dryRun: opts.dryRun };
  }

  const verb = opts.overwrite ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
  const stmt = db.prepare(
    `${verb} INTO indicator_observations
       (indicator_id, observed_at, value, source_id, ingested_at, payload_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  let written = 0;
  for (let i = 0; i < filtered.length; i += HIST_BATCH_SIZE) {
    const slice = filtered.slice(i, i + HIST_BATCH_SIZE);
    const batch: D1PreparedStatement[] = slice.map((o) =>
      stmt.bind(o.indicatorId, o.observedAt, o.value, o.sourceId, now, o.payloadHash),
    );
    await db.batch(batch);
    written += slice.length;
  }
  return { attempted: observations.length, written, rejected, dryRun: false };
}
