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
import { INDICATORS } from "@tightrope/shared";
import type { AdapterResult, DataSourceAdapter, RawObservation } from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";

const SOURCE_ID = "obr_efo";
const FIXTURE_URL = "local:fixtures/obr-efo.json";

export interface ObrFixture {
  observed_at: string;
  source_url?: string;
  indicators: Record<string, { value: number; unit: string }>;
}

/**
 * Parse an already-read OBR fixture object into `AdapterResult`. Split out
 * from `obrEfoAdapter.fetch()` so a Red→Green test can exercise the
 * validation branches (malformed fixture, unknown indicator id, wrong-
 * pillar indicator, non-finite value) without having to patch the static
 * JSON import.
 *
 * `catalog` defaults to the production `INDICATORS` catalog; tests inject
 * a minimal map.
 */
export async function parseObrEfoFixture(
  data: ObrFixture,
  catalog: { [id: string]: { pillar: string } } = INDICATORS,
): Promise<AdapterResult> {
  if (!data || typeof data !== "object" || !data.indicators) {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: FIXTURE_URL,
      message: "OBR EFO: fixture malformed -- missing indicators",
    });
  }
  if (typeof data.observed_at !== "string" || !data.observed_at) {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: FIXTURE_URL,
      message: "OBR EFO: fixture missing observed_at",
    });
  }
  const payloadHash = await sha256Hex(JSON.stringify(data));
  const observedAt = data.observed_at;
  const observations: RawObservation[] = [];
  for (const [indicatorId, meta] of Object.entries(data.indicators)) {
    const def = catalog[indicatorId];
    if (!def) {
      // A typo'd indicator id would otherwise silently produce a stored
      // observation that no downstream consumer recognises. Fail loud so
      // the audit row records a failure and the operator fixes it.
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: FIXTURE_URL,
        message: `OBR EFO: unknown indicator id '${indicatorId}' — not in INDICATORS catalog`,
      });
    }
    if (def.pillar !== "fiscal") {
      // OBR EFO figures feed the fiscal pillar. A non-fiscal indicator
      // in this fixture is almost certainly a copy-paste mistake.
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: FIXTURE_URL,
        message: `OBR EFO: indicator '${indicatorId}' is on pillar '${def.pillar}', not 'fiscal' — refusing to emit observation`,
      });
    }
    if (!meta || typeof meta.value !== "number" || !Number.isFinite(meta.value)) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: FIXTURE_URL,
        message: `OBR EFO: indicator '${indicatorId}' has non-finite value`,
      });
    }
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
}

export const obrEfoAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "OBR Economic & Fiscal Outlook (fixture-backed)",
  async fetch(): Promise<AdapterResult> {
    return parseObrEfoFixture(fixture as unknown as ObrFixture);
  },
};

registerAdapter(obrEfoAdapter);
