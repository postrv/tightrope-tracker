import type { ScoreHistoryPoint } from "@tightrope/shared";

/** Use actual elapsed time; equal index spacing misplaces events when days are missing. */
export function timeRatio(timestamp: string, first: string, last: string): number {
  const start = Date.parse(first);
  const span = Date.parse(last) - start;
  return span > 0 ? Math.max(0, Math.min(1, (Date.parse(timestamp) - start) / span)) : 0.5;
}

/** Select a recorded sample, never an interpolated or invented score. */
export function nearestPointIndex(points: readonly Pick<ScoreHistoryPoint, "timestamp">[], ratio: number): number {
  if (points.length < 2) return 0;
  const first = Date.parse(points[0]!.timestamp);
  const last = Date.parse(points[points.length - 1]!.timestamp);
  const target = first + Math.max(0, Math.min(1, ratio)) * (last - first);
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  points.forEach((point, index) => {
    const candidate = Math.abs(Date.parse(point.timestamp) - target);
    if (candidate < distance) { best = index; distance = candidate; }
  });
  return best;
}
