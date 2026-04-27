import type {
  PillarId,
  ScoreSnapshot,
  ScoreHistory,
  ScoreHistoryPoint,
  PillarScore,
  HeadlineScore,
  IndicatorContribution,
  SourceHealthEntry,
  TodayMovement,
  Trend,
  Iso8601,
} from "@tightrope/shared";
import {
  INDICATORS,
  PILLAR_ORDER,
  PILLARS,
  bandFor,
  computeSourceHealth,
  isScoreRowStale,
  BASELINE_START_ISO,
  COVID_EXCLUDE_START_ISO,
  COVID_EXCLUDE_END_ISO,
} from "@tightrope/shared";
import type { DeliveryCommitment, DeliveryStatus } from "@tightrope/shared/delivery";
import type { TimelineEvent, TimelineCategory } from "@tightrope/shared/timeline";
import { summariseBaseline, type BaselineSummary } from "@tightrope/methodology";

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
  if (cached && cached.schemaVersion === 1 && isFresh(cached) && hasContributions(cached)) return cached;
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

/**
 * A cached snapshot written by an older recompute pipeline can have empty
 * `contributions` arrays even when the headline + pillar values are fine.
 * The /explore simulator depends on populated contributions to recompute,
 * and ProvenanceBadge / source-health surfaces depend on them on the
 * homepage. Treat the cache as cold whenever every pillar's contributions
 * is empty so the next read rebuilds from D1.
 */
function hasContributions(snapshot: ScoreSnapshot): boolean {
  for (const p of PILLAR_ORDER) {
    if ((snapshot.pillars[p]?.contributions?.length ?? 0) > 0) return true;
  }
  return false;
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
    // Latest *live* observation per indicator. Pick by MAX(ingested_at)
    // — not MAX(observed_at) — so a fixture whose observed_at moves
    // backwards (e.g. an OBR EFO update with an earlier publication
    // date) does not lock the API onto the stale row. Exclude
    // historical-backfill rows (`hist:*`) and seed rows (`seed*`)
    // so a recently-run backfill cannot mis-select as "live". See
    // apps/api/src/tests/snapshot-fixture-supersede.test.ts for
    // the regression cases.
    db.prepare(
      `SELECT o.indicator_id, o.value, o.observed_at, o.source_id
       FROM indicator_observations o
       JOIN (
         SELECT indicator_id, MAX(ingested_at) AS ts
         FROM indicator_observations
         WHERE payload_hash IS NULL
            OR (payload_hash NOT LIKE 'hist:%' AND payload_hash NOT LIKE 'seed%')
         GROUP BY indicator_id
       ) m ON o.indicator_id = m.indicator_id AND o.ingested_at = m.ts
         AND (o.payload_hash IS NULL
              OR (o.payload_hash NOT LIKE 'hist:%' AND o.payload_hash NOT LIKE 'seed%'))`,
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
    // The pillar history SQL above downsamples to one row per UTC day, so
    // `series.at(-7)` reaches back ~7 calendar days. Mirrors
    // apps/api/src/lib/db.ts:144 — if either query's window changes the
    // 7d trend would silently desync between API and SSR.
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
 * short, falls back to oldest row as long as it's at least
 * `MIN_FALLBACK_DAYS` old, and surfaces its observedAt as
 * baselineDate so the UI can label the number honestly.
 *
 * Mirrors apps/api/src/lib/db.ts deltaAgoWithFallback. Without the
 * floor, a fresh deploy with thin history would report a 2-day-old
 * delta as "30d" while the API correctly returns 0 — a divergence
 * that would mislead a viewer mid-broadcast.
 */
const MIN_FALLBACK_DAYS = 7;

function deltaAgoWithDate(rows: readonly ScoreRow[], targetDays: number): DeltaWithBaseline {
  if (rows.length < 2) return { value: 0 };
  const latest = rows[rows.length - 1]!;
  const idx = rows.length - 1 - targetDays;
  if (idx >= 0) {
    return { value: round1(latest.value - rows[idx]!.value) };
  }
  const oldest = rows[0]!;
  const ageDays = (Date.now() - new Date(oldest.observed_at).getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays < MIN_FALLBACK_DAYS) return { value: 0 };
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
  const oldestMs = new Date(oldest.observed_at).getTime();
  const ageDays = (now.getTime() - oldestMs) / (24 * 60 * 60 * 1000);
  if (ageDays < MIN_FALLBACK_DAYS) return { value: 0 };
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

/**
 * Today-movement rows feeding both the intraday strip and the per-pillar
 * "live readings" tiles on the homepage. The strip caller slices to the
 * top 8 movers itself; we deliberately do not LIMIT here so per-pillar
 * components (MarketSection, etc.) can look up specific indicator IDs
 * by name — without that, calmly-trading indicators like breakeven_5y
 * or ftse_250 would render as "—" on a quiet day.
 */
export async function getTodayMovements(env: Env): Promise<TodayMovement[]> {
  const res = await env.DB
    .prepare(
      `SELECT indicator_id, label, latest_value, display_value, change, change_pct,
              change_display, direction, worsening, sparkline, gloss, observed_at
       FROM today_movements
       ORDER BY worsening DESC, ABS(change_pct) DESC`,
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

export interface HeadroomVintage {
  /** GBP billions; the OBR forecast for the stability-rule target year at this vintage. */
  value: number;
  /** observed_at = OBR EFO publication date. */
  observedAt: Iso8601;
}

/**
 * Return the most recent OBR cb_headroom vintages from indicator_observations,
 * latest first. The Hero uses [0] as the live forecast and [1] (if present)
 * as the prior-vintage baseline; the FiscalSection plots [0..N-1] as the
 * forecast-headroom-by-vintage trendline.
 *
 * Filter rationale: `hist:%` rows are NOT excluded. For most live indicators
 * (gilts, FX, etc.) `hist:` marks synthetic carry-forward backfill and is
 * appropriately filtered, but OBR EFO is fixture-only — every cb_headroom
 * row is an authentic point-in-time forecast vintage, regardless of whether
 * it was written by the historical-backfill path (`hist:*`) or the daily
 * `fetch()` head-of-list path (live sha). Excluding `hist:*` here was the
 * cause of the Pillar 2 detail chart silently rendering its empty-state
 * hint despite the vintage trail being present in the database. `seed%`
 * rows remain excluded so dev placeholders never bleed in.
 */
export async function getHeadroomVintages(env: Env, limit = 4): Promise<HeadroomVintage[]> {
  const res = await env.DB
    .prepare(
      `SELECT value, observed_at FROM indicator_observations
       WHERE indicator_id = 'cb_headroom'
         AND (payload_hash IS NULL OR payload_hash NOT LIKE 'seed%')
       ORDER BY observed_at DESC
       LIMIT ?1`,
    )
    .bind(limit)
    .all<{ value: number; observed_at: string }>();
  return (res.results ?? []).map((r) => ({
    value: r.value,
    observedAt: r.observed_at as Iso8601,
  }));
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

// --- score history --------------------------------------------------------
//
// 90 days of headline + pillar scores, downsampled to one row per UTC day.
// Mirrors apps/api/src/lib/db.ts:buildHistoryFromD1 in shape (the API and
// the web app must produce identical history for a given `days` value),
// but we add a KV-first read path here keyed at `score:history:90d` —
// the recompute pipeline writes that key every 5 minutes, so most page
// loads avoid the four D1 queries entirely. The freshness gate matches
// the API's gate (30 minutes) so we don't render stale history when
// upstream ingestion has failed.

/** KV history is only trusted if its newest point is at most this old. */
const KV_HISTORY_MAX_AGE_MS = 30 * 60_000;

/**
 * Build a ScoreHistory for the homepage chart.
 *
 * Reads `score:history:90d` from KV first when `days === 90` (the homepage
 * default); falls through to D1 if the cache is empty, malformed, or stale.
 * For other windows we go straight to D1 — the homepage only ever asks for
 * 90, but the long-composite page wants 30 / 365 / all.
 */
export async function getHistory(env: Env, days: number): Promise<ScoreHistory> {
  const clampedDays = Math.max(1, Math.min(800, Math.floor(days)));
  if (clampedDays === 90) {
    const cached = await safeKvHistory(env);
    if (cached) return cached;
  }
  return buildHistoryFromD1(env, clampedDays);
}

async function safeKvHistory(env: Env): Promise<ScoreHistory | null> {
  try {
    const cached = await env.KV.get<ScoreHistory>("score:history:90d", "json");
    if (!cached || cached.schemaVersion !== 1) return null;
    if (!historyIsFresh(cached)) return null;
    return cached;
  } catch {
    // KV transient errors should never break the page; let D1 take over.
    return null;
  }
}

function historyIsFresh(history: ScoreHistory): boolean {
  const last = history.points[history.points.length - 1];
  if (!last) return false;
  const ts = Date.parse(last.timestamp);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < KV_HISTORY_MAX_AGE_MS;
}

interface PillarSeriesRow {
  id: PillarId;
  observed_at: string;
  value: number;
}

/**
 * Mirror of the API's MethodologyBaselines payload shape. We keep this
 * colocated rather than importing across app boundaries so the contract
 * is "same rows, same shapes" -- changes flag immediately via the
 * dedicated test rather than silently after a worker deploy.
 */
export interface MethodologyBaselinesPayload {
  schemaVersion: 1;
  generatedAt: string;
  baselineStart: string;
  baselineEnd: string;
  excludeStart: string;
  excludeEnd: string;
  baselines: Record<string, BaselineSummary>;
}

const KV_BASELINES_KEY = "methodology:baselines";
const KV_BASELINES_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Load per-indicator baseline quantile summaries for the /explore
 * what-if simulator. Reads through KV (24h freshness gate) and assembles
 * fresh from D1 on miss / stale.
 */
export async function getBaselineSummaries(env: Env): Promise<MethodologyBaselinesPayload> {
  try {
    const cached = await env.KV.get<MethodologyBaselinesPayload>(KV_BASELINES_KEY, "json");
    if (cached && cached.schemaVersion === 1 && baselinesAreFresh(cached)) {
      return cached;
    }
  } catch {
    // KV outage -- fall through to D1.
  }
  const fresh = await buildBaselineSummariesFromD1(env);
  try {
    await env.KV.put(KV_BASELINES_KEY, JSON.stringify(fresh), { expirationTtl: 60 * 60 * 6 });
  } catch {
    // Best-effort cache prime.
  }
  return fresh;
}

function baselinesAreFresh(p: MethodologyBaselinesPayload): boolean {
  const ts = Date.parse(p.generatedAt);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < KV_BASELINES_MAX_AGE_MS;
}

export async function buildBaselineSummariesFromD1(env: Env): Promise<MethodologyBaselinesPayload> {
  const res = await env.DB
    .prepare(
      `SELECT indicator_id, value
       FROM indicator_observations
       WHERE observed_at >= ?
         AND NOT (observed_at >= ? AND observed_at <= ?)
       ORDER BY indicator_id, observed_at ASC`,
    )
    .bind(BASELINE_START_ISO, COVID_EXCLUDE_START_ISO, COVID_EXCLUDE_END_ISO)
    .all<{ indicator_id: string; value: number }>();
  const rows = res.results ?? [];
  const byIndicator = new Map<string, number[]>();
  for (const row of rows) {
    if (!Number.isFinite(row.value)) continue;
    const arr = byIndicator.get(row.indicator_id) ?? [];
    arr.push(row.value);
    byIndicator.set(row.indicator_id, arr);
  }
  const baselines: Record<string, BaselineSummary> = {};
  for (const [id, samples] of byIndicator) {
    if (samples.length === 0) continue;
    baselines[id] = summariseBaseline(samples);
  }
  const generatedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    generatedAt,
    baselineStart: BASELINE_START_ISO,
    baselineEnd: generatedAt,
    excludeStart: COVID_EXCLUDE_START_ISO,
    excludeEnd: COVID_EXCLUDE_END_ISO,
    baselines,
  };
}

/**
 * Read history directly from D1. Identical contract to the API's
 * buildHistoryFromD1 — same SQL shape, same downsampling, same return
 * type. We keep them as parallel implementations rather than importing
 * across app boundaries; the contract is "same rows, same shapes",
 * verified by tests on both sides.
 */
export async function buildHistoryFromD1(env: Env, days: number): Promise<ScoreHistory> {
  // Cap matches apps/api/src/handlers/score.ts and the ingest backfill cap so
  // the long-composite page can serve the full GE-2024-to-today range.
  const clampedDays = Math.max(1, Math.min(800, Math.floor(days)));

  // Downsample to one row per UTC day (latest per day wins). The recompute
  // pipeline writes hundreds of rows per day to headline_scores; without
  // this aggregation the chart shows today repeated and older days hidden.
  // Mirrors the equivalent SQL-side downsample in apps/api/src/lib/db.ts.
  const [headlineRows, pillarRows] = await Promise.all([
    env.DB.prepare(
      `SELECT h.observed_at, h.value FROM headline_scores h
       JOIN (
         SELECT substr(observed_at, 1, 10) AS day, MAX(observed_at) AS ts
         FROM headline_scores
         WHERE observed_at >= datetime('now', '-' || ?1 || ' days')
         GROUP BY substr(observed_at, 1, 10)
       ) m ON h.observed_at = m.ts
       ORDER BY h.observed_at ASC`,
    ).bind(clampedDays).all<{ observed_at: string; value: number }>(),
    env.DB.prepare(
      `SELECT p.pillar_id AS id, p.observed_at, p.value FROM pillar_scores p
       JOIN (
         SELECT pillar_id, substr(observed_at, 1, 10) AS day, MAX(observed_at) AS ts
         FROM pillar_scores
         WHERE observed_at >= datetime('now', '-' || ?1 || ' days')
         GROUP BY pillar_id, substr(observed_at, 1, 10)
       ) m ON p.pillar_id = m.pillar_id AND p.observed_at = m.ts
       ORDER BY p.observed_at ASC`,
    ).bind(clampedDays).all<PillarSeriesRow>(),
  ]);

  const pillarsByTs = new Map<string, Partial<Record<PillarId, number>>>();
  for (const r of pillarRows.results) {
    const bucket = pillarsByTs.get(r.observed_at) ?? {};
    bucket[r.id] = r.value;
    pillarsByTs.set(r.observed_at, bucket);
  }

  const points: ScoreHistoryPoint[] = headlineRows.results.map((r) => {
    const pbucket = pillarsByTs.get(r.observed_at) ?? {};
    const pillars = {} as Record<PillarId, number>;
    for (const p of PILLAR_ORDER) pillars[p] = pbucket[p] ?? 0;
    return { timestamp: r.observed_at as Iso8601, headline: r.value, pillars };
  });

  return { points, rangeDays: clampedDays, schemaVersion: 1 };
}
