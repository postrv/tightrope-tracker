/**
 * UK housebuilder composite via Twelve Data live quotes.
 *
 * Equal-weighted composite of Persimmon, Barratt Redrow, Taylor Wimpey,
 * Berkeley, Vistry — rebased to 100 at the 2019 average closing price.
 * Falls back to the editorial fixture when TWELVE_DATA_KEY is not set
 * (dev, tests, probe scripts).
 *
 * Twelve Data free tier: 800 req/day, 8/min. A single batch call fetches
 * all five constituents using ~1 request.
 */
import type { AdapterContext, AdapterResult, DataSourceAdapter, RawObservation } from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError, fetchOrThrow } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";
import fixture from "../fixtures/housebuilders.json" with { type: "json" };

const SOURCE_ID = "twelve_data_housebuilders";
const API_BASE = "https://api.twelvedata.com/quote";

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

interface TwelveDataQuote {
  symbol: string;
  close: string;
  datetime: string;
  currency?: string;
  is_market_open?: boolean;
}

interface TwelveDataError {
  code: number;
  message: string;
  status: "error";
}

type TwelveDataBatchResponse = Record<string, TwelveDataQuote | TwelveDataError>;

function isErrorResponse(obj: TwelveDataQuote | TwelveDataError): obj is TwelveDataError {
  return "status" in obj && obj.status === "error";
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

export const twelveDataHousebuildersAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "Twelve Data -- UK housebuilder composite (live, fixture fallback)",
  async fetch(fetchImpl, ctx?: AdapterContext): Promise<AdapterResult> {
    const apiKey = ctx?.secrets?.TWELVE_DATA_KEY;
    if (!apiKey) {
      return fetchFromFixture();
    }

    const symbols = CONSTITUENTS.map((c) => c.symbol).join(",");
    const url = `${API_BASE}?symbol=${symbols}&exchange=LSE&apikey=${apiKey}`;

    let res: Response;
    try {
      res = await fetchOrThrow(fetchImpl, SOURCE_ID, url);
    } catch {
      console.warn(`${SOURCE_ID}: API call failed, falling back to fixture`);
      return fetchFromFixture();
    }

    const body = await res.text();
    let parsed: TwelveDataBatchResponse | TwelveDataQuote;
    try {
      parsed = JSON.parse(body);
    } catch (cause) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: url,
        message: "Twelve Data response was not valid JSON",
        cause,
      });
    }

    // Single-symbol response comes back as a plain object, not keyed by symbol.
    // Normalise to the batch shape.
    if ("symbol" in parsed && "close" in parsed && typeof (parsed as TwelveDataQuote).close === "string") {
      parsed = { [(parsed as TwelveDataQuote).symbol]: parsed as TwelveDataQuote };
    }

    const batch = parsed as TwelveDataBatchResponse;
    const rebasedValues: number[] = [];
    let latestDate = "";

    for (const c of CONSTITUENTS) {
      const quote = batch[c.symbol];
      if (!quote || isErrorResponse(quote)) {
        console.warn(`${SOURCE_ID}: no data for ${c.symbol}${quote ? ` (${(quote as TwelveDataError).message})` : ""}`);
        continue;
      }
      const close = Number(quote.close);
      if (!Number.isFinite(close) || close <= 0) {
        console.warn(`${SOURCE_ID}: invalid close for ${c.symbol}: ${quote.close}`);
        continue;
      }
      rebasedValues.push((close / c.rebase2019) * 100);
      if (quote.datetime > latestDate) latestDate = quote.datetime;
    }

    if (rebasedValues.length < MIN_CONSTITUENTS) {
      console.warn(`${SOURCE_ID}: only ${rebasedValues.length}/${CONSTITUENTS.length} constituents resolved, falling back to fixture`);
      return fetchFromFixture();
    }

    const composite = rebasedValues.reduce((a, b) => a + b, 0) / rebasedValues.length;
    const observedAt = latestDate.includes("T") ? latestDate : `${latestDate}T16:30:00Z`;
    const payloadHash = await sha256Hex(body);

    const observations: RawObservation[] = [{
      indicatorId: "housebuilder_idx",
      value: Math.round(composite * 10) / 10,
      observedAt,
      sourceId: SOURCE_ID,
      payloadHash,
    }];

    return {
      observations,
      sourceUrl: `https://api.twelvedata.com/quote?symbol=${symbols}&exchange=LSE`,
      fetchedAt: new Date().toISOString(),
    };
  },
};

registerAdapter(twelveDataHousebuildersAdapter);
