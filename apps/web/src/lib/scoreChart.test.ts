import { describe, expect, it } from "vitest";
import { nearestPointIndex, projectScorePoints, scoreGapThreshold, scoreLinePath, timeRatio } from "./scoreChart.js";

const points = ["2026-10-01", "2026-10-02", "2026-10-11"].map(timestamp => ({ timestamp }));

describe("score chart time projection", () => {
  it("preserves a missing nine-day interval instead of spacing samples evenly", () => {
    expect(timeRatio(points[1]!.timestamp, points[0]!.timestamp, points[2]!.timestamp)).toBeCloseTo(0.1);
    expect(nearestPointIndex(points, 0.2)).toBe(1);
    expect(nearestPointIndex(points, 0.9)).toBe(2);
  });

  it("clamps pointer selection to recorded endpoints and handles a single sample", () => {
    expect(nearestPointIndex(points, -10)).toBe(0);
    expect(nearestPointIndex(points, 10)).toBe(2);
    expect(timeRatio("2026-10-01", "2026-10-01", "2026-10-01")).toBe(0.5);
    expect(nearestPointIndex(points.slice(0, 1), 0.9)).toBe(0);
  });

  it("breaks the visible path across missing recording intervals", () => {
    const projected = projectScorePoints(points.map((point, i) => ({ ...point, headline: 40 + i })), { width: 350, height: 280, padL: 36, padR: 12, padT: 16, padB: 34 });
    expect(projected[0]?.x).toBe(36);
    expect(projected.at(-1)?.x).toBe(338);
    expect(scoreLinePath(projected, scoreGapThreshold("daily")).match(/M/g)).toHaveLength(2);
    expect(scoreLinePath(projected, scoreGapThreshold("weekly")).match(/M/g)).toHaveLength(1);
  });
});
