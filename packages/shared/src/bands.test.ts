import { describe, expect, it } from "vitest";
import { BANDS, bandFor, type ScoreBand } from "./bands.js";

describe("BANDS canonical thresholds", () => {
  it("defines the five bands in order critical → slack", () => {
    const ids: ScoreBand[] = ["critical", "acute", "strained", "steady", "slack"];
    expect(BANDS.map((b) => b.id)).toEqual(ids);
  });

  it("covers [0, 100] with no gaps and no overlaps", () => {
    // The contract communicated on /methodology: 0–20 critical, 20–40 acute,
    // 40–60 strained, 60–80 steady, 80–100 slack. Min is inclusive,
    // max is exclusive except the final band which is inclusive of 100.
    expect(BANDS[0]!.min).toBe(0);
    for (let i = 1; i < BANDS.length; i += 1) {
      expect(BANDS[i]!.min, `band ${BANDS[i]!.id} min`).toBe(BANDS[i - 1]!.max);
    }
    // Final band must cover 100 (max is 101 so bandFor(100) lands in slack).
    expect(BANDS[BANDS.length - 1]!.max).toBeGreaterThan(100);
  });

  it("places each band at the documented 20-point step", () => {
    const expected: [ScoreBand, number, number][] = [
      ["critical", 0,  20],
      ["acute",    20, 40],
      ["strained", 40, 60],
      ["steady",   60, 80],
    ];
    for (const [id, min, max] of expected) {
      const b = BANDS.find((x) => x.id === id)!;
      expect(b.min, `${id} min`).toBe(min);
      expect(b.max, `${id} max`).toBe(max);
    }
    // Slack starts at 80; max is > 100 to include a clamped 100 score.
    const slack = BANDS.find((b) => b.id === "slack")!;
    expect(slack.min).toBe(80);
    expect(slack.max).toBeGreaterThan(100);
  });

  it("bandFor matches thresholds at each boundary", () => {
    expect(bandFor(0).id).toBe("critical");
    expect(bandFor(19.999).id).toBe("critical");
    expect(bandFor(20).id).toBe("acute");
    expect(bandFor(39.999).id).toBe("acute");
    expect(bandFor(40).id).toBe("strained");
    expect(bandFor(59.999).id).toBe("strained");
    expect(bandFor(60).id).toBe("steady");
    expect(bandFor(79.999).id).toBe("steady");
    expect(bandFor(80).id).toBe("slack");
    expect(bandFor(100).id).toBe("slack");
  });

  it("clamps out-of-range scores into the nearest band", () => {
    expect(bandFor(-10).id).toBe("critical");
    expect(bandFor(250).id).toBe("slack");
  });

  it("every band carries a label, editorialLabel, colourToken and hex", () => {
    for (const band of BANDS) {
      expect(band.label, `${band.id} label`).toMatch(/\S/);
      expect(band.editorialLabel, `${band.id} editorial`).toMatch(/\S/);
      expect(band.colourToken, `${band.id} token`).toMatch(/^--band-/);
      expect(band.hex, `${band.id} hex`).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });
});
