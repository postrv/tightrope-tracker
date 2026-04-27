/**
 * D1 query layer for the public API.
 *
 * Patterns are intentionally aligned with apps/web/src/lib/db.ts — but copied,
 * not imported. The contract we care about is "same rows, same shapes". If the
 * shared lifts ever diverge, it should be by design and with a contract note,
 * not a silent import coupling.
 */
import type {
  PillarId,
  ScoreSnapshot,
  PillarScore,
  HeadlineScore,
  ScoreHistory,
  ScoreHistoryPoint,
  DeliveryCommitment,
  DeliveryStatus,
  IndicatorContribution,
  SourceHealthEntry,
  TimelineEvent,
  TimelineCategory,
  Trend,
  Iso8601,
} from "@tightrope/shared";
import { INDICATORS, PILLAR_ORDER, PILLARS, bandFor, computeSourceHealth, isScoreRowStale } from "@tightrope/shared";

interface PillarLatestRow {
  id: PillarId;
  observed_at: string;
  value: number;
  band: string;
}
interface PillarSeriesRow {
  id: PillarId;
  observed_at: string;
  value: number;
}
interface HeadlineRow {
  observed_at: string;
  value: number;
  band: string;
  dominant: string;
  editorial: string;
}

export async function buildSnapshotFromD1(env: Env): Promise<ScoreSnapshot> {
  const db = env.DB;

  const [headlineRow, headlineHistory, pillarsLatest, pillarHistory, latestAttempts, lastSuccesses, latestObservations] = await Promise.all([
    db.prepare(
      "SELECT observed_at, value, band, dominant, editorial FROM headline_scores ORDER BY observed_at DESC LIMIT 1",
    ).first<HeadlineRow>(),
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
    ).all<{ observed_at: string; value: number }>(),
    db.prepare(
      `SELECT p.pillar_id AS id, p.observed_at, p.value, p.band
       FROM pillar_scores p
       JOIN (
         SELECT pillar_id, MAX(observed_at) AS ts FROM pillar_scores GROUP BY pillar_id
       ) m ON p.pillar_id = m.pillar_id AND p.observed_at = m.ts`,
    ).all<PillarLatestRow>(),
    // Downsample to one row per UTC day per pillar (latest per day wins) over
    // the last 30 days. Mirrors the headline query above. Without this, the
    // 30-day window includes every 5-minute recompute row (~300+ per pillar
    // per day) so `series.at(-7)` in the trend calc below would reach back
    // ~30 minutes rather than 7 days, and the serialized sparkline has no
    // meaningful shape.
    db.prepare(
      `SELECT p.pillar_id AS id, p.observed_at, p.value FROM pillar_scores p
       JOIN (
         SELECT pillar_id, substr(observed_at, 1, 10) AS day, MAX(observed_at) AS ts
         FROM pillar_scores
         WHERE observed_at >= datetime('now', '-30 days')
         GROUP BY pillar_id, substr(observed_at, 1, 10)
       ) m ON p.pillar_id = m.pillar_id AND p.observed_at = m.ts
       ORDER BY p.pillar_id, p.observed_at ASC`,
    ).all<PillarSeriesRow>(),
    // Latest ingestion attempt per source (any status). Used to surface "source
    // is failing upstream" ahead of the staleness-threshold thresholds.
    db.prepare(
      `SELECT i.source_id, i.started_at, i.status FROM ingestion_audit i
       JOIN (
         SELECT source_id, MAX(started_at) AS ts FROM ingestion_audit GROUP BY source_id
       ) m ON i.source_id = m.source_id AND i.started_at = m.ts`,
    ).all<{ source_id: string; started_at: string; status: string }>(),
    // Last successful attempt per source -- lets the UI say "failing since X hours ago".
    db.prepare(
      // 'unchanged' is a healthy fetch (same payload as last time).
      // Include it so sources that publish less often than they're
      // polled don't appear to be failing between real updates.
      `SELECT source_id, MAX(started_at) AS last_success
       FROM ingestion_audit WHERE status IN ('success', 'unchanged') GROUP BY source_id`,
    ).all<{ source_id: string; last_success: string }>(),
    // Latest *live* observation per indicator. We pick by MAX(ingested_at)
    // — not MAX(observed_at) — so the row most recently written by an
    // adapter wins, even if an editorial fixture has moved its
    // `observed_at` backwards (e.g. an OBR EFO update where the
    // publication date is earlier than the previously-shipped fixture's
    // synthetic date). MAX(observed_at) locks onto the stale row;
    // MAX(ingested_at) tracks the current state.
    //
    // We also exclude historical-backfill rows (payload_hash 'hist:*')
    // and seed rows (payload_hash 'seed*') so a recently-run backfill
    // or seed re-import cannot be mis-selected as the live value. Live
    // adapters write a sha256 hash (no prefix); the NULL fallback
    // covers any pre-payload_hash rows.
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

  const now = new Date();
  const obsByIndicator = new Map<string, { value: number; observedAt: string; sourceId: string }>();
  for (const r of latestObservations.results) {
    obsByIndicator.set(r.indicator_id, { value: r.value, observedAt: r.observed_at, sourceId: r.source_id });
  }
  const pillars = {} as Record<PillarId, PillarScore>;
  let anyPillarStale = false;
  for (const p of PILLAR_ORDER) {
    const latest = pillarsLatest.results.find((r) => r.id === p);
    const series = pillarHistory.results.filter((r) => r.id === p).map((r) => r.value);
    const value = latest?.value ?? 0;
    const sevenDaysAgo = series.at(-7) ?? value;
    const delta = value - sevenDaysAgo;
    const trend: Trend = Math.abs(delta) < 0.5 ? "flat" : delta > 0 ? "up" : "down";
    // 30d trend/delta spans the full pillar sparkline (first → last) so
    // chart-adjacent labels can't contradict the visible chart. See
    // computePillarScore for the matching recompute-path implementation.
    const first = series[0];
    const last = series[series.length - 1];
    const delta30 = series.length >= 2 && first !== undefined && last !== undefined
      ? last - first
      : 0;
    const trend30: Trend = Math.abs(delta30) < 0.5 ? "flat" : delta30 > 0 ? "up" : "down";
    // Infer staleness at serve time. Recompute writes every non-stale pillar
    // every 5 minutes; if the latest row is past MAX_SCORE_AGE_MS (30 min),
    // either the loop is broken or this pillar has been failing its quorum.
    // Either way, the chip should say "stale", not "live".
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
      delta7d: round1(delta),
      trend30d: trend30,
      delta30d: round1(delta30),
      sparkline30d: series,
      ...(stale ? { stale: true } : {}),
    };
  }

  const hValue = headlineRow?.value ?? 0;
  // Already ordered ASC by observed_at (one row per UTC day, see SQL above).
  const hSeries = headlineHistory.results.map((r) => r.value);
  const hRows = headlineHistory.results;
  // If the headline row is missing we stamp updatedAt at the unix epoch so
  // callers can distinguish an empty-seed placeholder from a real read. See
  // looksUnseeded() in ../handlers/score.ts.
  const EPOCH_ISO = "1970-01-01T00:00:00.000Z";
  // Headline is stale if any pillar is stale OR the headline row itself is
  // past MAX_SCORE_AGE_MS. Recompute refuses to write a new headline row when
  // any pillar fails quorum, so an aging headline row is the canonical signal
  // that the dashboard is no longer live.
  const headlineStale = anyPillarStale || isScoreRowStale(headlineRow?.observed_at, now);
  const deltas30d = deltaAgoWithFallback(hRows, 30, 7);
  const deltasYtd = deltaAgoYtdWithFallback(hRows, now, 7);
  const headline: HeadlineScore = {
    value: hValue,
    band: (headlineRow?.band as HeadlineScore["band"]) ?? bandFor(hValue).id,
    editorial: headlineRow?.editorial ?? "",
    updatedAt: (headlineRow?.observed_at as Iso8601) ?? (EPOCH_ISO as Iso8601),
    dominantPillar: (headlineRow?.dominant as PillarId) ?? "market",
    sparkline90d: hSeries,
    delta24h: deltaAgo(hSeries, 1),
    // Mirrors the recompute fallback: if history doesn't reach back 30d, use
    // the oldest row as long as it's at least 7 days old. Converges to the
    // true 30d delta once history accumulates past 30 days. The
    // baselineDate is populated when the row we landed on sits more than
    // a week off the ideal target, so the UI can honestly render
    // "since DD MMM" rather than a misleading "30d" / "YTD" label.
    delta30d: deltas30d.value,
    deltaYtd: deltasYtd.value,
    ...(deltas30d.baselineDate ? { delta30dBaselineDate: deltas30d.baselineDate as Iso8601 } : {}),
    ...(deltasYtd.baselineDate ? { deltaYtdBaselineDate: deltasYtd.baselineDate as Iso8601 } : {}),
    ...(headlineStale ? { stale: true } : {}),
  };

  const lastSuccessBySource: Record<string, string> = {};
  for (const r of lastSuccesses.results) lastSuccessBySource[r.source_id] = r.last_success;
  const sourceHealth: readonly SourceHealthEntry[] = computeSourceHealth(
    latestAttempts.results.map((r) => ({ sourceId: r.source_id, startedAt: r.started_at, status: r.status })),
    lastSuccessBySource,
  );

  const snapshot: ScoreSnapshot = { headline, pillars, schemaVersion: 1 };
  if (sourceHealth.length > 0) snapshot.sourceHealth = sourceHealth;
  return snapshot;
}

export async function buildHistoryFromD1(env: Env, days: number): Promise<ScoreHistory> {
  // Cap matches the API days param (apps/api/src/handlers/score.ts) and the
  // ingest backfill cap so a /api/v1/score/history?days=800 request can serve
  // the full GE-2024-to-today range once backfilled.
  const clampedDays = Math.max(1, Math.min(800, Math.floor(days)));

  // Downsample to one row per UTC day (latest per day wins). The recompute
  // pipeline writes a fresh headline_scores row every 5 minutes, so on any
  // given day the table holds 200-300 rows. Without this aggregation the
  // chart shows hundreds of duplicate today-points clobbering older days,
  // and the 90-day cache slice (last 90 chronological rows) collapses to
  // ~7.5 hours of intraday recompute. Mirrors buildSnapshotFromD1's
  // sparkline downsample query.
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

  // Index pillar rows by timestamp.
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

/**
 * Lightweight contributions used in the D1-fallback snapshot path.
 *
 * The recompute loop writes a full snapshot (including z-score and
 * normalised contributions) into KV. When we miss the KV cache and
 * rebuild from D1 we don't have cheap access to the baseline series, so
 * we return `zScore: 0` / `normalised: 0` placeholders -- the raw
 * value, observedAt, sourceId and weight are enough for a stale banner
 * to name the specific indicator that froze, and for an API consumer
 * to inspect the inputs. Full contribution detail lives in KV.
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

// --- helpers ---------------------------------------------------------------

function deltaAgo(series: readonly number[], n: number): number {
  if (series.length < 2) return 0;
  const now = series.at(-1) ?? 0;
  const then = series.at(Math.max(0, series.length - 1 - n)) ?? now;
  return round1(now - then);
}

export interface DeltaWithBaseline {
  value: number;
  /**
   * Populated when the row actually used as the baseline is meaningfully
   * off-target (30d off by >7 days, or YTD later than Jan 8). Enables
   * the UI to render "since DD MMM" instead of a misleading "30d" /
   * "YTD" label when history is too short to cover the stated window.
   */
  baselineDate?: string;
}

/**
 * Delta over `targetDays` of one-row-per-day history. If the series doesn't
 * reach back far enough, fall back to the oldest row as long as it's at least
 * `minFallbackDays` old. Returns 0 when history is too thin to say anything.
 */
function deltaAgoWithFallback(
  rows: readonly { observed_at: string; value: number }[],
  targetDays: number,
  minFallbackDays: number,
): DeltaWithBaseline {
  if (rows.length < 2) return { value: 0 };
  const latest = rows[rows.length - 1]!;
  const idx = rows.length - 1 - targetDays;
  if (idx >= 0) {
    const baseline = rows[idx]!;
    return { value: round1(latest.value - baseline.value) };
  }
  const oldest = rows[0]!;
  const ageDays = (Date.now() - new Date(oldest.observed_at).getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays < minFallbackDays) return { value: 0 };
  // Fallback was used — flag baselineDate so the UI knows to say
  // "since DD MMM" rather than the requested window.
  return { value: round1(latest.value - oldest.value), baselineDate: oldest.observed_at };
}

/** Same idea, but with the target rooted at the 1 January of `now`'s year. */
function deltaAgoYtdWithFallback(
  rows: readonly { observed_at: string; value: number }[],
  now: Date,
  minFallbackDays: number,
): DeltaWithBaseline {
  if (rows.length < 2) return { value: 0 };
  const latest = rows[rows.length - 1]!;
  const startOfYearMs = Date.UTC(now.getUTCFullYear(), 0, 1);
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Scan backwards for the last row observed on or before 1 Jan. If we
  // find one within a week of Jan 1 it's "clean" YTD; further back is
  // also fine (Jan 1 is the target, earlier is a superset).
  for (let i = rows.length - 1; i >= 0; i--) {
    const rowMs = new Date(rows[i]!.observed_at).getTime();
    if (rowMs <= startOfYearMs) {
      return { value: round1(latest.value - rows[i]!.value) };
    }
  }
  const oldest = rows[0]!;
  const oldestMs = new Date(oldest.observed_at).getTime();
  const ageDays = (now.getTime() - oldestMs) / DAY_MS;
  if (ageDays < minFallbackDays) return { value: 0 };
  // Fallback was used — oldest row sits inside the current year.
  return { value: round1(latest.value - oldest.value), baselineDate: oldest.observed_at };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
