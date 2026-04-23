/**
 * Bank of England IADB -- 5-year breakeven inflation.
 *
 * Series codes:
 *   IUDSNZC  -- 5-year nominal zero-coupon yield
 *   IUDSIZC  -- 5-year real (index-linked) zero-coupon yield
 *
 * We pull both in one IADB CSV request, take the most recent row where
 * both series have a numeric value, and emit one indicator:
 *
 *   breakeven_5y = nominal 5y - real 5y   (market-implied CPI 5y)
 *
 * This is an OBR-proxy indicator: the 5y breakeven leads the OBR's CPI
 * inflation forecast. See docs/OBR_PROXIES.md.
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
const SERIES_CODES = "IUDSNZC,IUDSIZC";

interface LatestRow {
  date: string;
  nom5: number;
  real5: number;
}

export const boeBreakevensAdapter: DataSourceAdapter = {
  id: "boe_breakevens",
  name: "Bank of England -- 5y breakeven (IUDSNZC/IUDSIZC)",
  async fetch(fetchImpl): Promise<AdapterResult> {
    const url = buildBoEIadbUrl(SERIES_CODES);
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
    const keys = {
      nom5: "IUDSNZC" in first ? "IUDSNZC" : null,
      real5: "IUDSIZC" in first ? "IUDSIZC" : null,
    };
    if (!dateKey || !keys.nom5 || !keys.real5) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: url,
        message: `BoE breakevens: unexpected columns ${Object.keys(first).join("|")}`,
      });
    }

    let latest: LatestRow | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      const nom5 = parseNum(row[keys.nom5]);
      const real5 = parseNum(row[keys.real5]);
      if (nom5 === null || real5 === null) continue;
      latest = { date: row[dateKey]!, nom5, real5 };
      break;
    }
    if (!latest) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: url,
        message: "BoE breakevens: no row with both 5y yields populated",
      });
    }

    const observedAt = boeDateToIso(latest.date);
    const payloadHash = await sha256Hex(body);
    const be5 = latest.nom5 - latest.real5;
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
  const url = buildBoEIadbUrl(SERIES_CODES, { from: opts.from, to: opts.to });
  const res = await fetchOrThrow(fetchImpl, SOURCE_ID, url, { headers: BOE_FETCH_HEADERS });
  const body = await res.text();
  assertLooksLikeCsv(SOURCE_ID, url, body);
  const rows = parseCsv(body);
  if (rows.length === 0) {
    throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: url, message: "BoE breakevens: no rows in CSV payload" });
  }
  const first = rows[0]!;
  const dateKey = "DATE" in first ? "DATE" : "Date" in first ? "Date" : null;
  const keys = {
    nom5: "IUDSNZC" in first ? "IUDSNZC" : null,
    real5: "IUDSIZC" in first ? "IUDSIZC" : null,
  };
  if (!dateKey || !keys.nom5 || !keys.real5) {
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

    const nom5 = parseNum(row[keys.nom5]);
    const real5 = parseNum(row[keys.real5]);
    if (nom5 === null || real5 === null) {
      skippedIncomplete++;
      continue;
    }
    const be5 = nom5 - real5;
    observations.push({
      indicatorId: "breakeven_5y",
      value: be5,
      observedAt,
      sourceId: SOURCE_ID,
      payloadHash: await historicalPayloadHash("breakeven_5y", observedAt, be5),
    });
  }

  const notes: string[] = [];
  if (skippedIncomplete > 0) notes.push(`${skippedIncomplete} rows skipped (incomplete yield pair)`);
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
