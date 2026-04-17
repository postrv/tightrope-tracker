import type { D1PreparedStatement } from "@cloudflare/workers-types";
import {
  INDICATORS,
  PILLAR_ORDER,
  PILLARS,
  type PillarId,
  type PillarScore,
  type ScoreHistory,
  type ScoreHistoryPoint,
  type ScoreSnapshot,
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

/**
 * Per-pillar max-staleness windows. Fast-cadence pillars (intraday / daily) get
 * a 2-day ceiling; slow-cadence pillars (monthly / event) tolerate 7 days
 * before we flag the reading as stale. If fewer than a quorum of indicators
 * in a pillar have a reading inside its window the pillar is flagged `stale`,
 * and any stale pillar poisons the headline.
 */
const MAX_STALE_MS_FAST = 2 * DAY_MS;
const MAX_STALE_MS_SLOW = 7 * DAY_MS;
/** Fraction of pillar indicators that must be fresh to count as a quorum. */
const QUORUM_FRACTION = 0.5;

function maxStaleMsForPillar(pillarId: PillarId): number {
  const cadence = PILLARS[pillarId].cadence;
  // "intraday" and "daily" get the tight window; "monthly" and "event" get the loose one.
  return cadence === "intraday" || cadence === "daily" ? MAX_STALE_MS_FAST : MAX_STALE_MS_SLOW;
}

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

  // Persist: D1 (pillars always; headline only if fully fresh), KV (snapshot + history).
  await persistScores(env, snapshot, updatedAt, { skipHeadline: anyStale });
  await env.KV.put("score:latest", JSON.stringify(snapshot), { expirationTtl: KV_TTL_6H });

  const history = buildHistory(headlineHist, pillarHistByPillar);
  await env.KV.put("score:history:90d", JSON.stringify(history), { expirationTtl: KV_TTL_6H });

  return snapshot;
}

async function persistScores(
  env: Env,
  snapshot: ScoreSnapshot,
  observedAt: string,
  opts: { skipHeadline?: boolean } = {},
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
  for (const p of PILLAR_ORDER) {
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
  await env.DB.batch(stmts);
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
