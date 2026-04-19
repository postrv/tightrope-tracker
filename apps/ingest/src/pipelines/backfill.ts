import type { D1PreparedStatement } from "@cloudflare/workers-types";
import {
  INDICATORS,
  PILLAR_ORDER,
  historicalIndicatorsForPillar,
  type PillarId,
  type PillarScore,
} from "@tightrope/shared";
import {
  computeHeadlineScore,
  computePillarScore,
  type IndicatorReading,
} from "@tightrope/methodology";
import type { Env } from "../env.js";
import {
  readBaselineObservations,
  readRecentObservations,
  valueAtLeastAgo,
  valueOldestIfAged,
  type ObservationRow,
} from "../lib/history.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Fraction of a pillar's indicators that must have any observation at or
 * before the target day for the day to be scored. Matches the live
 * recompute quorum. Days failing this are reported as gaps, not silently
 * filled with carry-forward values.
 */
const QUORUM_FRACTION = 0.5;

export interface BackfillOptions {
  /** How many UTC days (ending yesterday) to backfill. Clamped to [1, 365]. */
  days: number;
  /**
   * `true` (default): INSERT OR REPLACE — the backfill owns the row for the
   *   day. Re-runs are deterministic given the same observations.
   * `false`: INSERT OR IGNORE — preserves any row already present.
   */
  overwrite: boolean;
}

export interface BackfillGap {
  day: string;
  stalePillars: PillarId[];
  indicatorsWithData: number;
  totalIndicators: number;
}

export interface BackfillResult {
  startedAt: string;
  completedAt: string;
  daysRequested: number;
  /** Days where a headline row was written (all 4 pillars met quorum). */
  daysWritten: number;
  /**
   * Days where at least one pillar met quorum but at least one did not, so
   * per-pillar rows were written but the headline was suppressed. Gives the
   * pillar sparklines a backbone even when delivery (or any other pillar) is
   * historically thin. Counted separately from `daysSkipped`.
   */
  daysPartial: number;
  /** Days where no pillar met quorum -- nothing written for the day. */
  daysSkipped: number;
  earliestDayWritten: string | null;
  latestDayWritten: string | null;
  pillarRowsWritten: number;
  gaps: BackfillGap[];
}

/**
 * Rebuild historical headline and pillar scores from raw indicator
 * observations, one row per UTC day.
 *
 * Accuracy guarantees — the backfilled score for day D equals what the live
 * pipeline would have produced if we had run it on day D, given only the
 * observations then in the database:
 *
 *   1. Baseline-as-of-day — the ECDF baseline is filtered to observations
 *      with observed_at ≤ end-of-day(D). Prevents lookahead bias in the
 *      normalisation step.
 *   2. Readings-as-of-day — each indicator contributes its latest observation
 *      ≤ end-of-day(D), matching `latestByIndicator` in live recompute.
 *   3. Rolling priors — the loop walks oldest→newest so value7dAgo (pillar
 *      delta/trend) and value24h/30d/ytd ago (headline deltas / editorial
 *      text) reference actually-backfilled prior days rather than future
 *      data.
 *   4. Quorum enforcement — days with fewer than 50% of a pillar's
 *      indicators observed ≤ that day are skipped and reported in `gaps`.
 *      We do not carry-forward unknown values into historical rows.
 *
 * Today is excluded: live 5-minute recompute owns today's rows.
 *
 * The backfilled row is anchored at `YYYY-MM-DDT23:59:00.000Z` — late
 * enough to win the "latest observation that day" downsample, distinct
 * enough from live 5-minute rows that an operator can tell apart in the
 * raw history.
 */
export async function backfillHistoricalScores(
  env: Env,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const days = clampDays(opts.days);
  const overwrite = opts.overwrite;
  const startedAt = new Date().toISOString();

  // A backfill window of N days plus 30 days of lookback for the rolling
  // 30d pillar sparkline (used by trend7d in computePillarScore). 365 is
  // already enough for any 1-year window; for longer we read the larger
  // of (days + 30, 365).
  const [baseline, recent] = await Promise.all([
    readBaselineObservations(env.DB),
    readRecentObservations(env.DB, Math.max(days + 30, 365)),
  ]);

  const baselineByIndicator = groupByIndicator(baseline);
  const recentByIndicator = groupByIndicator(recent);

  const now = new Date();
  const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  const gaps: BackfillGap[] = [];
  const written: string[] = [];
  let daysPartial = 0;
  let pillarRowsWritten = 0;

  // Rolling records of this-run's output so each day's delta/editorial
  // references actually-backfilled predecessors, not live data. This is the
  // same pattern live recompute uses via readHeadlineHistory / readPillarHistory.
  const priorPillars: Record<PillarId, { observed_at: string; value: number }[]> = {
    market: [], fiscal: [], labour: [], delivery: [],
  };
  const priorHeadline: { observed_at: string; value: number }[] = [];

  const totalIndicators = Object.keys(INDICATORS).length;

  for (let offset = days; offset >= 1; offset--) {
    const dayStartMs = todayStartMs - offset * DAY_MS;
    const day = new Date(dayStartMs);
    const dayIso = day.toISOString().slice(0, 10);
    const observedAt = `${dayIso}T23:59:00.000Z`;
    const cutoffMs = dayStartMs + DAY_MS - 1;

    // Clip on publication date, not reference period. For indicators whose
    // adapter knows when the data became public (ONS PSF, LMS, RTI all
    // expose `updateDate` per observation), `released_at` is persisted and
    // used here; for daily series where published ≈ observed (BoE gilt
    // yields, fixture-backed adapters) it falls back to `observed_at`.
    // Without this, a March PSNB figure (observed_at=2025-03-31, released
    // ~2025-04-22) would flatter every backfilled score for April 1-21.
    const asOfMs = (r: ObservationRow): number => {
      const stamp = r.released_at ?? r.observed_at;
      return new Date(stamp).getTime();
    };

    // Baseline filtered to observations ≤ cutoff — no lookahead bias.
    // NOTE: baseline observations are sorted ASC by observed_at, but the
    // published-date cutoff may be non-monotonic (a later reference period
    // can have an earlier revision). Scan the whole slice rather than
    // breaking on the first out-of-range row.
    const baselineAsOf = new Map<string, number[]>();
    for (const [id, arr] of baselineByIndicator) {
      const vals: number[] = [];
      for (const r of arr) {
        if (asOfMs(r) <= cutoffMs) vals.push(r.value);
      }
      baselineAsOf.set(id, vals);
    }

    // Latest observation per indicator ≤ cutoff, comparing on release date.
    // Walk backwards (rows are sorted ASC by observed_at) and stop on the
    // first row whose release date is on/before cutoff. For indicators
    // where released_at is absent, this collapses to observed_at as before.
    const latestAsOf = new Map<string, { value: number; observedAt: string }>();
    for (const [id, arr] of recentByIndicator) {
      for (let i = arr.length - 1; i >= 0; i--) {
        const r = arr[i]!;
        if (asOfMs(r) <= cutoffMs) {
          latestAsOf.set(id, { value: r.value, observedAt: r.observed_at });
          break;
        }
      }
    }

    const pillars: Partial<Record<PillarId, PillarScore>> = {};
    const stalePillars: PillarId[] = [];
    let indicatorsWithData = 0;

    for (const pillarId of PILLAR_ORDER) {
      // Historical backfill counts quorum against the subset of indicators
      // that carry a defensible historical series. Editorial-only indicators
      // (e.g. delivery milestones curated from political announcements) are
      // tagged `hasHistoricalSeries: false` and deliberately excluded from
      // both the readings loop and the quorum denominator. This keeps the
      // historical dataset honest without preventing the pillar from ever
      // passing quorum — live recompute still uses every indicator. The
      // disclosure lives on /methodology via `liveOnlyIndicatorsForPillar`.
      const historicalIndicators = historicalIndicatorsForPillar(pillarId);
      const readings: IndicatorReading[] = [];
      for (const def of historicalIndicators) {
        const latest = latestAsOf.get(def.id);
        if (!latest) continue;
        indicatorsWithData++;
        readings.push({
          indicatorId: def.id,
          value: latest.value,
          observedAt: latest.observedAt,
          baseline: baselineAsOf.get(def.id) ?? [],
        });
      }
      const quorum = Math.max(1, Math.ceil(historicalIndicators.length * QUORUM_FRACTION));
      if (readings.length < quorum) {
        stalePillars.push(pillarId);
        continue;
      }
      const baseline7d = valueAtLeastAgo(priorPillars[pillarId], 7 * DAY_MS, day);
      const sparkline30d = priorPillars[pillarId].slice(-30).map((p) => p.value);
      pillars[pillarId] = computePillarScore(pillarId, {
        readings,
        sparkline30d,
        ...(baseline7d !== undefined ? { value7dAgo: baseline7d.value } : {}),
      });
    }

    const verb = overwrite ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
    const stmts: D1PreparedStatement[] = [];
    const passedPillars: PillarId[] = [];

    // Write pillar_scores for every pillar that met quorum, even if other
    // pillars didn't. This gives per-pillar sparklines a historical backbone
    // (market + fiscal + labour have real BoE/ONS history) when delivery is
    // historically thin because its indicators are fixture-only today.
    for (const p of PILLAR_ORDER) {
      const ps = pillars[p];
      if (!ps) continue;
      stmts.push(
        env.DB
          .prepare(
            `${verb} INTO pillar_scores (pillar_id, observed_at, value, band)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(p, observedAt, ps.value, ps.band),
      );
      passedPillars.push(p);
    }

    // Headline is strict: written only when every pillar met quorum, so the
    // 90-day sparkline never synthesises a weighted average over missing
    // pillars. Callers can still show pillar history independently.
    let headline: ReturnType<typeof computeHeadlineScore> | null = null;
    if (stalePillars.length === 0) {
      const pillarRecord = pillars as Record<PillarId, PillarScore>;
      const sparkline90d = priorHeadline.slice(-90).map((h) => h.value);
      const baseline24h = valueAtLeastAgo(priorHeadline, DAY_MS, day);
      // Fallback to oldest-if-aged for 30d / YTD matches the live recompute
      // path — early backfill days (few prior days in the synthesised
      // history) still get a populated delta rather than a flat 0. Baseline
      // dates are threaded through so the UI can honestly render "since
      // DD MMM" when history is too thin for the requested window.
      const MIN_FALLBACK_AGE_MS = 7 * DAY_MS;
      const baseline30d = valueAtLeastAgo(priorHeadline, 30 * DAY_MS, day)
        ?? valueOldestIfAged(priorHeadline, MIN_FALLBACK_AGE_MS, day);
      const startOfYearMs = Date.UTC(day.getUTCFullYear(), 0, 1);
      const ytdMs = day.getTime() - startOfYearMs;
      const baselineYtd = ytdMs > 0
        ? (valueAtLeastAgo(priorHeadline, ytdMs, day)
            ?? valueOldestIfAged(priorHeadline, MIN_FALLBACK_AGE_MS, day))
        : undefined;

      headline = computeHeadlineScore({
        pillars: pillarRecord,
        sparkline90d,
        updatedAt: observedAt,
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
      stmts.unshift(
        env.DB
          .prepare(
            `${verb} INTO headline_scores (observed_at, value, band, dominant, editorial)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(observedAt, headline.value, headline.band, headline.dominantPillar, headline.editorial),
      );
    }

    // Bookkeep before issuing SQL so we never record "written" if batch fails.
    if (stmts.length === 0) {
      gaps.push({ day: dayIso, stalePillars, indicatorsWithData, totalIndicators });
      continue;
    }

    await env.DB.batch(stmts);
    pillarRowsWritten += passedPillars.length;

    if (headline !== null) {
      written.push(dayIso);
      priorHeadline.push({ observed_at: observedAt, value: headline.value });
    } else {
      daysPartial++;
      gaps.push({ day: dayIso, stalePillars, indicatorsWithData, totalIndicators });
    }
    for (const p of passedPillars) {
      priorPillars[p].push({ observed_at: observedAt, value: pillars[p]!.value });
    }
  }

  // KV caches were built against pre-backfill data — invalidate so the next
  // read goes to D1 and reflects the newly-written history.
  await Promise.all([
    env.KV.delete("score:latest").catch(() => undefined),
    env.KV.delete("score:history:90d").catch(() => undefined),
  ]);

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    daysRequested: days,
    daysWritten: written.length,
    daysPartial,
    daysSkipped: gaps.length - daysPartial,
    earliestDayWritten: written[0] ?? null,
    latestDayWritten: written[written.length - 1] ?? null,
    pillarRowsWritten,
    gaps,
  };
}

function clampDays(n: number): number {
  if (!Number.isFinite(n)) return 90;
  return Math.max(1, Math.min(365, Math.floor(n)));
}

function groupByIndicator(rows: readonly ObservationRow[]): Map<string, ObservationRow[]> {
  const out = new Map<string, ObservationRow[]>();
  for (const r of rows) {
    const arr = out.get(r.indicator_id);
    if (arr) arr.push(r);
    else out.set(r.indicator_id, [r]);
  }
  return out;
}
