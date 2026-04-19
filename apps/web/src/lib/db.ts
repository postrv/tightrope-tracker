import type {
  PillarId,
  ScoreSnapshot,
  PillarScore,
  HeadlineScore,
  IndicatorContribution,
  SourceHealthEntry,
  TodayMovement,
  Trend,
  Iso8601,
} from "@tightrope/shared";
import { INDICATORS, PILLAR_ORDER, PILLARS, bandFor, computeSourceHealth, isScoreRowStale } from "@tightrope/shared";
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
  const [headlineRow, headlineHistory, pillarsLatest, pillarHistory, latestAttempts, lastSuccesses, latestObservations] = await Promise.all([
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
    // Downsample to one row per UTC day per pillar. Mirrors the headline
    // query above — see the comment there for the reasoning.
    db.prepare(
      `SELECT p.pillar_id AS id, p.observed_at, p.value FROM pillar_scores p
       JOIN (
         SELECT pillar_id, substr(observed_at, 1, 10) AS day, MAX(observed_at) AS ts
         FROM pillar_scores
         WHERE observed_at >= datetime('now', '-30 days')
         GROUP BY pillar_id, substr(observed_at, 1, 10)
       ) m ON p.pillar_id = m.pillar_id AND p.observed_at = m.ts
       ORDER BY p.pillar_id, p.observed_at ASC`,
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
      // 'unchanged' is a healthy fetch (same payload as last time).
      // Include it so sources that publish less often than they're
      // polled don't appear to be failing between real updates.
      `SELECT source_id, MAX(started_at) AS last_success
       FROM ingestion_audit WHERE status IN ('success', 'unchanged') GROUP BY source_id`,
    ).all<{ source_id: string; last_success: string }>(),
    // Latest observation per indicator, for lightweight per-pillar
    // contributions in this D1-fallback path. The recompute+KV snapshot
    // carries full z-score contributions; here we surface raw value +
    // observedAt + sourceId so a stale-banner consumer can name the
    // specific indicator that froze.
    db.prepare(
      `SELECT o.indicator_id, o.value, o.observed_at, o.source_id
       FROM indicator_observations o
       JOIN (
         SELECT indicator_id, MAX(observed_at) AS ts
         FROM indicator_observations GROUP BY indicator_id
       ) m ON o.indicator_id = m.indicator_id AND o.observed_at = m.ts`,
    ).all<{ indicator_id: string; value: number; observed_at: string; source_id: string }>(),
  ]);

  // Shape into snapshot.
  const now = new Date();
  const obsByIndicator = new Map<string, { value: number; observedAt: string; sourceId: string }>();
  for (const r of latestObservations.results) {
    obsByIndicator.set(r.indicator_id, { value: r.value, observedAt: r.observed_at, sourceId: r.source_id });
  }
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
    // 30d spans the full pillar sparkline so labels match what the user
    // sees in the chart — mirrors computePillarScore in the recompute path.
    const first = series[0];
    const last = series[series.length - 1];
    const delta30 = series.length >= 2 && first !== undefined && last !== undefined
      ? last - first
      : 0;
    const trend30: Trend = Math.abs(delta30) < 0.5 ? "flat" : delta30 > 0 ? "up" : "down";
    // Serve-time staleness inference: recompute writes every non-stale pillar
    // every 5 min, so a row older than MAX_SCORE_AGE_MS (30 min) signals
    // either a broken loop or a pillar that has been failing its quorum.
    const stale = isScoreRowStale(latest?.observed_at, now);
    if (stale) anyPillarStale = true;
    pillars[p] = {
      pillar: p,
      label: PILLARS[p].shortTitle,
      value,
      band: (latest?.band as PillarScore["band"]) ?? bandFor(value).id,
      weight: PILLARS[p].weight,
      contributions: buildContributionsForPillar(p, obsByIndicator),
      trend7d: trend,
      delta7d: Math.round(delta * 10) / 10,
      trend30d: trend30,
      delta30d: Math.round(delta30 * 10) / 10,
      sparkline30d: series,
      ...(stale ? { stale: true } : {}),
    };
  }

  const hValue = headlineRow?.value ?? 0;
  // Already ordered ASC by observed_at (one row per UTC day, see SQL above).
  const hRows = (headlineHistory.results as ScoreRow[]);
  const hSeries = hRows.map((r: ScoreRow) => r.value);
  const headlineStale = anyPillarStale || isScoreRowStale(headlineRow?.observed_at, now);
  // delta30d / deltaYtd pair the number with the ISO date of the row
  // actually used as the baseline. When the row is meaningfully off the
  // requested window (history doesn't stretch back 30d / to Jan 1), the
  // UI should render "since DD MMM" instead of the "30d" / "YTD" label.
  // This fixes the live-prod bug where both deltas silently collapsed to
  // the same oldest-row number because the fallback was invisible.
  const delta30d = deltaAgoWithDate(hRows, 30);
  const deltaYtd = deltaAgoYtd(hRows, now);
  const headline: HeadlineScore = {
    value: hValue,
    band: (headlineRow?.band as HeadlineScore["band"]) ?? bandFor(hValue).id,
    editorial: headlineRow?.editorial ?? "",
    updatedAt: (headlineRow?.observed_at as Iso8601) ?? new Date().toISOString(),
    dominantPillar: (headlineRow?.dominant as PillarId) ?? "market",
    sparkline90d: hSeries,
    delta24h: deltaAgo(hSeries, 1),
    delta30d: delta30d.value,
    deltaYtd: deltaYtd.value,
    ...(delta30d.baselineDate ? { delta30dBaselineDate: delta30d.baselineDate as Iso8601 } : {}),
    ...(deltaYtd.baselineDate ? { deltaYtdBaselineDate: deltaYtd.baselineDate as Iso8601 } : {}),
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

interface DeltaWithBaseline {
  value: number;
  baselineDate?: string;
}

/**
 * One-UTC-day-per-row history (as produced by the 90d headline query).
 * Returns delta = latest - row[latest_index - n]. If history is too
 * short, falls back to oldest row and surfaces its observedAt as
 * baselineDate so the UI can label the number honestly.
 */
function deltaAgoWithDate(rows: readonly ScoreRow[], targetDays: number): DeltaWithBaseline {
  if (rows.length < 2) return { value: 0 };
  const latest = rows[rows.length - 1]!;
  const idx = rows.length - 1 - targetDays;
  if (idx >= 0) {
    return { value: round1(latest.value - rows[idx]!.value) };
  }
  const oldest = rows[0]!;
  return { value: round1(latest.value - oldest.value), baselineDate: oldest.observed_at };
}

function deltaAgoYtd(rows: readonly ScoreRow[], now: Date): DeltaWithBaseline {
  if (rows.length < 2) return { value: 0 };
  const latest = rows[rows.length - 1]!;
  const startOfYearMs = Date.UTC(now.getUTCFullYear(), 0, 1);
  // Scan backwards for the last row observed on or before 1 Jan.
  for (let i = rows.length - 1; i >= 0; i--) {
    const rowMs = new Date(rows[i]!.observed_at).getTime();
    if (rowMs <= startOfYearMs) {
      return { value: round1(latest.value - rows[i]!.value) };
    }
  }
  const oldest = rows[0]!;
  return { value: round1(latest.value - oldest.value), baselineDate: oldest.observed_at };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Lightweight contributions used in the D1-fallback snapshot path.
 *
 * The recompute loop writes a full snapshot (z-score + normalised
 * contributions) into KV. When we miss the KV cache and rebuild from
 * D1 we don't have cheap access to the baseline series, so we fill in
 * `zScore: 0` / `normalised: 0` and return the raw value, observedAt,
 * sourceId and intra-pillar weight. That's enough for a stale banner
 * to name the specific indicator that froze, and for API consumers to
 * inspect the inputs; the full contribution detail stays in KV.
 */
function buildContributionsForPillar(
  pillar: PillarId,
  obs: Map<string, { value: number; observedAt: string; sourceId: string }>,
): IndicatorContribution[] {
  const defs = Object.values(INDICATORS).filter((d) => d.pillar === pillar);
  const pillarWeightSum = defs.reduce((acc, d) => acc + d.weight, 0);
  const out: IndicatorContribution[] = [];
  for (const def of defs) {
    const o = obs.get(def.id);
    if (!o) continue;
    out.push({
      indicatorId: def.id,
      rawValue: o.value,
      rawValueUnit: def.unit,
      zScore: 0,
      normalised: 0,
      weight: pillarWeightSum > 0 ? def.weight / pillarWeightSum : 0,
      sourceId: o.sourceId,
      observedAt: o.observedAt,
    });
  }
  return out;
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
