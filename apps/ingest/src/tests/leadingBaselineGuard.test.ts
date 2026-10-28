import { describe, expect, it } from "vitest";
import { guardLeadingBaselineBackfill, type ExistingBaselineRow } from "../pipelines/leadingBaselineGuard.js";
import type { RawObservation } from "@tightrope/data-sources";

const cutoff = { gilt_10y: "2024-04-02" };
const candidate: RawObservation = { indicatorId: "gilt_10y", sourceId: "boe_yields", observedAt: "2019-01-02T16:00:00Z", value: 1.3, payloadHash: "hist:reviewed" };
const row = (c: RawObservation): ExistingBaselineRow => ({ indicator_id: c.indicatorId, observed_at: c.observedAt,
  value: c.value, source_id: c.sourceId, payload_hash: c.payloadHash, released_at: c.releasedAt ?? null });

describe("reviewed leading baseline scope", () => {
  it("allows missing leading observations and exact retries without requesting an overwrite", () => {
    expect(guardLeadingBaselineBackfill([], [candidate], cutoff)).toEqual({ missing: 1, alreadyPresent: 0 });
    expect(guardLeadingBaselineBackfill([row(candidate)], [candidate], cutoff)).toEqual({ missing: 0, alreadyPresent: 1 });
  });
  it("rejects an in-range gap and a duplicate reference day with a different timestamp", () => {
    expect(() => guardLeadingBaselineBackfill([], [{ ...candidate, observedAt: "2024-04-03T16:00:00Z" }], cutoff)).toThrow("outside reviewed");
    expect(() => guardLeadingBaselineBackfill([{ ...row(candidate), observed_at: "2019-01-02T00:00:00Z" }], [candidate], cutoff)).toThrow("Unreviewed earlier history");
  });
  it("rejects newly discovered conflicting history and source-mislabeled candidates", () => {
    expect(() => guardLeadingBaselineBackfill([{ ...row(candidate), value: 9 }], [candidate], cutoff)).toThrow("Unreviewed earlier history");
    expect(() => guardLeadingBaselineBackfill([], [{ ...candidate, sourceId: "ons_lms" }], cutoff)).toThrow("outside reviewed");
  });
  it("rejects multiple candidate timestamps for a single day instead of inflating the percentile sample", () => {
    expect(() => guardLeadingBaselineBackfill([], [candidate, { ...candidate, observedAt: "2019-01-02T00:00:00Z" }], cutoff)).toThrow("Duplicate candidate");
  });
  it("permits documented finite historical extremes without loosening current live bounds", () => {
    const observations: RawObservation[] = [
      { indicatorId: "borrowing_outturn", sourceId: "ons_psf", observedAt: "2020-05-01T00:00:00Z", value: 51.103, payloadHash: "hist:verified-covid" },
      { indicatorId: "debt_interest", sourceId: "ons_psf", observedAt: "2019-03-01T00:00:00Z", value: -0.125, payloadHash: "hist:verified-net-credit" },
    ];
    expect(guardLeadingBaselineBackfill([], observations, { borrowing_outturn: "2024-08-01", debt_interest: "2024-08-01" }))
      .toEqual({ missing: 2, alreadyPresent: 0 });
    expect(() => guardLeadingBaselineBackfill([], [{ ...candidate, value: NaN }], cutoff)).toThrow("outside reviewed");
  });
});
