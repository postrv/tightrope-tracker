import type { D1PreparedStatement } from "@cloudflare/workers-types";
import {
  INDICATORS,
  PILLAR_ORDER,
  computeSourceHealth,
  maxStaleMsForPillar,
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
  readBaselineObservations,
  readHeadlineHistory,
  readPillarHistory,
  readRecentObservations,
  valueAtLeastAgo,
} from "../lib/history.js";

const KV_TTL_6H = 60 * 60 * 6;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Fraction of pillar indicators that must be fresh to count as a quorum. */
const QUORUM_FRACTION = 0.5;

export async function recomputeScores(env: Env): Promise<ScoreSnapshot | null> {
  const [baseline, recent, headlineHist, pillarHist] = await Promise.all([
    readBaselineObservations(env.DB),
    readRecentObservations(env.DB, 365),
    readHeadlineHistory(env.DB, 365),
    readPillarHistory(env.DB, 90),
  ]);
  if (recent.length === 0) return null;

  // Group recent and baseline observations by indicator.
  const latestByIndicator = new Map<string, { value: number; observedAt: string }>();
  const baselineByIndicator = new Map<string, number[]>();
  for (const row of recent) {
    // Walk ascending; the final write wins.
    latestByIndicator.set(row.indicator_id, { value: row.value, observedAt: row.observed_at });
  }
  for (const row of baseline) {
    const arr = baselineByIndicator.get(row.indicator_id) ?? [];
    arr.push(row.value);
    baselineByIndicator.set(row.indicator_id, arr);
  }

  // Per-pillar 30d sparkline from pillar_scores history.
  const pillarSparks: Record<PillarId, number[]> = {
    market: [], fiscal: [], labour: [], delivery: [],
  };
  const pillarHistByPillar: Record<PillarId, { observed_at: string; value: number }[]> = {
    market: [], fiscal: [], labour: [], delivery: [],
  };
  for (const row of pillarHist) {
    pillarHistByPillar[row.pillar_id].push({ observed_at: row.observed_at, value: row.value });
  }
  for (const p of PILLAR_ORDER) {
    // Most recent 30 entries
    pillarSparks[p] = pillarHistByPillar[p].slice(-30).map((e) => e.value);
  }

  // Build per-pillar readings and compute.
  const now = new Date();
  const nowMs = now.getTime();
  const updatedAt = now.toISOString();
  const pillars: Partial<Record<PillarId, PillarScore>> = {};
  let anyStale = false;
  for (const pillarId of PILLAR_ORDER) {
    const pillarIndicators = Object.values(INDICATORS).filter((i) => i.pillar === pillarId);
    const maxStale = maxStaleMsForPillar(pillarId);
    const readings: IndicatorReading[] = [];
    let freshCount = 0;
    const staleIds: string[] = [];
    for (const def of pillarIndicators) {
      const latest = latestByIndicator.get(def.id);
      if (!latest) {
        staleIds.push(def.id);
        continue;
      }
      const ageMs = nowMs - new Date(latest.observedAt).getTime();
      if (ageMs <= maxStale) freshCount++;
      else staleIds.push(def.id);
      readings.push({
        indicatorId: def.id,
        value: latest.value,
        observedAt: latest.observedAt,
        baseline: baselineByIndicator.get(def.id) ?? [],
      });
    }
    const quorum = Math.max(1, Math.ceil(pillarIndicators.length * QUORUM_FRACTION));
    const stale = freshCount < quorum;
    if (stale) {
      anyStale = true;
      console.warn(
        `recompute: pillar '${pillarId}' stale -- ${freshCount}/${pillarIndicators.length} fresh (quorum ${quorum}). Stale indicators: ${staleIds.join(", ")}`,
      );
    }
    const value7dAgo = valueAtLeastAgo(pillarHistByPillar[pillarId], 7 * DAY_MS, now);
    const input = {
      readings,
      sparkline30d: pillarSparks[pillarId],
      ...(value7dAgo !== undefined ? { value7dAgo } : {}),
    };
    const score = computePillarScore(pillarId, input);
    pillars[pillarId] = stale ? { ...score, stale: true } : score;
  }

  const pillarRecord = pillars as Record<PillarId, PillarScore>;
  const stalePillarIds = (Object.entries(pillarRecord) as [PillarId, PillarScore][])
    .filter(([, ps]) => ps.stale)
    .map(([id]) => id);

  // 90d headline sparkline.
  const sparkline90d = headlineHist.slice(-90).map((h) => h.value);
  const value24hAgo = valueAtLeastAgo(headlineHist, 24 * 60 * 60 * 1000, now);
  const value30dAgo = valueAtLeastAgo(headlineHist, 30 * DAY_MS, now);
  const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const ytdMs = now.getTime() - startOfYear.getTime();
  const valueYtdAgo = valueAtLeastAgo(headlineHist, ytdMs, now);

  const headlineCore = computeHeadlineScore({
    pillars: pillarRecord,
    sparkline90d,
    updatedAt,
    ...(value24hAgo !== undefined ? { value24hAgo } : {}),
    ...(value30dAgo !== undefined ? { value30dAgo } : {}),
    ...(valueYtdAgo !== undefined ? { valueYtdAgo } : {}),
  });
  const headline = anyStale ? { ...headlineCore, stale: true } : headlineCore;
  if (anyStale) {
    console.warn("recompute: at least one pillar stale -- refusing to rewrite headline_scores; snapshot still served via KV with stale flag.");
  }

  const snapshot = assembleSnapshot(pillarRecord, headline);
  const sourceHealth = await readSourceHealth(env);
  if (sourceHealth.length > 0) snapshot.sourceHealth = sourceHealth;

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
      `SELECT source_id, MAX(started_at) AS last_success
       FROM ingestion_audit WHERE status = 'success' GROUP BY source_id`,
    ).all<{ source_id: string; last_success: string }>(),
  ]);
  const lastSuccessBySource: Record<string, string> = {};
  for (const r of lastSuccesses.results) lastSuccessBySource[r.source_id] = r.last_success;
  return computeSourceHealth(
    latestAttempts.results.map((r) => ({ sourceId: r.source_id, startedAt: r.started_at, status: r.status })),
    lastSuccessBySource,
  );
}

function buildHistory(
  headline: { observed_at: string; value: number }[],
  pillarHist: Record<PillarId, { observed_at: string; value: number }[]>,
): ScoreHistory {
  // Align pillar values to each headline timestamp using last-known values.
  const points: ScoreHistoryPoint[] = [];
  const cursors: Record<PillarId, number> = { market: 0, fiscal: 0, labour: 0, delivery: 0 };
  const last: Record<PillarId, number> = { market: 0, fiscal: 0, labour: 0, delivery: 0 };
  for (const h of headline) {
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
