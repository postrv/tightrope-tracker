import type { D1Database } from "@cloudflare/workers-types";
import {
  BASELINE_START_ISO,
  COVID_EXCLUDE_START_ISO,
  COVID_EXCLUDE_END_ISO,
  type PillarId,
} from "@tightrope/shared";

export interface ObservationRow {
  indicator_id: string;
  observed_at: string;
  value: number;
  /**
   * The source that wrote this row. Carried so the stale-live filter
   * (`filterStaleLiveRows`) can scope dedupe to a single source — two
   * adapters legitimately producing the same indicator (housebuilders
   * via EODHD vs. fixture fallback) must each be evaluated independently.
   */
  source_id?: string;
  /**
   * ISO-8601 timestamp of when the upstream publisher released this
   * observation, if known. Populated by adapters that get the publication
   * date from the upstream API (the ONS timeseries envelope ships
   * `updateDate` per month). Nullable because older rows pre-date the
   * feature and non-time-lagged adapters (e.g. daily gilt yields) don't
   * need it. Consumers that care about lookahead (`backfill.ts`) should
   * `released_at ?? observed_at` when comparing against a day cutoff.
   */
  released_at?: string | null;
  /**
   * `payload_hash` is `'hist:*'` for backfilled rows, `'seed*'` for the
   * initial seed import, and a sha256 hex (or content-derived hash) for
   * adapter-written live rows. The stale-live filter relies on this
   * prefix convention.
   */
  payload_hash?: string | null;
  /**
   * `INSERT OR REPLACE` advances `ingested_at` to NOW for any matching
   * (indicator_id, observed_at) PK. Treat it as "when did we last write
   * this row" and use it to break ties when an editorial fixture moves
   * its observed_at backwards.
   */
  ingested_at?: string | null;
}

/** Read the last N days of raw observations for every indicator. */
export async function readRecentObservations(
  db: D1Database,
  days: number,
): Promise<ObservationRow[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const res = await db
    .prepare(
      `SELECT indicator_id, source_id, observed_at, value, released_at, payload_hash, ingested_at
       FROM indicator_observations
       WHERE observed_at >= ?
       ORDER BY indicator_id, observed_at ASC`,
    )
    .bind(cutoff)
    .all<ObservationRow>();
  return res.results ?? [];
}

/** Read the full baseline window (2019-present minus the COVID outlier). */
export async function readBaselineObservations(db: D1Database): Promise<ObservationRow[]> {
  const res = await db
    .prepare(
      `SELECT indicator_id, source_id, observed_at, value, released_at, payload_hash, ingested_at
       FROM indicator_observations
       WHERE observed_at >= ?
         AND NOT (observed_at >= ? AND observed_at <= ?)
       ORDER BY indicator_id, observed_at ASC`,
    )
    .bind(BASELINE_START_ISO, COVID_EXCLUDE_START_ISO, COVID_EXCLUDE_END_ISO)
    .all<ObservationRow>();
  return res.results ?? [];
}

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

export interface LatestLiveObservation {
  indicator_id: string;
  source_id: string;
  observed_at: string;
  value: number;
  ingested_at: string;
}

/**
 * For each indicator, return the live observation with the most recent
 * `ingested_at`. Live = `payload_hash` is neither `hist:*` nor `seed*`.
 *
 * Why not `MAX(observed_at)`? Because adapters write rows with `INSERT
 * OR REPLACE` keyed on `(indicator_id, observed_at)`. When an editorial
 * fixture changes its `observed_at` to an *earlier* date (e.g. an OBR
 * EFO fixture is corrected from a 2026-03-26 placeholder to the actual
 * 2026-03-03 publication date), the previously-written row at the
 * later observed_at survives untouched and a `MAX(observed_at)`
 * selector locks onto the stale value. `MAX(ingested_at)` tracks the
 * actual most-recently-written row, which always reflects the current
 * fixture state.
 *
 * The `WHERE` clauses on both halves of the JOIN are repeated so the
 * planner can use the same predicate on each side; a single `WHERE` on
 * the outer query is correct semantically but the duplicate keeps the
 * query plan symmetric.
 */
export async function readLatestLiveObservations(
  db: D1Database,
): Promise<LatestLiveObservation[]> {
  const res = await db
    .prepare(
      `SELECT o.indicator_id, o.source_id, o.observed_at, o.value, o.ingested_at
       FROM indicator_observations o
       JOIN (
         SELECT indicator_id, MAX(ingested_at) AS ts
         FROM indicator_observations
         WHERE payload_hash IS NULL
            OR (payload_hash NOT LIKE 'hist:%' AND payload_hash NOT LIKE 'seed%')
         GROUP BY indicator_id
       ) m ON o.indicator_id = m.indicator_id AND o.ingested_at = m.ts
         AND (o.payload_hash IS NULL
              OR (o.payload_hash NOT LIKE 'hist:%' AND o.payload_hash NOT LIKE 'seed%'))`,
    )
    .all<LatestLiveObservation>();
  return res.results ?? [];
}

/**
 * Drop "stale-live" rows: live observations that have been superseded
 * by a more recently-ingested row for the same `(indicator_id,
 * source_id)` pair. Historical (`hist:*`) and seed (`seed*`) rows
 * pass through unmodified — they represent past publications, not
 * a current live snapshot, and many of them legitimately exist per
 * indicator/source.
 *
 * Caller-side defence against fixture-supersede bugs: when an editorial
 * fixture's `observed_at` moves backwards, the previously-written live
 * row remains in D1 and would otherwise be picked up as "the value as
 * of cutoff day" by `buildDailyPillarSparkline`. Filtering here
 * restores the invariant that each (indicator, source) pair has at
 * most one live row in the working set.
 */
export function filterStaleLiveRows(
  rows: readonly ObservationRow[],
): ObservationRow[] {
  // Pass 1: latest ingested_at per (indicator_id, source_id) for live rows.
  const latestIngested = new Map<string, string>();
  for (const r of rows) {
    if (!isLiveRow(r.payload_hash)) continue;
    const key = `${r.indicator_id}|${r.source_id ?? ""}`;
    const ts = r.ingested_at ?? "";
    const prev = latestIngested.get(key);
    if (prev === undefined || ts > prev) latestIngested.set(key, ts);
  }
  // Pass 2: keep the live row whose ingested_at matches the per-pair max,
  // plus all hist:/seed rows. A hash collision on ingested_at (two writes
  // at the same millisecond, same pair) would emit both — harmless because
  // the value would be identical (INSERT OR REPLACE overwrote).
  return rows.filter((r) => {
    if (!isLiveRow(r.payload_hash)) return true;
    const key = `${r.indicator_id}|${r.source_id ?? ""}`;
    const want = latestIngested.get(key);
    return (r.ingested_at ?? "") === want;
  });
}

export interface HeadlineRow { observed_at: string; value: number; }
export interface PillarRow { pillar_id: PillarId; observed_at: string; value: number; }

export async function readHeadlineHistory(db: D1Database, days: number): Promise<HeadlineRow[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const res = await db
    .prepare(`SELECT observed_at, value FROM headline_scores WHERE observed_at >= ? ORDER BY observed_at ASC`)
    .bind(cutoff)
    .all<HeadlineRow>();
  return res.results ?? [];
}

export async function readPillarHistory(db: D1Database, days: number): Promise<PillarRow[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const res = await db
    .prepare(`SELECT pillar_id, observed_at, value FROM pillar_scores WHERE observed_at >= ? ORDER BY observed_at ASC`)
    .bind(cutoff)
    .all<PillarRow>();
  return res.results ?? [];
}

/**
 * Baseline sample: a value paired with the ISO timestamp of the row it
 * was read from, so callers can honestly label the delta ("since 19 Jan"
 * vs. a misleading "YTD" when history doesn't actually reach Jan 1).
 */
export interface HistoryBaseline {
  value: number;
  observedAt: string;
}

/**
 * Given an ordered headline series (oldest first), return the most recent
 * {value, observedAt} at least `targetAgeMs` old, or undefined if the
 * series doesn't reach back that far. Returning observedAt (not just the
 * value) lets callers surface the true baseline date to users — critical
 * for YTD/30d deltas that fall back to a nearer row because history
 * doesn't yet stretch to the ideal window.
 */
export function valueAtLeastAgo(
  series: readonly { observed_at: string; value: number }[],
  targetAgeMs: number,
  now: Date = new Date(),
): HistoryBaseline | undefined {
  const cutoff = now.getTime() - targetAgeMs;
  for (let i = series.length - 1; i >= 0; i--) {
    const ts = new Date(series[i]!.observed_at).getTime();
    if (ts <= cutoff) return { value: series[i]!.value, observedAt: series[i]!.observed_at };
  }
  return undefined;
}

/**
 * Return the oldest {value, observedAt} in `series` only if the row is at
 * least `minAgeMs` old. Used as a fallback when `valueAtLeastAgo` can't
 * reach the ideal target window: emits "delta since we started tracking"
 * rather than 0, but guards against labelling a 2-day-old row as a 30-day
 * baseline by requiring a minimum age. When history eventually extends
 * past the target window, the primary `valueAtLeastAgo` lookup wins and
 * this fallback goes unused.
 */
export function valueOldestIfAged(
  series: readonly { observed_at: string; value: number }[],
  minAgeMs: number,
  now: Date = new Date(),
): HistoryBaseline | undefined {
  if (series.length === 0) return undefined;
  const oldest = series[0]!;
  const ageMs = now.getTime() - new Date(oldest.observed_at).getTime();
  return ageMs >= minAgeMs ? { value: oldest.value, observedAt: oldest.observed_at } : undefined;
}

/**
 * Downsample a time-series to one value per UTC day (latest observation per
 * day wins). Used for the headline 90d sparkline: recompute writes a row
 * every 5 minutes, so a naive slice(-90) would cover ~7.5 hours rather than
 * 90 days. Output is ascending by day. Days with no observation are skipped
 * entirely rather than carried forward — the sparkline renders as "days
 * covered" rather than "last-known for an arbitrary cutoff".
 */
export function downsampleLatestPerDay(
  series: readonly { observed_at: string; value: number }[],
): number[] {
  const latestByDay = new Map<string, { ts: string; v: number }>();
  for (const row of series) {
    // `observed_at` is ISO8601 with a 'T' separator. Treat the first 10 chars
    // as the UTC calendar date — that's stable across the two row formats
    // D1 may return (`2026-04-18T17:25:36.084Z` vs `2026-04-18 17:25:36`).
    const day = row.observed_at.slice(0, 10);
    const prev = latestByDay.get(day);
    if (!prev || row.observed_at > prev.ts) latestByDay.set(day, { ts: row.observed_at, v: row.value });
  }
  return [...latestByDay.keys()].sort().map((d) => latestByDay.get(d)!.v);
}
