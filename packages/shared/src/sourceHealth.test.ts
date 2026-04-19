import { describe, expect, it } from "vitest";
import { computeSourceHealth } from "./sourceHealth.js";

describe("computeSourceHealth", () => {
  it("returns an empty list when every source's latest attempt succeeded", () => {
    const out = computeSourceHealth(
      [
        { sourceId: "boe_yields", startedAt: "2026-04-18T10:00:00Z", status: "success" },
        { sourceId: "eia_brent", startedAt: "2026-04-18T10:01:00Z", status: "success" },
      ],
      { boe_yields: "2026-04-18T10:00:00Z", eia_brent: "2026-04-18T10:01:00Z" },
    );
    expect(out).toHaveLength(0);
  });

  it("flags sources whose latest attempt failed and attaches last-success where known", () => {
    const out = computeSourceHealth(
      [
        { sourceId: "boe_yields", startedAt: "2026-04-18T10:00:00Z", status: "failure" },
        { sourceId: "eia_brent", startedAt: "2026-04-18T10:01:00Z", status: "success" },
      ],
      { boe_yields: "2026-04-17T14:02:00Z" },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.sourceId).toBe("boe_yields");
    expect(out[0]!.status).toBe("failure");
    expect(out[0]!.lastSuccessAt).toBe("2026-04-17T14:02:00Z");
    expect(out[0]!.name).toContain("Bank of England");
  });

  it("distinguishes partial status from full failure", () => {
    const out = computeSourceHealth(
      [{ sourceId: "boe_fx", startedAt: "2026-04-18T10:00:00Z", status: "partial" }],
      {},
    );
    expect(out[0]!.status).toBe("partial");
    expect(out[0]!.lastSuccessAt).toBeUndefined();
  });

  it("falls back to the sourceId when the catalog has no entry", () => {
    const out = computeSourceHealth(
      [{ sourceId: "unknown_feed", startedAt: "2026-04-18T10:00:00Z", status: "failure" }],
      {},
    );
    expect(out[0]!.name).toBe("unknown_feed");
  });

  it("orders entries by sourceId so UI lists don't flicker between requests", () => {
    const out = computeSourceHealth(
      [
        { sourceId: "eia_brent", startedAt: "2026-04-18T10:00:00Z", status: "failure" },
        { sourceId: "boe_yields", startedAt: "2026-04-18T10:01:00Z", status: "failure" },
      ],
      {},
    );
    expect(out.map((e) => e.sourceId)).toEqual(["boe_yields", "eia_brent"]);
  });

  it("filters out the literal 'unknown' sourceId written by the DLQ fallback", () => {
    // The ingest worker's DLQ handler writes a row with source_id='unknown'
    // when a dead-lettered message has no sourceId in its payload. That row
    // surfaces in the public API as a ghost "unknown: failure" entry. It's
    // not an ingestion source the reader can act on, so suppress it here
    // rather than leaking it to every consumer of computeSourceHealth.
    const out = computeSourceHealth(
      [
        { sourceId: "unknown", startedAt: "2026-04-18T10:00:00Z", status: "dlq" },
        { sourceId: "boe_yields", startedAt: "2026-04-18T10:01:00Z", status: "success" },
      ],
      {},
    );
    expect(out).toHaveLength(0);
  });

  it("still surfaces unrecognised sourceIds other than the literal 'unknown'", () => {
    // Regression guard: make sure the 'unknown' filter doesn't accidentally
    // match substrings like 'unknown_feed' (a real but uncatalogued source).
    const out = computeSourceHealth(
      [{ sourceId: "unknown_feed", startedAt: "2026-04-18T10:00:00Z", status: "failure" }],
      {},
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.sourceId).toBe("unknown_feed");
  });
});
