import { describe, expect, it } from "vitest";
import { INDICATORS } from "@tightrope/shared";
import { computePillarScore } from "@tightrope/methodology";
import { buildDailyPillarSparkline } from "../pipelines/recompute.js";

describe("daily pillar sparkline publication cutoff", () => {
  it("keeps the prior public print until a newer reference period is released", () => {
    const baseline = [1.5, 2, 2.4, 2.8, 3.4, 3.8];
    const older = { indicatorId: "dd_failure_rate", value: 2.4, observedAt: "2026-07-31T00:00:00Z", baseline };
    const newer = { indicatorId: "dd_failure_rate", value: 3.4, observedAt: "2026-08-31T00:00:00Z", baseline };
    const oldScore = computePillarScore("labour", { readings: [older], sparkline30d: [] }).value;
    const newScore = computePillarScore("labour", { readings: [newer], sparkline30d: [] }).value;
    expect(oldScore).not.toBe(newScore);

    const series = buildDailyPillarSparkline(
      "labour",
      [INDICATORS.dd_failure_rate!],
      [
        { indicator_id: "dd_failure_rate", value: 2.4, observed_at: older.observedAt, released_at: "2026-08-20T00:00:00Z" },
        { indicator_id: "dd_failure_rate", value: 3.4, observed_at: newer.observedAt, released_at: "2026-09-17T00:00:00Z" },
        // A newer reference period with a later release must not prevent the
        // scan from finding the August print on 17–20 September.
        { indicator_id: "dd_failure_rate", value: 3.8, observed_at: "2026-09-01T00:00:00Z", released_at: "2026-10-01T00:00:00Z" },
      ],
      new Map([["dd_failure_rate", baseline]]),
      8,
      new Date("2026-09-20T12:00:00Z"),
    );

    // The eight daily points cover 13–20 September. August's value first
    // enters on its 17 September publication date, not its 31 August period.
    expect(series).toEqual([
      oldScore, oldScore, oldScore, oldScore,
      newScore, newScore, newScore, newScore,
    ]);
  });
});
