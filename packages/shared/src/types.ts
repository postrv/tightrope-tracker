import type { PillarId } from "./indicators.js";
import type { ScoreBand } from "./bands.js";

/** ISO-8601 UTC timestamp (e.g. `2026-04-17T14:02:00Z`). */
export type Iso8601 = string;

/** A pillar's score at a point in time. 0 = no pressure / on track, 100 = maximum stress / badly off track. */
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
  delta24h: number;
  delta30d: number;
  deltaYtd: number;
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
  /** Sources whose latest ingestion attempt did not succeed. Absent or empty when every source is healthy. */
  sourceHealth?: readonly SourceHealthEntry[];
  schemaVersion: 1;
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
  schemaVersion: 1;
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
