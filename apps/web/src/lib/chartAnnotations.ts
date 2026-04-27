/**
 * Pure helper that maps timeline events onto a headline-score history series.
 *
 * Used by AnnotatedHeadlineChart to position event markers on the SVG line.
 * The output is intentionally framework-agnostic (no DOM, no Astro) so the
 * same calculation can be re-used by alternative renderers (an OG image,
 * an embed page) and so it can be unit-tested deterministically.
 *
 * Snapping rules:
 *   - Events whose date falls outside the inclusive history window are dropped.
 *   - Each retained event snaps to the nearest history point by absolute
 *     day-distance, with a tolerance of one day. If the closest history
 *     point is more than one day away the event is dropped — we'd rather
 *     omit a marker than draw it on the wrong week.
 *   - Multiple events on the same day are all retained (the renderer handles
 *     stacking). Order is preserved from the input array — call sites that
 *     care about deterministic ordering should pre-sort.
 */
import type { ScoreHistory, TimelineEvent } from "@tightrope/shared";

/** A single annotation, ready to render into an SVG. */
export interface AnnotationPoint {
  /** The original timeline event. */
  event: TimelineEvent;
  /** Position along the chart x-axis as a 0..1 ratio (0 = first point, 1 = last). */
  xRatio: number;
  /** Index of the history point this event snapped to. */
  seriesIndex: number;
  /** Headline value at the snapped history point — used to position the marker on the y-axis. */
  value: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** One-day tolerance for snapping; events further than this from the nearest sample drop out. */
const SNAP_TOLERANCE_MS = DAY_MS;

/**
 * Snap each event to the nearest point in `history.points` by date.
 *
 * Returns a frozen array — the renderer should treat the result as immutable.
 */
export function mapEventsToChart(
  history: ScoreHistory,
  events: readonly TimelineEvent[],
): readonly AnnotationPoint[] {
  const points = history.points;
  if (points.length === 0 || events.length === 0) return [];

  // Pre-compute timestamp ms for each history point so the inner loop is cheap.
  // A non-finite timestamp (corrupt row) is excluded from the index pool but
  // doesn't block the function — we'd rather skip a single bad row than 404
  // the entire chart.
  const pointTimes: Array<{ idx: number; ms: number }> = [];
  for (let i = 0; i < points.length; i++) {
    const ms = Date.parse(points[i]!.timestamp);
    if (Number.isFinite(ms)) pointTimes.push({ idx: i, ms });
  }
  if (pointTimes.length === 0) return [];

  const firstMs = pointTimes[0]!.ms;
  const lastMs = pointTimes[pointTimes.length - 1]!.ms;
  // Allow a one-day grace either side of the inclusive window so events
  // observed late on the same UTC day as the first/last sample don't get
  // dropped on a millisecond technicality.
  const windowMin = firstMs - SNAP_TOLERANCE_MS;
  const windowMax = lastMs + SNAP_TOLERANCE_MS;
  const span = lastMs - firstMs;

  const out: AnnotationPoint[] = [];
  for (const event of events) {
    const eventMs = Date.parse(event.date);
    if (!Number.isFinite(eventMs)) continue;
    if (eventMs < windowMin || eventMs > windowMax) continue;

    // Linear scan is fine — typical inputs are 90 history points and <40
    // events. A binary search would be premature optimisation.
    let bestIdx = pointTimes[0]!.idx;
    let bestDelta = Math.abs(eventMs - pointTimes[0]!.ms);
    for (let i = 1; i < pointTimes.length; i++) {
      const d = Math.abs(eventMs - pointTimes[i]!.ms);
      if (d < bestDelta) {
        bestDelta = d;
        bestIdx = pointTimes[i]!.idx;
      }
    }
    if (bestDelta > SNAP_TOLERANCE_MS) continue;

    const point = points[bestIdx]!;
    // xRatio: position along the rendered span (0..1), proportional to the
    // event's actual date — *not* the snapped index. This keeps two events
    // at slightly different times on the same UTC day visually distinct
    // even when they snap to the same point.
    const xRatio = span > 0
      ? clamp01((eventMs - firstMs) / span)
      : 0.5;
    out.push({
      event,
      xRatio,
      seriesIndex: bestIdx,
      value: point.headline,
    });
  }
  return Object.freeze(out);
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
