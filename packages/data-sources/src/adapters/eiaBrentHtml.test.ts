import { afterEach, describe, expect, it, vi } from "vitest";
import { eiaBrentAdapter, parseEiaBrentHtml } from "./eiaBrent.js";
import type { AdapterContext } from "../types.js";

// Verbatim numeric cells from the official RBRTED.htm release 10/28/2026,
// fetched after publication. The 28 October cell was still blank.
const HTML = `<table><tr><td class='B6'>&nbsp;&nbsp;2026 Oct-19 to Oct-23</td><td class='B3'>118.82</td><td class='B3'>115.22</td><td class='B3'>117.37</td><td class='B3'>125.39</td><td class='B3'>128.30</td></tr><tr><td class='B6'>&nbsp;&nbsp;2026 Oct-26 to Oct-30</td><td class='B3'>128.12</td><td class='B3'>123.10</td><td class='B3'></td><td class='B3'></td><td class='B3'></td></tr></table>`;
const fixes = [
  ["2026-10-21", 1.3384], ["2026-10-22", 1.3363], ["2026-10-23", 1.3387], ["2026-10-26", 1.3347], ["2026-10-27", 1.3313],
].map(([date, value]) => ({ observedAt: `${date}T16:00:00Z`, value: Number(value) }));
const ctx: AdapterContext = {
  getObservationsInRange: async () => fixes,
  getObservationBefore: async (_id, _source, before) => fixes.filter(r => r.observedAt < before).at(-1) ?? null,
};
const fetchImpl = (async (input: RequestInfo | URL) => String(input).startsWith("https://api.eia.gov/")
  ? Response.json({ response: { data: [{ period: "2026-10-20", value: "115.22" }] } })
  : new Response(HTML)) as typeof fetch;
afterEach(() => vi.useRealTimers());

describe("official EIA HTML publication", () => {
  it("keeps blanks as gaps rather than fabricating a Budget-day Brent price", () => {
    expect(parseEiaBrentHtml(HTML).map(r => r.period)).toEqual(["2026-10-27", "2026-10-26", "2026-10-23", "2026-10-22", "2026-10-21", "2026-10-20", "2026-10-19"]);
  });
  it("uses a newer official table when the API is lagging", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-28T17:00:00Z"));
    const result = await eiaBrentAdapter.fetch(fetchImpl, { ...ctx, secrets: { EIA_API_KEY: "test-key" } });
    expect(result.observations[0]).toMatchObject({ observedAt: "2026-10-27T00:00:00Z", value: 92.47 });
    expect(result.sourceUrl).toBe("https://www.eia.gov/dnav/pet/hist/RBRTED.htm");
  });
  it("pairs every newly published historical day without requiring API credentials", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-28T17:00:00Z"));
    const result = await eiaBrentAdapter.fetchHistorical!(fetchImpl, { from: new Date("2026-10-21"), to: new Date("2026-10-27T23:59:59Z") }, ctx);
    expect(result.observations.map(r => [r.observedAt.slice(0, 10), r.value])).toEqual([
      ["2026-10-21",87.69], ["2026-10-22",93.83], ["2026-10-23",95.84], ["2026-10-26",95.99], ["2026-10-27",92.47],
    ]);
  });
  it("continues with the official table when the API is unavailable", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-28T17:00:00Z"));
    const unavailableApi = (async (input: RequestInfo | URL) => String(input).startsWith("https://api.eia.gov/")
      ? new Response("API unavailable", { status: 503 }) : new Response(HTML)) as typeof fetch;
    const result = await eiaBrentAdapter.fetch(unavailableApi, { ...ctx, secrets: { EIA_API_KEY: "test-key" } });
    expect(result.observations[0]).toMatchObject({ observedAt: "2026-10-27T00:00:00Z", value: 92.47 });
    expect(result.sourceUrl).toBe("https://www.eia.gov/dnav/pet/hist/RBRTED.htm");
  });
});
