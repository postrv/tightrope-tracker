/**
 * Regression tests for the INACTIVE_INGEST_SOURCES filter.
 *
 * Retired adapter audit rows linger in production (deliberately — they
 * carry forensic value), but they shouldn't surface on the public
 * source-health banner. Operators saw "lseg_housebuilders last success
 * 5 days ago" and wasted cycles investigating a "failure" that was
 * intentional retirement.
 */
import { describe, expect, it } from "vitest";
import {
  INACTIVE_INGEST_SOURCES,
  computeSourceHealth,
  isActiveIngestSource,
} from "./sourceHealth.js";

describe("INACTIVE_INGEST_SOURCES", () => {
  it("contains every adapter we explicitly retired", () => {
    expect(INACTIVE_INGEST_SOURCES.has("boe_sonia")).toBe(true);
    expect(INACTIVE_INGEST_SOURCES.has("ice_gas")).toBe(true);
    expect(INACTIVE_INGEST_SOURCES.has("lseg_housebuilders")).toBe(true);
    expect(INACTIVE_INGEST_SOURCES.has("twelve_data_housebuilders")).toBe(true);
  });

  it("does not retire any source that an active indicator references", () => {
    // Defensive: if any catalogued INDICATOR uses a source that's in the
    // retired set, we'd show the indicator without a corresponding source
    // health entry. Catch it at build time.
    // (We import INDICATORS lazily because pulling it at module top would
    // create a cycle in some test runs.)
    return import("./indicators.js").then(({ INDICATORS }) => {
      for (const def of Object.values(INDICATORS)) {
        expect(
          INACTIVE_INGEST_SOURCES.has(def.sourceId),
          `indicator '${def.id}' references retired source '${def.sourceId}'`,
        ).toBe(false);
      }
    });
  });

  it("isActiveIngestSource returns false for retired sources, true otherwise", () => {
    expect(isActiveIngestSource("boe_sonia")).toBe(false);
    expect(isActiveIngestSource("boe_yields")).toBe(true);
    expect(isActiveIngestSource("ons_psf")).toBe(true);
  });
});

describe("computeSourceHealth — retired-adapter filter", () => {
  it("suppresses lseg_housebuilders even if its latest attempt was a failure", () => {
    const out = computeSourceHealth(
      [
        { sourceId: "lseg_housebuilders", startedAt: "2026-04-22T07:46:00Z", status: "failure" },
        { sourceId: "ons_psf",             startedAt: "2026-04-27T02:00:00Z", status: "failure" },
      ],
      {},
    );
    const ids = out.map((e) => e.sourceId);
    expect(ids).not.toContain("lseg_housebuilders");
    expect(ids).toContain("ons_psf");
  });

  it("suppresses twelve_data_housebuilders even with status='partial'", () => {
    const out = computeSourceHealth(
      [
        { sourceId: "twelve_data_housebuilders", startedAt: "2026-04-22T08:45:00Z", status: "partial" },
      ],
      {},
    );
    expect(out).toEqual([]);
  });

  it("still surfaces failures from active sources", () => {
    const out = computeSourceHealth(
      [{ sourceId: "boe_yields", startedAt: "2026-04-27T10:00:00Z", status: "failure" }],
      {},
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.sourceId).toBe("boe_yields");
  });
});
