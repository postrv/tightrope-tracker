import { readScoreHistory, clampHistoryDays } from "@tightrope/snapshot";
import type {
  ScoreSnapshot,
  ScoreHistory,
  ScoreHistoryResolutionRequest,
  TodayMovement,
  Trend,
  Iso8601,
} from "@tightrope/shared";
import {
  PILLAR_ORDER,
  INDICATORS,
  SCORE_HISTORY_SCHEMA_VERSION,
  SCORE_SCHEMA_VERSION,
  selectBaselineObservations,
  METHODOLOGY_BASELINES_CACHE_KEY,
  type BaselineObservationRow,
  BASELINE_START_ISO,
  COVID_EXCLUDE_START_ISO,
  COVID_EXCLUDE_END_ISO,
} from "@tightrope/shared";
import type { DeliveryCommitment, DeliveryStatus } from "@tightrope/shared/delivery";
import type { TimelineEvent, TimelineCategory } from "@tightrope/shared/timeline";
import { summariseBaseline, type BaselineSummary } from "@tightrope/methodology";
import { buildSnapshotFromD1 as buildSnapshotFromDb, primeSnapshotCache } from "@tightrope/snapshot";

/** KV snapshot is only trusted if this fresh. Beyond, we fall through to D1. */
const KV_SNAPSHOT_MAX_AGE_MS = 30 * 60_000;

/**
 * Build a complete score snapshot, KV-first.
 *
 * Prefers the cached snapshot in KV so every page render is a single KV
 * `get` rather than four D1 queries. Falls back to a fresh D1 read (via the
 * single `@tightrope/snapshot` builder) if the cache is empty, the schema
 * version has bumped, or the cached snapshot is older than
 * KV_SNAPSHOT_MAX_AGE_MS -- we prefer a slightly slower render over silently
 * serving stale data.
 */
export async function getLatestSnapshot(env: Env): Promise<ScoreSnapshot> {
  const cached = await env.KV.get<ScoreSnapshot>("score:latest", "json");
  if (cached && cached.schemaVersion === SCORE_SCHEMA_VERSION && isFresh(cached) && hasContributions(cached)) return cached;
  const fresh = await buildSnapshotFromDb(env.DB);
  // Best-effort re-prime so subsequent hits in the 30-minute window serve
  // from KV. Single-writer: primeSnapshotCache owns score:latest.
  try {
    await primeSnapshotCache(env.KV, fresh);
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


/**
 * Latest published changes feeding both the change strip and the per-pillar
 * "live readings" tiles on the homepage. The strip caller slices to the
 * top 8 movers itself; we deliberately do not LIMIT here so per-pillar
 * components (MarketSection, etc.) can look up specific indicator IDs
 * by name — without that, calmly-trading indicators like breakeven_5y
 * or ftse_250 would render as "—" on a quiet day.
 */
export async function getTodayMovements(env: Env): Promise<TodayMovement[]> {
  // Persisted rows can outlive a retired indicator. Keep those archive rows,
  // but exclude them before ranking so they cannot displace current cards.
  const marketIds = Object.values(INDICATORS).filter(i => i.pillar === "market").map(i => i.id);
  const res = await env.DB
    .prepare(
      `SELECT indicator_id, label, latest_value, display_value, change, change_pct,
              change_display, direction, worsening, sparkline, gloss, observed_at
       FROM today_movements
       WHERE indicator_id IN (${marketIds.map(() => "?").join(", ")})
       ORDER BY worsening DESC, ABS(change_pct) DESC`,
    )
    .bind(...marketIds)
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
    unit: INDICATORS[r.indicator_id]!.unit,
    latestValue: r.latest_value,
    displayValue: r.display_value,
    change: r.change,
    changePct: r.change_pct,
    changeDisplay: r.change_display,
    direction: r.direction,
    worsening: r.worsening === 1,
    sparkline: parseSparklineSafe(r.sparkline, r.indicator_id),
    gloss: r.gloss,
    sourceId: INDICATORS[r.indicator_id]!.sourceId,
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

export async function getTimelineEvents(env: Env, limit = 40, since?: string): Promise<TimelineEvent[]> {
  const res = await env.DB
    .prepare(
      `SELECT id, event_date, title, summary, category, source_label, source_url, score_delta
       FROM timeline_events ${since ? "WHERE event_date >= ?2" : ""} ORDER BY event_date DESC LIMIT ?1`,
    )
    .bind(limit, ...(since ? [since] : []))
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
export async function getHistory(env: Env, days: number, resolution: ScoreHistoryResolutionRequest = "auto"): Promise<ScoreHistory> {
  const clampedDays = clampHistoryDays(days);
  if (clampedDays === 90 && (resolution === "auto" || resolution === "daily")) {
    const cached = await safeKvHistory(env);
    if (cached) return { ...cached, requestedResolution: resolution };
  }
  return buildHistoryFromD1(env, clampedDays, resolution);
}

async function safeKvHistory(env: Env): Promise<ScoreHistory | null> {
  try {
    const cached = await env.KV.get<ScoreHistory>("score:history:90d", "json");
    if (!cached || cached.schemaVersion !== SCORE_HISTORY_SCHEMA_VERSION) return null;
    if (cached.sampling !== "last_recorded_in_bucket" || cached.resolution !== "daily" || !historyIsFresh(cached)) return null;
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

const KV_BASELINES_KEY = METHODOLOGY_BASELINES_CACHE_KEY;
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
      `SELECT indicator_id, source_id, observed_at, value, released_at, payload_hash, ingested_at
       FROM indicator_observations
       WHERE observed_at >= ?
         AND NOT (observed_at >= ? AND observed_at <= ?)
       ORDER BY indicator_id, observed_at ASC`,
    )
    .bind(BASELINE_START_ISO, COVID_EXCLUDE_START_ISO, COVID_EXCLUDE_END_ISO)
    .all<BaselineObservationRow>();
  const rows = selectBaselineObservations(res.results ?? []);
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
export function buildHistoryFromD1(env: Env, days: number, resolution: ScoreHistoryResolutionRequest = "auto"): Promise<ScoreHistory> {
  return readScoreHistory(env.DB, days, resolution);
}
