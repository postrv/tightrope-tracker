/**
 * LSE UK-housebuilder composite adapter (fixture-backed).
 *
 * UK-listed housebuilders (Persimmon, Barratt Redrow, Taylor Wimpey, Berkeley,
 * Vistry) are a clean OBR-proxy for residential investment and construction
 * GVA. LSE has no free, bulk, daily API reachable from a Cloudflare Worker
 * without an account/API key, so we ship an editorial-maintained fixture that
 * captures an equal-weighted rebased composite of the five names. The fixture
 * is refreshed weekly from the public LSE last-close quotes.
 *
 * The composite methodology: for each constituent, rebase the closing price to
 * 100 at the 2019 mean, then take the simple average across all five.
 *
 * TODO(source): https://www.londonstockexchange.com -- replace with a direct
 * intraday feed once a licensed vendor with a free tier and Worker-safe JSON
 * endpoint is identified (Alpha Vantage, FCS API, etc.).
 */
import fixture from "../fixtures/housebuilders.json" with { type: "json" };
import type { AdapterResult, DataSourceAdapter } from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";

const SOURCE_ID = "lseg_housebuilders";
const FIXTURE_URL = "local:fixtures/housebuilders.json";

interface HousebuilderFixture {
  observed_at: string;
  housebuilder_idx: { value: number; unit: string };
  source_url: string;
}

export const lseHousebuildersAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "LSE UK housebuilder composite (fixture-backed)",
  async fetch(_fetchImpl): Promise<AdapterResult> {
    const data = fixture as unknown as HousebuilderFixture;
    if (!data || typeof data.housebuilder_idx?.value !== "number") {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: FIXTURE_URL,
        message: "Housebuilders: fixture missing housebuilder_idx.value",
      });
    }
    const hash = await sha256Hex(JSON.stringify(data));
    return {
      observations: [{
        indicatorId: "housebuilder_idx",
        value: data.housebuilder_idx.value,
        observedAt: data.observed_at,
        sourceId: SOURCE_ID,
        payloadHash: hash,
      }],
      sourceUrl: data.source_url ?? FIXTURE_URL,
      fetchedAt: new Date().toISOString(),
    };
  },
};

registerAdapter(lseHousebuildersAdapter);
