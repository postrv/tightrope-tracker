import { describe, expect, it } from "vitest";
import {
  aggregateGiltPortfolio,
  dmoGiltPortfolioAdapter,
  parseGiltsInIssueXml,
  type GiltRow,
} from "./dmoGiltPortfolio.js";

function row(attrs: Record<string, string | number>): string {
  const out = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return `<View_GILTS_IN_ISSUE ${out}/>`;
}

function sampleXml(): string {
  const rows = [
    row({
      CLOSE_OF_BUSINESS_DATE: "2026-04-17T00:00:00",
      INSTRUMENT_TYPE: "Conventional ", // trailing whitespace as in real DMO feed
      MATURITY_BRACKET: "Short",
      TOTAL_AMOUNT_IN_ISSUE: "100000",
      TOTAL_AMOUNT_INCLUDING_IL_UPLIFT: "100000",
    }),
    row({
      CLOSE_OF_BUSINESS_DATE: "2026-04-17T00:00:00",
      INSTRUMENT_TYPE: "Conventional ",
      MATURITY_BRACKET: "Medium",
      TOTAL_AMOUNT_IN_ISSUE: "300000",
      TOTAL_AMOUNT_INCLUDING_IL_UPLIFT: "300000",
    }),
    row({
      CLOSE_OF_BUSINESS_DATE: "2026-04-17T00:00:00",
      INSTRUMENT_TYPE: "Conventional ",
      MATURITY_BRACKET: "Long",
      TOTAL_AMOUNT_IN_ISSUE: "200000",
      TOTAL_AMOUNT_INCLUDING_IL_UPLIFT: "200000",
    }),
    row({
      CLOSE_OF_BUSINESS_DATE: "2026-04-17T00:00:00",
      INSTRUMENT_TYPE: "Index-linked 3 months",
      MATURITY_BRACKET: "Medium",
      TOTAL_AMOUNT_IN_ISSUE: "150000",
      TOTAL_AMOUNT_INCLUDING_IL_UPLIFT: "250000",
    }),
    row({
      CLOSE_OF_BUSINESS_DATE: "2026-04-17T00:00:00",
      INSTRUMENT_TYPE: "Index-linked 8 months",
      MATURITY_BRACKET: "Long",
      TOTAL_AMOUNT_IN_ISSUE: "100000",
      TOTAL_AMOUNT_INCLUDING_IL_UPLIFT: "150000",
    }),
  ];
  return `<Data>\n  ${rows.join("\n  ")}\n</Data>`;
}

describe("parseGiltsInIssueXml", () => {
  it("pulls instrument type / bracket / IL-uplift amount from every row", () => {
    const parsed = parseGiltsInIssueXml(sampleXml(), "test://url");
    expect(parsed).toHaveLength(5);
    expect(parsed[0]!.instrumentType).toBe("Conventional"); // trailing space trimmed
    expect(parsed[0]!.maturityBracket).toBe("Short");
    expect(parsed[0]!.amount).toBe(100000);
    expect(parsed[3]!.instrumentType).toBe("Index-linked 3 months");
    expect(parsed[3]!.amount).toBe(250000); // prefers IL-uplift over nominal
    expect(parsed[0]!.closeOfBusinessDate).toBe("2026-04-17T00:00:00");
  });

  it("throws when the XML contains no gilt rows at all", () => {
    expect(() => parseGiltsInIssueXml("<Data></Data>", "test://url")).toThrow(/no.*rows/i);
  });

  it("skips rows with missing or non-numeric amounts without aborting the batch", () => {
    const xml = `<Data>
      <View_GILTS_IN_ISSUE CLOSE_OF_BUSINESS_DATE="2026-04-17T00:00:00" INSTRUMENT_TYPE="Conventional" MATURITY_BRACKET="Short" TOTAL_AMOUNT_IN_ISSUE="100"/>
      <View_GILTS_IN_ISSUE CLOSE_OF_BUSINESS_DATE="2026-04-17T00:00:00" INSTRUMENT_TYPE="Conventional" MATURITY_BRACKET="Short" TOTAL_AMOUNT_IN_ISSUE="not_a_number"/>
      <View_GILTS_IN_ISSUE CLOSE_OF_BUSINESS_DATE="2026-04-17T00:00:00" INSTRUMENT_TYPE="Conventional" MATURITY_BRACKET="Long" TOTAL_AMOUNT_IN_ISSUE="50"/>
    </Data>`;
    const parsed = parseGiltsInIssueXml(xml, "test://url");
    expect(parsed).toHaveLength(2);
    expect(parsed.map((r) => r.amount)).toEqual([100, 50]);
  });
});

describe("aggregateGiltPortfolio", () => {
  it("sums by instrument type and counts Long+Ultra-Long as long-conventional", () => {
    const rows: GiltRow[] = [
      { instrumentType: "Conventional",           maturityBracket: "Short",      amount: 100, closeOfBusinessDate: "2026-04-17T00:00:00" },
      { instrumentType: "Conventional",           maturityBracket: "Long",       amount: 200, closeOfBusinessDate: "2026-04-17T00:00:00" },
      { instrumentType: "Conventional",           maturityBracket: "Ultra-Long", amount:  50, closeOfBusinessDate: "2026-04-17T00:00:00" },
      { instrumentType: "Index-linked 3 months",  maturityBracket: "Long",       amount: 150, closeOfBusinessDate: "2026-04-17T00:00:00" },
    ];
    const t = aggregateGiltPortfolio(rows, "test://url");
    expect(t.total).toBe(500);
    expect(t.conventional).toBe(350);
    expect(t.conventionalLong).toBe(250); // Long(200) + Ultra-Long(50)
    expect(t.indexLinked).toBe(150);
  });

  it("throws on empty conventional pool to avoid producing NaN long-share", () => {
    const rows: GiltRow[] = [
      { instrumentType: "Index-linked 3 months", maturityBracket: "Long", amount: 100, closeOfBusinessDate: "2026-04-17T00:00:00" },
    ];
    expect(() => aggregateGiltPortfolio(rows, "test://url")).toThrow(/conventional/i);
  });
});

describe("dmoGiltPortfolioAdapter.fetch", () => {
  it("emits ilg_share and issuance_long_share with correct percentages", async () => {
    const body = sampleXml();
    const fetchImpl = async () =>
      new Response(body, { status: 200, headers: { "content-type": "application/xml" } });

    const result = await dmoGiltPortfolioAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch);

    expect(result.observations).toHaveLength(2);

    const ilg = result.observations.find((o) => o.indicatorId === "ilg_share")!;
    const long = result.observations.find((o) => o.indicatorId === "issuance_long_share")!;

    // total (IL-uplift) = 100 + 300 + 200 + 250 + 150 = 1,000,000
    // index-linked     = 250 + 150 = 400,000  -> 40.00%
    // conventional     = 100 + 300 + 200 = 600,000
    // conv-long        = 200,000  -> 200/600 = 33.33%
    expect(ilg.value).toBeCloseTo(40.00, 2);
    expect(long.value).toBeCloseTo(33.33, 2);

    expect(ilg.observedAt).toBe("2026-04-17T00:00:00Z");
    expect(ilg.sourceId).toBe("dmo");
    expect(ilg.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sourceUrl).toContain("reportCode=D1A");
  });

  it("preserves sub-2-dp precision so small day-to-day composition changes still register", async () => {
    // Rationale: DMO D1A publishes daily with large stock amounts. A single
    // issuance rolls the long-share by thousandths of a percent, which is
    // the whole point of the sparkline. Rounding to 2 dp at storage time
    // flattens those day-to-day moves to zero and kills the sparkline
    // signal. Store full double precision; `fmtPct(1)` handles display-time
    // rounding for humans.
    //
    // Construct input that yields a genuinely irrational pct: conv=3,
    // conv-long=1 => 33.333333...%.
    const body = `<Data>
      <View_GILTS_IN_ISSUE CLOSE_OF_BUSINESS_DATE="2026-04-17T00:00:00" INSTRUMENT_TYPE="Conventional" MATURITY_BRACKET="Long" TOTAL_AMOUNT_INCLUDING_IL_UPLIFT="100"/>
      <View_GILTS_IN_ISSUE CLOSE_OF_BUSINESS_DATE="2026-04-17T00:00:00" INSTRUMENT_TYPE="Conventional" MATURITY_BRACKET="Short" TOTAL_AMOUNT_INCLUDING_IL_UPLIFT="200"/>
      <View_GILTS_IN_ISSUE CLOSE_OF_BUSINESS_DATE="2026-04-17T00:00:00" INSTRUMENT_TYPE="Index-linked 3 months" MATURITY_BRACKET="Medium" TOTAL_AMOUNT_INCLUDING_IL_UPLIFT="50"/>
    </Data>`;
    const fetchImpl = async () =>
      new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
    const result = await dmoGiltPortfolioAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch);
    const long = result.observations.find((o) => o.indicatorId === "issuance_long_share")!;
    // True share: 100 / 300 = 33.33333...%
    expect(long.value).toBeCloseTo(100 / 300 * 100, 6);
    // The stored value must retain more than 2 dp of signal. Anything
    // rounded to 2 dp would be exactly 33.33; the test requires a
    // difference larger than floating-point noise.
    expect(Math.abs(long.value - 33.33)).toBeGreaterThan(1e-4);
  });

  it("throws AdapterError when the CLOSE_OF_BUSINESS_DATE shape is unrecognised", async () => {
    const body = `<Data>${row({
      CLOSE_OF_BUSINESS_DATE: "17/04/2026", // wrong shape on purpose
      INSTRUMENT_TYPE: "Conventional",
      MATURITY_BRACKET: "Long",
      TOTAL_AMOUNT_IN_ISSUE: "100",
      TOTAL_AMOUNT_INCLUDING_IL_UPLIFT: "100",
    })}</Data>`;
    const fetchImpl = async () =>
      new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
    await expect(
      dmoGiltPortfolioAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch),
    ).rejects.toThrow(/CLOSE_OF_BUSINESS_DATE/);
  });
});
