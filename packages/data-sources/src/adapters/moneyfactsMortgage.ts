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
import type { AdapterResult, DataSourceAdapter } from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";

const SOURCE_ID = "moneyfacts";
const FIXTURE_URL = "local:fixtures/mortgage.json";

interface MortgageFixture {
  observed_at: string;
  mortgage_2y_fix: { value: number };
  source_url: string;
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
};

registerAdapter(moneyfactsMortgageAdapter);
