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
import { AdapterError, fetchOrThrow } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";
import { assertFixtureFresh } from "../lib/fixtureFreshness.js";
import { londonCloseIso } from "../lib/londonClose.js";
import fixture from "../fixtures/housebuilders.json" with { type: "json" };

const SOURCE_ID = "eodhd_housebuilders";
const API_BASE = "https://eodhd.com/api/eod";
const FIXTURE_URL = "local:fixtures/housebuilders.json";
const MAX_FIXTURE_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days, fallback only
// Bound both connection/header latency and the response body. A stalled
// issuer must not leave the daily ingest audit open indefinitely.
const CONSTITUENT_TIMEOUT_MS = 10_000;

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

function fetchFromFixture(fallbackReason: string): AdapterResult {
  const data = fixture as { observed_at: string; housebuilder_idx: { value: number }; source_url: string };
  // Fallback only: tripping the freshness guard here means BOTH the live
  // EODHD path and the editorial fixture have rotted. Surface it as a loud
  // AdapterError rather than silently re-emitting a stale composite on every
  // cron tick. Matches the 14-day guard on the sibling fixture-backed
  // adapters (LSEG FTSE 250, EIA Brent).
  assertFixtureFresh(data.observed_at, MAX_FIXTURE_AGE_MS, SOURCE_ID, FIXTURE_URL);
  return {
    observations: [{
      indicatorId: "housebuilder_idx",
      value: data.housebuilder_idx.value,
      observedAt: data.observed_at,
      sourceId: SOURCE_ID,
      payloadHash: "fixture-fallback",
    }],
    sourceUrl: FIXTURE_URL,
    fetchedAt: new Date().toISOString(),
    fallbackReason: `live retrieval unavailable; serving guarded fixture: ${fallbackReason}`,
  };
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function fetchConstituent(
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
  symbol: string,
  failures: string[],
): Promise<EodhdCandle[]> {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86_400_000);
  const url = `${API_BASE}/${symbol}.LSE?api_token=${apiKey}&fmt=json&from=${formatDate(from)}&to=${formatDate(to)}&order=d`;

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let readingBody = false;
  let candles: EodhdCandle[];
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error("constituent request timed out"));
      }, CONSTITUENT_TIMEOUT_MS);
    });
    candles = await Promise.race([
      (async () => {
        const res = await fetchOrThrow(fetchImpl, SOURCE_ID, url, { signal: controller.signal });
        readingBody = true;
        return await res.json() as EodhdCandle[];
      })(),
      timeout,
    ]);
  } catch (err) {
    const reason = controller.signal.aborted
      ? `request timed out after ${CONSTITUENT_TIMEOUT_MS}ms`
      : readingBody ? "invalid JSON"
        : err instanceof AdapterError && err.status ? `HTTP ${err.status}` : "network fetch failed";
    console.warn(`${SOURCE_ID}: ${symbol}: ${reason}`);
    failures.push(`${symbol}: ${reason}`);
    return [];
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  if (!Array.isArray(candles) || candles.length === 0) {
    console.warn(`${SOURCE_ID}: no candles returned for ${symbol}`);
    failures.push(`${symbol}: no candles returned`);
    return [];
  }

  // Providers can expose today's daily bar before the cash session closes.
  // Keep the whole window so the composite can use a common completed
  // session even when one constituent's latest bar is delayed.
  return candles.filter((candle) => {
    if (!candle || typeof candle.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(candle.date)) return false;
    const dayMs = Date.parse(`${candle.date}T00:00:00Z`);
    if (!Number.isFinite(dayMs) || new Date(dayMs).toISOString().slice(0, 10) !== candle.date) return false;
    const closeMs = Date.parse(londonCloseIso(candle.date));
    // Allow the closing auction five minutes to settle, matching FTSE 250.
    return Number.isFinite(closeMs) && closeMs + 5 * 60_000 <= to.getTime()
      && Number.isFinite(candle.close) && candle.close > 0;
  });
}

export const eodhdHousebuildersAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "EODHD -- UK housebuilder composite (daily EOD, fixture fallback)",
  async fetch(fetchImpl, ctx?: AdapterContext): Promise<AdapterResult> {
    const apiKey = ctx?.secrets?.EODHD_API_KEY;
    if (!apiKey) {
      return fetchFromFixture("no EODHD_API_KEY in context");
    }

    const sessions = new Map<string, Map<string, { close: number; rebased: number }>>();
    const failures: string[] = [];

    for (const c of CONSTITUENTS) {
      const candles = await fetchConstituent(fetchImpl, apiKey, c.symbol, failures);
      for (const candle of candles) {
        const session = sessions.get(candle.date) ?? new Map();
        // One issuer contributes once per session, even if a malformed
        // upstream response repeats a row.
        if (!session.has(c.symbol)) session.set(c.symbol, {
          close: candle.close,
          rebased: (candle.close / c.rebase2019) * 100,
        });
        sessions.set(candle.date, session);
      }
    }

    const latestDate = [...sessions.keys()].sort().reverse()
      .find((date) => sessions.get(date)!.size >= MIN_CONSTITUENTS);
    if (!latestDate) {
      console.warn(`${SOURCE_ID}: fewer than ${MIN_CONSTITUENTS} constituents share a completed session, falling back to fixture`);
      return fetchFromFixture(`fewer than ${MIN_CONSTITUENTS} constituents share a completed session${failures.length ? `; ${failures.join("; ")}` : ""}`);
    }

    const session = sessions.get(latestDate)!;
    const rebasedValues = [...session.values()].map((part) => part.rebased);
    const rawParts = [...session.entries()].map(([symbol, part]) => `${symbol}:${part.close}`);
    const composite = rebasedValues.reduce((a, b) => a + b, 0) / rebasedValues.length;
    const observedAt = londonCloseIso(latestDate);
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
