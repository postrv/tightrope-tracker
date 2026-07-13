/**
 * FTSE 250 index-level adapter.
 *
 * Live path: EODHD end-of-day API for ticker `FTMC.INDX` (FTSE 250 mid-cap,
 * EODHD's indices namespace). The previous `FTMC.LSE` symbol began returning
 * HTTP 402 Payment Required on ~2026-07-02 — an EODHD plan/coverage change,
 * not a code fault (LSE equity symbols also degraded: the housebuilders
 * adapter resolves only 2/5 constituents as of 2026-07-12). If `.INDX` also
 * 402s, the EODHD subscription tier is the blocker and the editorial fixture
 * is the operative path until that's resolved.
 * Falls back to the editorial fixture when EODHD_API_KEY is not present
 * (dev, tests, probe scripts) or when the live call fails; a fixture
 * freshness failure carries the live-path failure reason in its audit error.
 *
 * EODHD ships UK index closes ~16:35 London. We pull a 7-day window and
 * take the latest close. The free tier has 20 calls/day; one call per
 * fiscal-pipeline run (02:00 UTC) costs 1 of 20.
 *
 * Historical mode still reads `ftse-250-history.json` (Yahoo ^FTMC daily
 * closes 2024-07 → 2026-04). Yahoo's prints can drift ~1% from the LSEG
 * closing-auction print on the most recent days; the live `fetch()` above
 * remains the authority for the head value, so historical rows never
 * overwrite a live row at the same observedAt.
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

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function fetchFromEodhd(
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
): Promise<{ observation: RawObservation } | { reason: string }> {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86_400_000);
  const url = `${EODHD_API_BASE}/${EODHD_TICKER}?api_token=${apiKey}&fmt=json&from=${formatDate(from)}&to=${formatDate(to)}&order=d`;
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
  const latest = candles[0]!;
  const close = latest.close;
  if (!Number.isFinite(close) || close <= 0) {
    console.warn(`${SOURCE_ID}: invalid close for ${EODHD_TICKER}: ${close}`);
    return { reason: `invalid close for ${EODHD_TICKER}: ${close}` };
  }
  const observedAt = latest.date.includes("T") ? latest.date : `${latest.date}T16:30:00Z`;
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

async function fixtureObservation(): Promise<{ observation: RawObservation; sourceUrl: string }> {
  const data = fixture as unknown as Ftse250Fixture;
  if (!data || typeof data.ftse_250?.value !== "number" || !Number.isFinite(data.ftse_250.value)) {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: FIXTURE_URL,
      message: "ftse_250 fixture missing numeric value",
    });
  }
  // Fallback only: tripping the freshness guard here means BOTH the live
  // EODHD path and the editorial fixture have rotted. That's a legitimate
  // alert — surface it rather than serve a stale number.
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
  name: "LSEG FTSE 250 -- EODHD FTMC.INDX (fixture fallback)",
  async fetch(fetchImpl, ctx?: AdapterContext): Promise<AdapterResult> {
    const apiKey = ctx?.secrets?.EODHD_API_KEY;
    let liveReason = "no EODHD_API_KEY in context";
    if (apiKey) {
      const live = await fetchFromEodhd(fetchImpl, apiKey);
      if ("observation" in live) {
        return {
          observations: [live.observation],
          sourceUrl: `${EODHD_API_BASE}/${EODHD_TICKER}`,
          fetchedAt: new Date().toISOString(),
        };
      }
      liveReason = live.reason;
      console.warn(`${SOURCE_ID}: EODHD live path failed (${liveReason}), falling back to fixture`);
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
          message: `${err.message}; live path: ${liveReason}`,
        });
      }
      throw err;
    }
  },
  // Historical mode reads ftse-250-history.json (Yahoo ^FTMC daily closes
  // 2024-07 → 2026-04). Yahoo's prints can drift ~1% from the LSEG closing-
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
