import type {
  ScoreSnapshot,
  ScoreHistory,
  TodayMovement,
  PillarId,
  PillarScore,
  HeadlineScore,
} from "@tightrope/shared";
import { PILLAR_ORDER, PILLARS, bandFor } from "@tightrope/shared";
import type { DeliveryCommitment } from "@tightrope/shared/delivery";
import type { TimelineEvent } from "@tightrope/shared/timeline";

import {
  getLatestSnapshot,
  getHistory,
  getTodayMovements,
  getDeliveryCommitments,
  getTimelineEvents,
  getCorrections,
  getLastIngestionAudit,
  getBaselineSummaries,
  type MethodologyBaselinesPayload,
} from "./db.js";

export interface HomepageData {
  snapshot: ScoreSnapshot;
  movements: TodayMovement[];
  delivery: DeliveryCommitment[];
  timeline: TimelineEvent[];
  /** 90-day headline + pillar history, used by HeadlineChartSection. */
  history: ScoreHistory;
  empty: boolean;
}

/**
 * Gather every piece of data the homepage needs, with graceful degradation if
 * D1 or KV aren't set up yet (e.g. first boot before seed).
 */
export async function loadHomepageData(astroLocals: App.Locals): Promise<HomepageData> {
  const env = astroLocals.runtime?.env;
  if (!env || !env.DB || !env.KV) {
    return { ...emptyFallback(), empty: true };
  }

  try {
    const [snapshot, movements, delivery, timeline, history] = await Promise.all([
      getLatestSnapshot(env).catch(() => emptySnapshot()),
      getTodayMovements(env).catch(() => [] as TodayMovement[]),
      getDeliveryCommitments(env).catch(() => [] as DeliveryCommitment[]),
      // Pull a wider timeline window for the chart annotations than the
      // homepage's editorial timeline (which is capped at 20). Markers
      // outside the 90-day chart window are dropped by mapEventsToChart.
      getTimelineEvents(env, 80).catch(() => [] as TimelineEvent[]),
      // 90-day history reads KV first (with a 30-min freshness gate),
      // falling through to D1 on miss / stale. Defensive: any failure
      // returns an empty history so the chart shows its empty-state
      // rather than crashing the page render.
      getHistory(env, 90).catch(() => emptyHistory()),
    ]);
    const empty = snapshot.headline.value === 0 && movements.length === 0;
    return { snapshot, movements, delivery, timeline, history, empty };
  } catch {
    return { ...emptyFallback(), empty: true };
  }
}

export async function loadCorrections(astroLocals: App.Locals) {
  const env = astroLocals.runtime?.env;
  if (!env || !env.DB) return [] as Awaited<ReturnType<typeof getCorrections>>;
  try {
    return await getCorrections(env);
  } catch {
    return [];
  }
}

export async function loadIngestionAudit(astroLocals: App.Locals) {
  const env = astroLocals.runtime?.env;
  if (!env || !env.DB) return [] as Awaited<ReturnType<typeof getLastIngestionAudit>>;
  try {
    return await getLastIngestionAudit(env);
  } catch {
    return [];
  }
}

export async function loadSnapshot(astroLocals: App.Locals): Promise<ScoreSnapshot> {
  const env = astroLocals.runtime?.env;
  if (!env || !env.DB || !env.KV) return emptySnapshot();
  try {
    return await getLatestSnapshot(env);
  } catch {
    return emptySnapshot();
  }
}

/**
 * Load per-indicator baseline summaries for the /explore simulator.
 *
 * Defensive: returns an empty payload when KV/D1 are unavailable so the
 * page still renders. Consumers (ExploreIsland) fall back to a linear
 * approximation per-indicator when its summary is missing -- the
 * fallback is per-indicator, not global, so partial coverage degrades
 * gracefully rather than disabling the whole simulator.
 */
export async function loadBaselineSummaries(astroLocals: App.Locals): Promise<MethodologyBaselinesPayload> {
  const env = astroLocals.runtime?.env;
  if (!env || !env.DB || !env.KV) return emptyBaselines();
  try {
    return await getBaselineSummaries(env);
  } catch {
    return emptyBaselines();
  }
}

export function emptyBaselines(): MethodologyBaselinesPayload {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    generatedAt: now,
    baselineStart: now,
    baselineEnd: now,
    excludeStart: now,
    excludeEnd: now,
    baselines: {},
  };
}

export async function loadMovements(astroLocals: App.Locals): Promise<TodayMovement[]> {
  const env = astroLocals.runtime?.env;
  if (!env || !env.DB) return [];
  try {
    return await getTodayMovements(env);
  } catch {
    return [];
  }
}

export async function loadDelivery(astroLocals: App.Locals): Promise<DeliveryCommitment[]> {
  const env = astroLocals.runtime?.env;
  if (!env || !env.DB) return [];
  try {
    return await getDeliveryCommitments(env);
  } catch {
    return [];
  }
}

function emptyFallback(): Omit<HomepageData, "empty"> {
  return {
    snapshot: emptySnapshot(),
    movements: [],
    delivery: [],
    timeline: [],
    history: emptyHistory(),
  };
}

/**
 * Empty ScoreHistory used as a default when KV/D1 are unavailable or the
 * fetch fails. Returning a typed-but-empty history lets downstream
 * components (the chart) render their own empty-state without needing
 * to special-case undefined.
 */
export function emptyHistory(): ScoreHistory {
  return { points: [], rangeDays: 90, schemaVersion: 1 };
}

/**
 * Load score history for an explicit window. Used by the long-composite
 * page (/composite) where the URL governs the range. Defensive: any
 * failure resolves to an empty history of the requested width so the
 * page still renders.
 */
export async function loadHistory(astroLocals: App.Locals, days: number): Promise<ScoreHistory> {
  const env = astroLocals.runtime?.env;
  if (!env || !env.DB) return { points: [], rangeDays: clampDays(days), schemaVersion: 1 };
  try {
    return await getHistory(env, days);
  } catch {
    return { points: [], rangeDays: clampDays(days), schemaVersion: 1 };
  }
}

function clampDays(days: number): number {
  if (!Number.isFinite(days)) return 90;
  // Cap matches apps/api/src/handlers/score.ts and the ingest backfill cap so
  // the long-composite page can serve the full GE-2024-to-today range.
  return Math.max(1, Math.min(800, Math.floor(days)));
}

function emptySnapshot(): ScoreSnapshot {
  const pillars = {} as Record<PillarId, PillarScore>;
  for (const id of PILLAR_ORDER) {
    pillars[id] = {
      pillar: id,
      label: PILLARS[id].shortTitle,
      value: 0,
      band: bandFor(0).id,
      weight: PILLARS[id].weight,
      contributions: [],
      trend7d: "flat",
      delta7d: 0,
      trend30d: "flat",
      delta30d: 0,
      sparkline30d: [],
    };
  }
  // Stamp the placeholder updatedAt with the Unix epoch — NOT the wall clock —
  // so a reader never sees "updated 09:32 UTC" next to score 0 during an
  // outage. The API's `looksUnseeded` predicate explicitly checks for
  // pre-2000 timestamps to suppress publication of placeholder data; the
  // homepage banner renders the data-loading copy when it sees a 1970 stamp.
  const headline: HeadlineScore = {
    value: 0,
    band: bandFor(0).id,
    editorial: "Data loading — the first ingestion run has not completed yet.",
    updatedAt: "1970-01-01T00:00:00.000Z",
    delta24h: 0,
    delta30d: 0,
    deltaYtd: 0,
    dominantPillar: "market",
    sparkline90d: [],
  };
  return { headline, pillars, schemaVersion: 1 };
}
