/**
 * D1 query layer for the public API.
 *
 * The score snapshot builder and the two-tier latest-observation selector
 * that used to live here (and in duplicate in apps/web + apps/ingest) now
 * live in the single `@tightrope/snapshot` package. `buildSnapshotFromD1`
 * below is a thin binding of that package function to this worker's `Env`.
 * The history / editorial readers remain here — they are api-shaped and not
 * yet consolidated.
 */
import type {
  PillarId,
  ScoreSnapshot,
  ScoreHistory,
  ScoreHistoryPoint,
  DeliveryCommitment,
  DeliveryStatus,
  TimelineEvent,
  TimelineCategory,
  Iso8601,
} from "@tightrope/shared";
import {
  PILLAR_ORDER,
  SCORE_DIRECTION,
  SCORE_HISTORY_SCHEMA_VERSION,
} from "@tightrope/shared";
import { buildSnapshotFromD1 as buildSnapshotFromDb } from "@tightrope/snapshot";

interface PillarSeriesRow {
  id: PillarId;
  observed_at: string;
  value: number;
}

/**
 * Build a complete score snapshot from D1. Delegates to the single
 * `@tightrope/snapshot` builder; kept as an `Env`-shaped wrapper so the
 * handler and tests call it exactly as before.
 */
export function buildSnapshotFromD1(env: Env): Promise<ScoreSnapshot> {
  return buildSnapshotFromDb(env.DB);
}

export async function buildHistoryFromD1(env: Env, days: number): Promise<ScoreHistory> {
  // Cap matches the API days param (apps/api/src/handlers/score.ts) and the
  // ingest backfill cap so a /api/v1/score/history?days=800 request can serve
  // the full GE-2024-to-today range once backfilled.
  const clampedDays = Math.max(1, Math.min(800, Math.floor(days)));

  // SEC-7: precompute the cutoff as a single ISO timestamp and bind it once.
  // The previous shape (`'-' || ?1 || ' days'`) was safe in practice because
  // `clampedDays` is integer-bounded above, but it concatenates a bound value
  // back into SQL syntax — a fragile pattern that any future caller routing
  // around the clamp could exploit. A bound ISO string carries no SQL
  // semantics whatsoever, so the shape simply cannot smuggle anything.
  // observed_at is stored as ISO 8601 ("YYYY-MM-DDTHH:MM:SS.sssZ"), so a
  // strict lexicographic compare against the same format is byte-exact.
  const cutoffISO = new Date(Date.now() - clampedDays * 86_400_000).toISOString();

  // Downsample to one row per UTC day (latest per day wins). The recompute
  // pipeline writes a fresh headline_scores row every 5 minutes, so on any
  // given day the table holds 200-300 rows. Without this aggregation the
  // chart shows hundreds of duplicate today-points clobbering older days,
  // and the 90-day cache slice (last 90 chronological rows) collapses to
  // ~7.5 hours of intraday recompute. Mirrors the sparkline downsample query
  // inside @tightrope/snapshot's buildSnapshotFromD1.
  const [headlineRows, pillarRows] = await Promise.all([
    env.DB.prepare(
      `SELECT h.observed_at, h.value FROM headline_scores h
       JOIN (
         SELECT substr(observed_at, 1, 10) AS day, MAX(observed_at) AS ts
         FROM headline_scores
         WHERE observed_at >= ?1
         GROUP BY substr(observed_at, 1, 10)
       ) m ON h.observed_at = m.ts
       ORDER BY h.observed_at ASC`,
    ).bind(cutoffISO).all<{ observed_at: string; value: number }>(),
    env.DB.prepare(
      `SELECT p.pillar_id AS id, p.observed_at, p.value FROM pillar_scores p
       JOIN (
         SELECT pillar_id, substr(observed_at, 1, 10) AS day, MAX(observed_at) AS ts
         FROM pillar_scores
         WHERE observed_at >= ?1
         GROUP BY pillar_id, substr(observed_at, 1, 10)
       ) m ON p.pillar_id = m.pillar_id AND p.observed_at = m.ts
       UNION ALL
       SELECT p.pillar_id AS id, p.observed_at, p.value FROM pillar_scores p
       JOIN (
         SELECT pillar_id, MAX(observed_at) AS ts
         FROM pillar_scores
         WHERE observed_at < ?2
         GROUP BY pillar_id
       ) prev ON p.pillar_id = prev.pillar_id AND p.observed_at = prev.ts
       ORDER BY observed_at ASC`,
    ).bind(cutoffISO, cutoffISO).all<PillarSeriesRow>(),
  ]);

  const byPillar: Record<PillarId, PillarSeriesRow[]> = {
    market: [], fiscal: [], labour: [], delivery: [],
  };
  for (const r of pillarRows.results) byPillar[r.id].push(r);
  for (const p of PILLAR_ORDER) byPillar[p].sort((a, b) => a.observed_at.localeCompare(b.observed_at));

  const cursors: Record<PillarId, number> = { market: 0, fiscal: 0, labour: 0, delivery: 0 };
  const last: Record<PillarId, number> = {
    market: 0,
    fiscal: 0,
    labour: 0,
    delivery: 0,
  };

  const points: ScoreHistoryPoint[] = headlineRows.results.map((r) => {
    for (const p of PILLAR_ORDER) {
      const arr = byPillar[p];
      while (cursors[p] < arr.length && arr[cursors[p]]!.observed_at <= r.observed_at) {
        last[p] = arr[cursors[p]]!.value;
        cursors[p] += 1;
      }
    }
    return { timestamp: r.observed_at as Iso8601, headline: r.value, pillars: { ...last } };
  });

  return { points, rangeDays: clampedDays, scoreDirection: SCORE_DIRECTION, schemaVersion: SCORE_HISTORY_SCHEMA_VERSION };
}

export async function getDeliveryCommitments(env: Env): Promise<DeliveryCommitment[]> {
  const res = await env.DB.prepare(
    `SELECT id, name, department, latest, target, status, source_url, source_label, updated_at, notes
     FROM delivery_commitments
     ORDER BY sort_order ASC, name ASC`,
  ).all<{
    id: string; name: string; department: string; latest: string;
    target: string; status: string; source_url: string; source_label: string;
    updated_at: string; notes: string | null;
  }>();
  return res.results.map((r) => ({
    id: r.id,
    name: r.name,
    department: r.department,
    latest: r.latest,
    target: r.target,
    status: r.status as DeliveryStatus,
    sourceUrl: r.source_url,
    sourceLabel: r.source_label,
    updatedAt: r.updated_at,
    ...(r.notes ? { notes: r.notes } : {}),
  }));
}

export async function getTimelineEvents(env: Env, limit: number): Promise<TimelineEvent[]> {
  const clamped = Math.max(1, Math.min(200, Math.floor(limit)));
  const res = await env.DB.prepare(
    `SELECT id, event_date, title, summary, category, source_label, source_url, score_delta
     FROM timeline_events ORDER BY event_date DESC LIMIT ?`,
  ).bind(clamped).all<{
    id: string; event_date: string; title: string; summary: string; category: string;
    source_label: string; source_url: string | null; score_delta: number | null;
  }>();
  return res.results.map((r) => ({
    id: r.id,
    date: r.event_date,
    title: r.title,
    summary: r.summary,
    category: r.category as TimelineCategory,
    sourceLabel: r.source_label,
    ...(r.source_url ? { sourceUrl: r.source_url } : {}),
    ...(r.score_delta !== null ? { scoreDelta: r.score_delta } : {}),
  }));
}

export async function getLastIngestionAudit(
  env: Env,
): Promise<Record<string, string>> {
  const res = await env.DB.prepare(
    `SELECT i.source_id, i.started_at, i.status FROM ingestion_audit i
     JOIN (
       SELECT source_id, MAX(started_at) AS ts FROM ingestion_audit
       WHERE status IN ('success', 'unchanged') GROUP BY source_id
     ) m ON i.source_id = m.source_id AND i.started_at = m.ts`,
  ).all<{ source_id: string; started_at: string; status: string }>();
  const map: Record<string, string> = {};
  for (const r of res.results) map[r.source_id] = r.started_at;
  return map;
}
