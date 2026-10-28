import { describe, expect, it } from "vitest";
import { selectBaselineObservations, type BaselineObservationRow } from "./baselineObservations.js";

function row(observed: string, value: number, ingested = "2026-10-28T09:00:00Z"): BaselineObservationRow {
  return { indicator_id: "gilt_10y", source_id: "boe_yields", observed_at: observed, value, ingested_at: ingested, payload_hash: "hist:sample" };
}

describe("selectBaselineObservations", () => {
  it("counts a midnight duplicate and the canonical close as one reference-day sample", () => {
    const midnight = row("2026-10-26T00:00:00Z", 5.3);
    const close = row("2026-10-26T16:00:00Z", 5.3);
    const next = row("2026-10-27T16:00:00Z", 5.4);
    expect(selectBaselineObservations([midnight, close, next])).toEqual([close, next]);
    expect(selectBaselineObservations([next, close, midnight])).toEqual([next, close]);
  });

  it("prefers a later-ingested historical revision while retaining other periods", () => {
    const original = row("2026-10-26T16:00:00Z", 5.3, "2026-10-27T09:00:00Z");
    const revised = row("2026-10-26T00:00:00Z", 5.35);
    const next = row("2026-10-27T16:00:00Z", 5.4);
    expect(selectBaselineObservations([original, revised, next])).toEqual([revised, next]);
  });

  it("does not collapse different indicators on the same reference day", () => {
    const ten = row("2026-10-26T16:00:00Z", 5.3);
    const thirty = { ...ten, indicator_id: "gilt_30y", value: 5.8 };
    expect(selectBaselineObservations([ten, thirty])).toEqual([ten, thirty]);
  });

  it("keeps successive real live publications while discarding a superseded wrong date", () => {
    const old = { ...row("2025-11-26T00:00:00Z", 22, "2025-11-27T09:00:00Z"), payload_hash: "live:old" };
    const wrong = { ...row("2026-03-26T00:00:00Z", 9.9, "2026-04-15T09:00:00Z"), payload_hash: "live:wrong" };
    const current = { ...row("2026-03-03T00:00:00Z", 23.6), payload_hash: "live:current" };
    expect(selectBaselineObservations([old, wrong, current])).toEqual([old, current]);
    expect(selectBaselineObservations([current, wrong, old])).toEqual([current, old]);
  });

  it("ignores invalid dates and non-finite values", () => {
    const valid = row("2026-10-26T16:00:00Z", 5.3);
    expect(selectBaselineObservations([valid, row("bad-date", 5.4), row("2026-10-27T16:00:00Z", Number.NaN)])).toEqual([valid]);
  });
});
