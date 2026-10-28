import { describe, expect, it } from "vitest";
import { parseObrEfoFixture, parseObrEfoHistorical, type ObrFixture } from "./obrEfo.js";

function fixture(releasedAt = "2026-10-28T13:29:19Z"): ObrFixture {
  return { vintages: [{
    observed_at: "2026-10-28T00:00:00Z", released_at: releasedAt,
    indicators: { cb_headroom: { value: 14.5, unit: "GBPbn" } },
  }] };
}

describe("OBR publication instant", () => {
  it("preserves the actual release time in live and historical observations", async () => {
    const live = await parseObrEfoFixture(fixture());
    const history = await parseObrEfoHistorical(fixture(), {
      from: new Date("2026-10-28T00:00:00Z"), to: new Date("2026-10-28T23:59:59Z"),
    });
    for (const result of [live, history]) {
      expect(result.observations[0]!.observedAt).toBe("2026-10-28T00:00:00Z");
      expect(result.observations[0]!.releasedAt).toBe("2026-10-28T13:29:19Z");
    }
  });
  it("accepts publication metadata on the legacy single-vintage format", async () => {
    const result = await parseObrEfoFixture(fixture().vintages![0]!);
    expect(result.observations[0]!.releasedAt).toBe("2026-10-28T13:29:19Z");
  });
  it("retains calendar-date fallback for old vintages with no publication instant", async () => {
    const result = await parseObrEfoFixture({
      observed_at: "2026-03-03T00:00:00Z", indicators: { cb_headroom: { value: 23.6, unit: "GBPbn" } },
    });
    expect(result.observations[0]!.releasedAt).toBe("2026-03-03T00:00:00Z");
  });
  it.each(["invalid", "2026-10-27T13:29:19Z", "2026-10-28"])("rejects invalid or pre-period publication metadata %s", async (published) => {
    await expect(parseObrEfoFixture(fixture(published))).rejects.toThrow(/released_at/);
  });
});
