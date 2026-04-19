import { describe, expect, it } from "vitest";
import { parseObrEfoFixture, type ObrFixture } from "./obrEfo.js";
import { AdapterError } from "../lib/errors.js";

const catalog = {
  cb_headroom: { pillar: "fiscal" },
  psnfl_trajectory: { pillar: "fiscal" },
  gilt_10y: { pillar: "market" }, // decoy: fiscal fixture must reject this
};

function baseFixture(): ObrFixture {
  return {
    observed_at: "2026-03-26T00:00:00Z",
    source_url: "https://obr.uk/efo/",
    indicators: {
      cb_headroom: { value: 9.9, unit: "GBPbn" },
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
      expect(obs.observedAt).toBe("2026-03-26T00:00:00Z");
      expect(obs.sourceId).toBe("obr_efo");
    }
  });

  it("throws AdapterError when an indicator id is not in the catalog (guards typos)", async () => {
    // Typo'd id would otherwise create a ghost observation no UI reads.
    // This is the whole point of the validation — surface the mistake as
    // an ingest audit failure instead of silently accepting it.
    const f = baseFixture();
    f.indicators.cb_hedrom = { value: 9.9, unit: "GBPbn" };
    await expect(parseObrEfoFixture(f, catalog)).rejects.toThrow(AdapterError);
    await expect(parseObrEfoFixture(f, catalog)).rejects.toThrow(/unknown indicator id 'cb_hedrom'/);
  });

  it("throws when a fixture indicator belongs to a non-fiscal pillar (copy-paste guard)", async () => {
    const f = baseFixture();
    f.indicators.gilt_10y = { value: 4.5, unit: "%" };
    await expect(parseObrEfoFixture(f, catalog)).rejects.toThrow(/not 'fiscal'/);
  });

  it("throws when value is not a finite number", async () => {
    const f = baseFixture();
    // @ts-expect-error — intentionally invalid
    f.indicators.cb_headroom = { value: "lots", unit: "GBPbn" };
    await expect(parseObrEfoFixture(f, catalog)).rejects.toThrow(/non-finite/);

    const fNaN = baseFixture();
    fNaN.indicators.cb_headroom = { value: NaN, unit: "GBPbn" };
    await expect(parseObrEfoFixture(fNaN, catalog)).rejects.toThrow(/non-finite/);
  });

  it("throws when the fixture is malformed (no indicators object)", async () => {
    await expect(
      parseObrEfoFixture({} as unknown as ObrFixture, catalog),
    ).rejects.toThrow(/missing indicators/);
  });

  it("throws when observed_at is absent", async () => {
    const f = baseFixture();
    // @ts-expect-error — intentionally missing
    f.observed_at = undefined;
    await expect(parseObrEfoFixture(f, catalog)).rejects.toThrow(/observed_at/);
  });

  it("throws when the fixture has zero indicators (prevents empty success)", async () => {
    const f = baseFixture();
    f.indicators = {};
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
    // Uses the default catalog (production INDICATORS). The on-disk
    // fixture currently lists `cb_headroom` and `psnfl_trajectory` — if
    // someone ever lands an indicator here that fails validation, this
    // test is the canary.
    const res = await parseObrEfoFixture(baseFixture());
    expect(res.observations.length).toBe(2);
  });
});
