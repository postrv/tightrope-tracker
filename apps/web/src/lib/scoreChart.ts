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
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const middle = Math.floor((lo + hi) / 2);
    if (Date.parse(points[middle]!.timestamp) < target) lo = middle + 1;
    else hi = middle;
  }
  if (lo === 0) return 0;
  return target - Date.parse(points[lo - 1]!.timestamp) <= Date.parse(points[lo]!.timestamp) - target ? lo - 1 : lo;
}

export interface ScorePlotLayout {
  width: number;
  height: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
  domainMin?: number;
  domainMax?: number;
}

export function yForScore(value: number, layout: ScorePlotLayout): number {
  const min = layout.domainMin ?? 0;
  const max = layout.domainMax ?? 100;
  return layout.padT + (layout.height - layout.padT - layout.padB) * (1 - (value - min) / (max - min || 1));
}

export function projectScorePoints<T extends Pick<ScoreHistoryPoint, "timestamp" | "headline">>(points: readonly T[], layout: ScorePlotLayout): Array<T & { x: number; y: number }> {
  if (!points.length) return [];
  const first = points[0]!.timestamp;
  const last = points[points.length - 1]!.timestamp;
  return points.map(point => ({ ...point,
    x: layout.padL + timeRatio(point.timestamp, first, last) * (layout.width - layout.padL - layout.padR),
    y: yForScore(point.headline, layout),
  }));
}

/** Leave long missing intervals visible rather than suggesting a measured continuous path. */
export function scoreLinePath(points: readonly { x: number; y: number; timestamp: string }[], maxGapMs = Number.POSITIVE_INFINITY): string {
  return points.map((point, index) => {
    const previous = points[index - 1];
    const move = !previous || Date.parse(point.timestamp) - Date.parse(previous.timestamp) > maxGapMs;
    return `${move ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`;
  }).join(" ");
}

export function scoreGapThreshold(resolution = "daily"): number {
  return ({ raw: 30 * 60_000, hourly: 3 * 3_600_000, daily: 3 * 86_400_000, weekly: 21 * 86_400_000 } as Record<string, number>)[resolution] ?? 3 * 86_400_000;
}
