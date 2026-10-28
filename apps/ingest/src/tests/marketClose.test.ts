import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";
import { isUkCloseCatchup, isUkMarketHours, isUkOpenRecovery } from "../lib/time.js";
const { runAdapterSafe } = vi.hoisted(() => ({ runAdapterSafe: vi.fn(async () => null) }));
vi.mock("../pipelines/runAdapter.js", () => ({ runAdapterSafe }));
import { ingestMarket } from "../pipelines/market.js";

afterEach(() => vi.clearAllMocks());
const env = {} as Env;
const ran = () => runAdapterSafe.mock.calls.map((call) => (call as unknown as [Env, { id: string }])[1].id);

describe("completed London closes reach scheduled ingestion", () => {
  it("collects both completed equity series at 16:35 GMT", async () => {
    expect(await ingestMarket(env, { now: new Date("2026-10-28T16:35:00Z") })).toEqual({ ran: true });
    expect(ran()).toEqual(["eia_brent", "growth_sentiment", "lseg", "eodhd_housebuilders"]);
  });
  it("retries delayed close publication at 18:05 London", async () => {
    await ingestMarket(env, { now: new Date("2026-10-28T18:05:00Z") });
    expect(ran()).toContain("lseg");
    expect(ran()).toContain("eodhd_housebuilders");
  });
  it("uses the London clock during BST and after its autumn change", () => {
    expect(isUkCloseCatchup(new Date("2026-10-23T15:35:00Z"))).toBe(true);
    expect(isUkCloseCatchup(new Date("2026-10-26T15:35:00Z"))).toBe(false);
    expect(isUkCloseCatchup(new Date("2026-10-26T16:35:00Z"))).toBe(true);
    expect(isUkOpenRecovery(new Date("2026-10-23T06:00:00Z"))).toBe(true);
    expect(isUkOpenRecovery(new Date("2026-10-26T07:00:00Z"))).toBe(true);
  });
  it("does not spend equity quota every five minutes before the close", async () => {
    await ingestMarket(env, { now: new Date("2026-10-28T16:30:00Z") });
    expect(ran()).toEqual(["eia_brent", "growth_sentiment"]);
  });
  it("recovers the prior FTSE close once at 07:00 London", async () => {
    await ingestMarket(env, { now: new Date("2026-10-28T07:00:00Z") });
    expect(ran()).toEqual(["eia_brent", "growth_sentiment", "lseg"]);
  });
  it("skips weekends and non-scheduled after-hours fetches", async () => {
    expect(isUkMarketHours(new Date("2026-10-31T12:00:00Z"))).toBe(false);
    expect(isUkCloseCatchup(new Date("2026-10-31T16:35:00Z"))).toBe(false);
    expect(await ingestMarket(env, { now: new Date("2026-10-28T17:00:00Z") })).toEqual({ ran: false });
    expect(await ingestMarket(env, { now: new Date("2026-10-31T16:35:00Z") })).toEqual({ ran: false });
    expect(ran()).toEqual([]);
  });
  it("retains an explicit force-run path for verified operator catch-up", async () => {
    await ingestMarket(env, { now: new Date("2026-10-28T20:00:00Z"), force: true });
    expect(ran()).toEqual(["eia_brent", "growth_sentiment", "lseg", "eodhd_housebuilders"]);
  });
});
