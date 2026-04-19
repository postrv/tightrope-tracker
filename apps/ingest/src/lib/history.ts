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
   * ISO-8601 timestamp of when the upstream publisher released this
   * observation, if known. Populated by adapters that get the publication
   * date from the upstream API (the ONS timeseries envelope ships
   * `updateDate` per month). Nullable because older rows pre-date the
   * feature and non-time-lagged adapters (e.g. daily gilt yields) don't
   * need it. Consumers that care about lookahead (`backfill.ts`) should
   * `released_at ?? observed_at` when comparing against a day cutoff.
   */
  released_at?: string | null;
}

/** Read the last N days of raw observations for every indicator. */
export async function readRecentObservations(
  db: D1Database,
  days: number,
): Promise<ObservationRow[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const res = await db
    .prepare(
      `SELECT indicator_id, observed_at, value, released_at
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
      `SELECT indicator_id, observed_at, value, released_at
       FROM indicator_observations
       WHERE observed_at >= ?
         AND NOT (observed_at >= ? AND observed_at <= ?)
       ORDER BY indicator_id, observed_at ASC`,
    )
    .bind(BASELINE_START_ISO, COVID_EXCLUDE_START_ISO, COVID_EXCLUDE_END_ISO)
    .all<ObservationRow>();
  return res.results ?? [];
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
