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
}

/** Read the last N days of raw observations for every indicator. */
export async function readRecentObservations(
  db: D1Database,
  days: number,
): Promise<ObservationRow[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const res = await db
    .prepare(
      `SELECT indicator_id, observed_at, value
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
      `SELECT indicator_id, observed_at, value
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
 * Given an ordered headline series (oldest first), return the most recent
 * value at least `targetAgeMs` old, or undefined if the series doesn't reach
 * back that far.
 */
export function valueAtLeastAgo(
  series: readonly { observed_at: string; value: number }[],
  targetAgeMs: number,
  now: Date = new Date(),
): number | undefined {
  const cutoff = now.getTime() - targetAgeMs;
  for (let i = series.length - 1; i >= 0; i--) {
    const ts = new Date(series[i]!.observed_at).getTime();
    if (ts <= cutoff) return series[i]!.value;
  }
  return undefined;
}
