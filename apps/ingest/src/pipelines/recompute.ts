import type { D1PreparedStatement } from "@cloudflare/workers-types";
import {
  INDICATORS,
  PILLAR_ORDER,
  computeSourceHealth,
  evaluatePillarFreshness,
  type IndicatorDefinition,
  type PillarId,
  type PillarScore,
  type ScoreHistory,
  type ScoreHistoryPoint,
  type ScoreSnapshot,
  type SourceHealthEntry,
} from "@tightrope/shared";
import {
  assembleSnapshot,
  computeHeadlineScore,
  computePillarScore,
  type IndicatorReading,
} from "@tightrope/methodology";
import type { Env } from "../env.js";
import {
  downsampleLatestPerDay,
  filterStaleLiveRows,
  readBaselineObservations,
  readHeadlineHistory,
  readLatestLiveObservations,
  readPillarHistory,
  readRecentObservations,
  valueAtLeastAgo,
  valueOldestIfAged,
  type ObservationRow,
} from "../lib/history.js";
import { maybeAlertSourceHealth } from "./alerts.js";

const KV_TTL_6H = 60 * 60 * 6;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function recomputeScores(env: Env): Promise<ScoreSnapshot | null> {
  const [baselineRaw, recentRaw, headlineHist, pillarHist, latestLive] = await Promise.all([
    readBaselineObservations(env.DB),
    readRecentObservations(env.DB, 365),
    readHeadlineHistory(env.DB, 365),
    readPillarHistory(env.DB, 90),
    readLatestLiveObservations(env.DB),
  ]);
  if (recentRaw.length === 0) return null;

  // Apply the same stale-live filter to both windows. This drops live rows
  // that have been superseded by a more recently-ingested row for the
  // same (indicator_id, source_id), keeping all hist:/seed rows. Without
  // this, an editorial fixture whose `observed_at` moved backwards leaves
  // the daily-pillar-sparkline picking the stale row when scanning by
  // `observed_at <= cutoff`. See packages/data-sources fixture audit notes.
  const recent = filterStaleLiveRows(recentRaw);
  const baseline = filterStaleLiveRows(baselineRaw);

  // `latestByIndicator` is sourced from a dedicated MAX(ingested_at) query
  // that excludes hist:/seed rows. This is the only correct selector for
  // "what is the live value right now" — see
  // apps/api/src/tests/snapshot-fixture-supersede.test.ts for the
  // regression cases that motivated it.
  const latestByIndicator = new Map<string, { value: number; observedAt: string }>();
  for (const row of latestLive) {
    latestByIndicator.set(row.indicator_id, { value: row.value, observedAt: row.observed_at });
  }
  const baselineByIndicator = new Map<string, number[]>();
  for (const row of baseline) {
    const arr = baselineByIndicator.get(row.indicator_id) ?? [];
    arr.push(row.value);
    baselineByIndicator.set(row.indicator_id, arr);
  }

  // Per-pillar 30d sparkline derived day-by-day from indicator_observations:
  // for each of the last 30 days take the latest observation as of that day
  // for every indicator in the pillar, then re-run computePillarScore. This
  // gives a real movement curve even for pillars whose pillar_scores rows
  // happen to be flat (e.g. when all indicators read the same value at every
  // recompute, but the pillar score itself was different a week ago because a
  // single indicator updated mid-week).
  const pillarHistByPillar: Record<PillarId, { observed_at: string; value: number }[]> = {
    market: [], fiscal: [], labour: [], delivery: [],
  };
  for (const row of pillarHist) {
    pillarHistByPillar[row.pillar_id].push({ observed_at: row.observed_at, value: row.value });
  }
  const now = new Date();
  const updatedAt = now.toISOString();

  const pillarSparks: Record<PillarId, number[]> = {
    market: [], fiscal: [], labour: [], delivery: [],
  };
  for (const p of PILLAR_ORDER) {
    const indicatorsForPillar = Object.values(INDICATORS).filter((i) => i.pillar === p);
    pillarSparks[p] = buildDailyPillarSparkline(
      p,
      indicatorsForPillar,
      recent,
      baselineByIndicator,
      30,
      now,
    );
  }

  // Build per-pillar readings and compute.
  const pillars: Partial<Record<PillarId, PillarScore>> = {};
  let anyStale = false;
  for (const pillarId of PILLAR_ORDER) {
    const pillarIndicators = Object.values(INDICATORS).filter((i) => i.pillar === pillarId);
    const readings: IndicatorReading[] = [];
    for (const def of pillarIndicators) {
      const latest = latestByIndicator.get(def.id);
      if (!latest) continue;
      readings.push({
        indicatorId: def.id,
        value: latest.value,
        observedAt: latest.observedAt,
        baseline: baselineByIndicator.get(def.id) ?? [],
      });
    }
    // Quorum check uses per-indicator freshness windows + excludes
    // never-observed indicators from the denominator. See
    // packages/shared/src/staleness.ts::evaluatePillarFreshness.
    const freshness = evaluatePillarFreshness(pillarId, pillarIndicators, latestByIndicator, now);
    if (freshness.stale) {
      anyStale = true;
      const stalePart = freshness.staleIndicatorIds.length > 0
        ? `stale=[${freshness.staleIndicatorIds.join(",")}]` : "stale=[]";
      const missingPart = freshness.missingIndicatorIds.length > 0
        ? ` missing=[${freshness.missingIndicatorIds.join(",")}]` : "";
      console.warn(
        `recompute: pillar '${pillarId}' failed quorum -- ${freshness.freshCount}/${freshness.observedCount} fresh (quorum ${freshness.quorum}). ${stalePart}${missingPart}`,
      );
    }
    const value7dBaseline = valueAtLeastAgo(pillarHistByPillar[pillarId], 7 * DAY_MS, now);
    const input = {
      readings,
      sparkline30d: pillarSparks[pillarId],
      ...(value7dBaseline !== undefined ? { value7dAgo: value7dBaseline.value } : {}),
    };
    const score = computePillarScore(pillarId, input);
    pillars[pillarId] = freshness.stale ? { ...score, stale: true } : score;
  }

  const pillarRecord = pillars as Record<PillarId, PillarScore>;
  const stalePillarIds = (Object.entries(pillarRecord) as [PillarId, PillarScore][])
    .filter(([, ps]) => ps.stale)
    .map(([id]) => id);

  // 90d headline sparkline, downsampled to one point per UTC day. Without
  // this, the 90-row slice below covers ~7.5 hours of 5-minute recompute
  // rows, producing a flat line every day indicators hold steady.
  const sparkline90d = downsampleLatestPerDay(headlineHist).slice(-90);
  const baseline24h = valueAtLeastAgo(headlineHist, 24 * 60 * 60 * 1000, now);
  // When history doesn't reach back 30d / YTD (bootstrap period before the
  // historical backfill has run), fall back to the oldest available row if
  // it's at least 7 days old so the deltas render a meaningful "since we
  // started tracking" number rather than a flat 0. Converges to the true 30d
  // / YTD delta as history accumulates.
  //
  // The baseline's observedAt is threaded through to HeadlineScore so the UI
  // can honestly label a fallback result "since 19 Jan" rather than a
  // misleading "YTD" — the bug that had delta30d == deltaYtd == -7.9 in
  // production was rooted in both lookups silently falling back to the same
  // oldest row with no disclosure to the consumer.
  const MIN_FALLBACK_AGE_MS = 7 * DAY_MS;
  const baseline30d = valueAtLeastAgo(headlineHist, 30 * DAY_MS, now)
    ?? valueOldestIfAged(headlineHist, MIN_FALLBACK_AGE_MS, now);
  const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const ytdMs = now.getTime() - startOfYear.getTime();
  const baselineYtd = valueAtLeastAgo(headlineHist, ytdMs, now)
    ?? valueOldestIfAged(headlineHist, MIN_FALLBACK_AGE_MS, now);

  const headlineCore = computeHeadlineScore({
    pillars: pillarRecord,
    sparkline90d,
    updatedAt,
    ...(baseline24h !== undefined ? { value24hAgo: baseline24h.value } : {}),
    ...(baseline30d !== undefined ? {
      value30dAgo: baseline30d.value,
      value30dAgoObservedAt: baseline30d.observedAt,
    } : {}),
    ...(baselineYtd !== undefined ? {
      valueYtdAgo: baselineYtd.value,
      valueYtdAgoObservedAt: baselineYtd.observedAt,
    } : {}),
  });
  const headline = anyStale ? { ...headlineCore, stale: true } : headlineCore;
  if (anyStale) {
    console.warn("recompute: at least one pillar stale -- refusing to rewrite headline_scores; snapshot still served via KV with stale flag.");
  }

  const snapshot = assembleSnapshot(pillarRecord, headline);
  const sourceHealth = await readSourceHealth(env);
  if (sourceHealth.length > 0) snapshot.sourceHealth = sourceHealth;

  // Fire source-health alerts (no-op if ALERT_WEBHOOK_URL is unset, and
  // swallows webhook errors so recompute never blocks on a Slack outage).
  await maybeAlertSourceHealth(env, sourceHealth);

  // Persist: D1 (headline + non-stale pillars only), KV (snapshot + history).
  // We intentionally skip writing stale rows so the historical series in D1
  // only ever contains points that were fresh when written. The API's latest
  // read still returns the last-fresh row; the pillar.stale/headline.stale
  // flags are inferred at serve time from the observed_at age.
  await persistScores(env, snapshot, updatedAt, { skipHeadline: anyStale, skipPillars: stalePillarIds });
  await env.KV.put("score:latest", JSON.stringify(snapshot), { expirationTtl: KV_TTL_6H });

  const history = buildHistory(headlineHist, pillarHistByPillar);
  await env.KV.put("score:history:90d", JSON.stringify(history), { expirationTtl: KV_TTL_6H });

  return snapshot;
}

async function persistScores(
  env: Env,
  snapshot: ScoreSnapshot,
  observedAt: string,
  opts: { skipHeadline?: boolean; skipPillars?: readonly PillarId[] } = {},
): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  if (!opts.skipHeadline) {
    stmts.push(
      env.DB
        .prepare(
          `INSERT OR REPLACE INTO headline_scores (observed_at, value, band, dominant, editorial)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          observedAt,
          snapshot.headline.value,
          snapshot.headline.band,
          snapshot.headline.dominantPillar,
          snapshot.headline.editorial,
        ),
    );
  }
  const skipPillars = new Set(opts.skipPillars ?? []);
  for (const p of PILLAR_ORDER) {
    if (skipPillars.has(p)) continue;
    const ps = snapshot.pillars[p];
    stmts.push(
      env.DB
        .prepare(
          `INSERT OR REPLACE INTO pillar_scores (pillar_id, observed_at, value, band)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(p, observedAt, ps.value, ps.band),
    );
  }
  if (stmts.length > 0) await env.DB.batch(stmts);
}

/**
 * Load the per-source latest-attempt + last-success rollups and derive the
 * sourceHealth list the homepage banner renders. Done here so the snapshot
 * cached under `score:latest` already carries the flag -- the API handler's
 * cache-hit path returns the cached snapshot verbatim, so deriving this only
 * on the cache-miss path leaves the homepage blind while the cache is warm.
 */
async function readSourceHealth(env: Env): Promise<readonly SourceHealthEntry[]> {
  const [latestAttempts, lastSuccesses] = await Promise.all([
    env.DB.prepare(
      `SELECT i.source_id, i.started_at, i.status FROM ingestion_audit i
       JOIN (
         SELECT source_id, MAX(started_at) AS ts FROM ingestion_audit GROUP BY source_id
       ) m ON i.source_id = m.source_id AND i.started_at = m.ts`,
    ).all<{ source_id: string; started_at: string; status: string }>(),
    env.DB.prepare(
      // 'unchanged' counts as a healthy fetch (upstream returned 200 with
      // a byte-identical body), so include it in the "last success" query
      // — otherwise a source that runs daily but only publishes monthly
      // (e.g. ONS PSF) would show as "last successful run 30 days ago".
      `SELECT source_id, MAX(started_at) AS last_success
       FROM ingestion_audit WHERE status IN ('success', 'unchanged') GROUP BY source_id`,
    ).all<{ source_id: string; last_success: string }>(),
  ]);
  const lastSuccessBySource: Record<string, string> = {};
  for (const r of lastSuccesses.results) lastSuccessBySource[r.source_id] = r.last_success;
  return computeSourceHealth(
    latestAttempts.results.map((r) => ({ sourceId: r.source_id, startedAt: r.started_at, status: r.status })),
    lastSuccessBySource,
  );
}

/**
 * Build a 30-day daily sparkline for a pillar by re-running the pillar
 * scoring against the latest indicator observations as of each day in the
 * window. Days where no indicator has any observation yet carry forward the
 * previous day's value (or 0 at the start). Empty days at the *front* are
 * dropped so the chart doesn't render a leading flat shelf.
 */
function buildDailyPillarSparkline(
  pillarId: PillarId,
  pillarIndicators: readonly IndicatorDefinition[],
  recent: readonly ObservationRow[],
  baselineByIndicator: Map<string, number[]>,
  days: number,
  now: Date,
): number[] {
  const indicatorIds = new Set(pillarIndicators.map((d) => d.id));
  const byIndicator = new Map<string, ObservationRow[]>();
  for (const r of recent) {
    if (!indicatorIds.has(r.indicator_id)) continue;
    const arr = byIndicator.get(r.indicator_id);
    if (arr) arr.push(r);
    else byIndicator.set(r.indicator_id, [r]);
  }

  const series: number[] = [];
  const nowMs = now.getTime();
  for (let i = days - 1; i >= 0; i--) {
    const cutoffMs = nowMs - i * DAY_MS;
    const readings: IndicatorReading[] = [];
    for (const def of pillarIndicators) {
      const arr = byIndicator.get(def.id);
      if (!arr || arr.length === 0) continue;
      // Linear scan from latest backwards; arr is ascending by observed_at.
      let pick: ObservationRow | undefined;
      for (let j = arr.length - 1; j >= 0; j--) {
        const ts = new Date(arr[j]!.observed_at).getTime();
        if (ts <= cutoffMs) { pick = arr[j]!; break; }
      }
      if (!pick) continue;
      readings.push({
        indicatorId: def.id,
        value: pick.value,
        observedAt: pick.observed_at,
        baseline: baselineByIndicator.get(def.id) ?? [],
      });
    }
    if (readings.length === 0) {
      const prev = series.length > 0 ? series[series.length - 1]! : null;
      if (prev !== null) series.push(prev);
      continue;
    }
    const score = computePillarScore(pillarId, { readings, sparkline30d: [] });
    series.push(score.value);
  }
  return series;
}

function buildHistory(
  headline: { observed_at: string; value: number }[],
  pillarHist: Record<PillarId, { observed_at: string; value: number }[]>,
): ScoreHistory {
  // Downsample headline to one row per UTC day (latest per day wins). Without
  // this, the recompute writes ~300 rows per day to headline_scores and the
  // chart's slice(-90) below collapses to ~7.5 hours of today's intraday
  // recomputes, hiding 89 days of real history. Mirrors the SQL-side
  // GROUP BY substr(observed_at, 1, 10) used in apps/api/src/lib/db.ts and
  // apps/web/src/lib/db.ts when reading history live from D1.
  const headlineDaily = downsampleLatestPerDayKeepTs(headline);

  // Align pillar values to each headline timestamp using last-known values.
  const points: ScoreHistoryPoint[] = [];
  const cursors: Record<PillarId, number> = { market: 0, fiscal: 0, labour: 0, delivery: 0 };
  const last: Record<PillarId, number> = { market: 0, fiscal: 0, labour: 0, delivery: 0 };
  for (const h of headlineDaily) {
    const ts = h.observed_at;
    for (const p of PILLAR_ORDER) {
      const arr = pillarHist[p];
      while (cursors[p] < arr.length && arr[cursors[p]]!.observed_at <= ts) {
        last[p] = arr[cursors[p]]!.value;
        cursors[p] += 1;
      }
    }
    points.push({
      timestamp: ts,
      headline: h.value,
      pillars: { market: last.market, fiscal: last.fiscal, labour: last.labour, delivery: last.delivery },
    });
  }
  return { points: points.slice(-90), rangeDays: 90, schemaVersion: 1 };
}

/**
 * Like `downsampleLatestPerDay` (which returns just the values for sparklines),
 * but keeps each day's latest row intact so the caller can use `observed_at`
 * to align other series (pillar history) to the same per-day cadence.
 */
function downsampleLatestPerDayKeepTs(
  series: readonly { observed_at: string; value: number }[],
): { observed_at: string; value: number }[] {
  const latestByDay = new Map<string, { observed_at: string; value: number }>();
  for (const row of series) {
    const day = row.observed_at.slice(0, 10);
    const prev = latestByDay.get(day);
    if (!prev || row.observed_at > prev.observed_at) latestByDay.set(day, row);
  }
  return [...latestByDay.keys()].sort().map((d) => latestByDay.get(d)!);
}
