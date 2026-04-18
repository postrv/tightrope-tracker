import { PILLARS, type PillarId } from "./indicators.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Fast-cadence pillars (intraday / daily) must have a reading inside a 2-day
 * window to be considered fresh; slow-cadence pillars (monthly / event) get 7
 * days. These thresholds are used both server-side at recompute time (to
 * decide whether to persist a new pillar row) and at API serve time (to flag
 * a previously-fresh row as stale because the data layer has gone quiet).
 */
export const MAX_STALE_MS_FAST = 2 * DAY_MS;
export const MAX_STALE_MS_SLOW = 7 * DAY_MS;

export function maxStaleMsForPillar(pillarId: PillarId): number {
  const cadence = PILLARS[pillarId].cadence;
  return cadence === "intraday" || cadence === "daily" ? MAX_STALE_MS_FAST : MAX_STALE_MS_SLOW;
}

/**
 * Is the reading at `observedAt` outside the staleness window for `pillarId`?
 * `now` is injectable for deterministic tests.
 */
export function isPillarStale(pillarId: PillarId, observedAt: string, now: Date = new Date()): boolean {
  const ts = Date.parse(observedAt);
  if (!Number.isFinite(ts)) return true;
  return now.getTime() - ts > maxStaleMsForPillar(pillarId);
}
