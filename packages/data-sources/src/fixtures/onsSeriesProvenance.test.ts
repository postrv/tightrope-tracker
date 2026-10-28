import { describe, expect, it } from "vitest";
import { INDICATORS } from "@tightrope/shared";
import capture from "./ons-series-provenance.json" with { type: "json" };
import { onsLmsAdapter } from "../adapters/onsLms.js";
import { onsRtiAdapter } from "../adapters/onsRti.js";
import { onsPsfAdapter } from "../adapters/onsPsf.js";
import { sha256Hex } from "../lib/hash.js";

const series = Object.fromEntries(capture.series.map(row => [row.cdid, row]));

/** Replay excerpts of real ONS responses, including real search candidates.
 * Wrong CDID/dataset mappings cannot succeed through a generic mock URL.
 * Original full-response hashes remain in the fixture for provenance; the
 * replay's hashes cover the deliberately smaller recorded excerpts. */
function recordedFetch(): typeof fetch {
  return async (input) => {
    const url = String(input);
    const row = capture.series.find(item => item.searchUrl === url || item.dataUrl === url);
    if (!row) throw new Error(`Unrecorded ONS request: ${url}`);
    const body = url === row.searchUrl ? row.search : row.data;
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
}

describe("ONS source definitions recorded on 28 October 2026", () => {
  it("retains primary identities, original-response hashes and unchanged excerpt integrity", async () => {
    expect(capture.series.map(row => row.cdid).sort()).toEqual([
      "A3WW", "AP2Y", "J5II", "K54L", "LF2S", "LF69", "MGSC", "MGSX", "NMFX",
    ]);
    for (const row of capture.series) {
      expect(row.sourceUrl).toMatch(/^https:\/\/www\.ons\.gov\.uk\/.+\/timeseries\//);
      expect(row.dataUrl).toBe(`${row.sourceUrl}/data`);
      expect(row.data.description.cdid).toBe(row.cdid);
      expect(row.data.description.datasetId).toBe(row.dataset);
      expect(row.originalDataResponseSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.originalSearchResponseSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await sha256Hex(JSON.stringify(row.data))).toBe(row.excerptDataSha256);
    }
  });

  it("parses real LMS rates/counts and matches the actual three-month vacancy interval", async () => {
    const live = await onsLmsAdapter.fetch(recordedFetch());
    const byId = Object.fromEntries(live.observations.map(row => [row.indicatorId, row]));
    expect(byId.unemployment).toMatchObject({ value: 4.7, observedAt: "2026-07-01T00:00:00Z" });
    expect(byId.inactivity_rate?.value).toBe(20.9);
    // LF69 is thousands of people, while the shared indicator displays millions.
    expect(series.LF69!.data.description.title).toContain("16-64:000s:SA");
    expect(byId.inactivity_health?.value).toBeCloseTo(2.738, 12);

    const vacancyJuly = series.AP2Y!.data.months.find(row => row.date === "2026 JUL")!;
    const unemployedJuly = series.MGSC!.data.months.find(row => row.date === "2026 JUL")!;
    expect(vacancyJuly.label).toBe("2026 JUN-AUG");
    expect(unemployedJuly.label).toBe(vacancyJuly.label);
    expect(byId.vacancies_per_unemployed).toMatchObject({ observedAt: "2026-07-01T00:00:00Z" });
    expect(byId.vacancies_per_unemployed?.value).toBeCloseTo(704 / 1712, 12);
    expect(byId.vacancies_per_unemployed?.value).not.toBeCloseTo(691 / 1712, 8);

    // Source updateDate is retained verbatim; it is not an intraday release claim.
    expect(byId.unemployment?.releasedAt).toBe("2026-10-19T23:00:00.000Z");
    expect(byId.unemployment?.payloadHash).toBe(series.MGSX!.excerptDataSha256);
  });

  it("keeps CPIH real total-pay growth distinct from regular pay and nominal index levels", async () => {
    const labour = await onsLmsAdapter.fetch(recordedFetch());
    expect(series.A3WW!.data.description.title).toContain("Seasonally Adjusted Total Pay");
    expect(series.A3WW!.data.description.title).toContain("Year on Year Three Month Growth (%)");
    expect(labour.observations.find(row => row.indicatorId === "real_regular_pay")).toMatchObject({
      value: 0.7, observedAt: "2026-08-01T00:00:00Z",
    });
    // The source bulletin reports 0.7% total versus 0.6% regular CPIH-real pay.
    expect(INDICATORS.real_regular_pay!.label).toContain("total pay");
    expect(INDICATORS.real_regular_pay!.description).toContain("CPIH");
    expect(INDICATORS.real_regular_pay!.description).toContain("including bonuses");
    expect(INDICATORS.real_regular_pay!.unit).toBe("%");

    const rti = await onsRtiAdapter.fetch(recordedFetch());
    expect(rti.observations.find(row => row.indicatorId === "payroll_mom")).toMatchObject({
      value: 238.3, observedAt: "2026-08-01T00:00:00Z",
    });
    expect(series.K54L!.data.description.title).toContain("Regular Pay Excluding Arrears");
    // The independent source's annual rows establish the base, absent in its unit field.
    expect(series.K54L!.data.years?.find(row => row.date === "2000")?.value).toBe("100.0");
    expect(series.K54L!.data.years?.find(row => row.date === "2015")?.value).toBe("152.7");
    expect(INDICATORS.payroll_mom!.description).toContain("2000=100");
    expect(INDICATORS.payroll_mom!.description).not.toContain("2015=100");
    expect(INDICATORS.payroll_mom!.unit).toBe("index");
  });

  it("converts actual PSF £m and preserves both borrowing and surplus signs", async () => {
    const live = await onsPsfAdapter.fetch(recordedFetch());
    const byId = Object.fromEntries(live.observations.map(row => [row.indicatorId, row]));
    expect(series.J5II!.data.description.title).toContain("excluding public sector banks");
    expect(series.J5II!.data.description).toMatchObject({ preUnit: "£", unit: "m" });
    // September bulletin independently describes £24.5bn of borrowing. J5II
    // records -24520, so /1000 alone would reverse the dashboard's meaning.
    expect(byId.borrowing_outturn).toMatchObject({ value: 24.52, observedAt: "2026-09-01T00:00:00Z" });
    expect(series.NMFX!.data.description.title).toContain("CG: Current expenditure: Net Interest payable");
    expect(series.NMFX!.data.description).toMatchObject({ preUnit: "£", unit: "m" });
    expect(byId.debt_interest).toMatchObject({ value: 10.933, observedAt: "2026-09-01T00:00:00Z" });

    const history = await onsPsfAdapter.fetchHistorical!(recordedFetch(), {
      from: new Date("2026-01-01"), to: new Date("2026-09-30"),
    });
    expect(history.observations.find(row => row.indicatorId === "borrowing_outturn"
      && row.observedAt === "2026-01-01T00:00:00Z")?.value).toBe(-31.96);
    expect(history.observations.find(row => row.indicatorId === "debt_interest"
      && row.observedAt === "2026-01-01T00:00:00Z")?.value).toBe(1.502);
    expect(INDICATORS.debt_interest!.label).toContain("Central-government net interest");
  });

  it("aligns displayed units and scoring directions with the interpreted adapter output", () => {
    const expected = {
      unemployment: ["%", true],
      inactivity_rate: ["%", true],
      inactivity_health: ["m", true],
      vacancies_per_unemployed: ["ratio", false],
      real_regular_pay: ["%", false],
      payroll_mom: ["index", false],
      borrowing_outturn: ["GBPbn", true],
      debt_interest: ["GBPbn", true],
    } as const;
    for (const [id, [unit, risingIsBad]] of Object.entries(expected)) {
      expect(INDICATORS[id]).toMatchObject({ unit, risingIsBad });
    }
    expect(series.MGSX!.data.description.title).toContain("aged 16 and over");
    expect(series.LF2S!.data.description.title).toContain("Aged 16-64");
    expect(INDICATORS.unemployment!.label).toContain("16+");
    expect(INDICATORS.inactivity_rate!.label).toContain("16-64");
  });
});
