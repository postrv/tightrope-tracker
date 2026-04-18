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
});
