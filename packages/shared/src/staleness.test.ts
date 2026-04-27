import { describe, expect, it } from "vitest";
import { INDICATORS, indicatorsForPillar } from "./indicators.js";
import { evaluatePillarFreshness, maxStaleMsForIndicator } from "./staleness.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MIN_DAILY_WINDOW_MS = 3 * DAY_MS;
const MAX_DAILY_WINDOW_MS = WEEK_MS;
const OBSERVED_PSF_LAG_DAYS = 76;
const PSF_LAG_MS = OBSERVED_PSF_LAG_DAYS * DAY_MS;
const MHCLG_QUARTER_MS = 95 * DAY_MS;
const OBR_HALFYEAR_MS = 200 * DAY_MS;
const LMS_LAG_MS = 60 * DAY_MS;
const EDITORIAL_MIN_MS = 180 * DAY_MS;

describe("maxStaleMsForIndicator", () => {
  it("returns the indicator's own maxStaleMs field", () => {
    const def = INDICATORS.gilt_10y!;
    expect(maxStaleMsForIndicator(def)).toBe(def.maxStaleMs);
  });

  it("every indicator in the catalog defines a positive maxStaleMs", () => {
    for (const [id, def] of Object.entries(INDICATORS)) {
      expect(def.maxStaleMs, `${id} is missing maxStaleMs`).toBeGreaterThan(0);
    }
  });

  it("ons_psf monthly indicators tolerate the natural publication gap", () => {
    expect(INDICATORS.borrowing_outturn!.maxStaleMs).toBeGreaterThan(PSF_LAG_MS);
    expect(INDICATORS.debt_interest!.maxStaleMs).toBeGreaterThan(PSF_LAG_MS);
  });

  it("obr_efo fiscal indicators tolerate the 6-month publication cadence", () => {
    expect(INDICATORS.cb_headroom!.maxStaleMs).toBeGreaterThan(OBR_HALFYEAR_MS);
    expect(INDICATORS.psnfl_trajectory!.maxStaleMs).toBeGreaterThan(OBR_HALFYEAR_MS);
  });

  it("quarterly delivery indicators tolerate a full quarter between releases", () => {
    const q = MHCLG_QUARTER_MS;
    expect(INDICATORS.housing_trajectory!.maxStaleMs).toBeGreaterThan(q);
    expect(INDICATORS.planning_consents!.maxStaleMs).toBeGreaterThan(q);
  });

  it("ons_lms indicators tolerate LFS / AWE reporting lag", () => {
    const lmsIds = ["inactivity_rate", "inactivity_health", "unemployment",
                    "vacancies_per_unemployed", "real_regular_pay"];
    for (const id of lmsIds) {
      expect(INDICATORS[id]!.maxStaleMs, `${id}`).toBeGreaterThanOrEqual(LMS_LAG_MS);
    }
  });

  it("ftse_250 uses the weekly-fixture window (adapter has a 14-day freshness guard)", () => {
    const weeklyFixtureMs = 14 * DAY_MS;
    for (const id of ["ftse_250"]) {
      expect(INDICATORS[id]!.maxStaleMs, `${id}`).toBe(weeklyFixtureMs);
      expect(INDICATORS[id]!.provenance, `${id}`).toBe("live");
    }
  });

  it("editorial delivery-milestone indicators use the quarterly fixture window", () => {
    // These four indicators are editorial judgements against political
    // commitments with no machine-readable upstream. The fixture-backed
    // `deliveryMilestones` adapter enforces a 90-day freshness guard, so
    // `maxStaleMs` can be tightened from the old 365-day "editorial"
    // fallback to the quarterly-MHCLG window. If any indicator moves
    // back above that window, the fixture freshness guard has probably
    // been removed — surface the regression here rather than let the
    // figure silently rot.
    const quarterlyFixtureMs = 130 * DAY_MS;
    const editorialIds = ["new_towns_milestones", "bics_rollout",
                          "industrial_strategy", "smr_programme"];
    for (const id of editorialIds) {
      expect(INDICATORS[id]!.maxStaleMs, `${id}`).toBe(quarterlyFixtureMs);
      expect(INDICATORS[id]!.provenance, `${id}`).toBe("editorial");
    }
    // The EDITORIAL_MIN_MS sanity floor is no longer used — the only
    // remaining "editorial" indicators live under a tighter, adapter-
    // enforced threshold.
    expect(EDITORIAL_MIN_MS).toBeGreaterThan(quarterlyFixtureMs);
  });

  it("daily live feeds use a window between 3 and 7 days", () => {
    const dailyIds = [
      "gilt_10y", "gilt_30y", "breakeven_5y",
      "gbp_usd", "gbp_twi",
      "ilg_share", "issuance_long_share",
      "housebuilder_idx",
    ];
    for (const id of dailyIds) {
      const ms = INDICATORS[id]!.maxStaleMs;
      expect(ms, `${id} too loose`).toBeLessThanOrEqual(MAX_DAILY_WINDOW_MS);
      expect(ms, `${id} too tight`).toBeGreaterThanOrEqual(MIN_DAILY_WINDOW_MS);
    }
  });

  it("mortgage_2y_fix uses the BoE monthly window now that the source is IUMBV34", () => {
    // The series moved from Moneyfacts (advertised, monthly press release)
    // to BoE IADB IUMBV34 (effective new-business, monthly). The freshness
    // window is now ONS-monthly-equivalent (60 days), matching the RTI
    // monthly cadence. If anyone moves it back to a daily window, the BoE
    // monthly print will trip the staleness banner the day after it lands.
    expect(INDICATORS.mortgage_2y_fix!.maxStaleMs).toBe(60 * DAY_MS);
    expect(INDICATORS.mortgage_2y_fix!.sourceId).toBe("boe_mortgage_rates");
  });
});

const NOW = new Date("2026-04-18T22:00:00Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function latestMap(
  entries: readonly [string, number][],
): Map<string, { value: number; observedAt: string }> {
  const m = new Map<string, { value: number; observedAt: string }>();
  for (const [id, ageDays] of entries) {
    m.set(id, { value: 0, observedAt: daysAgo(ageDays) });
  }
  return m;
}

describe("evaluatePillarFreshness", () => {
  it("reports fresh when every indicator's observation is inside its own window", () => {
    const defs = indicatorsForPillar("market");
    const entries = defs.map((d) => [d.id, 1] as [string, number]);
    const result = evaluatePillarFreshness("market", defs, latestMap(entries), NOW);
    expect(result.stale).toBe(false);
    expect(result.freshCount).toBe(defs.length);
    expect(result.observedCount).toBe(defs.length);
    expect(result.staleIndicatorIds).toEqual([]);
    expect(result.missingIndicatorIds).toEqual([]);
  });

  it("uses per-indicator windows (OBR EFO 23 days old is fresh, not stale)", () => {
    // The production regression this whole refactor exists to fix:
    // cb_headroom / psnfl_trajectory sit at ~23 days old between EFO
    // releases. Under the old pillar-wide 7-day slow window they were
    // flagged stale; under per-indicator windows (220d for OBR) they
    // must read as fresh.
    const defs = indicatorsForPillar("fiscal");
    const m = latestMap([
      ["cb_headroom", 23],
      ["psnfl_trajectory", 23],
      ["borrowing_outturn", 76],    // monthly + 45d publication lag
      ["debt_interest", 76],
      ["ilg_share", 1],
      ["issuance_long_share", 1],
    ]);
    const result = evaluatePillarFreshness("fiscal", defs, m, NOW);
    expect(result.stale).toBe(false);
    expect(result.freshCount).toBe(6);
  });

  it("excludes indicators that have never been observed from the quorum denominator", () => {
    // Delivery has 2 MHCLG fixture indicators with observations + 4
    // editorial indicators that may never have been ingested. If we
    // counted the 4 missing ones in the denominator, quorum would be
    // unreachable. They belong in missingIndicatorIds, not in the
    // stale vs fresh split.
    const defs = indicatorsForPillar("delivery");
    const m = latestMap([
      ["housing_trajectory", 18],
      ["planning_consents", 18],
    ]);
    const result = evaluatePillarFreshness("delivery", defs, m, NOW);
    expect(result.observedCount).toBe(2);
    expect(result.freshCount).toBe(2);
    expect(result.missingIndicatorIds.length).toBe(defs.length - 2);
    expect(result.stale).toBe(false);
  });

  it("flags a pillar stale when fewer than half of the observed indicators are fresh", () => {
    const defs = indicatorsForPillar("fiscal");
    const m = latestMap([
      ["cb_headroom", 500],          // past 220d window -> stale
      ["psnfl_trajectory", 500],     // past 220d window -> stale
      ["borrowing_outturn", 500],    // past 90d window  -> stale
      ["debt_interest", 1],
      ["ilg_share", 1],
      ["issuance_long_share", 1],
    ]);
    const result = evaluatePillarFreshness("fiscal", defs, m, NOW);
    expect(result.freshCount).toBe(3);
    expect(result.observedCount).toBe(6);
    expect(result.quorum).toBe(3);
    expect(result.stale).toBe(false);
  });

  it("flags stale when observed indicators fail quorum", () => {
    const defs = indicatorsForPillar("fiscal");
    const m = latestMap([
      ["cb_headroom", 500],
      ["psnfl_trajectory", 500],
      ["borrowing_outturn", 500],
      ["debt_interest", 500],
      ["ilg_share", 1],
      ["issuance_long_share", 1],
    ]);
    const result = evaluatePillarFreshness("fiscal", defs, m, NOW);
    expect(result.freshCount).toBe(2);
    expect(result.stale).toBe(true);
    expect(result.staleIndicatorIds).toContain("cb_headroom");
    expect(result.staleIndicatorIds).toContain("debt_interest");
  });

  it("is stale when the pillar has no observations at all (degenerate case)", () => {
    const defs = indicatorsForPillar("labour");
    const result = evaluatePillarFreshness("labour", defs, new Map(), NOW);
    expect(result.observedCount).toBe(0);
    expect(result.freshCount).toBe(0);
    expect(result.stale).toBe(true);
  });

  it("regression: market pillar is fresh when BoE feeds are 3 days old (weekend)", () => {
    // Saturday-Sunday closes + BoE's 2-business-day publish lag routinely
    // push gilt_10y / breakevens / SONIA to age 3 days. The old 2-day
    // market window flagged this normal-operation state as stale.
    const defs = indicatorsForPillar("market");
    const boeIds = ["gilt_10y", "gilt_30y", "breakeven_5y", "breakeven_10y",
                    "gilt_il_10y_real", "gbp_usd", "gbp_twi", "sonia_12m"];
    const entries: [string, number][] = boeIds.map((id) => [id, 3]);
    // Leave the OBR-proxy fixtures at 1d, editorial ones missing.
    entries.push(["brent_gbp", 1], ["housebuilder_idx", 1],
                 ["services_pmi", 15], ["consumer_confidence", 15],
                 ["rics_price_balance", 15]);
    const result = evaluatePillarFreshness("market", defs, latestMap(entries), NOW);
    expect(result.stale).toBe(false);
    expect(result.staleIndicatorIds).toEqual([]);
  });
});
