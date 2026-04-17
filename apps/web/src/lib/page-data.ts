import type {
  ScoreSnapshot,
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
  getTodayMovements,
  getDeliveryCommitments,
  getTimelineEvents,
  getCorrections,
  getLastIngestionAudit,
} from "./db.js";

export interface HomepageData {
  snapshot: ScoreSnapshot;
  movements: TodayMovement[];
  delivery: DeliveryCommitment[];
  timeline: TimelineEvent[];
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
    const [snapshot, movements, delivery, timeline] = await Promise.all([
      getLatestSnapshot(env).catch(() => emptySnapshot()),
      getTodayMovements(env).catch(() => [] as TodayMovement[]),
      getDeliveryCommitments(env).catch(() => [] as DeliveryCommitment[]),
      getTimelineEvents(env, 20).catch(() => [] as TimelineEvent[]),
    ]);
    const empty = snapshot.headline.value === 0 && movements.length === 0;
    return { snapshot, movements, delivery, timeline, empty };
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
  };
}

function emptySnapshot(): ScoreSnapshot {
  const pillars = {} as Record<PillarId, PillarScore>;
  for (const id of PILLAR_ORDER) {
    pillars[id] = {
      pillar: id,
      value: 0,
      band: bandFor(0).id,
      weight: PILLARS[id].weight,
      contributions: [],
      trend7d: "flat",
      delta7d: 0,
      sparkline30d: [],
    };
  }
  const headline: HeadlineScore = {
    value: 0,
    band: bandFor(0).id,
    editorial: "Data loading — the first ingestion run has not completed yet.",
    updatedAt: new Date().toISOString(),
    delta24h: 0,
    delta30d: 0,
    deltaYtd: 0,
    dominantPillar: "market",
    sparkline90d: [],
  };
  return { headline, pillars, schemaVersion: 1 };
}
