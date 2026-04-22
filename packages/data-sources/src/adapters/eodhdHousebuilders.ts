/**
 * UK housebuilder composite via EODHD end-of-day close prices.
 *
 * Equal-weighted composite of Persimmon, Barratt Redrow, Taylor Wimpey,
 * Berkeley, Vistry — rebased to 100 at the 2019 average closing price.
 * Falls back to the editorial fixture when EODHD_API_KEY is not set
 * (dev, tests, probe scripts).
 *
 * EODHD free tier: 20 req/day. Each constituent requires one call,
 * so a full fetch uses 5 of 20. Run once daily (fiscal pipeline, 02:00 UTC).
 */
import type { AdapterContext, AdapterResult, DataSourceAdapter, RawObservation } from "../types.js";
import { registerAdapter } from "../registry.js";
import { fetchOrThrow } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";
import fixture from "../fixtures/housebuilders.json" with { type: "json" };

const SOURCE_ID = "eodhd_housebuilders";
const API_BASE = "https://eodhd.com/api/eod";

interface Constituent {
  symbol: string;
  rebase2019: number;
}

const CONSTITUENTS: Constituent[] = [
  { symbol: "PSN",  rebase2019: 2010.47 },
  { symbol: "BTRW", rebase2019: 603.15 },
  { symbol: "TW",   rebase2019: 163.26 },
  { symbol: "BKG",  rebase2019: 4684.43 },
  { symbol: "VTY",  rebase2019: 919.61 },
];

const MIN_CONSTITUENTS = 3;

interface EodhdCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjusted_close: number;
  volume: number;
}

function fetchFromFixture(): AdapterResult {
  const data = fixture as { observed_at: string; housebuilder_idx: { value: number }; source_url: string };
  return {
    observations: [{
      indicatorId: "housebuilder_idx",
      value: data.housebuilder_idx.value,
      observedAt: data.observed_at,
      sourceId: SOURCE_ID,
      payloadHash: "fixture-fallback",
    }],
    sourceUrl: data.source_url ?? "local:fixtures/housebuilders.json",
    fetchedAt: new Date().toISOString(),
  };
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function fetchConstituent(
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
  symbol: string,
): Promise<EodhdCandle | null> {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86_400_000);
  const url = `${API_BASE}/${symbol}.LSE?api_token=${apiKey}&fmt=json&from=${formatDate(from)}&to=${formatDate(to)}&order=d`;

  let res: Response;
  try {
    res = await fetchOrThrow(fetchImpl, SOURCE_ID, url);
  } catch {
    console.warn(`${SOURCE_ID}: fetch failed for ${symbol}`);
    return null;
  }

  let candles: EodhdCandle[];
  try {
    candles = await res.json() as EodhdCandle[];
  } catch {
    console.warn(`${SOURCE_ID}: invalid JSON for ${symbol}`);
    return null;
  }

  if (!Array.isArray(candles) || candles.length === 0) {
    console.warn(`${SOURCE_ID}: no candles returned for ${symbol}`);
    return null;
  }

  return candles[0]!;
}

export const eodhdHousebuildersAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "EODHD -- UK housebuilder composite (daily EOD, fixture fallback)",
  async fetch(fetchImpl, ctx?: AdapterContext): Promise<AdapterResult> {
    const apiKey = ctx?.secrets?.EODHD_API_KEY;
    if (!apiKey) {
      return fetchFromFixture();
    }

    const rebasedValues: number[] = [];
    let latestDate = "";
    const rawParts: string[] = [];

    for (const c of CONSTITUENTS) {
      const candle = await fetchConstituent(fetchImpl, apiKey, c.symbol);
      if (!candle) continue;

      const close = candle.close;
      if (!Number.isFinite(close) || close <= 0) {
        console.warn(`${SOURCE_ID}: invalid close for ${c.symbol}: ${close}`);
        continue;
      }

      rebasedValues.push((close / c.rebase2019) * 100);
      if (candle.date > latestDate) latestDate = candle.date;
      rawParts.push(`${c.symbol}:${close}`);
    }

    if (rebasedValues.length < MIN_CONSTITUENTS) {
      console.warn(`${SOURCE_ID}: only ${rebasedValues.length}/${CONSTITUENTS.length} constituents resolved, falling back to fixture`);
      return fetchFromFixture();
    }

    const composite = rebasedValues.reduce((a, b) => a + b, 0) / rebasedValues.length;
    const observedAt = latestDate.includes("T") ? latestDate : `${latestDate}T16:30:00Z`;
    const payloadHash = await sha256Hex(rawParts.join("|"));

    const observations: RawObservation[] = [{
      indicatorId: "housebuilder_idx",
      value: Math.round(composite * 10) / 10,
      observedAt,
      sourceId: SOURCE_ID,
      payloadHash,
    }];

    return {
      observations,
      sourceUrl: `https://eodhd.com/api/eod/?exchange=LSE`,
      fetchedAt: new Date().toISOString(),
    };
  },
};

registerAdapter(eodhdHousebuildersAdapter);
