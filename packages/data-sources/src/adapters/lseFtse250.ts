/**
 * FTSE 250 index-level adapter.
 *
 * Live path, in order:
 *   1. EODHD end-of-day API for ticker `FTMC.INDX` (requires EODHD_API_KEY).
 *      The previous `FTMC.LSE` symbol began returning HTTP 402 on ~2026-07-02
 *      (plan/coverage change). `.INDX` 402s too once the free tier's 20
 *      req/day is exhausted — the 5-minute market cron burns that quota in
 *      the first ~100 minutes of a session, which is why this source sat in
 *      `failure` from 2026-07-24 (fixture freshness trip) until the Yahoo
 *      fallback landed.
 *   2. Yahoo Finance v8 chart for `^FTMC` — the same free proxy the
 *      historical back-series uses. No API key, no daily quota. Tried only
 *      after EODHD fails so a missing key (dev/tests) still uses the fixture.
 *   3. Editorial fixture, 14-day freshness guard. A stale-fixture throw
 *      carries both live-path failure reasons in the audit error.
 *
 * Yahoo prints can drift ~1% from the LSEG closing-auction print; the
 * historical file documents that. For a source that has been dark for a
 * month, a ~1% proxy beats a rotting number and a 6-hourly page.
 *
 * Both live legs skip the current London session until 16:35 Europe/London.
 * EODHD and Yahoo both emit an in-progress daily bar from the open; taking
 * `candles[0]` during market hours stamped today's incomplete print as the
 * 16:30 close (prod 2026-09-01 11:35 UTC wrote 24477 against the 28 Aug
 * close of 24938.8).
 */
import fixture from "../fixtures/ftse-250.json" with { type: "json" };
import history from "../fixtures/ftse-250-history.json" with { type: "json" };
import type {
  AdapterContext,
  AdapterResult,
  DataSourceAdapter,
  HistoricalFetchResult,
  RawObservation,
} from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError, fetchOrThrow } from "../lib/errors.js";
import { historicalPayloadHash, sha256Hex } from "../lib/hash.js";
import { assertFixtureFresh } from "../lib/fixtureFreshness.js";
import { buildHistoricalResult, rangeUtcBounds } from "../lib/historical.js";

const SOURCE_ID = "lseg";
const FIXTURE_URL = "local:fixtures/ftse-250.json";
const HISTORY_FIXTURE_URL = "local:fixtures/ftse-250-history.json";
const EODHD_API_BASE = "https://eodhd.com/api/eod";
const EODHD_TICKER = "FTMC.INDX"; // .LSE alias 402s since ~2026-07-02 (plan gating)
const YAHOO_CHART_URL =
  "https://query1.finance.yahoo.com/v8/finance/chart/%5EFTMC?interval=1d&range=10d";
const MAX_FIXTURE_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days, fallback only

interface Ftse250Fixture {
  observed_at: string;
  ftse_250: { value: number; unit: string };
  source_url: string;
}

interface Ftse250HistoryPoint {
  observed_at: string;
  value: number;
}

interface Ftse250HistoryFixture {
  points: readonly Ftse250HistoryPoint[];
}

interface EodhdCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjusted_close: number;
  volume: number;
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
  };
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const LONDON_TZ = "Europe/London";
/** Auction print is ~16:30; wait five minutes so the daily bar is complete. */
const LONDON_CLOSE_MINUTES = 16 * 60 + 35;

function londonYmd(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: LONDON_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function londonMinutesPastMidnight(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/** True once `dateYmd` is a finished London cash-equity session. */
function isCompletedLondonSession(dateYmd: string, now: Date = new Date()): boolean {
  const today = londonYmd(now);
  if (dateYmd < today) return true;
  if (dateYmd > today) return false;
  return londonMinutesPastMidnight(now) >= LONDON_CLOSE_MINUTES;
}

function sessionYmdFromUnix(tsSec: number): string {
  return londonYmd(new Date(tsSec * 1000));
}

async function fetchFromEodhd(
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
  now: Date = new Date(),
): Promise<{ observation: RawObservation } | { reason: string }> {
  const from = new Date(now.getTime() - 7 * 86_400_000);
  const url = `${EODHD_API_BASE}/${EODHD_TICKER}?api_token=${apiKey}&fmt=json&from=${formatDate(from)}&to=${formatDate(now)}&order=d`;
  let res: Response;
  try {
    res = await fetchOrThrow(fetchImpl, SOURCE_ID, url);
  } catch (err) {
    const reason = `EODHD fetch failed for ${EODHD_TICKER} -- ${(err as Error)?.message ?? String(err)}`;
    console.warn(`${SOURCE_ID}: ${reason}`);
    return { reason };
  }
  let candles: EodhdCandle[];
  try {
    candles = (await res.json()) as EodhdCandle[];
  } catch {
    console.warn(`${SOURCE_ID}: invalid JSON for ${EODHD_TICKER}`);
    return { reason: `invalid JSON for ${EODHD_TICKER}` };
  }
  if (!Array.isArray(candles) || candles.length === 0) {
    console.warn(`${SOURCE_ID}: no EODHD candles for ${EODHD_TICKER}`);
    return { reason: `no EODHD candles for ${EODHD_TICKER}` };
  }
  const latest = candles.find((c) => {
    const ymd = (c.date ?? "").slice(0, 10);
    return ymd.length === 10 && isCompletedLondonSession(ymd, now)
      && Number.isFinite(c.close) && c.close > 0;
  });
  if (!latest) {
    console.warn(`${SOURCE_ID}: no completed EODHD session in window`);
    return { reason: `no completed EODHD session in window for ${EODHD_TICKER}` };
  }
  const close = latest.close;
  const day = latest.date.slice(0, 10);
  const observedAt = latest.date.includes("T") ? latest.date : `${day}T16:30:00Z`;
  const payloadHash = await sha256Hex(`${EODHD_TICKER}:${latest.date}:${close}`);
  return {
    observation: {
      indicatorId: "ftse_250",
      value: Math.round(close * 10) / 10,
      observedAt,
      sourceId: SOURCE_ID,
      payloadHash,
    },
  };
}

async function fetchFromYahoo(
  fetchImpl: typeof globalThis.fetch,
  now: Date = new Date(),
): Promise<{ observation: RawObservation } | { reason: string }> {
  let res: Response;
  try {
    res = await fetchOrThrow(fetchImpl, SOURCE_ID, YAHOO_CHART_URL);
  } catch (err) {
    const reason = `Yahoo fetch failed for ^FTMC -- ${(err as Error)?.message ?? String(err)}`;
    console.warn(`${SOURCE_ID}: ${reason}`);
    return { reason };
  }
  let body: YahooChartResponse;
  try {
    body = (await res.json()) as YahooChartResponse;
  } catch {
    console.warn(`${SOURCE_ID}: invalid JSON from Yahoo ^FTMC`);
    return { reason: "invalid JSON from Yahoo ^FTMC" };
  }
  const result = body.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(timestamps) || !Array.isArray(closes) || timestamps.length === 0) {
    console.warn(`${SOURCE_ID}: Yahoo ^FTMC chart missing timestamp/close arrays`);
    return { reason: "Yahoo ^FTMC chart missing timestamp/close arrays" };
  }
  let close: number | null = null;
  let ts: number | null = null;
  for (let i = closes.length - 1; i >= 0; i--) {
    const c = closes[i];
    const stamp = timestamps[i];
    if (typeof c !== "number" || !Number.isFinite(c) || c <= 0) continue;
    if (typeof stamp !== "number" || !Number.isFinite(stamp)) continue;
    if (!isCompletedLondonSession(sessionYmdFromUnix(stamp), now)) continue;
    close = c;
    ts = stamp;
    break;
  }
  if (close === null || ts === null) {
    console.warn(`${SOURCE_ID}: no usable completed Yahoo ^FTMC close`);
    return { reason: "no usable completed Yahoo ^FTMC close" };
  }
  const day = sessionYmdFromUnix(ts);
  const observedAt = `${day}T16:30:00Z`;
  const payloadHash = await sha256Hex(`yahoo:^FTMC:${day}:${close}`);
  return {
    observation: {
      indicatorId: "ftse_250",
      value: Math.round(close * 10) / 10,
      observedAt,
      sourceId: SOURCE_ID,
      payloadHash,
    },
  };
}

async function fixtureObservation(): Promise<{ observation: RawObservation; sourceUrl: string }> {
  const data = fixture as unknown as Ftse250Fixture;
  if (!data || typeof data.ftse_250?.value !== "number" || !Number.isFinite(data.ftse_250.value)) {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: FIXTURE_URL,
      message: "ftse_250 fixture missing numeric value",
    });
  }
  // Fallback only: tripping the freshness guard here means EODHD, Yahoo,
  // AND the editorial fixture have all rotted. That's a legitimate alert
  // — surface it rather than serve a stale number.
  assertFixtureFresh(data.observed_at, MAX_FIXTURE_AGE_MS, SOURCE_ID, FIXTURE_URL);
  const hash = await sha256Hex(JSON.stringify(data));
  return {
    observation: {
      indicatorId: "ftse_250",
      value: data.ftse_250.value,
      observedAt: data.observed_at,
      sourceId: SOURCE_ID,
      payloadHash: hash,
    },
    sourceUrl: data.source_url ?? FIXTURE_URL,
  };
}

export const lseFtse250Adapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "LSEG FTSE 250 -- EODHD FTMC.INDX / Yahoo ^FTMC (fixture fallback)",
  async fetch(fetchImpl, ctx?: AdapterContext): Promise<AdapterResult> {
    const apiKey = ctx?.secrets?.EODHD_API_KEY;
    const reasons: string[] = [];
    if (apiKey) {
      const live = await fetchFromEodhd(fetchImpl, apiKey);
      if ("observation" in live) {
        return {
          observations: [live.observation],
          sourceUrl: `${EODHD_API_BASE}/${EODHD_TICKER}`,
          fetchedAt: new Date().toISOString(),
        };
      }
      reasons.push(live.reason);
      console.warn(`${SOURCE_ID}: EODHD live path failed (${live.reason}), trying Yahoo ^FTMC`);
      const yahoo = await fetchFromYahoo(fetchImpl);
      if ("observation" in yahoo) {
        return {
          observations: [yahoo.observation],
          sourceUrl: "https://query1.finance.yahoo.com/v8/finance/chart/%5EFTMC",
          fetchedAt: new Date().toISOString(),
        };
      }
      reasons.push(`Yahoo: ${yahoo.reason}`);
      console.warn(`${SOURCE_ID}: Yahoo live path failed (${yahoo.reason}), falling back to fixture`);
    } else {
      reasons.push("no EODHD_API_KEY in context");
    }
    try {
      const { observation, sourceUrl } = await fixtureObservation();
      return {
        observations: [observation],
        sourceUrl,
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      // Surface the live-path root cause in the audit row: "fixture is stale"
      // alone says nothing about WHY the adapter was on the fixture (the July
      // 2026 case: EODHD started 402ing the symbol, silently, for 11 days).
      if (err instanceof AdapterError) {
        throw new AdapterError({
          sourceId: SOURCE_ID,
          sourceUrl: FIXTURE_URL,
          message: `${err.message}; live path: ${reasons.join("; ")}`,
        });
      }
      throw err;
    }
  },
  // Historical mode reads ftse-250-history.json (Yahoo ^FTMC daily closes
  // 2024-07 → 2026-08). Yahoo's prints can drift ~1% from the LSEG closing-
  // auction print on the most recent days; the live `fetch()` above remains
  // the authority for the head value, so historical rows never overwrite a
  // live row at the same observedAt.
  async fetchHistorical(_fetchImpl, opts): Promise<HistoricalFetchResult> {
    const { fromMs, toMs } = rangeUtcBounds(opts);
    const data = history as unknown as Ftse250HistoryFixture;
    const observations: RawObservation[] = [];
    let skippedOutOfRange = 0;

    for (const point of data.points) {
      const ms = Date.parse(point.observed_at);
      if (!Number.isFinite(ms)) continue;
      if (ms < fromMs || ms > toMs) { skippedOutOfRange++; continue; }
      if (typeof point.value !== "number" || !Number.isFinite(point.value)) continue;
      observations.push({
        indicatorId: "ftse_250",
        value: point.value,
        observedAt: point.observed_at,
        sourceId: SOURCE_ID,
        payloadHash: await historicalPayloadHash("ftse_250", point.observed_at, point.value),
      });
    }

    observations.sort((a, b) =>
      a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0,
    );

    const notes: string[] = [];
    if (skippedOutOfRange > 0) notes.push(`${skippedOutOfRange} days outside requested range`);
    return buildHistoricalResult(observations, HISTORY_FIXTURE_URL, notes);
  },
};

registerAdapter(lseFtse250Adapter);
