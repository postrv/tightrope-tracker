/**
 * Growth-sentiment fixture adapter.
 *
 * Three monthly headline prints that are OBR-proxy indicators for the growth
 * side of the EFO (Services GVA, household consumption, residential
 * investment):
 *
 *   services_pmi         -- S&P Global / CIPS UK Services PMI headline
 *   consumer_confidence  -- GfK / NIESR Consumer Confidence Barometer headline
 *   rics_price_balance   -- RICS UK Residential Market Survey price balance
 *
 * Each source is licensed to its publisher; their full back-sets are behind a
 * paywall. We mirror only the monthly headline figures from each publisher's
 * press release, which is a lawful fair-dealing summary. The fixture is
 * refreshed manually when a release drops (S&P Global publishes Flash PMI near
 * the 3rd working day of the following month; GfK/NIESR publishes last Friday;
 * RICS publishes mid-month).
 *
 * Each observation carries its own sourceId so the UI can attribute cleanly.
 *
 * TODO(source):
 *   - https://www.pmi.spglobal.com/Public/Home/PressRelease
 *   - https://www.niesr.ac.uk/our-work/consumer-confidence
 *   - https://www.rics.org/news-insights/market-surveys/uk-residential-market-survey
 */
import fixture from "../fixtures/growth-sentiment.json" with { type: "json" };
import type { AdapterResult, DataSourceAdapter, RawObservation } from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";
import { assertFixtureFresh } from "../lib/fixtureFreshness.js";

const ADAPTER_ID = "growth_sentiment";
const FIXTURE_URL = "local:fixtures/growth-sentiment.json";
// PMI / GfK CC / RICS RMS publish monthly with reference period at end
// of month and release date typically within the first week of the
// following month. 40 days = monthly cadence (~30) + a 10-day grace
// for slipped press releases before we want a loud audit failure.
const MAX_FIXTURE_AGE_MS = 40 * 24 * 60 * 60 * 1000;

interface GrowthSentimentFixture {
  observed_at: string;
  services_pmi?:        { value: number };
  consumer_confidence?: { value: number };
  rics_price_balance?:  { value: number };
  source_url: string;
}

const BINDINGS: ReadonlyArray<{ indicatorId: string; fixtureKey: keyof GrowthSentimentFixture; sourceId: string }> = [
  { indicatorId: "services_pmi",        fixtureKey: "services_pmi",        sourceId: "sp_global_pmi" },
  { indicatorId: "consumer_confidence", fixtureKey: "consumer_confidence", sourceId: "gfk_confidence" },
  { indicatorId: "rics_price_balance",  fixtureKey: "rics_price_balance",  sourceId: "rics_rms" },
];

export const growthSentimentAdapter: DataSourceAdapter = {
  id: ADAPTER_ID,
  name: "UK growth sentiment: Services PMI, GfK, RICS (fixture-backed)",
  async fetch(_fetchImpl): Promise<AdapterResult> {
    const data = fixture as unknown as GrowthSentimentFixture;
    if (!data || typeof data !== "object") {
      throw new AdapterError({
        sourceId: ADAPTER_ID,
        sourceUrl: FIXTURE_URL,
        message: "growth sentiment: fixture malformed",
      });
    }
    // Trip loudly on a forgotten editorial refresh rather than re-emit
    // last month's headline indefinitely.
    assertFixtureFresh(data.observed_at, MAX_FIXTURE_AGE_MS, ADAPTER_ID, FIXTURE_URL);
    const hash = await sha256Hex(JSON.stringify(data));
    const observations: RawObservation[] = [];
    for (const b of BINDINGS) {
      const slot = data[b.fixtureKey] as { value?: number } | undefined;
      const v = slot?.value;
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      observations.push({
        indicatorId: b.indicatorId,
        value: v,
        observedAt: data.observed_at,
        sourceId: b.sourceId,
        payloadHash: hash,
      });
    }
    if (observations.length === 0) {
      throw new AdapterError({
        sourceId: ADAPTER_ID,
        sourceUrl: FIXTURE_URL,
        message: "growth sentiment: fixture yielded zero observations",
      });
    }
    return {
      observations,
      sourceUrl: data.source_url ?? FIXTURE_URL,
      fetchedAt: new Date().toISOString(),
    };
  },
};

registerAdapter(growthSentimentAdapter);
