/**
 * Tests for the homepage freshness summary.
 *
 * Why this matters: the page uses INDICATORS[id].maxStaleMs to decide
 * whether each tile is fresh / ageing / stale. A regression here would
 * either over-flag fresh data (false positives → reader loses trust) or
 * under-flag genuinely stale fixtures (the bug class we're trying to
 * eliminate). Pin the rules concretely against fixed timestamps.
 */
import { describe, expect, it } from "vitest";
import type { ScoreSnapshot, TodayMovement, PillarScore, IndicatorContribution } from "@tightrope/shared";
import { ageBand, ageShort, summariseFreshness } from "./freshness.js";

const NOW = Date.parse("2026-04-27T12:00:00Z");

function contribution(id: string, observedAt: string): IndicatorContribution {
  return {
    indicatorId: id,
    rawValue: 0,
    rawValueUnit: "%",
    zScore: 0,
    normalised: 0,
    weight: 0.5,
    sourceId: id,
    observedAt,
  };
}

function pillar(id: string, contributions: IndicatorContribution[]): PillarScore {
  return {
    pillar: id as PillarScore["pillar"],
    label: id,
    value: 50,
    band: "strained",
    weight: 0.25,
    contributions,
    trend7d: "flat",
    delta7d: 0,
    trend30d: "flat",
    delta30d: 0,
    sparkline30d: [],
  };
}

function snap(contribs: Record<string, string>): ScoreSnapshot {
  const cs = Object.entries(contribs).map(([id, ts]) => contribution(id, ts));
  return {
    headline: {
      value: 50, band: "strained", editorial: "", updatedAt: "2026-04-27T11:55:00Z",
      delta24h: 0, delta30d: 0, deltaYtd: 0, dominantPillar: "market", sparkline90d: [],
    },
    pillars: {
      market: pillar("market", cs),
      fiscal: pillar("fiscal", []),
      labour: pillar("labour", []),
      delivery: pillar("delivery", []),
    },
    schemaVersion: 1,
  };
}

describe("ageBand", () => {
  it("returns 'fresh' for an observation under half of maxStaleMs", () => {
    // gilt_10y is daily (5d max). Under 2.5 days = fresh.
    expect(ageBand("2026-04-26T12:00:00Z", "gilt_10y", NOW)).toBe("fresh");
  });

  it("returns 'ageing' between 0.5x and 1x of maxStaleMs", () => {
    // 3 days old; daily window = 5d, so 3 > 2.5 = ageing.
    expect(ageBand("2026-04-24T12:00:00Z", "gilt_10y", NOW)).toBe("ageing");
  });

  it("returns 'stale' past maxStaleMs", () => {
    // 7 days old; daily window = 5d → stale.
    expect(ageBand("2026-04-20T12:00:00Z", "gilt_10y", NOW)).toBe("stale");
  });

  it("respects monthly windows so a 20-day-old PMI reads fresh", () => {
    // services_pmi is monthly (50d max). 20 days < 25 (=0.5 × 50) = fresh.
    expect(ageBand("2026-04-07T12:00:00Z", "services_pmi", NOW)).toBe("fresh");
  });

  it("returns 'unknown' for an indicator id not in INDICATORS", () => {
    expect(ageBand("2026-04-26T12:00:00Z", "not_an_indicator", NOW)).toBe("unknown");
  });
});

describe("ageShort", () => {
  it("formats sub-day ages in hours", () => {
    expect(ageShort("2026-04-27T08:00:00Z", NOW)).toBe("4h");
  });
  it("formats day-scale ages with 'd' suffix", () => {
    expect(ageShort("2026-04-24T12:00:00Z", NOW)).toBe("3d");
  });
  it("rolls over to weeks past 14 days", () => {
    expect(ageShort("2026-04-06T12:00:00Z", NOW)).toBe("3w");
  });
  it("rolls over to months past ~9 weeks", () => {
    expect(ageShort("2026-01-27T12:00:00Z", NOW)).toBe("3mo");
  });
});

describe("summariseFreshness", () => {
  it("flags an indicator past its maxStaleMs as stale and skips fresh ones", () => {
    const s = snap({
      gilt_10y: "2026-04-26T12:00:00Z", // 1d old → fresh on 5d window
      brent_gbp: "2026-04-17T00:00:00Z", // 10d old → past 14d window? no, fresh.
    });
    // brent_gbp is weekly fixture (14d). 10d > 7d → ageing.
    const movements: TodayMovement[] = [];
    const result = summariseFreshness(s, movements, NOW);
    expect(result.staleIndicators).toEqual([]);
    expect(result.ageingIndicators.map((a) => a.indicatorId)).toContain("brent_gbp");
  });

  it("returns the freshest observed timestamp across all sources", () => {
    const s = snap({
      gilt_10y: "2026-04-25T12:00:00Z",
      brent_gbp: "2026-04-17T00:00:00Z",
    });
    const movements: TodayMovement[] = [{
      indicatorId: "gbp_usd", label: "GBP/USD", unit: "ccy", latestValue: 1.25,
      displayValue: "$1.25", change: 0, changePct: 0, changeDisplay: "+0",
      direction: "flat", worsening: false, sparkline: [], gloss: "",
      sourceId: "boe_fx", observedAt: "2026-04-26T16:00:00Z",
    }];
    const result = summariseFreshness(s, movements, NOW);
    expect(result.freshestAt).toBe("2026-04-26T16:00:00.000Z");
    expect(result.freshestAgeDays).toBeCloseTo(0.83, 1);
  });

  it("flags the user-reported smoking-gun: brent_gbp 10 days stale on a daily-cadence reading", () => {
    // Note: brent_gbp is *editorial weekly* (14d window) — so the audit-flagged
    // staleness shows up as 'ageing' rather than 'stale'. The age dot lights amber
    // and the relative-time string is shown next to the date. This test pins the
    // behaviour; a future change of brent's cadence would force a deliberate update.
    const s = snap({ brent_gbp: "2026-04-17T00:00:00Z" });
    const result = summariseFreshness(s, [], NOW);
    expect(result.ageingIndicators.find((a) => a.indicatorId === "brent_gbp")).toBeDefined();
  });
});
