import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { eodhdHousebuildersAdapter } from "./eodhdHousebuilders.js";
import fixture from "../fixtures/housebuilders.json" with { type: "json" };
import manifest from "../fixtures/lse-housebuilders-2026-10-28/manifest.json" with { type: "json" };

const archive = new URL("../fixtures/lse-housebuilders-2026-10-28/", import.meta.url);
const sources = manifest.constituents.map(row => ({
  ...row,
  body: readFileSync(new URL(row.rawResponsePath, archive), "utf8"),
}));

function replay(change?: (data: Record<string, unknown>, symbol: string) => void): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.startsWith("https://eodhd.com/")) return new Response("Quota exceeded", { status: 429 });
    const source = sources.find(row => row.sourceUrl === url);
    if (!source) throw new Error(`Unexpected source URL: ${url}`);
    const payload = JSON.parse(source.body) as { data: Record<string, unknown> };
    change?.(payload.data, source.symbol);
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  };
}

function expectRetainedFixture(result: Awaited<ReturnType<typeof eodhdHousebuildersAdapter.fetch>>) {
  expect(result.observations[0]).toMatchObject({
    value: fixture.housebuilder_idx.value,
    observedAt: fixture.observed_at,
    payloadHash: "fixture-fallback",
  });
  expect(result.fallbackReason).toBeTruthy();
}

function completeEodReplay(date: "2026-10-27" | "2026-10-28", missing?: string): typeof fetch {
  const lse = replay();
  return async (input, init) => {
    const url = String(input);
    if (!url.startsWith("https://eodhd.com/")) return lse(input, init);
    const source = sources.find(row => url.includes(`/${row.symbol}.LSE`));
    if (!source || source.symbol === missing) return new Response("[]");
    const raw = JSON.parse(source.body).data;
    const close = Number(String(date === "2026-10-27" ? raw.HST_CLOSE : raw.OFF_CLOSE).replaceAll(",", ""));
    return new Response(JSON.stringify([{ date, close }]));
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("official LSE completed-close housebuilder fallback", () => {
  beforeEach(() => {
    // The archived provider quotes are the 28 October completed session.
    // Calendar-boundary cases below override this deterministic fixture time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T18:30:00Z"));
  });

  it("archives exact primary responses and the independently resolved listing identities", () => {
    for (const source of sources) {
      expect(createHash("sha256").update(source.body).digest("hex")).toBe(source.sha256);
      const rawRic = readFileSync(new URL(source.ricResponsePath, archive), "utf8");
      expect(createHash("sha256").update(rawRic).digest("hex")).toBe(source.ricResponseSha256);
      expect(JSON.parse(rawRic).data.ric).toBe(source.ric);
      const data = JSON.parse(source.body).data;
      expect(data.OFF_CLS_DT).toBe("28 October 2026");
      expect(data.CURRENCY).toBe("GBX");
      expect(data.PERIOD_DESCRIPTION).toBe("Closed");
    }
  });

  it("replays five actual official closes to 52.6 when EODHD is rate limited", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T18:30:00Z"));
    const result = await eodhdHousebuildersAdapter.fetch(replay(), { secrets: { EODHD_API_KEY: "test-key" } });
    expect(result.observations[0]).toMatchObject({
      indicatorId: "housebuilder_idx", sourceId: "eodhd_housebuilders",
      value: 52.6, observedAt: "2026-10-28T16:30:00Z",
      payloadHash: "9a63a50480aa3b54bd5ccf587193d94867e3d1ae9453d2db9c63c12439551167",
    });
    expect(result.sourceUrl).toBe("https://apidata.londonstockexchange.com/rdp/v1/pricing?ric=PSN.L");
    expect(result.fallbackReason).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also uses verified LSE closes when the EODHD key is absent", async () => {
    const result = await eodhdHousebuildersAdapter.fetch(replay());
    expect(result.observations[0]?.value).toBe(52.6);
    expect(result.fallbackReason).toBeUndefined();
  });

  it("advances a delayed full EODHD basket using LSE's newer completed session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T18:30:00Z"));
    const result = await eodhdHousebuildersAdapter.fetch(completeEodReplay("2026-10-27"), { secrets: { EODHD_API_KEY: "test-key" } });
    expect(result.observations[0]).toMatchObject({ value: 52.6, observedAt: "2026-10-28T16:30:00Z" });
    expect(result.sourceUrl).toContain("apidata.londonstockexchange.com");
    expect(result.fallbackReason).toBeUndefined();
  });

  it("checks LSE for a delayed EODHD basket on the following morning", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T08:00:00Z"));
    const result = await eodhdHousebuildersAdapter.fetch(completeEodReplay("2026-10-27"), { secrets: { EODHD_API_KEY: "test-key" } });
    expect(result.observations[0]).toMatchObject({ value: 52.6, observedAt: "2026-10-28T16:30:00Z" });
    expect(result.sourceUrl).toContain("apidata.londonstockexchange.com");
  });

  it("withholds an older verified LSE candidate instead of moving the stored head backwards", async () => {
    const result = await eodhdHousebuildersAdapter.fetch(replay(data => {
      data.OFF_CLOSE = data.HST_CLOSE;
      data.OFF_CLS_DT = data.HSTCLSDATE;
    }), { getObservationBefore: async () => ({ value: 52.6, observedAt: "2026-10-28T16:30:00.000Z" }) });
    expect(result.observations[0]?.value).toBe(55.8);
    expect(result.fallbackReason).toContain("predates the stored verified head");
    expect(result.sourceUrl).toContain("apidata.londonstockexchange.com");
  });

  it("allows same-session revisions across equivalent ISO timestamp formats", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T18:30:00Z"));
    const getObservationBefore = vi.fn(async () => ({ value: 52.5, observedAt: "2026-10-28T16:30:00.000Z" }));
    const result = await eodhdHousebuildersAdapter.fetch(replay(), { getObservationBefore });
    expect(result.observations[0]?.value).toBe(52.6);
    expect(result.fallbackReason).toBeUndefined();
    expect(getObservationBefore).toHaveBeenCalledWith("housebuilder_idx", "eodhd_housebuilders", "2026-10-28T18:30:00.000Z");
  });

  it("fails closed if the stored-head lookup fails", async () => {
    const result = await eodhdHousebuildersAdapter.fetch(replay(), {
      getObservationBefore: async () => { throw new Error("database unavailable"); },
    });
    expect(result.observations[0]?.value).toBe(52.6);
    expect(result.fallbackReason).toContain("stored-head verification unavailable");
    expect(result.sourceUrl).toContain("apidata.londonstockexchange.com");
  });

  it("requires the fixed five-stock basket on EODHD as well as LSE", async () => {
    const result = await eodhdHousebuildersAdapter.fetch(completeEodReplay("2026-10-28", "VTY"), { secrets: { EODHD_API_KEY: "test-key" } });
    expect(result.observations[0]?.value).toBe(52.6);
    expect(result.sourceUrl).toContain("apidata.londonstockexchange.com");
  });

  it("keeps a full current EODHD basket without requesting LSE unnecessarily", async () => {
    const fetchImpl = vi.fn(completeEodReplay("2026-10-28"));
    const result = await eodhdHousebuildersAdapter.fetch(fetchImpl, { secrets: { EODHD_API_KEY: "test-key" } });
    expect(result.observations[0]?.value).toBe(52.6);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(result.sourceUrl).toContain("eodhd.com");
  });

  it("never stamps a weekend date when neither source has a newer actual session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T18:30:00Z"));
    const result = await eodhdHousebuildersAdapter.fetch(completeEodReplay("2026-10-28"), { secrets: { EODHD_API_KEY: "test-key" } });
    expect(result.observations[0]).toMatchObject({ value: 52.6, observedAt: "2026-10-28T16:30:00Z" });
    expect(result.sourceUrl).toContain("eodhd.com");
  });

  it("reconstructs the stored 55.8 using the actual archived previous-close fields", async () => {
    // HST_CLOSE/HSTCLSDATE in the original LSE responses independently record
    // the previous session; replay those fields as the official-close input.
    const result = await eodhdHousebuildersAdapter.fetch(replay(data => {
      data.OFF_CLOSE = data.HST_CLOSE;
      data.OFF_CLS_DT = data.HSTCLSDATE;
    }));
    expect(result.observations[0]).toMatchObject({ value: 55.8, observedAt: "2026-10-27T16:30:00Z" });
    expect(result.fallbackReason).toBeUndefined();
  });

  it.each([
    ["wrong currency", { CURRENCY: "GBP" }],
    ["wrong TIDM", { TIDM: "OTHER" }],
    ["wrong RIC", { RIC: "/OTHER.L" }],
    ["open market", { PERIOD_DESCRIPTION: "Regular Trading", PERIOD_CDE: "a" }],
    ["missing official close despite a valid last trade", { OFF_CLOSE: "-", TRDPRC_1: "1230.5" }],
    ["invalid official date", { OFF_CLS_DT: "31 February 2026" }],
    ["non-positive close", { OFF_CLOSE: "0" }],
  ])("rejects all-five verification when one constituent has %s", async (_name, badFields) => {
    const result = await eodhdHousebuildersAdapter.fetch(replay((data, symbol) => {
      if (symbol === "PSN") Object.assign(data, badFields);
    }));
    expectRetainedFixture(result);
    expect(result.fallbackReason).toContain("LSE PSN");
  });

  it("rejects mixed closing dates rather than averaging across sessions", async () => {
    const result = await eodhdHousebuildersAdapter.fetch(replay((data, symbol) => {
      if (symbol === "VTY") data.OFF_CLS_DT = "27 October 2026";
    }));
    expectRetainedFixture(result);
    expect(result.fallbackReason).toContain("do not share one completed session");
  });

  it("requires all five verified closes even when four are valid", async () => {
    const fetchImpl = replay();
    const result = await eodhdHousebuildersAdapter.fetch(async (input, init) =>
      String(input).includes("ric=VTYV.L") ? new Response("Unavailable", { status: 503 }) : fetchImpl(input, init));
    expectRetainedFixture(result);
  });

  it("does not accept even a Closed-labelled current-day quote before 16:35 London", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T16:34:59Z"));
    expectRetainedFixture(await eodhdHousebuildersAdapter.fetch(replay()));
    vi.setSystemTime(new Date("2026-10-28T16:35:00Z"));
    expect((await eodhdHousebuildersAdapter.fetch(replay())).observations[0]?.value).toBe(52.6);
    // The same London cutoff is 15:35 UTC while BST is in effect.
    const summer = replay(data => { data.OFF_CLS_DT = "22 October 2026"; });
    vi.setSystemTime(new Date("2026-10-22T15:34:59Z"));
    expectRetainedFixture(await eodhdHousebuildersAdapter.fetch(summer));
    vi.setSystemTime(new Date("2026-10-22T15:35:00Z"));
    expect((await eodhdHousebuildersAdapter.fetch(summer)).observations[0]?.observedAt).toBe("2026-10-22T15:30:00Z");
  });

  it.each([false, true])("bounds stalled LSE %s body/header requests concurrently and preserves the last fixture", async (bodyStalls) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T18:30:00Z"));
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init!.signal!);
      if (!bodyStalls) return await new Promise<Response>(() => {});
      const response = new Response("", { status: 200 });
      response.json = () => new Promise(() => {});
      return response;
    });
    let settled = false;
    const pending = eodhdHousebuildersAdapter.fetch(fetchImpl).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expectRetainedFixture(await pending);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
