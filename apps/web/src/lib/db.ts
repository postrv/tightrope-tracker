import type {
  PillarId,
  ScoreSnapshot,
  PillarScore,
  HeadlineScore,
  SourceHealthEntry,
  TodayMovement,
  Trend,
  Iso8601,
} from "@tightrope/shared";
import { PILLAR_ORDER, PILLARS, bandFor, computeSourceHealth, isScoreRowStale } from "@tightrope/shared";
import type { DeliveryCommitment, DeliveryStatus } from "@tightrope/shared/delivery";
import type { TimelineEvent, TimelineCategory } from "@tightrope/shared/timeline";

/** Time-series row returned from `headline_scores` / `pillar_scores`. */
interface ScoreRow {
  observed_at: string;
  value: number;
  band: string;
  dominant?: string;
  editorial?: string;
}

/** KV snapshot is only trusted if this fresh. Beyond, we fall through to D1. */
const KV_SNAPSHOT_MAX_AGE_MS = 30 * 60_000;

/**
 * Build a complete score snapshot from D1.
 *
 * Prefers the cached snapshot in KV so every page render is a single KV
 * `get` rather than four D1 queries. Falls back to a fresh D1 read if the
 * cache is empty, the schema version has bumped, or the cached snapshot is
 * older than KV_SNAPSHOT_MAX_AGE_MS -- we prefer a slightly slower render
 * over silently serving stale data.
 */
export async function getLatestSnapshot(env: Env): Promise<ScoreSnapshot> {
  const cached = await env.KV.get<ScoreSnapshot>("score:latest", "json");
  if (cached && cached.schemaVersion === 1 && isFresh(cached)) return cached;
  const fresh = await buildSnapshotFromD1(env);
  // Best-effort re-prime so subsequent hits in the 30-minute window serve from KV.
  try {
    await env.KV.put("score:latest", JSON.stringify(fresh), { expirationTtl: 60 * 60 * 6 });
  } catch {
    // KV write failures are non-fatal: we already have the snapshot to return.
  }
  return fresh;
}

function isFresh(snapshot: ScoreSnapshot): boolean {
  const ts = Date.parse(snapshot.headline.updatedAt);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < KV_SNAPSHOT_MAX_AGE_MS;
}

export async function buildSnapshotFromD1(env: Env): Promise<ScoreSnapshot> {
  const db = env.DB;

  // Run the four score queries and the two ingestion_audit queries in parallel
  // -- they're all independent reads against D1 and blocking sequentially here
  // would add 4-6x round-trip latency to every cache miss.
  const [headlineRow, headlineHistory, pillarsLatest, pillarHistory, latestAttempts, lastSuccesses] = await Promise.all([
    db.prepare(
      "SELECT observed_at, value, band, dominant, editorial FROM headline_scores ORDER BY observed_at DESC LIMIT 1",
    ).first<ScoreRow>(),
    // Downsample to one row per UTC day (latest per day wins) over the last
    // 90 days. Without this, 90 rows of 5-min recompute output covers ~7.5
    // hours, producing a flat line every day indicators hold steady.
    db.prepare(
      `SELECT h.observed_at, h.value FROM headline_scores h
       JOIN (
         SELECT substr(observed_at, 1, 10) AS day, MAX(observed_at) AS ts
         FROM headline_scores
         WHERE observed_at >= datetime('now', '-90 days')
         GROUP BY substr(observed_at, 1, 10)
       ) m ON h.observed_at = m.ts
       ORDER BY h.observed_at ASC`,
    ).all<ScoreRow>(),
    db.prepare(
      `SELECT p.pillar_id AS id, p.observed_at, p.value, p.band
       FROM pillar_scores p
       JOIN (
         SELECT pillar_id, MAX(observed_at) AS ts FROM pillar_scores GROUP BY pillar_id
       ) m ON p.pillar_id = m.pillar_id AND p.observed_at = m.ts`,
    ).all<{ id: PillarId; observed_at: string; value: number; band: string }>(),
    db.prepare(
      `SELECT pillar_id AS id, observed_at, value
       FROM pillar_scores
       WHERE observed_at >= datetime('now', '-30 days')
       ORDER BY pillar_id, observed_at ASC`,
    ).all<{ id: PillarId; observed_at: string; value: number }>(),
    // Latest ingestion attempt per source (any status) -- powers the
    // source-health signal that surfaces upstream failures earlier than the
    // observation-age staleness thresholds.
    db.prepare(
      `SELECT i.source_id, i.started_at, i.status FROM ingestion_audit i
       JOIN (
         SELECT source_id, MAX(started_at) AS ts FROM ingestion_audit GROUP BY source_id
       ) m ON i.source_id = m.source_id AND i.started_at = m.ts`,
    ).all<{ source_id: string; started_at: string; status: string }>(),
    db.prepare(
      `SELECT source_id, MAX(started_at) AS last_success
       FROM ingestion_audit WHERE status = 'success' GROUP BY source_id`,
    ).all<{ source_id: string; last_success: string }>(),
  ]);

  // Shape into snapshot.
  const now = new Date();
  const pillars = {} as Record<PillarId, PillarScore>;
  let anyPillarStale = false;
  type PillarLatestRow = { id: PillarId; observed_at: string; value: number; band: string };
  type PillarHistoryRow = { id: PillarId; observed_at: string; value: number };
  for (const p of PILLAR_ORDER) {
    const latest = (pillarsLatest.results as PillarLatestRow[]).find((r: PillarLatestRow) => r.id === p);
    const series = (pillarHistory.results as PillarHistoryRow[])
      .filter((r: PillarHistoryRow) => r.id === p)
      .map((r: PillarHistoryRow) => r.value);
    const value = latest?.value ?? 0;
    const sevenDaysAgo = series.at(-7) ?? value;
    const delta = value - sevenDaysAgo;
    const trend: Trend = Math.abs(delta) < 0.5 ? "flat" : delta > 0 ? "up" : "down";
    // Serve-time staleness inference: recompute writes every non-stale pillar
    // every 5 min, so a row older than MAX_SCORE_AGE_MS (30 min) signals
    // either a broken loop or a pillar that has been failing its quorum.
    const stale = isScoreRowStale(latest?.observed_at, now);
    if (stale) anyPillarStale = true;
    pillars[p] = {
      pillar: p,
      value,
      band: (latest?.band as PillarScore["band"]) ?? bandFor(value).id,
      weight: PILLARS[p].weight,
      contributions: [],
      trend7d: trend,
      delta7d: Math.round(delta * 10) / 10,
      sparkline30d: series,
      ...(stale ? { stale: true } : {}),
    };
  }

  const hValue = headlineRow?.value ?? 0;
  // Already ordered ASC by observed_at (one row per UTC day, see SQL above).
  const hSeries = (headlineHistory.results as ScoreRow[]).map((r: ScoreRow) => r.value);
  const headlineStale = anyPillarStale || isScoreRowStale(headlineRow?.observed_at, now);
  const headline: HeadlineScore = {
    value: hValue,
    band: (headlineRow?.band as HeadlineScore["band"]) ?? bandFor(hValue).id,
    editorial: headlineRow?.editorial ?? "",
    updatedAt: (headlineRow?.observed_at as Iso8601) ?? new Date().toISOString(),
    dominantPillar: (headlineRow?.dominant as PillarId) ?? "market",
    sparkline90d: hSeries,
    delta24h: deltaAgo(hSeries, 1),
    delta30d: deltaAgo(hSeries, 30),
    deltaYtd: deltaAgo(hSeries, hSeries.length - 1),
    ...(headlineStale ? { stale: true } : {}),
  };

  type AttemptRow = { source_id: string; started_at: string; status: string };
  type SuccessRow = { source_id: string; last_success: string };
  const lastSuccessBySource: Record<string, string> = {};
  for (const r of (lastSuccesses.results as SuccessRow[])) lastSuccessBySource[r.source_id] = r.last_success;
  const sourceHealth: readonly SourceHealthEntry[] = computeSourceHealth(
    (latestAttempts.results as AttemptRow[]).map((r: AttemptRow) => ({
      sourceId: r.source_id,
      startedAt: r.started_at,
      status: r.status,
    })),
    lastSuccessBySource,
  );

  const snapshot: ScoreSnapshot = { headline, pillars, schemaVersion: 1 };
  if (sourceHealth.length > 0) snapshot.sourceHealth = sourceHealth;
  return snapshot;
}

function deltaAgo(series: readonly number[], n: number): number {
  if (series.length < 2) return 0;
  const now = series.at(-1) ?? 0;
  const then = series.at(Math.max(0, series.length - 1 - n)) ?? now;
  return Math.round((now - then) * 10) / 10;
}

/** Today-movement cards for the intraday strip. */
export async function getTodayMovements(env: Env): Promise<TodayMovement[]> {
  const res = await env.DB
    .prepare(
      `SELECT indicator_id, label, latest_value, display_value, change, change_pct,
              change_display, direction, worsening, sparkline, gloss, observed_at
       FROM today_movements
       ORDER BY worsening DESC, ABS(change_pct) DESC
       LIMIT 8`,
    )
    .all<{
      indicator_id: string; label: string; latest_value: number; display_value: string;
      change: number; change_pct: number | null; change_display: string;
      direction: Trend; worsening: number; sparkline: string;
      gloss: string; observed_at: string;
    }>();
  type TodayRow = {
    indicator_id: string; label: string; latest_value: number; display_value: string;
    change: number; change_pct: number | null; change_display: string;
    direction: Trend; worsening: number; sparkline: string;
    gloss: string; observed_at: string;
  };

  return (res.results as TodayRow[]).map((r: TodayRow) => ({
    indicatorId: r.indicator_id,
    label: r.label,
    unit: "",
    latestValue: r.latest_value,
    displayValue: r.display_value,
    change: r.change,
    changePct: r.change_pct,
    changeDisplay: r.change_display,
    direction: r.direction,
    worsening: r.worsening === 1,
    sparkline: parseSparklineSafe(r.sparkline, r.indicator_id),
    gloss: r.gloss,
    sourceId: "",
    observedAt: r.observed_at as Iso8601,
  }));
}

/** Sparklines are stored as JSON strings; a corrupt row shouldn't take the page down. */
function parseSparklineSafe(raw: string, indicatorId: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(`sparkline for '${indicatorId}' is not an array, ignoring`);
      return [];
    }
    return parsed.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  } catch (err) {
    console.warn(`failed to parse sparkline for '${indicatorId}': ${(err as Error)?.message ?? String(err)}`);
    return [];
  }
}

export async function getDeliveryCommitments(env: Env): Promise<DeliveryCommitment[]> {
  const res = await env.DB
    .prepare(
      `SELECT id, name, department, latest, target, status, source_url, source_label, updated_at, notes
       FROM delivery_commitments
       ORDER BY sort_order ASC, name ASC`,
    )
    .all<{
      id: string; name: string; department: string; latest: string;
      target: string; status: string; source_url: string; source_label: string;
      updated_at: string; notes: string | null;
    }>();
  type CommitmentRow = {
    id: string; name: string; department: string; latest: string;
    target: string; status: string; source_url: string; source_label: string;
    updated_at: string; notes: string | null;
  };
  return (res.results as CommitmentRow[]).map((r: CommitmentRow) => ({
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

export async function getTimelineEvents(env: Env, limit = 40): Promise<TimelineEvent[]> {
  const res = await env.DB
    .prepare(
      `SELECT id, event_date, title, summary, category, source_label, source_url, score_delta
       FROM timeline_events ORDER BY event_date DESC LIMIT ?`,
    )
    .bind(limit)
    .all<{
      id: string; event_date: string; title: string; summary: string; category: string;
      source_label: string; source_url: string | null; score_delta: number | null;
    }>();
  type TimelineRow = {
    id: string; event_date: string; title: string; summary: string; category: string;
    source_label: string; source_url: string | null; score_delta: number | null;
  };
  return (res.results as TimelineRow[]).map((r: TimelineRow) => ({
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

export async function getLastIngestionAudit(env: Env): Promise<{ sourceId: string; startedAt: string; status: string }[]> {
  const res = await env.DB
    .prepare(
      `SELECT i.source_id, i.started_at, i.status FROM ingestion_audit i
       JOIN (
         SELECT source_id, MAX(started_at) AS ts FROM ingestion_audit GROUP BY source_id
       ) m ON i.source_id = m.source_id AND i.started_at = m.ts
       ORDER BY i.source_id ASC`,
    )
    .all<{ source_id: string; started_at: string; status: string }>();
  type AuditRow = { source_id: string; started_at: string; status: string };
  return (res.results as AuditRow[]).map((r: AuditRow) => ({
    sourceId: r.source_id,
    startedAt: r.started_at,
    status: r.status,
  }));
}

export async function getCorrections(env: Env): Promise<{
  id: string; publishedAt: string; affectedIndicator: string;
  originalValue: string; correctedValue: string; reason: string;
}[]> {
  const res = await env.DB
    .prepare(
      `SELECT id, published_at, affected_indicator, original_value, corrected_value, reason
       FROM corrections ORDER BY published_at DESC`,
    )
    .all<{
      id: string; published_at: string; affected_indicator: string;
      original_value: string; corrected_value: string; reason: string;
    }>();
  type CorrectionRow = {
    id: string; published_at: string; affected_indicator: string;
    original_value: string; corrected_value: string; reason: string;
  };
  return (res.results as CorrectionRow[]).map((r: CorrectionRow) => ({
    id: r.id,
    publishedAt: r.published_at,
    affectedIndicator: r.affected_indicator,
    originalValue: r.original_value,
    correctedValue: r.corrected_value,
    reason: r.reason,
  }));
}
