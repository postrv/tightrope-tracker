/**
 * ONS Public Sector Finances adapter.
 *
 * The legacy v0 endpoint at `api.ons.gov.uk/timeseries/...` was retired; we
 * now resolve each CDID via the beta search API (`onsCommon.ts`) and then
 * fetch the timeseries JSON from www.ons.gov.uk/{uri}/data. The envelope
 * shape (months[]/years[]/quarters[]) is unchanged.
 *
 * Mappings (Public Sector Finances bulletin):
 *   JW2O (ppubsec net borrowing, YTD, GBPm)   -> indicator `borrowing_outturn`
 *   JW2P (central government debt interest,   -> indicator `debt_interest`
 *          rolling 12m, GBPm)
 *
 * TODO(source): confirm CDIDs against the next PSF bulletin -- JW2O/JW2P are
 * the provisional codes pulled from the PSF time-series listing.
 */
import type {
  AdapterResult,
  DataSourceAdapter,
  HistoricalFetchResult,
  RawObservation,
} from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError, fetchOrThrow } from "../lib/errors.js";
import { historicalPayloadHash, sha256Hex } from "../lib/hash.js";
import { resolveOnsDataUrl } from "./onsCommon.js";
import { buildHistoricalResult, rangeUtcBounds } from "../lib/historical.js";

const SOURCE_ID = "ons_psf";

const SERIES: ReadonlyArray<{ indicatorId: string; cdid: string; dataset: string }> = [
  { indicatorId: "borrowing_outturn", cdid: "JW2O", dataset: "PUSF" },
  { indicatorId: "debt_interest",     cdid: "JW2P", dataset: "PUSF" },
];

export const onsPsfAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "ONS Public Sector Finances",
  async fetch(fetchImpl): Promise<AdapterResult> {
    const observations: RawObservation[] = [];
    let representativeUrl = "";

    for (const { indicatorId, cdid, dataset } of SERIES) {
      const url = await resolveOnsDataUrl(fetchImpl, SOURCE_ID, cdid, dataset);
      representativeUrl = url;
      const res = await fetchOrThrow(fetchImpl, SOURCE_ID, url, {
        headers: { accept: "application/json" },
      });
      const body = await res.text();
      const parsed = parseOnsMonthly(body, SOURCE_ID, url);
      const payloadHash = await sha256Hex(body);
      // ONS returns borrowing in GBP millions; our indicators are in GBP bn.
      const value = parsed.value / 1000;
      observations.push({
        indicatorId,
        value,
        observedAt: parsed.observedAt,
        sourceId: SOURCE_ID,
        payloadHash,
      });
    }

    return {
      observations,
      sourceUrl: representativeUrl || "https://www.ons.gov.uk/economy/governmentpublicsectorandtaxes/publicsectorfinance",
      fetchedAt: new Date().toISOString(),
    };
  },
  async fetchHistorical(fetchImpl, opts): Promise<HistoricalFetchResult> {
    const observations: RawObservation[] = [];
    const { fromMs, toMs } = rangeUtcBounds(opts);
    let representativeUrl = "";
    let skippedOutOfRange = 0;
    let skippedNonNumeric = 0;

    for (const { indicatorId, cdid, dataset } of SERIES) {
      const url = await resolveOnsDataUrl(fetchImpl, SOURCE_ID, cdid, dataset);
      representativeUrl = url;
      const res = await fetchOrThrow(fetchImpl, SOURCE_ID, url, {
        headers: { accept: "application/json" },
      });
      const body = await res.text();
      const series = parseOnsMonthlySeries(body, SOURCE_ID, url);
      for (const point of series) {
        const ms = Date.parse(point.observedAt);
        if (!Number.isFinite(ms)) { skippedNonNumeric++; continue; }
        if (ms < fromMs || ms > toMs) { skippedOutOfRange++; continue; }
        // ONS returns GBPm; indicator unit is GBPbn.
        const value = point.value / 1000;
        observations.push({
          indicatorId,
          value,
          observedAt: point.observedAt,
          sourceId: SOURCE_ID,
          payloadHash: await historicalPayloadHash(indicatorId, point.observedAt, value),
        });
      }
    }

    const notes: string[] = [];
    if (skippedOutOfRange > 0) notes.push(`${skippedOutOfRange} months outside requested range`);
    if (skippedNonNumeric > 0) notes.push(`${skippedNonNumeric} months skipped (unparseable date)`);
    return buildHistoricalResult(
      observations,
      representativeUrl || "https://www.ons.gov.uk/economy/governmentpublicsectorandtaxes/publicsectorfinance",
      notes,
    );
  },
};

interface OnsMonthPoint { date: string; year: string; month: string; value: string; }

/** One parsed month from an ONS `months[]` envelope. */
export interface OnsMonthlyPoint { value: number; observedAt: string; }

/**
 * Parse every `months[]` entry from an ONS timeseries JSON envelope into an
 * ordered list (oldest first). Skips months whose value is non-numeric or
 * whose date fails to parse, rather than throwing — a historical fetch over
 * five years of data should not be aborted by a single unparseable row.
 *
 * The live `parseOnsMonthly` (single-month) is kept for adapters that only
 * want the latest figure; it is the strict cousin of this helper.
 */
export function parseOnsMonthlySeries(body: string, sourceId: string, url: string): OnsMonthlyPoint[] {
  let parsed: { months?: OnsMonthPoint[] };
  try {
    parsed = JSON.parse(body) as { months?: OnsMonthPoint[] };
  } catch (cause) {
    throw new AdapterError({ sourceId, sourceUrl: url, message: "ONS response was not valid JSON", cause });
  }
  const months = parsed.months;
  if (!Array.isArray(months) || months.length === 0) {
    throw new AdapterError({ sourceId, sourceUrl: url, message: "ONS response missing months[]" });
  }
  const out: OnsMonthlyPoint[] = [];
  for (const point of months) {
    const value = Number(point.value);
    if (!Number.isFinite(value)) continue;
    let observedAt: string;
    try {
      observedAt = onsMonthToIso(point);
    } catch {
      continue;
    }
    out.push({ value, observedAt });
  }
  out.sort((a, b) => a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0);
  return out;
}

/**
 * Pull the most recent `months` item from an ONS timeseries JSON envelope.
 * Exported for unit tests.
 */
export function parseOnsMonthly(body: string, sourceId: string, url: string): { value: number; observedAt: string } {
  let parsed: { months?: OnsMonthPoint[] };
  try {
    parsed = JSON.parse(body) as { months?: OnsMonthPoint[] };
  } catch (cause) {
    throw new AdapterError({ sourceId, sourceUrl: url, message: "ONS response was not valid JSON", cause });
  }
  const months = parsed.months;
  if (!Array.isArray(months) || months.length === 0) {
    throw new AdapterError({ sourceId, sourceUrl: url, message: "ONS response missing months[]" });
  }
  // ONS `date` is like "2026 FEB" or "2026 M02" depending on dataset.
  const latest = months[months.length - 1]!;
  const value = Number(latest.value);
  if (!Number.isFinite(value)) {
    throw new AdapterError({ sourceId, sourceUrl: url, message: `ONS: latest value '${latest.value}' not numeric` });
  }
  const iso = onsMonthToIso(latest);
  return { value, observedAt: iso };
}

function onsMonthToIso(point: OnsMonthPoint): string {
  const months: Record<string, string> = {
    JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
    JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
  };
  const yr = (point.year ?? "").trim();
  let mm: string | undefined;
  const mRaw = (point.month ?? "").trim().toUpperCase();
  if (months[mRaw]) mm = months[mRaw];
  if (!mm) {
    // Fall back to parsing the `date` field: patterns like "2026 FEB" or "2026 M02".
    const date = (point.date ?? "").trim();
    const abbrMatch = date.match(/^(\d{4})\s+([A-Z]{3})/i);
    const numMatch = date.match(/^(\d{4})\s+M(\d{2})/i);
    if (abbrMatch) mm = months[abbrMatch[2]!.toUpperCase()];
    else if (numMatch) mm = numMatch[2];
  }
  if (!mm || !/^\d{4}$/.test(yr)) {
    throw new Error(`onsMonthToIso: unable to parse ${JSON.stringify(point)}`);
  }
  return `${yr}-${mm}-01T00:00:00Z`;
}

registerAdapter(onsPsfAdapter);
