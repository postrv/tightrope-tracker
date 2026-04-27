import { describe, expect, it } from "vitest";
import { parseObrEfoFixture, parseObrEfoHistorical, type ObrFixture } from "./obrEfo.js";
import { AdapterError } from "../lib/errors.js";

const catalog = {
  cb_headroom: { pillar: "fiscal" },
  psnfl_trajectory: { pillar: "fiscal" },
  gilt_10y: { pillar: "market" }, // decoy: fiscal fixture must reject this
};

function baseFixture(): ObrFixture {
  // Mirrors the on-disk obr-efo.json fixture: the March 2026 Spring
  // Forecast published 2026-03-03 with headroom of 23.6bn at the head of
  // the vintages array. Do not flip back to the old March 2025 crunch
  // figure (9.9bn) at the head — that exact bug (stale value with a
  // freshened date) was what triggered the audit item.
  return {
    vintages: [
      {
        observed_at: "2026-03-03T00:00:00Z",
        source_url: "https://obr.uk/efo/",
        indicators: {
          cb_headroom: { value: 23.6, unit: "GBPbn" },
          psnfl_trajectory: { value: 0.1, unit: "pp" },
        },
      },
    ],
  };
}

function legacyFixture(): ObrFixture {
  // Single-vintage object (pre-vintages schema). The adapter must still
  // accept this shape so an older fixture in a worktree doesn't crash
  // the live pipeline.
  return {
    observed_at: "2026-03-03T00:00:00Z",
    source_url: "https://obr.uk/efo/",
    indicators: {
      cb_headroom: { value: 23.6, unit: "GBPbn" },
      psnfl_trajectory: { value: 0.1, unit: "pp" },
    },
  };
}

describe("parseObrEfoFixture", () => {
  it("emits one observation per fiscal indicator in the fixture", async () => {
    const res = await parseObrEfoFixture(baseFixture(), catalog);
    expect(res.observations.length).toBe(2);
    const ids = new Set(res.observations.map((o) => o.indicatorId));
    expect(ids).toEqual(new Set(["cb_headroom", "psnfl_trajectory"]));
    expect(res.sourceUrl).toBe("https://obr.uk/efo/");
    for (const obs of res.observations) {
      expect(obs.observedAt).toBe("2026-03-03T00:00:00Z");
      expect(obs.sourceId).toBe("obr_efo");
    }
  });

  it("throws AdapterError when an indicator id is not in the catalog (guards typos)", async () => {
    // Typo'd id would otherwise create a ghost observation no UI reads.
    // This is the whole point of the validation — surface the mistake as
    // an ingest audit failure instead of silently accepting it.
    const f = baseFixture();
    f.vintages![0]!.indicators.cb_hedrom = { value: 23.6, unit: "GBPbn" };
    await expect(parseObrEfoFixture(f, catalog)).rejects.toThrow(AdapterError);
    await expect(parseObrEfoFixture(f, catalog)).rejects.toThrow(/unknown indicator id 'cb_hedrom'/);
  });

  it("throws when a fixture indicator belongs to a non-fiscal pillar (copy-paste guard)", async () => {
    const f = baseFixture();
    f.vintages![0]!.indicators.gilt_10y = { value: 4.5, unit: "%" };
    await expect(parseObrEfoFixture(f, catalog)).rejects.toThrow(/not 'fiscal'/);
  });

  it("throws when value is not a finite number", async () => {
    const f = baseFixture();
    // @ts-expect-error — intentionally invalid
    f.vintages![0]!.indicators.cb_headroom = { value: "lots", unit: "GBPbn" };
    await expect(parseObrEfoFixture(f, catalog)).rejects.toThrow(/non-finite/);

    const fNaN = baseFixture();
    fNaN.vintages![0]!.indicators.cb_headroom = { value: NaN, unit: "GBPbn" };
    await expect(parseObrEfoFixture(fNaN, catalog)).rejects.toThrow(/non-finite/);
  });

  it("throws when the fixture is malformed (no vintages and no legacy fields)", async () => {
    await expect(
      parseObrEfoFixture({} as unknown as ObrFixture, catalog),
    ).rejects.toThrow(/no vintages/);
  });

  it("throws when a vintage is missing observed_at", async () => {
    const f = baseFixture();
    // @ts-expect-error — intentionally missing
    f.vintages![0]!.observed_at = undefined;
    await expect(parseObrEfoFixture(f, catalog)).rejects.toThrow(/observed_at/);
  });

  it("throws when the head vintage has zero indicators (prevents empty success)", async () => {
    const f = baseFixture();
    f.vintages![0]!.indicators = {};
    await expect(parseObrEfoFixture(f, catalog)).rejects.toThrow(/zero observations/);
  });

  it("every observation carries a stable payloadHash derived from the fixture bytes", async () => {
    const a = await parseObrEfoFixture(baseFixture(), catalog);
    const b = await parseObrEfoFixture(baseFixture(), catalog);
    expect(a.observations[0]!.payloadHash).toEqual(b.observations[0]!.payloadHash);
    // Every observation from the same fetch shares one payloadHash.
    const hashes = new Set(a.observations.map((o) => o.payloadHash));
    expect(hashes.size).toBe(1);
  });

  it("real INDICATORS catalog accepts the real production fixture (smoke)", async () => {
    const res = await parseObrEfoFixture(baseFixture());
    expect(res.observations.length).toBe(2);
  });

  it("accepts the legacy single-vintage shape for backward compatibility", async () => {
    const res = await parseObrEfoFixture(legacyFixture(), catalog);
    expect(res.observations.length).toBe(2);
    for (const obs of res.observations) {
      expect(obs.observedAt).toBe("2026-03-03T00:00:00Z");
    }
  });

  it("on-disk obr-efo fixture has 23.6bn at the newest vintage (regression: 2025 value with 2026 date)", async () => {
    // Audit regression: the fixture once shipped `cb_headroom: 9.9`
    // stamped `published: 2026-03-26`, but 9.9bn was the March 2025
    // crunch figure. The value had never been refreshed even though the
    // date was mechanically advanced. The new vintages-array shape lets
    // us preserve historical 9.9 entries (Mar 2025, Oct 2024) while
    // the newest vintage (head) carries the current 23.6bn figure.
    const fixtureModule = await import("../fixtures/obr-efo.json", {
      with: { type: "json" },
    });
    const fixture = fixtureModule.default as {
      vintages: Array<{ observed_at: string; indicators: Record<string, { value: number }> }>;
    };
    expect(fixture.vintages.length).toBeGreaterThan(0);
    // Newest vintage = head of array (we sort by observed_at desc inside
    // the adapter; the on-disk file is curated in the same order).
    const head = fixture.vintages[0]!;
    expect(head.observed_at).toBe("2026-03-03T00:00:00Z");
    expect(head.indicators.cb_headroom!.value).toBe(23.6);
  });
});

describe("parseObrEfoHistorical", () => {
  function multiVintageFixture(): ObrFixture {
    return {
      vintages: [
        { observed_at: "2026-03-03T00:00:00Z", indicators: { cb_headroom: { value: 23.6, unit: "GBPbn" } } },
        { observed_at: "2025-11-26T00:00:00Z", indicators: { cb_headroom: { value: 22.0, unit: "GBPbn" } } },
        { observed_at: "2025-03-26T00:00:00Z", indicators: { cb_headroom: { value: 9.9, unit: "GBPbn" } } },
        { observed_at: "2024-10-30T00:00:00Z", indicators: { cb_headroom: { value: 9.9, unit: "GBPbn" } } },
      ],
    };
  }

  it("emits one observation per vintage that falls inside [from, to]", async () => {
    const res = await parseObrEfoHistorical(
      multiVintageFixture(),
      { from: new Date("2024-07-04T00:00:00Z"), to: new Date("2026-04-27T00:00:00Z") },
      catalog,
    );
    // 4 vintages × 1 indicator each = 4 observations.
    expect(res.observations.length).toBe(4);
    const dates = res.observations.map((o) => o.observedAt);
    expect(dates).toEqual([
      "2024-10-30T00:00:00Z",
      "2025-03-26T00:00:00Z",
      "2025-11-26T00:00:00Z",
      "2026-03-03T00:00:00Z",
    ]);
    expect(res.earliestObservedAt).toBe("2024-10-30T00:00:00Z");
    expect(res.latestObservedAt).toBe("2026-03-03T00:00:00Z");
  });

  it("clips vintages outside the requested range", async () => {
    const res = await parseObrEfoHistorical(
      multiVintageFixture(),
      { from: new Date("2025-04-01T00:00:00Z"), to: new Date("2025-12-31T00:00:00Z") },
      catalog,
    );
    expect(res.observations.length).toBe(1);
    expect(res.observations[0]!.observedAt).toBe("2025-11-26T00:00:00Z");
    expect(res.observations[0]!.value).toBe(22.0);
  });

  it("prefixes every payloadHash with 'hist:' so historical rows are distinguishable", async () => {
    const res = await parseObrEfoHistorical(
      multiVintageFixture(),
      { from: new Date("2024-01-01T00:00:00Z"), to: new Date("2026-12-31T00:00:00Z") },
      catalog,
    );
    for (const obs of res.observations) {
      expect(obs.payloadHash).toMatch(/^hist:[0-9a-f]{64}$/);
    }
  });

  it("propagates the release date so the backfill pipeline can prevent lookahead bias", async () => {
    const res = await parseObrEfoHistorical(
      multiVintageFixture(),
      { from: new Date("2024-01-01T00:00:00Z"), to: new Date("2026-12-31T00:00:00Z") },
      catalog,
    );
    for (const obs of res.observations) {
      expect(obs.releasedAt).toBe(obs.observedAt);
    }
  });

  it("returns no observations when no vintage falls in the range", async () => {
    const res = await parseObrEfoHistorical(
      multiVintageFixture(),
      { from: new Date("2020-01-01T00:00:00Z"), to: new Date("2024-01-01T00:00:00Z") },
      catalog,
    );
    expect(res.observations.length).toBe(0);
    expect(res.earliestObservedAt).toBeNull();
    expect(res.latestObservedAt).toBeNull();
  });
});
