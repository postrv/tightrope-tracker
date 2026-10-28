import { readScoreHistory } from "@tightrope/snapshot";
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
  ScoreSnapshot,
  ScoreHistory,
  ScoreHistoryResolutionRequest,
  DeliveryCommitment,
  DeliveryStatus,
  TimelineEvent,
  TimelineCategory,
} from "@tightrope/shared";
import { buildSnapshotFromD1 as buildSnapshotFromDb } from "@tightrope/snapshot";


/**
 * Build a complete score snapshot from D1. Delegates to the single
 * `@tightrope/snapshot` builder; kept as an `Env`-shaped wrapper so the
 * handler and tests call it exactly as before.
 */
export function buildSnapshotFromD1(env: Env): Promise<ScoreSnapshot> {
  return buildSnapshotFromDb(env.DB);
}

export function buildHistoryFromD1(env: Env, days: number, resolution: ScoreHistoryResolutionRequest = "auto"): Promise<ScoreHistory> {
  return readScoreHistory(env.DB, days, resolution);
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
