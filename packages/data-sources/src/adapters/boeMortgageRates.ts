/**
 * Bank of England IADB -- effective rate on new 2-year fixed-rate mortgages
 * to households at 75% LTV.
 *
 * Series code:
 *   IUMBV34  -- Monthly effective rate on new fixed-rate 2-year mortgages
 *               to households at 75% loan-to-value (in percent).
 *
 * Replaces the Moneyfacts editorial fixture for the `mortgage_2y_fix`
 * indicator. Note the semantic shift: BoE publishes the *effective rate
 * paid on new lending* (interest income ÷ balance), whereas Moneyfacts
 * publishes the *advertised rate* on new fixed-rate products. The two
 * typically diverge by 30-80bp; the BoE series is the canonical reference
 * an economist or rate-setter would cite.
 *
 * The IADB CSV endpoint returns one row per month with `IUMBV34` as the
 * column header; we take the most recent row that has a non-null value.
 */
import type {
  AdapterResult,
  DataSourceAdapter,
  HistoricalFetchOptions,
  HistoricalFetchResult,
  RawObservation,
} from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError, fetchOrThrow } from "../lib/errors.js";
import { historicalPayloadHash, sha256Hex } from "../lib/hash.js";
import { assertLooksLikeCsv, boeDateToIso, parseCsv } from "../lib/csv.js";
import { buildBoEIadbUrl, BOE_FETCH_HEADERS } from "../lib/boe.js";
import { buildHistoricalResult, rangeUtcBounds } from "../lib/historical.js";

const SOURCE_ID = "boe_mortgage_rates";
const SERIES_CODE = "IUMBV34";

export const boeMortgageRatesAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "Bank of England -- 2y fix mortgage rate (IUMBV34, 75% LTV)",
  async fetch(fetchImpl): Promise<AdapterResult> {
    // BoE IADB monthly series: a 2-year window comfortably covers the
    // most recent print plus several months of slack while staying inside
    // the URL-length budget.
    const url = buildBoEIadbUrl(SERIES_CODE);
    const res = await fetchOrThrow(fetchImpl, SOURCE_ID, url, {
      headers: BOE_FETCH_HEADERS,
    });
    const body = await res.text();
    assertLooksLikeCsv(SOURCE_ID, url, body);
    const rows = parseCsv(body);
    if (rows.length === 0) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: url,
        message: "BoE mortgage rates: no rows in CSV payload",
      });
    }
    const dateKey = findKey(rows[0]!, ["DATE", "Date"]);
    const valKey = findKey(rows[0]!, [SERIES_CODE]);
    if (!dateKey || !valKey) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: url,
        message: `BoE mortgage rates: unexpected columns ${Object.keys(rows[0]!).join("|")}`,
      });
    }

    // Walk from the bottom: monthly series prints once per month and we
    // want the most recent non-null reading.
    let latest: { date: string; value: number } | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      const v = parseNum(row[valKey]);
      if (v === null) continue;
      latest = { date: row[dateKey]!, value: v };
      break;
    }
    if (!latest) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: url,
        message: "BoE mortgage rates: no parseable numeric rows",
      });
    }

    const observedAt = boeDateToIso(latest.date);
    const payloadHash = await sha256Hex(body);
    return {
      observations: [{
        indicatorId: "mortgage_2y_fix",
        value: latest.value,
        observedAt,
        sourceId: SOURCE_ID,
        payloadHash,
      }],
      sourceUrl: url,
      fetchedAt: new Date().toISOString(),
    };
  },
  async fetchHistorical(fetchImpl, opts): Promise<HistoricalFetchResult> {
    return fetchBoeMortgageHistorical(fetchImpl, opts);
  },
};

async function fetchBoeMortgageHistorical(
  fetchImpl: typeof globalThis.fetch,
  opts: HistoricalFetchOptions,
): Promise<HistoricalFetchResult> {
  const url = buildBoEIadbUrl(SERIES_CODE, { from: opts.from, to: opts.to });
  const res = await fetchOrThrow(fetchImpl, SOURCE_ID, url, { headers: BOE_FETCH_HEADERS });
  const body = await res.text();
  assertLooksLikeCsv(SOURCE_ID, url, body);
  const rows = parseCsv(body);
  if (rows.length === 0) {
    throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: url, message: "BoE mortgage rates: no rows in CSV payload" });
  }
  const dateKey = findKey(rows[0]!, ["DATE", "Date"]);
  const valKey = findKey(rows[0]!, [SERIES_CODE]);
  if (!dateKey || !valKey) {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: url,
      message: `BoE mortgage rates: unexpected columns ${Object.keys(rows[0]!).join("|")}`,
    });
  }

  const { fromMs, toMs } = rangeUtcBounds(opts);
  const observations: RawObservation[] = [];
  let skippedBlank = 0;

  for (const row of rows) {
    const dateRaw = row[dateKey];
    if (!dateRaw) continue;
    const observedAt = boeDateToIso(dateRaw);
    const rowMs = Date.parse(observedAt);
    if (!Number.isFinite(rowMs) || rowMs < fromMs || rowMs > toMs) continue;

    const v = parseNum(row[valKey]);
    if (v === null) { skippedBlank++; continue; }
    observations.push({
      indicatorId: "mortgage_2y_fix",
      value: v,
      observedAt,
      sourceId: SOURCE_ID,
      payloadHash: await historicalPayloadHash("mortgage_2y_fix", observedAt, v),
    });
  }

  const notes: string[] = [];
  if (skippedBlank > 0) notes.push(`${skippedBlank} blank rows skipped`);
  return buildHistoricalResult(observations, url, notes);
}

function findKey(row: Record<string, string>, candidates: readonly string[]): string | null {
  for (const c of candidates) if (c in row) return c;
  return null;
}

function parseNum(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "n/a") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

registerAdapter(boeMortgageRatesAdapter);
