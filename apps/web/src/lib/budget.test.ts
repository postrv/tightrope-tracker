import { describe, expect, it } from "vitest";
import type { LatestObservationRow } from "@tightrope/snapshot";
import { compareBudgetIndicator, compareBudgetScore } from "./budget.js";

function row(id: string, value: number, observed: string, released: string | null = null): LatestObservationRow {
  return { indicator_id: id, value, observed_at: observed, released_at: released, source_id: "obr_efo", ingested_at: "2026-10-28T17:00:00Z" };
}
describe("Budget comparison credibility", () => {
  it.each(["breakeven_5y", "vacancies_per_unemployed"])("withdraws the invalid %s reference even when a newer post-Budget reading exists", id => {
    const result = compareBudgetIndicator(id, row(id, 1.2, "2026-10-27T16:00:00Z"), row(id, 3.7, "2026-10-29T16:00:00Z"));
    expect(result.status).toBe("baseline_invalidated");
    expect(result.baselineNotice).toBeTruthy();
    expect(result.before).toBeNull();
    expect(result.latest?.value).toBe(3.7);
    expect(result.delta).toBeNull();
    expect(result.deltaDisplay).toBeNull();
  });
  it("does not mistake a month-end period label for a post-Budget observation when the survey was released earlier", () => {
    const survey = row("consumer_confidence", -24, "2026-10-31T00:00:00Z", "2026-10-23T00:00:00Z");
    const result = compareBudgetIndicator("consumer_confidence", survey, survey);
    expect(result.status).toBe("awaiting_post_budget_data");
    expect(result.delta).toBeNull();
  });
  it("withholds a score delta across a calculation correction", () => {
    const result = compareBudgetScore({ timestamp: "2026-10-28T12:25:00Z", value: 38.2 }, { timestamp: "2026-10-28T14:00:00Z", value: 42.8 }, [{ date: "2026-10-28T13:00:00Z", title: "Sampling correction" }]);
    expect(result.comparable).toBe(false);
    expect(result.delta).toBeNull();
    expect(result.corrections).toHaveLength(1);
  });
  it("distinguishes a date-only Budget-day print from a timed post-statement reading", () => {
    const result = compareBudgetIndicator("gilt_10y",row("gilt_10y",4.3,"2026-10-27T00:00:00Z"),row("gilt_10y",4.4,"2026-10-28T00:00:00Z"));
    expect(result.status).toBe("budget_day_observation");
    expect(result.deltaDisplay).toBe("+10.0 bp");
    const morning = compareBudgetIndicator("gilt_10y", row("gilt_10y",4.3,"2026-10-27T00:00:00Z"), row("gilt_10y",4.4,"2026-10-28T09:00:00Z"));
    expect(morning.status).toBe("awaiting_post_budget_data");
    expect(morning.delta).toBeNull();
  });
  it("does not describe a newly ingested pre-Budget print as market reaction or a zero change", () => {
    const r = row("gilt_10y",4.3,"2026-10-27T00:00:00Z");
    const result = compareBudgetIndicator("gilt_10y",r,r);
    expect(result.status).toBe("awaiting_post_budget_data");
    expect(result.delta).toBeNull();
  });
  it("distinguishes forecast revisions from observed economic outcomes", () => {
    const result = compareBudgetIndicator("cb_headroom",row("cb_headroom",23.6,"2026-03-03T00:00:00Z"),row("cb_headroom",14.5,"2026-10-28T00:00:00Z","2026-10-28T13:29:19Z"));
    expect(result.status).toBe("forecast_revision");
    expect(result.delta).toBeCloseTo(-9.1);
    expect(result.deltaDisplay).toBe("−£9.1bn");
  });
  it("requires a real baseline and represents yield changes in basis points", () => {
    const latest = row("gilt_10y",4.4,"2026-10-28T16:30:00Z");
    expect(compareBudgetIndicator("gilt_10y",undefined,latest).delta).toBeNull();
    const result = compareBudgetIndicator("gilt_10y",row("gilt_10y",4.3,"2026-10-27T16:30:00Z"),latest);
    expect(result.status).toBe("post_budget_observation");
    expect(result.deltaDisplay).toBe("+10.0 bp");
  });
});

import baseline from '../../../../packages/data-sources/src/fixtures/budget-2026-baseline.json';
import { INDICATORS } from '@tightrope/shared';
import archived from '../../public/evidence/budget-2026-reference-snapshot.json';
it('freezes every scored input with a pre-cutoff publication/reference anchor and honest capture timing', () => {
  expect(Object.keys(baseline.readings).sort()).toEqual(Object.keys(INDICATORS).sort());
  expect(Date.parse(baseline.capturedAt)).toBeGreaterThan(Date.parse(baseline.publicationCutoff));
  expect(baseline.sourceFileSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(baseline.sourceSnapshotAt).toBe(archived.headline.updatedAt);
  const capturedInputs = Object.values(archived.pillars).flatMap(pillar => pillar.contributions);
  for (const [id, reading] of Object.entries(baseline.readings)) {
    const original = capturedInputs.find(input => input.indicatorId === id);
    expect(original?.rawValue).toBe(reading.value);
    expect(original?.observedAt).toBe(reading.observedAt);
  }
  for (const reading of Object.values(baseline.readings)) {
    expect(Number.isFinite(reading.value)).toBe(true);
    expect(Date.parse(reading.releasedAt ?? reading.observedAt)).toBeLessThan(Date.parse(baseline.publicationCutoff));
  }
});
