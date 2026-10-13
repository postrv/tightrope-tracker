import { describe, expect, it } from "vitest";
import brentHistory from "../fixtures/brent-history.json" with { type: "json" };
import brentLive from "../fixtures/brent.json" with { type: "json" };
import ftseHistory from "../fixtures/ftse-250-history.json" with { type: "json" };
import ftseLive from "../fixtures/ftse-250.json" with { type: "json" };
import { eiaBrentAdapter } from "./eiaBrent.js";
import { lseFtse250Adapter } from "./lseFtse250.js";

const fetchImpl = (async () => {
  throw new Error("fixture-backed fetchHistorical must not call the network");
}) as typeof globalThis.fetch;

describe("history fixtures cover the former Brent and FTSE gaps", () => {
  it("returns Brent points after 2026-04-20 through the live fixture date", async () => {
    const result = await eiaBrentAdapter.fetchHistorical!(fetchImpl, {
      from: new Date("2026-04-20T00:00:00Z"),
      to: new Date(brentLive.observed_at),
    });
    const afterGap = result.observations.filter((obs) => obs.observedAt > "2026-04-20T00:00:00Z");
    expect(afterGap.length).toBeGreaterThan(0);
    expect(afterGap.every((obs) => obs.indicatorId === "brent_gbp" && obs.sourceId === "eia_brent")).toBe(true);

    const seriesLast = brentHistory.points[brentHistory.points.length - 1]!.observed_at;
    expect(seriesLast >= brentLive.observed_at).toBe(true);
    expect(result.latestObservedAt! >= brentLive.observed_at).toBe(true);
  });

  it("returns FTSE 250 points after 2026-08-28 through the live fixture date", async () => {
    const result = await lseFtse250Adapter.fetchHistorical!(fetchImpl, {
      from: new Date("2026-08-28T00:00:00Z"),
      to: new Date(ftseLive.observed_at),
    });
    const afterGap = result.observations.filter((obs) => obs.observedAt > "2026-08-28T16:30:00Z");
    expect(afterGap.length).toBeGreaterThan(0);
    expect(afterGap.every((obs) => obs.indicatorId === "ftse_250" && obs.sourceId === "lseg")).toBe(true);

    const seriesLast = ftseHistory.points[ftseHistory.points.length - 1]!.observed_at;
    expect(seriesLast >= ftseLive.observed_at).toBe(true);
    expect(result.latestObservedAt! >= ftseLive.observed_at).toBe(true);
  });
});
