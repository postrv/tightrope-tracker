import { describe, expect, it } from "vitest";
import { INDICATORS } from "@tightrope/shared";
import baseline from "./budget-2026-baseline.json" with { type: "json" };

describe("the immutable Budget reference snapshot", () => {
  it("covers every registered indicator and distinguishes snapshot computation from file capture", () => {
    expect(Object.keys(baseline.readings).sort()).toEqual(Object.keys(INDICATORS).sort());
    expect(baseline.sourceSnapshotAt).toBe("2026-10-28T12:55:31.006Z");
    expect(baseline.capturedAt).toBe("2026-10-28T12:56:25.696Z");
    expect(Date.parse(baseline.capturedAt)).toBeGreaterThan(Date.parse(baseline.sourceSnapshotAt));
    expect(baseline.description).toContain("not a pre-statement snapshot");
  });
  it("does not mistake the confidence month-end label for a release after the statement", () => {
    const cutoff = Date.parse(baseline.publicationCutoff);
    for (const reading of Object.values(baseline.readings)) {
      expect(Number.isFinite(reading.value)).toBe(true);
      expect(Date.parse(reading.releasedAt ?? reading.observedAt)).toBeLessThan(cutoff);
    }
    expect(Date.parse(baseline.readings.consumer_confidence.observedAt)).toBeGreaterThan(cutoff);
    expect(baseline.readings.consumer_confidence.releasedAt).toBe("2026-10-23T00:00:00Z");
  });
});
