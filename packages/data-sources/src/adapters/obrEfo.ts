/**
 * OBR Economic & Fiscal Outlook adapter (fixture-backed).
 *
 * The OBR publishes the EFO as a set of PDFs and XLSX attachments. There is
 * no stable CSV-over-HTTP endpoint, so this adapter is entirely fixture-
 * driven: the editorial pipeline refreshes `src/fixtures/obr-efo.json` after
 * every OBR publication (twice yearly plus any in-year update). Nothing on
 * this code path hits the network.
 *
 * Fixture schema accepts two shapes:
 *
 *   1. `{ vintages: [...] }` (current). One entry per OBR publication. The
 *      newest entry (head of the sorted-desc list) drives `fetch()`; the
 *      full list drives `fetchHistorical()` so backfilled days carry the
 *      correct headroom / psnfl values until the next vintage.
 *   2. `{ observed_at, indicators }` (legacy single-vintage object).
 *      Preserved so an older fixture in a worktree won't crash the live
 *      pipeline. Treated as a one-element vintages array.
 *
 * If/when OBR publishes a machine-readable feed the adapter should grow a
 * live branch, but it has never had one — earlier versions of this file
 * claimed an env-driven `OBR_EFO_CSV_URL` path that was not implemented.
 */
import fixture from "../fixtures/obr-efo.json" with { type: "json" };
import { INDICATORS } from "@tightrope/shared";
import type {
  AdapterResult,
  DataSourceAdapter,
  HistoricalFetchOptions,
  HistoricalFetchResult,
  RawObservation,
} from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";

const SOURCE_ID = "obr_efo";
const FIXTURE_URL = "local:fixtures/obr-efo.json";

export interface ObrVintage {
  observed_at: string;
  source_url?: string;
  label?: string;
  indicators: Record<string, { value: number; unit: string }>;
}

export interface ObrFixture {
  /** New schema. */
  vintages?: ObrVintage[];
  /** Legacy single-vintage shape. */
  observed_at?: string;
  source_url?: string;
  indicators?: Record<string, { value: number; unit: string }>;
}

interface IndicatorCatalog {
  [id: string]: { pillar: string };
}

/**
 * Normalise either fixture shape into a sorted-desc list of vintages. Throws
 * `AdapterError` if no vintage information is present at all.
 */
export function normaliseVintages(data: ObrFixture): ObrVintage[] {
  let list: ObrVintage[];
  if (Array.isArray(data?.vintages)) {
    list = [...data.vintages];
  } else if (data?.indicators && data?.observed_at) {
    const legacy: ObrVintage = {
      observed_at: data.observed_at,
      indicators: data.indicators,
    };
    if (data.source_url !== undefined) legacy.source_url = data.source_url;
    list = [legacy];
  } else {
    list = [];
  }
  if (list.length === 0) {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: FIXTURE_URL,
      message: "OBR EFO: fixture malformed — no vintages",
    });
  }
  return list.sort((a, b) => b.observed_at.localeCompare(a.observed_at));
}

async function vintageToObservations(
  vintage: ObrVintage,
  catalog: IndicatorCatalog,
  payloadPrefix: string,
): Promise<RawObservation[]> {
  if (!vintage || typeof vintage !== "object" || !vintage.indicators) {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: FIXTURE_URL,
      message: "OBR EFO: vintage malformed — missing indicators",
    });
  }
  if (typeof vintage.observed_at !== "string" || !vintage.observed_at) {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: FIXTURE_URL,
      message: "OBR EFO: vintage missing observed_at",
    });
  }
  const payloadHashCore = await sha256Hex(JSON.stringify(vintage));
  const payloadHash = payloadPrefix ? `${payloadPrefix}${payloadHashCore}` : payloadHashCore;
  const out: RawObservation[] = [];
  for (const [indicatorId, meta] of Object.entries(vintage.indicators)) {
    const def = catalog[indicatorId];
    if (!def) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: FIXTURE_URL,
        message: `OBR EFO: unknown indicator id '${indicatorId}' — not in INDICATORS catalog`,
      });
    }
    if (def.pillar !== "fiscal") {
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
    out.push({
      indicatorId,
      value: meta.value,
      observedAt: vintage.observed_at,
      sourceId: SOURCE_ID,
      payloadHash,
      releasedAt: vintage.observed_at,
    });
  }
  return out;
}

/**
 * Parse an already-read OBR fixture object into an `AdapterResult`. The
 * `fetch()` path uses the most-recent vintage so the live pipeline always
 * tracks the latest published headroom.
 */
export async function parseObrEfoFixture(
  data: ObrFixture,
  catalog: IndicatorCatalog = INDICATORS,
): Promise<AdapterResult> {
  const vintages = normaliseVintages(data);
  const head = vintages[0]!;
  const observations = await vintageToObservations(head, catalog, "");
  if (observations.length === 0) {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: FIXTURE_URL,
      message: "OBR EFO: vintage yielded zero observations",
    });
  }
  return {
    observations,
    sourceUrl: head.source_url ?? FIXTURE_URL,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Emit one observation per vintage that falls in `[from, to]` (inclusive).
 * Vintages outside the range are silently skipped.
 */
export async function parseObrEfoHistorical(
  data: ObrFixture,
  opts: HistoricalFetchOptions,
  catalog: IndicatorCatalog = INDICATORS,
): Promise<HistoricalFetchResult> {
  const vintages = normaliseVintages(data);
  const fromMs = opts.from.getTime();
  const toMs = opts.to.getTime();
  const observations: RawObservation[] = [];
  const notes: string[] = [];
  let earliest: string | null = null;
  let latest: string | null = null;
  // Process oldest → newest so observations end up in chronological order.
  for (const vintage of [...vintages].reverse()) {
    const ms = new Date(vintage.observed_at).getTime();
    if (Number.isNaN(ms)) {
      notes.push(`vintage with malformed observed_at skipped: ${vintage.observed_at}`);
      continue;
    }
    if (ms < fromMs || ms > toMs) continue;
    const obs = await vintageToObservations(vintage, catalog, "hist:");
    observations.push(...obs);
    if (!earliest || vintage.observed_at < earliest) earliest = vintage.observed_at;
    if (!latest || vintage.observed_at > latest) latest = vintage.observed_at;
  }
  return {
    observations,
    sourceUrl: vintages[0]?.source_url ?? FIXTURE_URL,
    fetchedAt: new Date().toISOString(),
    earliestObservedAt: earliest,
    latestObservedAt: latest,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

export const obrEfoAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "OBR Economic & Fiscal Outlook (fixture-backed)",
  async fetch(): Promise<AdapterResult> {
    return parseObrEfoFixture(fixture as unknown as ObrFixture);
  },
  async fetchHistorical(
    _fetchImpl: typeof globalThis.fetch,
    opts: HistoricalFetchOptions,
  ): Promise<HistoricalFetchResult> {
    return parseObrEfoHistorical(fixture as unknown as ObrFixture, opts);
  },
};

registerAdapter(obrEfoAdapter);
