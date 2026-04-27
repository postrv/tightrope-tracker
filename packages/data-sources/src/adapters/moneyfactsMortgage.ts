/**
 * Moneyfacts average 2-year fixed mortgage rate (75% LTV).
 *
 * Moneyfacts publish monthly averages as press releases; there is no free API
 * and the data is behind a paywall for bulk access. We therefore ship a
 * hand-curated fixture updated on each monthly release.
 *
 * TODO(source): https://moneyfacts.co.uk -- replace with a scraped/paid feed
 * when one is available.
 */
import fixture from "../fixtures/mortgage.json" with { type: "json" };
import history from "../fixtures/mortgage-history.json" with { type: "json" };
import type {
  AdapterResult,
  DataSourceAdapter,
  HistoricalFetchResult,
  RawObservation,
} from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError } from "../lib/errors.js";
import { historicalPayloadHash, sha256Hex } from "../lib/hash.js";
import { assertFixtureFresh } from "../lib/fixtureFreshness.js";
import { buildHistoricalResult, rangeUtcBounds } from "../lib/historical.js";

const SOURCE_ID = "moneyfacts";
const FIXTURE_URL = "local:fixtures/mortgage.json";
const HISTORY_FIXTURE_URL = "local:fixtures/mortgage-history.json";
// Moneyfacts publishes monthly press releases. 45 days = monthly cadence
// (~30) + 15 days slack — averages can be published a fortnight after
// month-end. Past that window a forgotten refresh is genuinely stale.
const MAX_FIXTURE_AGE_MS = 45 * 24 * 60 * 60 * 1000;

interface MortgageFixture {
  observed_at: string;
  mortgage_2y_fix: { value: number };
  source_url: string;
}

interface MortgageHistoryPoint {
  observed_at: string;
  value: number;
}

interface MortgageHistoryFixture {
  points: readonly MortgageHistoryPoint[];
}

export const moneyfactsMortgageAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "Moneyfacts -- 2y fix average (fixture-backed)",
  async fetch(_fetchImpl): Promise<AdapterResult> {
    const data = fixture as unknown as MortgageFixture;
    if (!data || typeof data.mortgage_2y_fix?.value !== "number") {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: FIXTURE_URL,
        message: "Moneyfacts: fixture missing mortgage_2y_fix.value",
      });
    }
    // Trip loudly on a stale fixture — every five-minute cron would
    // otherwise silently re-emit last month's average rate.
    assertFixtureFresh(data.observed_at, MAX_FIXTURE_AGE_MS, SOURCE_ID, FIXTURE_URL);
    const hash = await sha256Hex(JSON.stringify(data));
    return {
      observations: [{
        indicatorId: "mortgage_2y_fix",
        value: data.mortgage_2y_fix.value,
        observedAt: data.observed_at,
        sourceId: SOURCE_ID,
        payloadHash: hash,
      }],
      sourceUrl: data.source_url ?? FIXTURE_URL,
      fetchedAt: new Date().toISOString(),
    };
  },
  // Historical mode reads mortgage-history.json (Moneyfacts overall all-LTV
  // 2y fix monthly figures sourced from Mortgage Finance Gazette dated
  // permalinks, 2024-07 → 2026-04). Each entry is the beginning-of-month
  // figure quoted by Moneyfacts.
  async fetchHistorical(_fetchImpl, opts): Promise<HistoricalFetchResult> {
    const { fromMs, toMs } = rangeUtcBounds(opts);
    const data = history as unknown as MortgageHistoryFixture;
    const observations: RawObservation[] = [];
    let skippedOutOfRange = 0;

    for (const point of data.points) {
      const ms = Date.parse(point.observed_at);
      if (!Number.isFinite(ms)) continue;
      if (ms < fromMs || ms > toMs) { skippedOutOfRange++; continue; }
      if (typeof point.value !== "number" || !Number.isFinite(point.value)) continue;
      observations.push({
        indicatorId: "mortgage_2y_fix",
        value: point.value,
        observedAt: point.observed_at,
        sourceId: SOURCE_ID,
        payloadHash: await historicalPayloadHash("mortgage_2y_fix", point.observed_at, point.value),
      });
    }

    observations.sort((a, b) =>
      a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0,
    );

    const notes: string[] = [];
    if (skippedOutOfRange > 0) notes.push(`${skippedOutOfRange} months outside requested range`);
    return buildHistoricalResult(observations, HISTORY_FIXTURE_URL, notes);
  },
};

registerAdapter(moneyfactsMortgageAdapter);
