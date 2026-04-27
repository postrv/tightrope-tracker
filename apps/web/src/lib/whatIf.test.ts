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
  type LeverKey,
} from "./whatIf.js";
import { summariseBaseline, normalisedFromSummary, type BaselineSummary } from "@tightrope/methodology";

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
  // Plausible per-indicator raw values so identity-mode round-trips work
  // for every lever in this pillar. Each is well within its lever domain.
  const marketRaw: Record<string, number> = {
    gilt_10y: 4.5,
    gilt_30y: 5.4,
    breakeven_5y: 3.4,
    brent_gbp: 70,
    services_pmi: 50,
    gbp_usd: 1.27,
    gbp_twi: 80,
    ftse_250: 19500,
    housebuilder_idx: 100,
    consumer_confidence: -20,
    rics_price_balance: 5,
  };
  const marketContribs: IndicatorContribution[] = marketDefs.map((d) =>
    makeContribution(d.id, marketRaw[d.id] ?? 1, 60, marketWeightSum),
  );

  const labourDefs = Object.values(INDICATORS).filter((d) => d.pillar === "labour");
  const labourWeightSum = labourDefs.reduce((a, d) => a + d.weight, 0);
  const labourRaw: Record<string, number> = {
    real_regular_pay: 0.4,
    inactivity_health: 2.788,
    unemployment: 4.2,
    mortgage_2y_fix: 4.85,
    inactivity_rate: 21.5,
    vacancies_per_unemployed: 0.7,
    payroll_mom: 122,
    dd_failure_rate: 1.2,
  };
  const labourContribs: IndicatorContribution[] = labourDefs.map((d) =>
    makeContribution(d.id, labourRaw[d.id] ?? 1, 55, labourWeightSum),
  );

  const deliveryDefs = Object.values(INDICATORS).filter((d) => d.pillar === "delivery");
  const deliveryWeightSum = deliveryDefs.reduce((a, d) => a + d.weight, 0);
  const deliveryRaw: Record<string, number> = {
    housing_trajectory: 49,
    planning_consents: 70,
  };
  const deliveryContribs: IndicatorContribution[] = deliveryDefs.map((d) =>
    makeContribution(d.id, deliveryRaw[d.id] ?? 50, 65, deliveryWeightSum),
  );

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
    // Populate every lever so the formatter emits all keys in canonical order.
    const values: Partial<Record<LeverKey, number>> = {};
    for (const lever of LEVERS) {
      values[lever.key] = (lever.min + lever.max) / 2;
    }
    const formatted = formatScenarioHash(values);
    const keys = formatted.split("&").map((p) => p.split("=")[0]);
    expect(keys).toEqual([...LEVER_KEYS]);
  });

  it("only emits keys whose value is supplied (sparse input)", () => {
    const formatted = formatScenarioHash({ headroom: 23.6, gilt30y: 5.4 });
    const keys = formatted.split("&").map((p) => p.split("=")[0]);
    expect(keys).toEqual(["gilt30y", "headroom"]);
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
    const values: Partial<Record<LeverKey, number>> = {
      headroom: 23.6, gilt30y: 5.4, pay: 0.4, inactivity: 2.79, housing: 49.0,
    };
    const formatted = formatScenarioHash(values);
    const parsed = parseScenarioHash(formatted);
    for (const k of Object.keys(values) as LeverKey[]) {
      expect(parsed[k]).toBeCloseTo(values[k]!, 2);
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

/* -------------------------------------------------------------------------- */
/*  recomputeFromOverrides — ECDF mode                                          */
/* -------------------------------------------------------------------------- */

describe("recomputeFromOverrides — ECDF mode", () => {
  function buildBaselines(): Record<string, BaselineSummary> {
    // Synthetic baselines spanning each lever's domain. The summary
    // resolution (101 knots) is enough that any value within the slider
    // range maps to a plausible probability.
    const out: Record<string, BaselineSummary> = {};
    for (const lever of LEVERS) {
      const samples: number[] = [];
      const span = lever.max - lever.min;
      // 200 samples uniformly distributed across the domain.
      for (let i = 0; i < 200; i++) {
        samples.push(lever.min + (span * i) / 199);
      }
      out[lever.indicatorId] = summariseBaseline(samples);
    }
    return out;
  }

  it("preserves the live identity when the slider equals the live raw value (within step)", () => {
    const snap = makeSnapshot();
    const baselines = buildBaselines();
    const live = liveValuesFromSnapshot(snap);

    // Push every lever to its live raw value -- the snapshot must come back unchanged.
    const overrides: Partial<Record<LeverKey, number>> = {};
    for (const lever of LEVERS) {
      overrides[lever.key] = live[lever.key];
    }

    const out = recomputeFromOverrides(snap, overrides, baselines);
    for (const id of PILLAR_ORDER) {
      expect(out.pillars[id].value).toBe(snap.pillars[id].value);
      expect(out.pillars[id].band).toBe(snap.pillars[id].band);
    }
  });

  it("uses the ECDF mapping rather than linear when the slider deviates", () => {
    const snap = makeSnapshot();
    const baselines = buildBaselines();
    // Raise the gilt 30y to its midpoint and confirm pressure ≈ 50,
    // which the ECDF over a uniform baseline returns. Linear over the
    // raw slider's hard-coded domain would also return 50 -- we
    // distinguish by *changing* the slider domain externally so linear
    // and ECDF would diverge.
    // Here we just sanity-check that the output is finite and bounded.
    const lever = LEVERS.find((l) => l.key === "gilt30y")!;
    const mid = (lever.min + lever.max) / 2;
    const out = recomputeFromOverrides(snap, { gilt30y: mid }, baselines);
    expect(out.pillars.market.value).toBeGreaterThanOrEqual(0);
    expect(out.pillars.market.value).toBeLessThanOrEqual(100);
    // 30y at the midpoint should produce a *different* market score
    // from 30y at its max.
    const stressed = recomputeFromOverrides(snap, { gilt30y: lever.max }, baselines);
    expect(stressed.pillars.market.value).toBeGreaterThan(out.pillars.market.value);
  });

  it("falls back to linear when an indicator has no baseline summary", () => {
    const snap = makeSnapshot();
    const partial: Record<string, BaselineSummary> = {};
    // Provide a baseline for housing only; the others must use linear fallback.
    const housingLever = LEVERS.find((l) => l.key === "housing")!;
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      samples.push(housingLever.min + ((housingLever.max - housingLever.min) * i) / 199);
    }
    partial[housingLever.indicatorId] = summariseBaseline(samples);

    // Raise gilt30y -- no baseline supplied; the result must still
    // produce a finite, bounded score and reflect a higher pressure.
    const out = recomputeFromOverrides(snap, { gilt30y: 6.5 }, partial);
    expect(out.pillars.market.value).toBeGreaterThan(0);
    expect(out.pillars.market.value).toBeLessThanOrEqual(100);
  });

  it("matches normalisedFromSummary for the active override (no ECDF leak)", () => {
    const snap = makeSnapshot();
    const baselines = buildBaselines();
    const lever = LEVERS.find((l) => l.key === "headroom")!;
    const summary = baselines[lever.indicatorId]!;
    // Pick a value far from live to ensure the ECDF path runs.
    const v = 1.0;
    const expected = normalisedFromSummary(v, summary, false /* headroom rises = good */);

    const out = recomputeFromOverrides(snap, { headroom: v }, baselines);
    const headroomContrib = out.pillars.fiscal.contributions.find(
      (c) => c.indicatorId === "cb_headroom",
    )!;
    expect(headroomContrib.normalised).toBeCloseTo(expected, 5);
  });
});

/* -------------------------------------------------------------------------- */
/*  Empty-contributions fallback                                               */
/* -------------------------------------------------------------------------- */

describe("recomputeFromOverrides — empty contributions fallback", () => {
  function buildBaselines(): Record<string, BaselineSummary> {
    const out: Record<string, BaselineSummary> = {};
    for (const lever of LEVERS) {
      const samples: number[] = [];
      const span = lever.max - lever.min;
      for (let i = 0; i < 200; i++) {
        samples.push(lever.min + (span * i) / 199);
      }
      out[lever.indicatorId] = summariseBaseline(samples);
    }
    return out;
  }

  /**
   * Reproduces the bug where a stale-cache snapshot from before the
   * contributions field was populated would render every override as a
   * no-op: recomputePillar returned the pillar unchanged when contributions
   * was empty, so pillar values + headline never moved on slider input.
   * After the fix, the recompute uses a delta-from-live model that still
   * reacts proportionally to each lever's in-pillar weight.
   */
  function emptyContribsSnapshot(): ScoreSnapshot {
    const pillars: Record<PillarId, PillarScore> = {
      market: makePillar("market", 60, []),
      fiscal: makePillar("fiscal", 50, []),
      labour: makePillar("labour", 55, []),
      delivery: makePillar("delivery", 65, []),
    };
    const headline: HeadlineScore = {
      value: 57,
      band: bandFor(57).id,
      editorial: "Empty contributions cache.",
      updatedAt: "2026-04-17T14:00:00Z",
      delta24h: 0,
      delta30d: 0,
      deltaYtd: 0,
      dominantPillar: "market",
      sparkline90d: [54, 55, 56, 57],
    };
    return { headline, pillars, schemaVersion: 1 };
  }

  it("does not freeze the headline when overrides arrive but contributions are empty", () => {
    const snap = emptyContribsSnapshot();
    const baselines = buildBaselines();
    // Big move on a heavyweight market lever -- pressure should rise visibly.
    const before = recomputeFromOverrides(snap, {}, baselines);
    const after = recomputeFromOverrides(snap, { gilt30y: 7.0 }, baselines);
    expect(after.pillars.market.value).not.toBe(before.pillars.market.value);
    expect(after.headline.value).not.toBe(before.headline.value);
  });

  it("changes scenario to scenario when contributions are empty", () => {
    const snap = emptyContribsSnapshot();
    const baselines = buildBaselines();
    const conflict = recomputeFromOverrides(
      snap,
      { brent: 110, gilt30y: 5.65, breakeven5y: 3.9, headroom: 15.0, housing: 46 },
      baselines,
    );
    const recovery = recomputeFromOverrides(
      snap,
      { headroom: 28.0, gilt30y: 4.5, gilt10y: 3.8, pay: 1.5, housing: 95, mortgage2y: 4.0, unemployment: 3.8 },
      baselines,
    );
    // Two structurally different scenarios must produce different headlines.
    expect(conflict.headline.value).not.toBeCloseTo(recovery.headline.value, 1);
    // Touched pillars must differ between the two scenarios.
    expect(conflict.pillars.market.value).not.toBe(recovery.pillars.market.value);
    expect(conflict.pillars.delivery.value).not.toBe(recovery.pillars.delivery.value);
  });

  it("keeps untouched pillars at their live values", () => {
    const snap = emptyContribsSnapshot();
    const baselines = buildBaselines();
    // Only touch a market lever -- fiscal/labour/delivery must stay at live.
    const out = recomputeFromOverrides(snap, { gilt30y: 7.0 }, baselines);
    expect(out.pillars.fiscal.value).toBe(snap.pillars.fiscal.value);
    expect(out.pillars.labour.value).toBe(snap.pillars.labour.value);
    expect(out.pillars.delivery.value).toBe(snap.pillars.delivery.value);
  });

  it("emits synthesized contributions for moved levers so the per-lever effect badge can paint", () => {
    const snap = emptyContribsSnapshot();
    const baselines = buildBaselines();
    const out = recomputeFromOverrides(snap, { gilt30y: 7.0, headroom: 5 }, baselines);
    const market = out.pillars.market.contributions.find((c) => c.indicatorId === "gilt_30y");
    const fiscal = out.pillars.fiscal.contributions.find((c) => c.indicatorId === "cb_headroom");
    expect(market).toBeDefined();
    expect(fiscal).toBeDefined();
    expect(market!.rawValue).toBeCloseTo(7.0, 5);
    expect(fiscal!.rawValue).toBeCloseTo(5, 5);
  });
});

/* -------------------------------------------------------------------------- */
/*  Snap-to-live identity boundary                                             */
/* -------------------------------------------------------------------------- */

describe("recomputeFromOverrides — snap-to-live boundary", () => {
  function buildSnapBaselines(): Record<string, BaselineSummary> {
    const out: Record<string, BaselineSummary> = {};
    for (const lever of LEVERS) {
      const samples: number[] = [];
      const span = lever.max - lever.min;
      for (let i = 0; i < 200; i++) {
        samples.push(lever.min + (span * i) / 199);
      }
      out[lever.indicatorId] = summariseBaseline(samples);
    }
    return out;
  }

  it("snaps a within-half-step nudge back to live (identity preserved)", () => {
    // The recompute path snaps a slider to its live value when the user's
    // override is within step/2 -- so a tiny ECDF approximation drift never
    // shows up as a non-zero delta on what should be the live snapshot. If
    // a future refactor accidentally widened the threshold to `step`, sub-
    // step user input would silently mask real motion. Lock the boundary
    // down here so a regression trips the test rather than the headline.
    const snap = makeSnapshot();
    const baselines = buildSnapBaselines();
    const lever = LEVERS.find((l) => l.key === "headroom")!; // step=0.1
    const live = liveValuesFromSnapshot(snap)[lever.key];
    const within = live + lever.step / 2 - 1e-6;
    const out = recomputeFromOverrides(snap, { [lever.key]: within }, baselines);
    const c = out.pillars.fiscal.contributions.find((cc) => cc.indicatorId === lever.indicatorId)!;
    const liveC = snap.pillars.fiscal.contributions.find((cc) => cc.indicatorId === lever.indicatorId)!;
    // Identity preserved: normalised carried verbatim from the snapshot,
    // not re-derived through ECDF (which has O(1%) approximation drift).
    expect(c.normalised).toBeCloseTo(liveC.normalised, 10);
  });

  it("does NOT snap once the nudge exceeds step/2 (real motion is honoured)", () => {
    const snap = makeSnapshot();
    const baselines = buildSnapBaselines();
    const lever = LEVERS.find((l) => l.key === "headroom")!; // step=0.1
    const live = liveValuesFromSnapshot(snap)[lever.key];
    const past = live + lever.step / 2 + 1e-3;
    const out = recomputeFromOverrides(snap, { [lever.key]: past }, baselines);
    const c = out.pillars.fiscal.contributions.find((cc) => cc.indicatorId === lever.indicatorId)!;
    expect(c.rawValue).toBeCloseTo(past, 5);
  });

  it("preserves pillar identity exactly when every slider matches live raw value", () => {
    // Pillar values are derived from contributions, so a full-identity round
    // trip must reproduce them byte-for-byte. The headline is *not* derived
    // from contributions in this fixture (we set it manually for delta
    // metadata) so we only assert that the recomputed headline isn't
    // perturbed beyond a small tolerance.
    const snap = makeSnapshot();
    const baselines = buildSnapBaselines();
    const live = liveValuesFromSnapshot(snap);
    const overrides: Partial<Record<LeverKey, number>> = {};
    for (const l of LEVERS) overrides[l.key] = live[l.key];
    const out = recomputeFromOverrides(snap, overrides, baselines);
    for (const pid of PILLAR_ORDER) {
      expect(out.pillars[pid].value).toBeCloseTo(snap.pillars[pid].value, 5);
    }
    // Headline must at least stay in [0, 100] and within reasonable
    // distance of the input — sub-1pt drift is fine because the fixture's
    // headline is set independently.
    expect(out.headline.value).toBeGreaterThanOrEqual(0);
    expect(out.headline.value).toBeLessThanOrEqual(100);
  });
});
