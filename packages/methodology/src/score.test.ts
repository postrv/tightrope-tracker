import { describe, expect, it } from "vitest";
import { PILLARS, INDICATORS, PILLAR_ORDER, type PillarId, type PillarScore } from "@tightrope/shared";
import { computePillarScore, computeHeadlineScore, assembleSnapshot } from "./score.js";

function mkBaseline(size: number, centre: number, spread: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < size; i++) {
    const r = (Math.sin(i * 1.2345) + Math.cos(i * 0.4567)) / 2; // deterministic pseudo-random in [-1,1]
    out.push(centre + spread * r);
  }
  return out;
}

function mkPillar(pillar: PillarId, value: number, sparkEnd: number = value): PillarScore {
  const spark = [value - 2, value - 1, value, value + 1, sparkEnd];
  const sparkDelta = spark[spark.length - 1]! - spark[0]!;
  const sparkTrend = sparkDelta > 0.5 ? "up" : sparkDelta < -0.5 ? "down" : "flat";
  return {
    pillar,
    label: PILLARS[pillar].shortTitle,
    value,
    band: "acute",
    weight: PILLARS[pillar].weight,
    contributions: [],
    trend7d: sparkEnd > value ? "up" : sparkEnd < value ? "down" : "flat",
    delta7d: sparkEnd - value,
    trend30d: sparkTrend,
    delta30d: sparkDelta,
    sparkline30d: spark,
  };
}

describe("computePillarScore", () => {
  it("returns a value inside [0,100] when supplied real-ish inputs", () => {
    const readings = Object.values(INDICATORS)
      .filter((d) => d.pillar === "market")
      .map((d) => ({
        indicatorId: d.id,
        value: d.risingIsBad ? 6.0 : 0.95,
        observedAt: "2026-04-17T14:00:00Z",
        baseline: mkBaseline(500, d.risingIsBad ? 2.5 : 1.2, 1.0),
      }));

    const pillar = computePillarScore("market", {
      readings,
      sparkline30d: Array.from({ length: 30 }, (_, i) => 40 + i * 0.5),
    });

    expect(pillar.value).toBeGreaterThanOrEqual(0);
    expect(pillar.value).toBeLessThanOrEqual(100);
    expect(pillar.pillar).toBe("market");
    expect(pillar.weight).toBe(0.40);
    expect(pillar.contributions.length).toBeGreaterThan(0);
    expect(pillar.trend7d).toBe("up");
  });

  it("populates a human-readable label from the pillar catalogue for every pillar", () => {
    const expected: Record<PillarId, string> = {
      market: "Market",
      fiscal: "Fiscal",
      labour: "Labour",
      delivery: "Delivery",
    };
    for (const p of PILLAR_ORDER) {
      const pillar = computePillarScore(p, { readings: [], sparkline30d: [] });
      expect(pillar.label).toBe(expected[p]);
    }
  });

  it("scores good delivery high on the public higher-is-better axis", () => {
    // Housing & planning deeply ahead of baseline => rising-is-good readings high.
    const readings = Object.values(INDICATORS)
      .filter((d) => d.pillar === "delivery")
      .map((d) => ({
        indicatorId: d.id,
        value: 95, // near the top of the historical range
        observedAt: "2026-04-17T14:00:00Z",
        baseline: Array.from({ length: 100 }, (_, i) => i + 1),
      }));

    const pillar = computePillarScore("delivery", {
      readings,
      sparkline30d: Array.from({ length: 30 }, () => 30),
    });
    expect(pillar.value).toBeGreaterThan(80);
  });

  it("handles missing readings gracefully without crashing", () => {
    const pillar = computePillarScore("fiscal", {
      readings: [],
      sparkline30d: [50, 50, 50],
    });
    expect(pillar.value).toBe(0);
    expect(pillar.contributions).toHaveLength(0);
  });

  it("produces a 7d delta against the supplied history", () => {
    const readings = Object.values(INDICATORS)
      .filter((d) => d.pillar === "fiscal")
      .map((d) => ({
        indicatorId: d.id,
        value: 30,
        observedAt: "2026-04-17T14:00:00Z",
        baseline: mkBaseline(200, 20, 10),
      }));
    const pillar = computePillarScore("fiscal", {
      readings,
      sparkline30d: [48, 50, 52, 55, 58, 60, 61],
      value7dAgo: 55,
    });
    expect(pillar.delta7d).toBeCloseTo(pillar.value - 55, 1);
  });

  // Matches the visible-chart window so the label under a sparkline can
  // never say "flat" when the chart obviously shows movement. Prod
  // regression: the delivery pillar had a 30d sparkline of
  // [72.4]*10 + [30.8]*20 (step drop at the backfill → live boundary)
  // and rendered "flat / 7d" because the 7d window sat entirely in the
  // post-drop regime.
  it("exposes a 30d trend/delta computed from the sparkline window", () => {
    const spark = [
      ...Array.from({ length: 10 }, () => 72.4),
      ...Array.from({ length: 20 }, () => 30.8),
    ];
    const pillar = computePillarScore("delivery", {
      readings: [],
      sparkline30d: spark,
      // pillar value computes to 0 with no readings, so leave
      // value7dAgo unset so delta7d is also 0 and we isolate the 30d path.
    });
    expect(pillar.trend7d).toBe("flat");
    expect(pillar.delta7d).toBe(0);
    expect(pillar.trend30d).toBe("down");
    expect(pillar.delta30d).toBeCloseTo(-41.6, 1);
  });

  it("reports a flat 30d trend when the full sparkline moves less than the epsilon", () => {
    const spark = Array.from({ length: 30 }, (_, i) => 50 + i * 0.01); // +0.29 over 30d
    const pillar = computePillarScore("fiscal", {
      readings: [],
      sparkline30d: spark,
      value7dAgo: 50.23,
    });
    expect(pillar.trend30d).toBe("flat");
    expect(pillar.delta30d).toBeCloseTo(0.3, 1);
  });

  it("reports an up trend when the sparkline rises meaningfully over the 30d window", () => {
    const spark = Array.from({ length: 30 }, (_, i) => 40 + i * 0.8); // ~+23 over 30d
    const pillar = computePillarScore("market", {
      readings: [],
      sparkline30d: spark,
      value7dAgo: 58,
    });
    expect(pillar.trend30d).toBe("up");
    expect(pillar.delta30d).toBeGreaterThan(20);
  });

  it("reports a flat 30d trend/delta when the sparkline is empty or single-point", () => {
    const pillarEmpty = computePillarScore("labour", { readings: [], sparkline30d: [] });
    expect(pillarEmpty.trend30d).toBe("flat");
    expect(pillarEmpty.delta30d).toBe(0);
    const pillarOne = computePillarScore("labour", { readings: [], sparkline30d: [50] });
    expect(pillarOne.trend30d).toBe("flat");
    expect(pillarOne.delta30d).toBe(0);
  });

  it("reflects whatever span the sparkline actually covers (coverage disclosure is the UI's job)", () => {
    // Mid-backfill: history only stretches back a week. The delta is
    // the literal first→last change; the UI renders "7 of 30 days
    // scored" via describeSparklineCoverage, not a flattened label.
    const pillar = computePillarScore("labour", {
      readings: [],
      sparkline30d: [50, 51, 52, 52, 52.5, 53, 53.5],
    });
    expect(pillar.trend30d).toBe("up");
    expect(pillar.delta30d).toBeCloseTo(3.5, 1);
  });
});

describe("computeHeadlineScore", () => {
  it("geometric mean of pillars is pulled down by a single low pillar", () => {
    const highAll: Record<PillarId, PillarScore> = {
      market: mkPillar("market", 80),
      fiscal: mkPillar("fiscal", 80),
      labour: mkPillar("labour", 80),
      delivery: mkPillar("delivery", 80),
    };
    const oneLow: Record<PillarId, PillarScore> = {
      market: mkPillar("market", 10),
      fiscal: mkPillar("fiscal", 80),
      labour: mkPillar("labour", 80),
      delivery: mkPillar("delivery", 80),
    };
    const hAll = computeHeadlineScore({
      pillars: highAll,
      sparkline90d: [70],
      updatedAt: "2026-04-17T14:00:00Z",
    });
    const hLow = computeHeadlineScore({
      pillars: oneLow,
      sparkline90d: [70],
      updatedAt: "2026-04-17T14:00:00Z",
    });
    expect(hAll.value).toBeCloseTo(80, 1);
    // geometric mean: a single pillar at 10 weighted 40% should drag the headline well below the arithmetic mean (52.5)
    expect(hLow.value).toBeLessThan(52.5);
  });

  it("picks the dominant pillar by weighted shortfall from 100", () => {
    const pillars: Record<PillarId, PillarScore> = {
      market: mkPillar("market", 78),
      fiscal: mkPillar("fiscal", 61),
      labour: mkPillar("labour", 72),
      delivery: mkPillar("delivery", 54),
    };
    const h = computeHeadlineScore({
      pillars,
      sparkline90d: [60],
      updatedAt: "2026-04-17T14:00:00Z",
    });
    expect(h.dominantPillar).toBe("fiscal"); // (100 - 61) * 0.30 = 11.7, the largest weighted drag.
    expect(h.editorial).toContain("Fiscal Room");
  });

  it("includes deltas when anchor values are supplied", () => {
    const pillars: Record<PillarId, PillarScore> = {
      market: mkPillar("market", 78, 80),
      fiscal: mkPillar("fiscal", 61),
      labour: mkPillar("labour", 72),
      delivery: mkPillar("delivery", 54),
    };
    const h = computeHeadlineScore({
      pillars,
      sparkline90d: [60, 62, 65, 67],
      value24hAgo: 64,
      value30dAgo: 56,
      valueYtdAgo: 48,
      updatedAt: "2026-04-17T14:00:00Z",
    });
    expect(h.delta24h).toBeGreaterThan(0);
    expect(h.delta30d).toBeGreaterThan(h.delta24h);
    expect(h.deltaYtd).toBeGreaterThan(h.delta30d);
  });

  it("omits baseline-date fields when the baseline row sits cleanly on the target window", () => {
    // value30dAgoObservedAt is exactly 30 days before updatedAt; the UI
    // doesn't need a "since" override — "30d" is literal truth.
    const pillars: Record<PillarId, PillarScore> = {
      market: mkPillar("market", 78),
      fiscal: mkPillar("fiscal", 61),
      labour: mkPillar("labour", 72),
      delivery: mkPillar("delivery", 54),
    };
    const h = computeHeadlineScore({
      pillars,
      sparkline90d: [60],
      value30dAgo: 56,
      value30dAgoObservedAt: "2026-03-18T14:00:00Z",
      valueYtdAgo: 48,
      valueYtdAgoObservedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-04-17T14:00:00Z",
    });
    expect(h.delta30dBaselineDate).toBeUndefined();
    expect(h.deltaYtdBaselineDate).toBeUndefined();
  });

  it("surfaces baseline-date fields when the baseline falls meaningfully short of the requested window", () => {
    // Production failure mode: D1 only has 25 days of headline history.
    // Both delta30d and deltaYtd fell back to the same 2026-03-26 row and
    // the UI silently rendered "-7.9" for both without disclosing that
    // the baseline was 24 days ago, not 30d / YTD. With baselineDate
    // plumbed through the output, UI can render "since 26 Mar" instead.
    const pillars: Record<PillarId, PillarScore> = {
      market: mkPillar("market", 78),
      fiscal: mkPillar("fiscal", 61),
      labour: mkPillar("labour", 72),
      delivery: mkPillar("delivery", 54),
    };
    const h = computeHeadlineScore({
      pillars,
      sparkline90d: [60],
      value30dAgo: 56,
      value30dAgoObservedAt: "2026-03-26T00:00:00Z", // 22 days ago, not 30
      valueYtdAgo: 56,
      valueYtdAgoObservedAt: "2026-03-26T00:00:00Z", // same — shared fallback
      updatedAt: "2026-04-17T14:00:00Z",
    });
    expect(h.delta30dBaselineDate).toBe("2026-03-26T00:00:00Z");
    expect(h.deltaYtdBaselineDate).toBe("2026-03-26T00:00:00Z");
  });

  it("surfaces only the deltaYtd baseline when YTD falls back but 30d is clean", () => {
    // Ingest has ~45 days of history: enough for a true 30d delta, not
    // enough for YTD (Jan 1 is ~107 days ago).
    const pillars: Record<PillarId, PillarScore> = {
      market: mkPillar("market", 78),
      fiscal: mkPillar("fiscal", 61),
      labour: mkPillar("labour", 72),
      delivery: mkPillar("delivery", 54),
    };
    const h = computeHeadlineScore({
      pillars,
      sparkline90d: [60],
      value30dAgo: 56,
      value30dAgoObservedAt: "2026-03-18T14:00:00Z", // exactly 30d back
      valueYtdAgo: 58,
      valueYtdAgoObservedAt: "2026-03-04T14:00:00Z", // oldest row, ~44d back
      updatedAt: "2026-04-17T14:00:00Z",
    });
    expect(h.delta30dBaselineDate).toBeUndefined();
    expect(h.deltaYtdBaselineDate).toBe("2026-03-04T14:00:00Z");
  });

  it("assembles a complete snapshot with schemaVersion", () => {
    const pillars: Record<PillarId, PillarScore> = {
      market: mkPillar("market", 78),
      fiscal: mkPillar("fiscal", 61),
      labour: mkPillar("labour", 72),
      delivery: mkPillar("delivery", 54),
    };
    const headline = computeHeadlineScore({
      pillars,
      sparkline90d: [67],
      updatedAt: "2026-04-17T14:00:00Z",
    });
    const snap = assembleSnapshot(pillars, headline);
    expect(snap.schemaVersion).toBe(2);
    expect(snap.headline.value).toBeGreaterThan(0);
    for (const p of PILLAR_ORDER) expect(snap.pillars[p]).toBeDefined();
  });
});
