/** Rows needed to select one defensible sample per indicator reference day. */
export interface BaselineObservationRow {
  indicator_id: string;
  observed_at: string;
  value: number;
  source_id?: string;
  released_at?: string | null;
  payload_hash?: string | null;
  ingested_at?: string | null;
}

/** Cache generation for the corrected shared baseline selection. Public shape stays v1. */
export const METHODOLOGY_BASELINES_CACHE_KEY = "methodology:baselines:reference-days-v2";

/**
 * "Live" rows: anything that's not historical backfill (`hist:*`) and
 * not a seed (`seed*`). Adapters write a sha256 hex digest. Historical
 * backfill writes `hist:<indicator_id>:<iso>`. Seeds write `seed_*`.
 * NULL is treated as live for safety with any pre-payload-hash data.
 */
function isLiveRow(payloadHash: string | null | undefined): boolean {
  if (payloadHash === null || payloadHash === undefined) return true;
  if (payloadHash.startsWith("hist:")) return false;
  if (payloadHash.startsWith("seed")) return false;
  return true;
}

/**
 * Drop only invalid later-dated live snapshots when the current source
 * snapshot has moved backwards in reference date. Ordinary earlier live
 * publications are history and must remain in the baseline and sparkline.
 * Historical (`hist:*`) and seed (`seed*`) rows pass through unmodified and
 * never set the current-live ceiling: a late historical revision/backfill is
 * not a new current snapshot.
 *
 * Caller-side defence against fixture-supersede bugs: when an editorial
 * fixture's `observed_at` moves backwards, the previously-written live
 * row remains in D1 and would otherwise be picked up as "the value as
 * of cutoff day" by `buildDailyPillarSparkline`. Filtering here
 * drops the erroneous later date while preserving all genuine past periods.
 * This is a working-set filter only; the underlying audit rows stay intact.
 */
export function filterStaleLiveRows(
  rows: readonly BaselineObservationRow[],
): BaselineObservationRow[] {
  // Pass 1: current live snapshot per (indicator_id, source_id). On a tie,
  // retain the later reference date (e.g. one batch containing several dates).
  const latestLive = new Map<string, BaselineObservationRow>();
  for (const r of rows) {
    if (!isLiveRow(r.payload_hash)) continue;
    const key = `${r.indicator_id}|${r.source_id ?? ""}`;
    const prev = latestLive.get(key);
    const ts = r.ingested_at ?? "";
    const prevTs = prev?.ingested_at ?? "";
    if (!prev || ts > prevTs || (ts === prevTs && r.observed_at > prev.observed_at)) {
      latestLive.set(key, r);
    }
  }
  // Pass 2: keep all earlier publications, not just the last ingest. Dropping
  // every earlier live row collapsed DMO's months of daily data to one sample
  // (a neutral 50 percentile) and erased real movement from the sparklines.
  return rows.filter((r) => {
    if (!isLiveRow(r.payload_hash)) return true;
    const key = `${r.indicator_id}|${r.source_id ?? ""}`;
    const current = latestLive.get(key)!;
    return r.observed_at <= current.observed_at;
  });
}


/**
 * One reference-day sample per indicator prevents legacy midnight and canonical
 * close timestamps from weighting the same daily publication twice. Prefer a
 * later ingested revision, then the canonical later timestamp on a tie. Source
 * rows remain untouched; only the scoring/summary working set is normalised.
 */
export function selectBaselineObservations<T extends BaselineObservationRow>(rows: readonly T[]): T[] {
  const retained = new Set(filterStaleLiveRows(rows));
  const byDay = new Map<string, T>();
  for (const row of rows) {
    if (!retained.has(row) || !Number.isFinite(row.value) || !Number.isFinite(Date.parse(row.observed_at))) continue;
    const key = `${row.indicator_id}|${row.observed_at.slice(0, 10)}`;
    const previous = byDay.get(key);
    const ingested = row.ingested_at ?? "";
    const previousIngested = previous?.ingested_at ?? "";
    if (!previous || ingested > previousIngested || (ingested === previousIngested && row.observed_at > previous.observed_at)) {
      byDay.set(key, row);
    }
  }
  const selected = new Set(byDay.values());
  return rows.filter((row) => selected.has(row));
}
