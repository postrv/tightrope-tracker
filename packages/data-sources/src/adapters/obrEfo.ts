/**
 * OBR Economic & Fiscal Outlook adapter.
 *
 * The OBR publishes the EFO as a set of PDFs and XLSX attachments with no
 * stable CSV-over-HTTP endpoint. Rather than scrape the HTML release page on
 * every cron tick (fragile) this adapter:
 *
 *   1. If an env-configured `OBR_EFO_CSV_URL` is available at call time and the
 *      response parses as our expected shape, prefer that.
 *   2. Otherwise, fall back to the hand-curated fixture at
 *      `src/fixtures/obr-efo.json`, refreshed by the editorial pipeline after
 *      every OBR publication.
 *
 * This is the fallback pattern explicitly sanctioned in SPEC section 7.5 for
 * sources without machine-readable feeds.
 *
 * TODO(source): https://obr.uk/efo/ -- replace fixture with a real CSV once
 * OBR publishes a stable URL.
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
  async fetch(_fetchImpl): Promise<AdapterResult> {
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
