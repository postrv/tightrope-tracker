import type { D1Database } from "@cloudflare/workers-types";
import {
  PILLAR_ORDER, SCORE_DIRECTION, SCORE_HISTORY_SCHEMA_VERSION,
  type Iso8601, type PillarId, type ScoreHistory, type ScoreHistoryPoint,
  type ScoreHistoryResolution, type ScoreHistoryResolutionRequest,
} from "@tightrope/shared";

export const HISTORY_MAX_DAYS = 7305;
export const HISTORY_POINT_LIMIT = 2000;
export const HISTORY_RESOLUTIONS = ["auto", "raw", "hourly", "daily", "weekly"] as const;

export function clampHistoryDays(days: number): number {
  return Number.isFinite(days) ? Math.max(1, Math.min(HISTORY_MAX_DAYS, Math.floor(days))) : 90;
}

export function resolveHistoryResolution(days: number, requested: ScoreHistoryResolutionRequest): ScoreHistoryResolution {
  const chosen = requested === "auto"
    ? days <= 2 ? "raw" : days <= 14 ? "hourly" : days <= 366 ? "daily" : "weekly"
    : requested;
  // Bound response size before querying. Five-minute is the recording cadence,
  // not the upstream publication cadence. A wider request is explicitly coarsened.
  if (chosen === "raw" && days * 288 <= HISTORY_POINT_LIMIT) return "raw";
  if ((chosen === "raw" || chosen === "hourly") && days * 24 <= HISTORY_POINT_LIMIT) return "hourly";
  if (chosen !== "weekly" && days <= HISTORY_POINT_LIMIT) return "daily";
  return "weekly";
}

interface HistoryRow {
  observed_at: string;
  value: number;
  market: number | null;
  fiscal: number | null;
  labour: number | null;
  delivery: number | null;
}

/** Shared API/SSR reader. Every pillar is the last published value AT the
 * headline timestamp, including pre-window carry-forward. Independent pillar
 * downsampling could lose that row or leak a later update into an earlier point. */
export async function readScoreHistory(
  db: D1Database,
  days: number,
  requestedResolution: ScoreHistoryResolutionRequest = "auto",
): Promise<ScoreHistory> {
  const rangeDays = clampHistoryDays(days);
  const now = new Date().toISOString();
  const cutoff = new Date(Date.parse(now) - rangeDays * 86_400_000).toISOString();
  const bounds = await db.prepare(`SELECT MIN(observed_at) AS first, MAX(observed_at) AS last
    FROM headline_scores WHERE observed_at <= ?1`).bind(now).all<{ first: string | null; last: string | null }>();
  const firstAvailable = bounds.results[0]?.first;
  const coveredDays = firstAvailable && Number.isFinite(Date.parse(firstAvailable))
    ? Math.min(rangeDays, Math.max(1, Math.ceil((Date.parse(now) - Date.parse(firstAvailable)) / 86_400_000)))
    : rangeDays;
  // "All + daily" should retain daily detail when the actual archive fits.
  // The20-year request ceiling must not force a two-year archive into weeks.
  const resolution = resolveHistoryResolution(coveredDays, requestedResolution);
  // Expressions are selected from constants, never interpolated user input.
  const bucket = {
    raw: "observed_at", hourly: "substr(observed_at, 1, 13)",
    daily: "substr(observed_at, 1, 10)", weekly: "date(observed_at, 'weekday 0', '-6 days')",
  }[resolution];
  const sample = await db.prepare(`WITH selected AS (
      SELECT MAX(observed_at) AS ts FROM headline_scores
      WHERE observed_at >= ?1 AND observed_at <= ?2
      GROUP BY ${bucket} ORDER BY ts DESC LIMIT ?3
    )
    SELECT h.observed_at, h.value,
      (SELECT value FROM pillar_scores WHERE pillar_id = 'market' AND observed_at <= h.observed_at ORDER BY observed_at DESC LIMIT 1) AS market,
      (SELECT value FROM pillar_scores WHERE pillar_id = 'fiscal' AND observed_at <= h.observed_at ORDER BY observed_at DESC LIMIT 1) AS fiscal,
      (SELECT value FROM pillar_scores WHERE pillar_id = 'labour' AND observed_at <= h.observed_at ORDER BY observed_at DESC LIMIT 1) AS labour,
      (SELECT value FROM pillar_scores WHERE pillar_id = 'delivery' AND observed_at <= h.observed_at ORDER BY observed_at DESC LIMIT 1) AS delivery
    FROM selected s JOIN headline_scores h ON h.observed_at = s.ts
    ORDER BY h.observed_at ASC`).bind(cutoff, now, HISTORY_POINT_LIMIT + 1).all<HistoryRow>();
  const truncated = sample.results.length > HISTORY_POINT_LIMIT;
  const rows = truncated ? sample.results.slice(-HISTORY_POINT_LIMIT) : sample.results;
  const points: ScoreHistoryPoint[] = [];
  for (const row of rows) {
    const validScore = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100;
    if (!Number.isFinite(Date.parse(row.observed_at)) || !validScore(row.value) || PILLAR_ORDER.some(p => !validScore(row[p]))) continue;
    const pillars = Object.fromEntries(PILLAR_ORDER.map(p => [p, row[p]])) as Record<PillarId, number>;
    points.push({ timestamp: row.observed_at as Iso8601, headline: row.value, pillars });
  }
  return {
    points, rangeDays, resolution, requestedResolution, sampling: "last_recorded_in_bucket",
    availableFrom: (bounds.results[0]?.first ?? null) as Iso8601 | null,
    availableTo: (bounds.results[0]?.last ?? null) as Iso8601 | null,
    selectedFrom: points[0]?.timestamp ?? null, selectedTo: points.at(-1)?.timestamp ?? null,
    pointLimit: HISTORY_POINT_LIMIT, truncated, excludedPoints: rows.length - points.length,
    scoreDirection: SCORE_DIRECTION, schemaVersion: SCORE_HISTORY_SCHEMA_VERSION,
  };
}
