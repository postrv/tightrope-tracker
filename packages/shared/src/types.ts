import type { PillarId } from "./indicators.js";
import type { ScoreBand } from "./bands.js";

/** ISO-8601 UTC timestamp (e.g. `2026-04-17T14:02:00Z`). */
export type Iso8601 = string;

export const SCORE_SCHEMA_VERSION = 2;
export const SCORE_HISTORY_SCHEMA_VERSION = 2;
export const SCORE_DIRECTION = "higher_is_better" as const;

/**
 * Sentinel timestamp used by the D1 fallback paths (API + SSR) when no
 * headline row exists yet — i.e. the DB is freshly migrated but the seed
 * has not run, or the seed was purged. Stamping `now` would make the
 * placeholder snapshot look fresh and bypass the not-seeded screen, so we
 * stamp the unix epoch instead. The API's `looksUnseeded` predicate (and
 * any future SSR equivalent) tests `Date.parse(updatedAt) < Date.UTC(2000, 0, 1)`
 * to distinguish a placeholder from a real read.
 */
export const EPOCH_ISO = "1970-01-01T00:00:00.000Z" as const;

/** A pillar's score at a point in time. 0 = critical / badly off track, 100 = on track / room to move. Higher is better. */
export interface PillarScore {
  pillar: PillarId;
  /** Human-readable label, sourced from `PILLARS[pillar].shortTitle`. */
  label: string;
  value: number;
  band: ScoreBand;
  weight: number;
  /** Contribution breakdown by raw input for debugging / hover-inspect. */
  contributions: IndicatorContribution[];
  /** Trend arrow vs. 7 days ago. */
  trend7d: Trend;
  /** Delta vs. 7d ago, in score points. */
  delta7d: number;
  /**
   * Trend across the full `sparkline30d` window (first → last). Matches
   * the visible chart, so a rendered "flat" label can never contradict
   * an obvious drop or rise in the sparkline next to it.
   */
  trend30d: Trend;
  /** Delta across the `sparkline30d` window, in score points (first → last). */
  delta30d: number;
  sparkline30d: number[];
  /** True if fewer than a quorum of indicators have a fresh reading; the value is a last-known carry, not a fresh recompute. */
  stale?: boolean;
}

export interface IndicatorContribution {
  indicatorId: string;
  rawValue: number;
  rawValueUnit: string;
  zScore: number;
  normalised: number;
  /** Weight of this indicator within its pillar (sums to 1 across the pillar). */
  weight: number;
  sourceId: string;
  observedAt: Iso8601;
}

export type Trend = "up" | "down" | "flat";

export interface HeadlineScore {
  value: number;
  band: ScoreBand;
  editorial: string;
  updatedAt: Iso8601;
  /**
   * Headline delta over the most recent one-UTC-day step of the scored
   * series. Historically named `delta24h` for API stability, but the UI
   * label is "1d" — the value is indexed-based (series.at(-1) - series.at(-2))
   * rather than a literal 24-hour-ago lookup, so it can be anywhere in
   * [~12h, ~48h] depending on when the most recent recompute fell inside
   * its day. The recompute path uses `valueAtLeastAgo(..., 24h)` which is
   * closer to a true 24h diff; both paths round into the same field.
   */
  delta24h: number;
  delta30d: number;
  deltaYtd: number;
  /**
   * ISO date of the row actually used as the 30d baseline. Populated
   * when the baseline is meaningfully older or younger than a clean 30
   * days — i.e. when the history doesn't yet reach the intended window.
   * UI should render "since DD MMM" from this field rather than the
   * hardcoded "30d" label. Omitted when the baseline sits within a few
   * days of the target (cleanly 30d-old).
   */
  delta30dBaselineDate?: Iso8601;
  /**
   * ISO date of the row actually used as the YTD baseline. Populated
   * when the baseline is meaningfully later than 1 January of the
   * current year (history doesn't yet reach back to Jan 1). Also
   * populated in the shared-fallback case where the delta30d and
   * deltaYtd baselines collapse to the same row — the UI can then
   * honestly render one "since DD MMM" note instead of two misleading
   * identical numbers.
   */
  deltaYtdBaselineDate?: Iso8601;
  dominantPillar: PillarId;
  sparkline90d: number[];
  /** True if any pillar was flagged stale; consumers should show a "stale data" chip and avoid treating the headline as authoritative. */
  stale?: boolean;
}

/**
 * A source whose most recent ingestion attempt did not succeed.
 *
 * Surfaces the "upstream feed has gone quiet" case earlier than the staleness
 * thresholds on PillarScore/HeadlineScore, which only fire once the existing
 * observations age out of their freshness window (2 days for fast-cadence, 7
 * days for slow-cadence pillars). A source can be failing for hours while
 * carry-forward values still score as fresh -- we want to say so.
 */
export interface SourceHealthEntry {
  sourceId: string;
  /** Human-readable name from the SOURCES catalog; "Unknown source" if not found. */
  name: string;
  /** "failure" or "partial" -- derived from the latest ingestion_audit row's status. */
  status: "failure" | "partial";
  /** When the most recent attempt (that failed) was started. */
  lastAttemptAt: Iso8601;
  /** When the source last ingested successfully; undefined if it has never succeeded. */
  lastSuccessAt?: Iso8601;
}

export interface ScoreSnapshot {
  headline: HeadlineScore;
  pillars: Record<PillarId, PillarScore>;
  /** Public score polarity. Since v2, higher scores mean more room to move; lower scores mean conditions are worsening (closer to the rope giving way). */
  scoreDirection: typeof SCORE_DIRECTION;
  /** Sources whose latest ingestion attempt did not succeed. Absent or empty when every source is healthy. */
  sourceHealth?: readonly SourceHealthEntry[];
  schemaVersion: typeof SCORE_SCHEMA_VERSION;
}

export interface ScoreHistoryPoint {
  timestamp: Iso8601;
  headline: number;
  pillars: Record<PillarId, number>;
}

export interface ScoreHistory {
  points: ScoreHistoryPoint[];
  /** Max range returned — older data is in R2 archives. */
  rangeDays: number;
  /** Public score polarity for every point in this series. */
  scoreDirection: typeof SCORE_DIRECTION;
  schemaVersion: typeof SCORE_HISTORY_SCHEMA_VERSION;
}

export interface TodayMovement {
  indicatorId: string;
  label: string;
  unit: string;
  latestValue: number;
  displayValue: string;
  change: number;
  /** Percentage change vs. prior print; null when the prior value is near-zero and the ratio would be meaningless. */
  changePct: number | null;
  changeDisplay: string;
  direction: Trend;
  /** "Up" != "worse" universally -- each indicator knows whether rising is bad. */
  worsening: boolean;
  sparkline: number[];
  gloss: string;
  sourceId: string;
  observedAt: Iso8601;
}

export interface IngestionAuditEntry {
  id: string;
  sourceId: string;
  startedAt: Iso8601;
  completedAt: Iso8601 | null;
  status: "success" | "failure" | "partial";
  rowsWritten: number;
  payloadHash: string;
  error: string | null;
  sourceUrl: string;
}

export interface CorrectionEntry {
  id: string;
  publishedAt: Iso8601;
  affectedIndicator: string;
  originalValue: string;
  correctedValue: string;
  reason: string;
}
