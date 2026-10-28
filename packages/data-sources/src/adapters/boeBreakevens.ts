/**
 * Bank of England IADB -- 5-year breakeven inflation.
 *
 * Series codes:
 *   IUDSIZC  -- 5-year inflation zero-coupon rate, already derived by BoE
 *
 * The BoE catalogue distinguishes IUDSIZC (inflation) from IUDSRZC (real).
 * Subtracting IUDSIZC from the nominal yield would recover a real-rate-like
 * quantity, not inflation compensation. Use the published inflation series
 * directly, taking the most recent populated row:
 *
 *   breakeven_5y = IUDSIZC
 *
 * This is RPI-linked gilt-market inflation compensation over five years,
 * including risk/liquidity premia, not a pure CPI forecast. The reference
 * series and interpretation are documented in docs/OBR_PROXIES.md.
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

const SOURCE_ID = "boe_yields";
/** Exported so the Actions relay script reuses the exact series codes the adapter requests (see BoE relay note, 2026-07). */
export const BOE_BREAKEVENS_SERIES_CODES = "IUDSIZC";

interface LatestRow {
  date: string;
  inflation5: number;
}

export const boeBreakevensAdapter: DataSourceAdapter = {
  id: "boe_breakevens",
  name: "Bank of England -- 5y RPI inflation compensation (IUDSIZC)",
  async fetch(fetchImpl): Promise<AdapterResult> {
    const url = buildBoEIadbUrl(BOE_BREAKEVENS_SERIES_CODES);
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
        message: "BoE breakevens: no rows in CSV payload",
      });
    }
    const first = rows[0]!;
    const dateKey = "DATE" in first ? "DATE" : "Date" in first ? "Date" : null;
    const inflationKey = "IUDSIZC" in first ? "IUDSIZC" : null;
    if (!dateKey || !inflationKey) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: url,
        message: `BoE breakevens: unexpected columns ${Object.keys(first).join("|")}`,
      });
    }

    let latest: LatestRow | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      const inflation5 = parseNum(row[inflationKey]);
      if (inflation5 === null) continue;
      latest = { date: row[dateKey]!, inflation5 };
      break;
    }
    if (!latest) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: url,
        message: "BoE breakevens: no populated 5y inflation zero-coupon rate",
      });
    }

    const observedAt = boeDateToIso(latest.date);
    const payloadHash = await sha256Hex(body);
    const be5 = latest.inflation5;
    const observations: RawObservation[] = [
      { indicatorId: "breakeven_5y", value: be5, observedAt, sourceId: SOURCE_ID, payloadHash },
    ];
    return { observations, sourceUrl: url, fetchedAt: new Date().toISOString() };
  },
  async fetchHistorical(fetchImpl, opts): Promise<HistoricalFetchResult> {
    return fetchBoeBreakevensHistorical(fetchImpl, opts);
  },
};

async function fetchBoeBreakevensHistorical(
  fetchImpl: typeof globalThis.fetch,
  opts: HistoricalFetchOptions,
): Promise<HistoricalFetchResult> {
  const url = buildBoEIadbUrl(BOE_BREAKEVENS_SERIES_CODES, { from: opts.from, to: opts.to });
  const res = await fetchOrThrow(fetchImpl, SOURCE_ID, url, { headers: BOE_FETCH_HEADERS });
  const body = await res.text();
  assertLooksLikeCsv(SOURCE_ID, url, body);
  const rows = parseCsv(body);
  if (rows.length === 0) {
    throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: url, message: "BoE breakevens: no rows in CSV payload" });
  }
  const first = rows[0]!;
  const dateKey = "DATE" in first ? "DATE" : "Date" in first ? "Date" : null;
  const inflationKey = "IUDSIZC" in first ? "IUDSIZC" : null;
  if (!dateKey || !inflationKey) {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: url,
      message: `BoE breakevens: unexpected columns ${Object.keys(first).join("|")}`,
    });
  }

  const { fromMs, toMs } = rangeUtcBounds(opts);
  const observations: RawObservation[] = [];
  let skippedIncomplete = 0;

  for (const row of rows) {
    const dateRaw = row[dateKey];
    if (!dateRaw) continue;
    const observedAt = boeDateToIso(dateRaw);
    const rowMs = Date.parse(observedAt);
    if (!Number.isFinite(rowMs) || rowMs < fromMs || rowMs > toMs) continue;

    const inflation5 = parseNum(row[inflationKey]);
    if (inflation5 === null) {
      skippedIncomplete++;
      continue;
    }
    const be5 = inflation5;
    observations.push({
      indicatorId: "breakeven_5y",
      value: be5,
      observedAt,
      sourceId: SOURCE_ID,
      payloadHash: await historicalPayloadHash("breakeven_5y", observedAt, be5),
    });
  }

  const notes: string[] = [];
  if (skippedIncomplete > 0) notes.push(`${skippedIncomplete} rows skipped (missing inflation rate)`);
  return buildHistoricalResult(observations, url, notes);
}

function parseNum(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (t === "" || t.toLowerCase() === "n/a") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

registerAdapter(boeBreakevensAdapter);
