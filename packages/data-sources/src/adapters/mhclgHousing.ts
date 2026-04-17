/**
 * MHCLG / DLUHC housing statistics adapter.
 *
 * MHCLG releases are XLSX/ODS attachments behind gov.uk collection pages --
 * no stable CSV-over-HTTP endpoint. We therefore ship a hand-curated fixture,
 * updated on each bulletin.
 *
 * TODO(source):
 *   - https://www.gov.uk/government/statistics/housing-supply-net-additional-dwellings-england
 *   - https://www.gov.uk/government/statistical-data-sets/live-tables-on-planning-application-statistics
 */
import fixture from "../fixtures/housing.json" with { type: "json" };
import type { AdapterResult, DataSourceAdapter, RawObservation } from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";

const SOURCE_ID = "mhclg";
const FIXTURE_URL = "local:fixtures/housing.json";

interface HousingFixture {
  observed_at: string;
  housing_trajectory: { value: number };
  planning_consents: { value: number };
  source_url: string;
}

export const mhclgHousingAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "MHCLG housing statistics (fixture-backed)",
  async fetch(_fetchImpl): Promise<AdapterResult> {
    const data = fixture as unknown as HousingFixture;
    if (!data) {
      throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: FIXTURE_URL, message: "MHCLG: fixture missing" });
    }
    const hash = await sha256Hex(JSON.stringify(data));
    const observations: RawObservation[] = [];
    if (typeof data.housing_trajectory?.value === "number") {
      observations.push({
        indicatorId: "housing_trajectory",
        value: data.housing_trajectory.value,
        observedAt: data.observed_at,
        sourceId: SOURCE_ID,
        payloadHash: hash,
      });
    }
    if (typeof data.planning_consents?.value === "number") {
      observations.push({
        indicatorId: "planning_consents",
        value: data.planning_consents.value,
        observedAt: data.observed_at,
        sourceId: SOURCE_ID,
        payloadHash: hash,
      });
    }
    if (observations.length === 0) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: FIXTURE_URL,
        message: "MHCLG: fixture yielded zero observations",
      });
    }
    return { observations, sourceUrl: data.source_url ?? FIXTURE_URL, fetchedAt: new Date().toISOString() };
  },
};

registerAdapter(mhclgHousingAdapter);
