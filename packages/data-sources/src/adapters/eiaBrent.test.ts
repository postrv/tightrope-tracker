import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/brent.json" with { type: "json" };
import { eiaBrentAdapter } from "./eiaBrent.js";
import type { AdapterContext } from "../types.js";

type FxFix = { value: number; observedAt: string };

/** Live-path context: EIA key + the relay-fed BoE fixes available in D1. */
function liveCtx(fixes: FxFix[] = [{ value: 1.3356, observedAt: "2026-07-06T16:00:00Z" }]): AdapterContext {
  return {
    secrets: { EIA_API_KEY: "test-key" },
    getObservationBefore: async (id, sourceId, beforeIso) =>
      id === "gbp_usd" && sourceId === "boe_fx"
        ? fixes.filter((fix) => fix.observedAt < beforeIso)
          .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0] ?? null
        : null,
  };
}

function eiaFetchStub(rows: Array<{ period: string; value: number | string }>): typeof globalThis.fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (!u.startsWith("https://api.eia.gov/")) throw new Error(`unexpected fetch: ${u}`);
    return new Response(JSON.stringify({ response: { data: rows } }), { status: 200 });
  }) as typeof globalThis.fetch;
}

describe("eiaBrentAdapter — live path", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("queries the RBRTE series facet and pairs with the published gbp_usd fix", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: RequestInfo | URL) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ response: { data: [{ period: "2026-07-06", value: "69.56" }] } }), { status: 200 });
    }) as typeof globalThis.fetch;

    const ctx = liveCtx();
    const lookup = vi.spyOn(ctx, "getObservationBefore");
    const result = await eiaBrentAdapter.fetch(fetchImpl, ctx);
    // The 2026-07-13 root cause: facets[series][]=EPCBRENT (a PRODUCT code)
    // matched nothing and EIA replied 200 with zero rows for two weeks.
    expect(capturedUrl).toContain("facets%5Bseries%5D%5B%5D=RBRTE");
    expect(capturedUrl).not.toContain("EPCBRENT");
    const obs = result.observations[0]!;
    expect(obs.indicatorId).toBe("brent_gbp");
    expect(obs.value).toBeCloseTo(69.56 / 1.3356, 2);
    expect(obs.observedAt).toBe("2026-07-06T00:00:00Z");
    expect(lookup).toHaveBeenCalledWith("gbp_usd", "boe_fx", "2026-07-07T00:00:00.000Z");
  });

  it("keeps a dated Brent price stable when later FX fixes arrive", async () => {
    const eia = eiaFetchStub([{ period: "2026-10-06", value: 125.44 }]);
    const periodFx = { value: 1.3279, observedAt: "2026-10-06T16:00:00Z" };
    const first = await eiaBrentAdapter.fetch(eia, liveCtx([periodFx]));
    const later = await eiaBrentAdapter.fetch(eia, liveCtx([
      periodFx,
      { value: 1.322, observedAt: "2026-10-12T16:00:00Z" },
    ]));

    expect(first.observations[0]!.value).toBeCloseTo(125.44 / 1.3279, 2);
    expect(later.observations[0]).toEqual(first.observations[0]);
  });

  it("falls back to the fixture when EIA returns zero rows, and a stale fixture names the live reason", async () => {
    // Fresh fixture: zero-rows EIA -> fixture value served quietly.
    const observedMs = Date.parse((fixture as { observed_at: string }).observed_at);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedMs + 24 * 60 * 60 * 1000));
    const result = await eiaBrentAdapter.fetch(eiaFetchStub([]), liveCtx());
    expect(result.observations[0]!.value).toBe((fixture as { brent_gbp: { value: number } }).brent_gbp.value);

    // Stale fixture: the audit error must carry the live-path root cause.
    vi.setSystemTime(new Date(observedMs + 30 * 24 * 60 * 60 * 1000));
    await expect(eiaBrentAdapter.fetch(eiaFetchStub([]), liveCtx()))
      .rejects.toThrow(/stale.*live path: EIA returned no usable Brent rows/is);
  });

  it("falls back with a pairing reason when no gbp_usd observation is published", async () => {
    const observedMs = Date.parse((fixture as { observed_at: string }).observed_at);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedMs + 24 * 60 * 60 * 1000));
    const result = await eiaBrentAdapter.fetch(
      eiaFetchStub([{ period: "2026-07-06", value: 69.56 }]),
      liveCtx([]),
    );
    // Fixture path served (fresh) — the live path declined to price without FX.
    expect(result.sourceUrl).toBe((fixture as { source_url: string }).source_url);
  });

  it("rejects a preceding FX fix more than five days before the EIA period", async () => {
    const observedMs = Date.parse((fixture as { observed_at: string }).observed_at);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedMs + 24 * 60 * 60 * 1000));
    const result = await eiaBrentAdapter.fetch(
      eiaFetchStub([{ period: "2026-07-06", value: 69.56 }]),
      liveCtx([{ value: 1.3356, observedAt: "2026-06-20T16:00:00Z" }]),
    );
    expect(result.sourceUrl).toBe((fixture as { source_url: string }).source_url);
  });

  it("accepts a preceding Friday fix for a Tuesday price after a UK bank holiday", async () => {
    const result = await eiaBrentAdapter.fetch(
      eiaFetchStub([{ period: "2026-09-01", value: 75 }]),
      liveCtx([{ value: 1.3, observedAt: "2026-08-28T16:00:00Z" }]),
    );
    expect(result.observations[0]!.value).toBeCloseTo(75 / 1.3, 2);
    expect(result.observations[0]!.observedAt).toBe("2026-09-01T00:00:00Z");
  });
});

describe("eiaBrentAdapter — historical EIA/BoE pairing", () => {
  it("fetches official daily prices and joins the nearest same or preceding BoE fix", async () => {
    let eiaUrl = "";
    let fxArgs: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      eiaUrl = String(url);
      return new Response(JSON.stringify({ response: {
        total: "4",
        data: [
          { period: "2026-05-01", value: "100" },
          { period: "2026-05-04", value: "102" },
          { period: "2026-05-05", value: "104" },
          { period: "2026-05-06", value: "." },
        ],
      } }), { status: 200 });
    }) as typeof globalThis.fetch;
    const ctx: AdapterContext = {
      secrets: { EIA_API_KEY: "test-key" },
      getObservationsInRange: async (...args) => {
        fxArgs = args;
        return [
          { observedAt: "2026-04-30T16:00:00Z", value: 1.2 },
          { observedAt: "2026-05-05T16:00:00Z", value: 1.3 },
          { observedAt: "2026-05-07T16:00:00Z", value: 1.4 },
        ];
      },
    };
    const result = await eiaBrentAdapter.fetchHistorical!(fetchImpl, {
      from: new Date("2026-05-01T00:00:00Z"),
      to: new Date("2026-05-06T23:59:59Z"),
    }, ctx);

    expect(eiaUrl).toContain("facets%5Bseries%5D%5B%5D=RBRTE");
    expect(eiaUrl).toContain("start=2026-05-01");
    expect(eiaUrl).toContain("end=2026-05-06");
    expect(fxArgs).toEqual([
      "gbp_usd", "boe_fx", "2026-04-26T00:00:00.000Z", "2026-05-07T00:00:00.000Z",
    ]);
    expect(result.observations.map((o) => [o.observedAt, o.value])).toEqual([
      ["2026-05-01T00:00:00Z", 83.33],
      ["2026-05-04T00:00:00Z", 85],
      ["2026-05-05T00:00:00Z", 80],
    ]);
    expect(result.observations.every((o) => /^hist:[0-9a-f]{64}$/.test(o.payloadHash))).toBe(true);
    expect(result.notes).toContain("1 EIA rows had no usable date or price");
  });

  it("skips price dates whose nearest available FX fix is older than five days", async () => {
    const ctx: AdapterContext = {
      secrets: { EIA_API_KEY: "test-key" },
      getObservationsInRange: async () => [{ observedAt: "2026-04-20T16:00:00Z", value: 1.25 }],
    };
    const result = await eiaBrentAdapter.fetchHistorical!(
      eiaFetchStub([{ period: "2026-05-01", value: "100" }]),
      { from: new Date("2026-05-01T00:00:00Z"), to: new Date("2026-05-01T23:59:59Z") },
      ctx,
    );
    expect(result.observations).toHaveLength(0);
    expect(result.notes).toContain("1 EIA price dates lacked a BoE fix within five days");
  });

  it("fails the daily catch-up visibly when EIA silently returns no prices", async () => {
    const ctx: AdapterContext = {
      secrets: { EIA_API_KEY: "test-key" },
      getObservationsInRange: async () => [],
    };
    await expect(eiaBrentAdapter.fetchHistorical!(
      eiaFetchStub([]),
      { from: new Date("2026-09-29T00:00:00Z"), to: new Date("2026-10-12T23:59:59Z") },
      ctx,
    )).rejects.toThrow(/no Brent prices/);
  });

  it("fails the daily catch-up visibly when BoE FX is absent", async () => {
    const ctx: AdapterContext = {
      secrets: { EIA_API_KEY: "test-key" },
      getObservationsInRange: async () => [],
    };
    await expect(eiaBrentAdapter.fetchHistorical!(
      eiaFetchStub([{ period: "2026-10-06", value: "125.44" }]),
      { from: new Date("2026-09-29T00:00:00Z"), to: new Date("2026-10-12T23:59:59Z") },
      ctx,
    )).rejects.toThrow(/could be paired with BoE FX/);
  });

  it("fails visibly if the EIA result is truncated", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ response: {
      total: "5001", data: [{ period: "2026-05-01", value: "100" }],
    } }), { status: 200 })) as typeof globalThis.fetch;
    const ctx: AdapterContext = {
      secrets: { EIA_API_KEY: "test-key" },
      getObservationsInRange: async () => [],
    };
    await expect(eiaBrentAdapter.fetchHistorical!(fetchImpl, {
      from: new Date("2026-05-01T00:00:00Z"), to: new Date("2026-05-01T23:59:59Z"),
    }, ctx)).rejects.toThrow(/truncated/);
  });

  it("refuses a production backfill without EIA credentials", async () => {
    await expect(eiaBrentAdapter.fetchHistorical!(
      eiaFetchStub([]),
      { from: new Date("2026-05-01T00:00:00Z"), to: new Date("2026-05-31T23:59:59Z") },
      { getObservationsInRange: async () => [] },
    )).rejects.toThrow(/requires EIA_API_KEY/);
  });

  it("emits every pairable business day after 2026-10-20 and omits a day with no in-window fix", async () => {
    // Recorded EIA payload. Prices after 2026-10-20 are not yet on the
    // public RBRTEd file; they exist here only to prove the shipped joiner.
    // FX fixes are the published BoE XUDLUSS values for those dates.
    const recorded = [
      { period: "2026-10-20", value: "115.22" },
      { period: "2026-10-21", value: "110.00" },
      { period: "2026-10-22", value: "111.50" },
      { period: "2026-10-23", value: "112.25" },
      { period: "2026-10-26", value: "113.00" },
      { period: "2026-10-27", value: "114.10" },
      { period: "2026-11-04", value: "120.00" },
    ];
    const fixes = [
      { observedAt: "2026-10-21T16:00:00Z", value: 1.3384 },
      { observedAt: "2026-10-22T16:00:00Z", value: 1.3363 },
      { observedAt: "2026-10-23T16:00:00Z", value: 1.3387 },
      { observedAt: "2026-10-26T16:00:00Z", value: 1.3347 },
      { observedAt: "2026-10-27T16:00:00Z", value: 1.3313 },
    ];
    const ctx: AdapterContext = {
      secrets: { EIA_API_KEY: "test-key" },
      getObservationsInRange: async () => fixes,
      getObservationBefore: async (_id, _sourceId, beforeIso) =>
        fixes.filter((fix) => fix.observedAt < beforeIso)
          .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0] ?? null,
    };
    const historical = await eiaBrentAdapter.fetchHistorical!(
      eiaFetchStub(recorded),
      { from: new Date("2026-10-20T00:00:00Z"), to: new Date("2026-11-04T23:59:59Z") },
      ctx,
    );
    expect(historical.observations.map((o) => [o.observedAt, o.value])).toEqual([
      ["2026-10-21T00:00:00Z", 82.19],
      ["2026-10-22T00:00:00Z", 83.44],
      ["2026-10-23T00:00:00Z", 83.85],
      ["2026-10-26T00:00:00Z", 84.66],
      ["2026-10-27T00:00:00Z", 85.71],
    ]);
    expect(historical.notes?.join(" ")).toMatch(/lacked a BoE fix/);

    const live = await eiaBrentAdapter.fetch(
      eiaFetchStub([
        { period: "2026-10-27", value: "114.10" },
        { period: "2026-10-26", value: "113.00" },
      ]),
      ctx,
    );
    expect(live.observations).toHaveLength(1);
    expect(live.observations[0]).toMatchObject({
      indicatorId: "brent_gbp",
      observedAt: "2026-10-27T00:00:00Z",
      value: 85.71,
    });

    const observedMs = Date.parse((fixture as { observed_at: string }).observed_at);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedMs + 24 * 60 * 60 * 1000));
    const unpaired = await eiaBrentAdapter.fetch(
      eiaFetchStub([{ period: "2026-11-04", value: "120.00" }]),
      ctx,
    );
    expect(unpaired.observations[0]!.observedAt).not.toBe("2026-11-04T00:00:00Z");
    expect(unpaired.observations[0]!.value).toBe((fixture as { brent_gbp: { value: number } }).brent_gbp.value);
    vi.useRealTimers();
  });
});

describe("eiaBrentAdapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits a brent_gbp observation from the fixture", async () => {
    const observedMs = Date.parse((fixture as { observed_at: string }).observed_at);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedMs + 24 * 60 * 60 * 1000));
    const result = await eiaBrentAdapter.fetch(globalThis.fetch);
    expect(result.observations).toHaveLength(1);
    const obs = result.observations[0]!;
    expect(obs.indicatorId).toBe("brent_gbp");
    expect(obs.sourceId).toBe("eia_brent");
    expect(typeof obs.value).toBe("number");
    expect(obs.value).toBeGreaterThan(10);
    expect(obs.value).toBeLessThan(300);
    expect(obs.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(obs.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws AdapterError when the fixture has rotted past the 14-day freshness window", async () => {
    // Advance system time so the bundled fixture's observed_at is older
    // than the 14-day guard. The adapter must trip into the audit log
    // rather than re-emit a stale Brent print every five minutes.
    const observedMs = Date.parse((fixture as { observed_at: string }).observed_at);
    expect(Number.isFinite(observedMs), "fixture has a parseable observed_at").toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedMs + 30 * 24 * 60 * 60 * 1000)); // 30 days later

    await expect(eiaBrentAdapter.fetch(globalThis.fetch)).rejects.toThrow(/stale/i);
  });

  it("emits cleanly when called the day after the fixture publishes", async () => {
    const observedMs = Date.parse((fixture as { observed_at: string }).observed_at);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedMs + 24 * 60 * 60 * 1000)); // +1 day

    const result = await eiaBrentAdapter.fetch(globalThis.fetch);
    expect(result.observations).toHaveLength(1);
  });

  it("serves the 2026-10-20 paired print from the fallback fixture inside the 14-day guard", async () => {
    const fx = fixture as { observed_at: string; brent_gbp: { value: number } };
    expect(fx.observed_at).toBe("2026-10-20T00:00:00Z");
    expect(fx.brent_gbp.value).toBe(86.07);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(fx.observed_at) + 8 * 24 * 60 * 60 * 1000));
    const result = await eiaBrentAdapter.fetch(globalThis.fetch);
    expect(result.observations[0]).toMatchObject({
      indicatorId: "brent_gbp",
      observedAt: "2026-10-20T00:00:00Z",
      value: 86.07,
    });
  });
});
