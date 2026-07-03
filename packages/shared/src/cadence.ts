import { SOURCES, type ExpectedCadence } from "./indicators.js";

/**
 * Release-cadence registry (AUTOMATION_PLAN.md §2.1).
 *
 * Staleness today is binary: an indicator is fresh until its `maxStaleMs`
 * window trips, at which point the pillar-quorum banner fires. That is a
 * *reactive* signal — by the time it lights up, a scheduled upstream release
 * has usually been missing for days. The cadence registry makes staleness
 * *predictive*: each source declares how often it publishes and how much
 * grace to allow, so we can say "a new S&P Global PMI should have landed by
 * now but we haven't ingested it" (amber) before the freshness guard trips
 * (red).
 *
 * The clock is always injected (`now: Date`) — no `Date.now()` in library
 * code, matching `staleness.ts`.
 */

export type { ExpectedCadence } from "./indicators.js";

/**
 * Cadence health of a single source:
 *   - green: the freshest ingested reading is inside the current publication
 *            cycle (no new upstream release is due yet).
 *   - amber: a new upstream release should exist by now but we have not
 *            ingested it — past the cadence period, still inside grace.
 *   - red:   past grace / maxStale — the freshness guard is (or is about to
 *            be) tripping.
 */
export type CadenceState = "green" | "amber" | "red";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Nominal days between two consecutive releases of a source on each cadence.
 * These are the *floor* of a healthy publishing rhythm — a reading younger
 * than this cannot be "overdue" because the next release isn't due yet.
 *
 *   trading-daily → 1 business day (weekend/bank-holiday slack lives in
 *                   graceDays so a Friday close doesn't flip amber on Sunday
 *                   the moment the calendar rolls over).
 *   monthly       → 31 (one calendar month; ONS/PMI/GfK/RICS/BoE monthly).
 *   quarterly     → 92 (~one quarter; MHCLG live tables).
 *   biannual      → 183 (~six months).
 *   event         → no predictable period; amber never fires on a schedule,
 *                   so the band collapses to green-until-grace / red-after
 *                   (OBR EFO, think-tank outputs).
 */
export const CADENCE_PERIOD_DAYS: Record<ExpectedCadence, number> = {
  "trading-daily": 1,
  monthly: 31,
  quarterly: 92,
  biannual: 183,
  event: Number.POSITIVE_INFINITY,
};

export interface EvaluateCadenceInput {
  /** Reference period of the freshest ingested reading (ISO-8601). */
  latestObservedAt: string;
  /**
   * Upstream *publication* instant of that reading, when known (ONS family
   * `updateDate`, OBR vintage date). Preferred over `latestObservedAt` as the
   * cadence anchor: a monthly ONS series is published ~3 weeks after its
   * reference month, so anchoring on the reference period alone would bake a
   * permanent lag into the age calculation and read amber the day it lands.
   */
  latestReleasedAt?: string;
  cadence: ExpectedCadence;
  /**
   * Absolute red-line, in days from the cadence anchor. Chosen per source to
   * mean "past this, a fresh release is definitively overdue" — usually at or
   * a little inside the indicator's `maxStaleMs` window so the chip warns
   * ahead of the quorum guard.
   */
  graceDays: number;
  now: Date;
}

/**
 * Decide the cadence state of a source's freshest reading at `now`.
 *
 * Model (non-event):
 *   age ≤ period          → green  (inside the current cycle)
 *   period < age ≤ grace  → amber  (a release is due/overdue, within grace)
 *   age > grace           → red    (past grace / maxStale)
 *
 * For `event` sources there is no period, so the amber band collapses:
 *   age ≤ grace → green,  age > grace → red.
 *
 * A future-dated anchor (clock skew, or a fixture stamped ahead) reads green.
 * An unparseable anchor reads red — we can't vouch for freshness we can't date.
 */
export function evaluateCadenceState(input: EvaluateCadenceInput): CadenceState {
  const anchor = input.latestReleasedAt ?? input.latestObservedAt;
  const anchorMs = Date.parse(anchor);
  if (!Number.isFinite(anchorMs)) return "red";
  const ageDays = (input.now.getTime() - anchorMs) / DAY_MS;
  if (ageDays < 0) return "green";

  const grace = input.graceDays;
  if (input.cadence === "event") {
    return ageDays > grace ? "red" : "green";
  }
  const period = CADENCE_PERIOD_DAYS[input.cadence];
  if (ageDays <= period) return "green";
  if (ageDays <= grace) return "amber";
  return "red";
}

/** One source's cadence health, surfaced on /admin/health, the snapshot, and /methodology. */
export interface SourceCadenceEntry {
  sourceId: string;
  /** Human-readable name from the SOURCES catalog. */
  name: string;
  cadence: ExpectedCadence;
  graceDays: number;
  state: CadenceState;
  /** Reference period of the freshest ingested reading. */
  latestObservedAt: string;
  /** Upstream publication instant, when the reading carried one. */
  latestReleasedAt?: string;
}

/** The per-source latest reading computeSourceCadence needs (a slim projection of an observation row). */
export interface LatestSourceObservation {
  sourceId: string;
  observedAt: string;
  releasedAt?: string | null;
}

/**
 * Roll a flat list of latest-per-indicator observations up to one cadence
 * entry per source, then evaluate each source's state.
 *
 * A source feeds one or more indicators; its cadence anchor is the freshest
 * (releasedAt ?? observedAt) across them. Observations whose `sourceId` has no
 * SOURCES entry (or an entry with no declared cadence) are skipped — cadence
 * is only meaningful for sources we know the publishing rhythm of.
 *
 * `now` is injected; the output is sorted by sourceId for stable UI order.
 */
export function computeSourceCadence(
  observations: readonly LatestSourceObservation[],
  now: Date,
): SourceCadenceEntry[] {
  const freshestBySource = new Map<string, LatestSourceObservation>();
  for (const o of observations) {
    if (!SOURCES[o.sourceId]) continue;
    const ref = o.releasedAt || o.observedAt;
    const prev = freshestBySource.get(o.sourceId);
    const prevRef = prev ? prev.releasedAt || prev.observedAt : "";
    if (!prev || ref > prevRef) freshestBySource.set(o.sourceId, o);
  }

  const out: SourceCadenceEntry[] = [];
  for (const [sourceId, o] of freshestBySource) {
    const src = SOURCES[sourceId]!;
    const state = evaluateCadenceState({
      latestObservedAt: o.observedAt,
      ...(o.releasedAt ? { latestReleasedAt: o.releasedAt } : {}),
      cadence: src.expectedCadence,
      graceDays: src.graceDays,
      now,
    });
    out.push({
      sourceId,
      name: src.name,
      cadence: src.expectedCadence,
      graceDays: src.graceDays,
      state,
      latestObservedAt: o.observedAt,
      ...(o.releasedAt ? { latestReleasedAt: o.releasedAt } : {}),
    });
  }
  out.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  return out;
}
