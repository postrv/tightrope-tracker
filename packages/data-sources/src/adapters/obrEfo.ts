/**
 * OBR Economic & Fiscal Outlook adapter (fixture-backed).
 *
 * The OBR publishes the EFO as a set of PDFs and XLSX attachments. There is
 * no stable CSV-over-HTTP endpoint, so this adapter is entirely fixture-
 * driven: the editorial pipeline refreshes `src/fixtures/obr-efo.json` after
 * every OBR publication (twice yearly plus any in-year update). Nothing on
 * this code path hits the network.
 *
 * If/when OBR publishes a machine-readable feed the adapter should grow a
 * live branch, but it has never had one -- earlier versions of this file
 * claimed an env-driven `OBR_EFO_CSV_URL` path that was not implemented.
 */
import fixture from "../fixtures/obr-efo.json" with { type: "json" };
import type { AdapterResult, DataSourceAdapter, RawObservation } from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";

const SOURCE_ID = "obr_efo";
const FIXTURE_URL = "local:fixtures/obr-efo.json";

interface ObrFixture {
  observed_at: string;
  source_url: string;
  indicators: Record<string, { value: number; unit: string }>;
}

export const obrEfoAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "OBR Economic & Fiscal Outlook (fixture-backed)",
  async fetch(): Promise<AdapterResult> {
    const data = fixture as unknown as ObrFixture;
    if (!data || typeof data !== "object" || !data.indicators) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: FIXTURE_URL,
        message: "OBR EFO: fixture malformed -- missing indicators",
      });
    }
    const payloadHash = await sha256Hex(JSON.stringify(data));
    const observedAt = data.observed_at;
    const observations: RawObservation[] = [];
    for (const [indicatorId, meta] of Object.entries(data.indicators)) {
      if (typeof meta.value !== "number" || !Number.isFinite(meta.value)) continue;
      observations.push({
        indicatorId,
        value: meta.value,
        observedAt,
        sourceId: SOURCE_ID,
        payloadHash,
      });
    }
    if (observations.length === 0) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: FIXTURE_URL,
        message: "OBR EFO: fixture yielded zero observations",
      });
    }
    return {
      observations,
      sourceUrl: data.source_url ?? FIXTURE_URL,
      fetchedAt: new Date().toISOString(),
    };
  },
};

registerAdapter(obrEfoAdapter);
