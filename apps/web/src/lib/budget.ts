import { INDICATORS, SOURCES } from "@tightrope/shared";
import { readLatestObservations, type LatestObservationRow } from "@tightrope/snapshot";
import recordedBaseline from "../../../../packages/data-sources/src/fixtures/budget-2026-baseline.json";

/** Parliament advertised approximately 12:30. This is a comparison cutoff,
 * not an assertion about the precise start of the Chancellor's statement. */
export const BUDGET_COMPARISON_AT = "2026-10-28T12:30:00Z";

// The original snapshot stays immutable. These captured inputs were later
// found to be invalid, so they cannot serve as a before/after denominator.
const INVALIDATED_BASELINES: Record<string, string> = {
  breakeven_5y: "The archived reference subtracted the BoE inflation series from a nominal yield. IUDSIZC already measures inflation compensation; the original reference is invalid and no Budget change is calculated.",
  vacancies_per_unemployed: "The archived reference combined vacancies and unemployment from different months. The corrected reading uses their latest common period; no Budget change is calculated from the invalid reference.",
};

export interface BudgetReading {
  value: number;
  display: string;
  observedAt: string;
  releasedAt: string | null;
  ingestedAt: string | null;
  sourceId: string;
  sourceLabel: string;
  sourceUrl: string;
}
export interface BudgetIndicatorComparison {
  id: string;
  label: string;
  unit: string;
  pillar: string;
  before: BudgetReading | null;
  latest: BudgetReading | null;
  status: "post_budget_observation" | "budget_day_observation" | "forecast_revision" | "awaiting_post_budget_data" | "baseline_unavailable" | "baseline_invalidated" | "unavailable";
  baselineNotice: string | null;
  delta: number | null;
  deltaDisplay: string | null;
}
export interface BudgetComparison {
  cutoff: string;
  baselineMode: "recorded_snapshot";
  baselineCapturedAt: string;
  baselineSnapshotAt: string;
  baselineSourceUrl: string;
  baselineArchiveUrl: string;
  baselineSourceSha256: string;
  generatedAt: string;
  indicators: BudgetIndicatorComparison[];
  score: {
    before: { timestamp: string; value: number } | null;
    latest: { timestamp: string; value: number } | null;
    delta: number | null;
    comparable: boolean;
    corrections: Array<{ date: string; title: string }>;
  };
  unavailable: boolean;
}

export function compareBudgetScore(
  before: BudgetComparison["score"]["before"], latest: BudgetComparison["score"]["latest"],
  corrections: Array<{ date: string; title: string }>,
): BudgetComparison["score"] {
  const relevantCorrections = corrections.filter(row => before && latest
    && Date.parse(row.date) > Date.parse(before.timestamp) && Date.parse(row.date) <= Date.parse(latest.timestamp));
  const comparable = !!before && !!latest && relevantCorrections.length === 0
    && Number.isFinite(before.value) && Number.isFinite(latest.value)
    && Date.parse(latest.timestamp) >= Date.parse(BUDGET_COMPARISON_AT);
  return { before, latest, comparable, delta: comparable ? latest!.value - before!.value : null, corrections: relevantCorrections };
}

function reading(row: LatestObservationRow | undefined, id: string): BudgetReading | null {
  if (!row || !Number.isFinite(row.value)) return null;
  const source = SOURCES[row.source_id];
  return {
    value: row.value, display: INDICATORS[id]!.formatDisplay(row.value),
    observedAt: row.observed_at, releasedAt: row.released_at, ingestedAt: row.ingested_at || null,
    sourceId: row.source_id, sourceLabel: source?.name ?? row.source_id, sourceUrl: source?.homepage ?? "",
  };
}

export function compareBudgetIndicator(id: string, beforeRow?: LatestObservationRow, latestRow?: LatestObservationRow): BudgetIndicatorComparison {
  const definition = INDICATORS[id]!;
  const baselineNotice = INVALIDATED_BASELINES[id] ?? null;
  const before = baselineNotice ? null : reading(beforeRow, id);
  const latest = reading(latestRow, id);
  // A later ingest/release of an older reference period is not a post-Budget
  // economic outcome. OBR is explicitly a forecast-vintage comparison.
  const isForecast = id === "cb_headroom" || id === "psnfl_trajectory";
  const publicationAfter = latest && Date.parse(latest.releasedAt ?? latest.observedAt) >= Date.parse(BUDGET_COMPARISON_AT);
  const hasNewReference = latest && publicationAfter && Date.parse(latest.observedAt) >= Date.parse(BUDGET_COMPARISON_AT);
  const hasNewForecast = latest && isForecast && Date.parse(latest.releasedAt ?? latest.observedAt) >= Date.parse(BUDGET_COMPARISON_AT);
  const isBudgetDay = latest && latest.observedAt.slice(0, 10) === BUDGET_COMPARISON_AT.slice(0, 10)
    && /T00:00:00(?:\.000)?Z$/.test(latest.observedAt)
    && (!latest.releasedAt || Date.parse(latest.releasedAt) >= Date.parse(BUDGET_COMPARISON_AT));
  const status = !latest ? "unavailable" : baselineNotice ? "baseline_invalidated" : !before ? "baseline_unavailable"
    : hasNewForecast ? "forecast_revision" : hasNewReference ? "post_budget_observation"
    : isBudgetDay ? "budget_day_observation" : "awaiting_post_budget_data";
  // Do not manufacture a zero change for a feed that still predates the event.
  const delta = before && latest && (status === "forecast_revision" || status === "post_budget_observation" || status === "budget_day_observation")
    ? latest.value - before.value : null;
  const unit = definition.unit;
  const formattedDelta = delta === null ? null : unit === "%" ? (["gilt_10y", "gilt_30y", "breakeven_5y", "mortgage_2y_fix"].includes(id) ? `${Math.abs(delta * 100).toFixed(1)} bp` : `${Math.abs(delta).toFixed(2)} pp`)
    : unit === "GBPbn" ? `£${Math.abs(delta).toFixed(1)}bn` : `${Math.abs(delta).toFixed(2)} ${unit}`;
  return { id, label: definition.label, unit, pillar: definition.pillar, before, latest, status, baselineNotice, delta,
    deltaDisplay: delta === null ? null : `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${formattedDelta}` };
}

export async function loadBudgetComparison(locals: App.Locals): Promise<BudgetComparison> {
  const result: BudgetComparison = {
    cutoff: BUDGET_COMPARISON_AT, baselineMode: "recorded_snapshot",
    baselineCapturedAt: recordedBaseline.capturedAt, baselineSourceUrl: recordedBaseline.sourceUrl,
    baselineSnapshotAt: recordedBaseline.sourceSnapshotAt,
    baselineArchiveUrl: "/evidence/budget-2026-reference-snapshot.json",
    baselineSourceSha256: recordedBaseline.sourceFileSha256,
    generatedAt: new Date().toISOString(), indicators: [],
    score: { before: null, latest: null, delta: null, comparable: false, corrections: [] }, unavailable: true,
  };
  const db = locals.runtime?.env?.DB;
  if (!db) return result;
  try {
    const [latest, scoreBefore, scoreLatest, corrections] = await Promise.all([
      readLatestObservations(db),
      db.prepare("SELECT observed_at AS timestamp, value FROM headline_scores WHERE observed_at < ?1 ORDER BY observed_at DESC LIMIT 1")
        .bind(BUDGET_COMPARISON_AT).first<{ timestamp: string; value: number }>(),
      db.prepare("SELECT observed_at AS timestamp, value FROM headline_scores ORDER BY observed_at DESC LIMIT 1")
        .first<{ timestamp: string; value: number }>(),
      db.prepare("SELECT event_date AS date, title FROM timeline_events WHERE category = 'methodology' ORDER BY event_date DESC")
        .all<{ date: string; title: string }>(),
    ]);
    // Immutable captured inputs survive later revisions, re-fetches and
    // backfills. Snapshot12:55, archived12:56 (after advertised statement start);
    // every constituent reference/release was earlier than12:30. Neither
    // the capture timestamp nor a month-end label is an intraday quote.
    const beforeById = new Map(Object.entries(recordedBaseline.readings).map(([id, row]) => [id, {
      indicator_id: id, source_id: row.sourceId, value: row.value,
      observed_at: row.observedAt, released_at: row.releasedAt, ingested_at: "",
    }]));
    const latestById = new Map(latest.map(row => [row.indicator_id, row]));
    result.indicators = Object.keys(INDICATORS).map(id => compareBudgetIndicator(id, beforeById.get(id), latestById.get(id)));
    result.score = compareBudgetScore(scoreBefore, scoreLatest, corrections.results);
    result.unavailable = false;
  } catch (err) {
    console.error("Budget comparison unavailable", err);
  }
  return result;
}
