import { describe, expect, it } from "vitest";
import type {
  HeadlineScore,
  IndicatorContribution,
  PillarId,
  PillarScore,
  ScoreSnapshot,
} from "@tightrope/shared";
import { INDICATORS, PILLARS, PILLAR_ORDER, bandFor } from "@tightrope/shared";
import {
  LEVERS,
  LEVER_KEYS,
  clamp,
  formatScenarioHash,
  liveValuesFromSnapshot,
  parseScenarioHash,
  recomputeFromOverrides,
  sliderToNormalised,
} from "./whatIf.js";

/* -------------------------------------------------------------------------- */
/*  Test fixtures                                                              */
/* -------------------------------------------------------------------------- */

function makeContribution(
  indicatorId: string,
  rawValue: number,
  normalised: number,
  pillarWeightSum: number,
): IndicatorContribution {
  const def = INDICATORS[indicatorId];
  if (!def) throw new Error(`unknown indicator ${indicatorId}`);
  return {
    indicatorId,
    rawValue,
    rawValueUnit: def.unit,
    zScore: 0,
    normalised,
    weight: def.weight / pillarWeightSum,
    sourceId: def.sourceId,
    observedAt: "2026-04-17T14:00:00Z",
  };
}

function makePillar(pillar: PillarId, value: number, contributions: IndicatorContribution[]): PillarScore {
  return {
    pillar,
    label: PILLARS[pillar].shortTitle,
    value,
    band: bandFor(value).id,
    weight: PILLARS[pillar].weight,
    contributions,
    trend7d: "flat",
    delta7d: 0,
    trend30d: "flat",
    delta30d: 0,
    sparkline30d: [value, value, value],
  };
}

function makeSnapshot(): ScoreSnapshot {
  // Pillar weights for fiscal, market, labour, delivery sum to 1 within each pillar.
  // Build small but representative pillars containing the indicators we need.
  const fiscalDefs = Object.values(INDICATORS).filter((d) => d.pillar === "fiscal");
  const fiscalWeightSum = fiscalDefs.reduce((a, d) => a + d.weight, 0);
  const fiscalContribs: IndicatorContribution[] = [
    makeContribution("cb_headroom", 23.6, 47.2, fiscalWeightSum), // headroom 23.6 inside [0,50] → 1-(23.6/50)=0.528 → 52.8 (rising-is-good)
    makeContribution("psnfl_trajectory", 0.05, 50, fiscalWeightSum),
    makeContribution("borrowing_outturn", 11.0, 50, fiscalWeightSum),
    makeContribution("debt_interest", 8.0, 50, fiscalWeightSum),
    makeContribution("ilg_share", 26.0, 50, fiscalWeightSum),
    makeContribution("issuance_long_share", 30.0, 50, fiscalWeightSum),
  ];

  const marketDefs = Object.values(INDICATORS).filter((d) => d.pillar === "market");
  const marketWeightSum = marketDefs.reduce((a, d) => a + d.weight, 0);
  const marketContribs: IndicatorContribution[] = marketDefs.map((d) => {
    let raw = 1;
    if (d.id === "gilt_30y") raw = 5.4;
    else if (d.id === "gilt_10y") raw = 4.5;
    return makeContribution(d.id, raw, 60, marketWeightSum);
  });

  const labourDefs = Object.values(INDICATORS).filter((d) => d.pillar === "labour");
  const labourWeightSum = labourDefs.reduce((a, d) => a + d.weight, 0);
  const labourContribs: IndicatorContribution[] = labourDefs.map((d) => {
    let raw = 1;
    if (d.id === "real_regular_pay") raw = 0.4;
    else if (d.id === "inactivity_health") raw = 2.788;
    return makeContribution(d.id, raw, 55, labourWeightSum);
  });

  const deliveryDefs = Object.values(INDICATORS).filter((d) => d.pillar === "delivery");
  const deliveryWeightSum = deliveryDefs.reduce((a, d) => a + d.weight, 0);
  const deliveryContribs: IndicatorContribution[] = deliveryDefs.map((d) => {
    let raw = 50;
    if (d.id === "housing_trajectory") raw = 49;
    return makeContribution(d.id, raw, 65, deliveryWeightSum);
  });

  const pillars: Record<PillarId, PillarScore> = {
    fiscal: makePillar("fiscal", weightedMean(fiscalContribs), fiscalContribs),
    market: makePillar("market", weightedMean(marketContribs), marketContribs),
    labour: makePillar("labour", weightedMean(labourContribs), labourContribs),
    delivery: makePillar("delivery", weightedMean(deliveryContribs), deliveryContribs),
  };

  const headline: HeadlineScore = {
    value: 55,
    band: bandFor(55).id,
    editorial: "Fixture editorial.",
    updatedAt: "2026-04-17T14:00:00Z",
    delta24h: 0.3,
    delta30d: 1.5,
    deltaYtd: 4.0,
    dominantPillar: "market",
    sparkline90d: [54, 55, 55, 56, 55],
  };

  return { headline, pillars, schemaVersion: 1 };
}

function weightedMean(contribs: IndicatorContribution[]): number {
  let num = 0;
  let den = 0;
  for (const c of contribs) {
    num += c.normalised * c.weight;
    den += c.weight;
  }
  return den === 0 ? 0 : Math.round((num / den) * 10) / 10;
}

/* -------------------------------------------------------------------------- */
/*  clamp                                                                      */
/* -------------------------------------------------------------------------- */

describe("clamp", () => {
  it("returns the value when inside range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it("clamps to lo when below", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });
  it("clamps to hi when above", () => {
    expect(clamp(50, 0, 10)).toBe(10);
  });
  it("returns lo on NaN to defend against malformed input", () => {
    expect(clamp(Number.NaN, 0, 10)).toBe(0);
  });
  it("supports negative ranges", () => {
    expect(clamp(-5, -10, -1)).toBe(-5);
    expect(clamp(-100, -10, -1)).toBe(-10);
  });
});

/* -------------------------------------------------------------------------- */
/*  parseScenarioHash                                                          */
/* -------------------------------------------------------------------------- */

describe("parseScenarioHash", () => {
  it("returns an empty object for an empty hash", () => {
    expect(parseScenarioHash("")).toEqual({});
    expect(parseScenarioHash("#")).toEqual({});
  });

  it("parses every recognised lever key", () => {
    const hash = "#headroom=23.6&gilt30y=5.4&pay=0.4&inactivity=2.788&housing=49.0";
    const got = parseScenarioHash(hash);
    expect(got).toEqual({
      headroom: 23.6,
      gilt30y: 5.4,
      pay: 0.4,
      inactivity: 2.788,
      housing: 49.0,
    });
  });

  it("tolerates a hash without the leading #", () => {
    const got = parseScenarioHash("headroom=10");
    expect(got).toEqual({ headroom: 10 });
  });

  it("ignores unknown keys", () => {
    const got = parseScenarioHash("#headroom=10&banana=99");
    expect(got).toEqual({ headroom: 10 });
  });

  it("drops malformed numeric values", () => {
    const got = parseScenarioHash("#headroom=banana&gilt30y=5.4");
    expect(got).toEqual({ gilt30y: 5.4 });
  });

  it("drops missing values", () => {
    const got = parseScenarioHash("#headroom=&gilt30y=5.4");
    expect(got).toEqual({ gilt30y: 5.4 });
  });

  it("does not throw on garbage input", () => {
    expect(() => parseScenarioHash("#%%%==&&==garbage")).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/*  formatScenarioHash                                                         */
/* -------------------------------------------------------------------------- */

describe("formatScenarioHash", () => {
  it("produces the same string for the same input (deterministic)", () => {
    const values = { headroom: 23.6, gilt30y: 5.4, pay: 0.4, inactivity: 2.79, housing: 49.0 };
    const a = formatScenarioHash(values);
    const b = formatScenarioHash({ ...values });
    expect(a).toBe(b);
  });

  it("emits keys in the canonical LEVER_KEYS order", () => {
    const values = { headroom: 23.6, gilt30y: 5.4, pay: 0.4, inactivity: 2.79, housing: 49.0 };
    const formatted = formatScenarioHash(values);
    const keys = formatted.split("&").map((p) => p.split("=")[0]);
    expect(keys).toEqual([...LEVER_KEYS]);
  });

  it("respects the per-lever step decimals when rounding", () => {
    // gilt30y step is 0.01 → 2 decimals; headroom step is 0.1 → 1 decimal.
    const values = { headroom: 23.66, gilt30y: 5.4321, pay: 0.4, inactivity: 2.78876, housing: 49.0 };
    const got = formatScenarioHash(values);
    expect(got).toContain("headroom=23.7");
    expect(got).toContain("gilt30y=5.43");
    expect(got).toContain("inactivity=2.79");
  });

  it("round-trips through parseScenarioHash", () => {
    const values = { headroom: 23.6, gilt30y: 5.4, pay: 0.4, inactivity: 2.79, housing: 49.0 };
    const formatted = formatScenarioHash(values);
    const parsed = parseScenarioHash(formatted);
    for (const k of LEVER_KEYS) {
      expect(parsed[k]).toBeCloseTo(values[k], 2);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  sliderToNormalised                                                         */
/* -------------------------------------------------------------------------- */

describe("sliderToNormalised", () => {
  it("maps the max of the range to 100 when risingIsBad", () => {
    const lever = LEVERS.find((l) => l.key === "gilt30y")!;
    expect(sliderToNormalised(lever.max, lever, true)).toBe(100);
  });
  it("maps the min of the range to 0 when risingIsBad", () => {
    const lever = LEVERS.find((l) => l.key === "gilt30y")!;
    expect(sliderToNormalised(lever.min, lever, true)).toBe(0);
  });
  it("inverts the mapping when risingIsBad is false", () => {
    const lever = LEVERS.find((l) => l.key === "headroom")!;
    expect(sliderToNormalised(lever.min, lever, false)).toBe(100);
    expect(sliderToNormalised(lever.max, lever, false)).toBe(0);
  });
  it("returns a value in [0,100] for any input within range", () => {
    const lever = LEVERS.find((l) => l.key === "pay")!;
    for (let v = lever.min; v <= lever.max; v += 0.1) {
      const n = sliderToNormalised(v, lever, false);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(100);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  liveValuesFromSnapshot                                                     */
/* -------------------------------------------------------------------------- */

describe("liveValuesFromSnapshot", () => {
  it("pulls every lever's raw value from the snapshot's contributions", () => {
    const live = liveValuesFromSnapshot(makeSnapshot());
    expect(live.headroom).toBe(23.6);
    expect(live.gilt30y).toBe(5.4);
    expect(live.pay).toBeCloseTo(0.4, 5);
    expect(live.inactivity).toBeCloseTo(2.788, 5);
    expect(live.housing).toBe(49);
  });

  it("falls back to the slider midpoint when a contribution is missing", () => {
    const snap = makeSnapshot();
    snap.pillars.fiscal = {
      ...snap.pillars.fiscal,
      contributions: snap.pillars.fiscal.contributions.filter(
        (c) => c.indicatorId !== "cb_headroom",
      ),
    };
    const live = liveValuesFromSnapshot(snap);
    const lever = LEVERS.find((l) => l.key === "headroom")!;
    expect(live.headroom).toBe((lever.min + lever.max) / 2);
  });
});

/* -------------------------------------------------------------------------- */
/*  recomputeFromOverrides                                                     */
/* -------------------------------------------------------------------------- */

describe("recomputeFromOverrides", () => {
  it("returns a snapshot equal to the input when no overrides are supplied", () => {
    const snap = makeSnapshot();
    const out = recomputeFromOverrides(snap, {});
    expect(out.schemaVersion).toBe(1);
    for (const id of PILLAR_ORDER) {
      expect(out.pillars[id].value).toBe(snap.pillars[id].value);
      expect(out.pillars[id].band).toBe(snap.pillars[id].band);
    }
    // Original deltas + editorial carried through verbatim — the simulator
    // is showing the live snapshot unchanged, so the headline metadata
    // must round-trip exactly.
    expect(out.headline.delta24h).toBe(snap.headline.delta24h);
    expect(out.headline.delta30d).toBe(snap.headline.delta30d);
    expect(out.headline.deltaYtd).toBe(snap.headline.deltaYtd);
    expect(out.headline.editorial).toBe(snap.headline.editorial);
    expect(out.headline.updatedAt).toBe(snap.headline.updatedAt);
  });

  it("is idempotent under repeated recomputes", () => {
    const snap = makeSnapshot();
    const once = recomputeFromOverrides(snap, {});
    const twice = recomputeFromOverrides(once, {});
    for (const id of PILLAR_ORDER) {
      expect(twice.pillars[id].value).toBe(once.pillars[id].value);
    }
    expect(twice.headline.value).toBe(once.headline.value);
  });

  it("raises the headline when fiscal headroom is cut to zero", () => {
    const snap = makeSnapshot();
    const baseline = recomputeFromOverrides(snap, {});
    const stressed = recomputeFromOverrides(snap, { headroom: 0 });
    expect(stressed.pillars.fiscal.value).toBeGreaterThan(baseline.pillars.fiscal.value);
    expect(stressed.headline.value).toBeGreaterThan(baseline.headline.value);
  });

  it("lowers the headline when fiscal headroom is raised to the max", () => {
    const snap = makeSnapshot();
    const baseline = recomputeFromOverrides(snap, {});
    const easy = recomputeFromOverrides(snap, { headroom: 50 });
    expect(easy.pillars.fiscal.value).toBeLessThan(baseline.pillars.fiscal.value);
    expect(easy.headline.value).toBeLessThan(baseline.headline.value);
  });

  it("raises the headline when the 20y gilt yield is pushed to the top", () => {
    const snap = makeSnapshot();
    const baseline = recomputeFromOverrides(snap, {});
    const stressed = recomputeFromOverrides(snap, { gilt30y: 6.5 });
    expect(stressed.pillars.market.value).toBeGreaterThan(baseline.pillars.market.value);
    expect(stressed.headline.value).toBeGreaterThan(baseline.headline.value);
  });

  it("lowers the labour pillar when real pay is set high", () => {
    const snap = makeSnapshot();
    const baseline = recomputeFromOverrides(snap, {});
    const better = recomputeFromOverrides(snap, { pay: 5 });
    expect(better.pillars.labour.value).toBeLessThan(baseline.pillars.labour.value);
  });

  it("raises the labour pillar when health-related inactivity is set high", () => {
    const snap = makeSnapshot();
    const baseline = recomputeFromOverrides(snap, {});
    const worse = recomputeFromOverrides(snap, { inactivity: 3.5 });
    expect(worse.pillars.labour.value).toBeGreaterThan(baseline.pillars.labour.value);
  });

  it("lowers the delivery pillar when housing trajectory is at the top", () => {
    const snap = makeSnapshot();
    const baseline = recomputeFromOverrides(snap, {});
    const easier = recomputeFromOverrides(snap, { housing: 110 });
    expect(easier.pillars.delivery.value).toBeLessThan(baseline.pillars.delivery.value);
  });

  it("clamps out-of-range values rather than letting them poison the score", () => {
    const snap = makeSnapshot();
    const wayOver = recomputeFromOverrides(snap, { headroom: 999 });
    const atMax = recomputeFromOverrides(snap, { headroom: 50 });
    expect(wayOver.pillars.fiscal.value).toBe(atMax.pillars.fiscal.value);
    const wayUnder = recomputeFromOverrides(snap, { headroom: -999 });
    const atMin = recomputeFromOverrides(snap, { headroom: 0 });
    expect(wayUnder.pillars.fiscal.value).toBe(atMin.pillars.fiscal.value);
  });

  it("does not mutate the input snapshot", () => {
    const snap = makeSnapshot();
    const headroomBefore = snap.pillars.fiscal.contributions.find((c) => c.indicatorId === "cb_headroom")!.rawValue;
    recomputeFromOverrides(snap, { headroom: 0 });
    const headroomAfter = snap.pillars.fiscal.contributions.find((c) => c.indicatorId === "cb_headroom")!.rawValue;
    expect(headroomAfter).toBe(headroomBefore);
  });

  it("zeroes deltas when the user has touched a slider", () => {
    const snap = makeSnapshot();
    const out = recomputeFromOverrides(snap, { headroom: 5 });
    expect(out.headline.delta24h).toBe(0);
    expect(out.headline.delta30d).toBe(0);
    expect(out.headline.deltaYtd).toBe(0);
  });

  it("ignores non-finite override values", () => {
    const snap = makeSnapshot();
    const out = recomputeFromOverrides(snap, {
      headroom: Number.NaN,
      gilt30y: Number.POSITIVE_INFINITY,
    });
    expect(out.pillars.fiscal.value).toBe(snap.pillars.fiscal.value);
    expect(out.pillars.market.value).toBe(snap.pillars.market.value);
  });

  it("preserves untouched pillars verbatim", () => {
    const snap = makeSnapshot();
    const out = recomputeFromOverrides(snap, { headroom: 5 });
    // market, labour, delivery should be unchanged
    expect(out.pillars.market).toBe(snap.pillars.market);
    expect(out.pillars.labour).toBe(snap.pillars.labour);
    expect(out.pillars.delivery).toBe(snap.pillars.delivery);
  });
});
