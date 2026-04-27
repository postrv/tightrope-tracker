/**
 * Per-indicator freshness helpers used by the homepage display.
 *
 * The headline `updatedAt` field is the recompute timestamp — refreshed every
 * five minutes by the cron loop, regardless of whether the underlying
 * indicators have moved. A ten-day-old fixture observation will still show a
 * "live" recompute time. To avoid that misleading-fresh chrome, the homepage
 * computes the freshest *observation* timestamp across all indicators and
 * uses that wherever the user is asked to read "how live is this?".
 *
 * Scope: read-only, no side effects, called once per SSR render.
 */
import type { ScoreSnapshot, TodayMovement } from "@tightrope/shared";
import { INDICATORS } from "@tightrope/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FreshnessSummary {
  /** ISO timestamp of the freshest indicator observation (max over pillars + movements). */
  freshestAt: string | null;
  /** Days between `now` and `freshestAt`, or null when no observation found. */
  freshestAgeDays: number | null;
  /** Indicators whose `observedAt` is past their `maxStaleMs`. Sorted by age desc. */
  staleIndicators: StaleIndicatorRef[];
  /** Indicators whose age is between 0.5x and 1x of `maxStaleMs` — "ageing", warning territory. */
  ageingIndicators: StaleIndicatorRef[];
}

export interface StaleIndicatorRef {
  indicatorId: string;
  label: string;
  observedAt: string;
  ageDays: number;
  maxDays: number;
}

/**
 * Per-indicator freshness state. "fresh" = under half of maxStaleMs.
 * "ageing" = between 0.5x and 1x. "stale" = past maxStaleMs.
 */
export function ageBand(observedAt: string, indicatorId: string, now = Date.now()): "fresh" | "ageing" | "stale" | "unknown" {
  const def = INDICATORS[indicatorId];
  if (!def) return "unknown";
  const ms = Date.parse(observedAt);
  if (!Number.isFinite(ms)) return "unknown";
  const age = now - ms;
  if (age >= def.maxStaleMs) return "stale";
  if (age >= def.maxStaleMs * 0.5) return "ageing";
  return "fresh";
}

/** Compact age string for chips: "fresh", "3d", "2w", "5w" — read-at-a-glance. */
export function ageShort(observedAt: string, now = Date.now()): string {
  const ms = Date.parse(observedAt);
  if (!Number.isFinite(ms)) return "";
  const ageDays = Math.max(0, (now - ms) / DAY_MS);
  if (ageDays < 1) {
    const hours = Math.max(1, Math.round((now - ms) / (60 * 60 * 1000)));
    return `${hours}h`;
  }
  const days = Math.round(ageDays);
  if (days < 14) return `${days}d`;
  const weeks = Math.round(ageDays / 7);
  if (weeks < 9) return `${weeks}w`;
  const months = Math.round(ageDays / 30);
  return `${months}mo`;
}

export function summariseFreshness(
  snapshot: ScoreSnapshot,
  movements: readonly TodayMovement[],
  now = Date.now(),
): FreshnessSummary {
  const observedAtById = new Map<string, string>();
  for (const pillar of Object.values(snapshot.pillars)) {
    for (const c of pillar.contributions ?? []) {
      const existing = observedAtById.get(c.indicatorId);
      if (!existing || Date.parse(c.observedAt) > Date.parse(existing)) {
        observedAtById.set(c.indicatorId, c.observedAt);
      }
    }
  }
  for (const m of movements) {
    const existing = observedAtById.get(m.indicatorId);
    if (!existing || Date.parse(m.observedAt) > Date.parse(existing)) {
      observedAtById.set(m.indicatorId, m.observedAt);
    }
  }

  let freshestMs = 0;
  const stale: StaleIndicatorRef[] = [];
  const ageing: StaleIndicatorRef[] = [];

  for (const [indicatorId, observedAt] of observedAtById) {
    const def = INDICATORS[indicatorId];
    if (!def) continue;
    const ms = Date.parse(observedAt);
    if (!Number.isFinite(ms)) continue;
    if (ms > freshestMs) freshestMs = ms;
    const ageMs = now - ms;
    const ageDays = ageMs / DAY_MS;
    const maxDays = def.maxStaleMs / DAY_MS;
    const ref: StaleIndicatorRef = { indicatorId, label: def.shortLabel, observedAt, ageDays, maxDays };
    if (ageMs >= def.maxStaleMs) stale.push(ref);
    else if (ageMs >= def.maxStaleMs * 0.5) ageing.push(ref);
  }

  stale.sort((a, b) => b.ageDays - a.ageDays);
  ageing.sort((a, b) => b.ageDays - a.ageDays);

  const freshestAt = freshestMs > 0 ? new Date(freshestMs).toISOString() : null;
  const freshestAgeDays = freshestMs > 0 ? (now - freshestMs) / DAY_MS : null;

  return { freshestAt, freshestAgeDays, staleIndicators: stale, ageingIndicators: ageing };
}
