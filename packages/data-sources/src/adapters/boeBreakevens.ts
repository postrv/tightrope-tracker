/**
 * Bank of England IADB -- breakeven inflation and index-linked real yields.
 *
 * Series codes:
 *   IUDSNZC  -- 5-year nominal zero-coupon yield
 *   IUDMNZC  -- 10-year nominal zero-coupon yield
 *   IUDSIZC  -- 5-year real (index-linked) zero-coupon yield
 *   IUDMIZC  -- 10-year real (index-linked) zero-coupon yield
 *
 * We pull all four in one IADB CSV request, take the most recent row where
 * every series has a numeric value, and emit three indicators:
 *
 *   breakeven_5y        = nominal 5y - real 5y     (market-implied CPI 5y)
 *   breakeven_10y       = nominal 10y - real 10y   (market-implied CPI 10y)
 *   gilt_il_10y_real    = real 10y                 (real-rate regime proxy)
 *
 * These are OBR-proxy indicators: breakevens lead the OBR's CPI inflation
 * forecast and the 10y real yield tracks the real-rate assumption behind
 * OBR's trend-growth path. See docs/OBR_PROXIES.md.
 */
import type { AdapterResult, DataSourceAdapter, RawObservation } from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError, fetchOrThrow } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";
import { assertLooksLikeCsv, boeDateToIso, parseCsv } from "../lib/csv.js";
import { buildBoEIadbUrl, BOE_FETCH_HEADERS } from "../lib/boe.js";

const SOURCE_ID = "boe_yields";
const SERIES_CODES = "IUDSNZC,IUDMNZC,IUDSIZC,IUDMIZC";

interface LatestRow {
  date: string;
  nom5: number;
  nom10: number;
  real5: number;
  real10: number;
}

export const boeBreakevensAdapter: DataSourceAdapter = {
  id: "boe_breakevens",
  name: "Bank of England -- breakevens & real yields (IUDSNZC/IUDMNZC/IUDSIZC/IUDMIZC)",
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
      nom10: "IUDMNZC" in first ? "IUDMNZC" : null,
      real5: "IUDSIZC" in first ? "IUDSIZC" : null,
      real10: "IUDMIZC" in first ? "IUDMIZC" : null,
    };
    if (!dateKey || !keys.nom5 || !keys.nom10 || !keys.real5 || !keys.real10) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: url,
        message: `BoE breakevens: unexpected columns ${Object.keys(first).join("|")}`,
      });
    }

    // Walk from newest to oldest to find the first row where every series parses.
    let latest: LatestRow | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      const nom5 = parseNum(row[keys.nom5]);
      const nom10 = parseNum(row[keys.nom10]);
      const real5 = parseNum(row[keys.real5]);
      const real10 = parseNum(row[keys.real10]);
      if (nom5 === null || nom10 === null || real5 === null || real10 === null) continue;
      latest = { date: row[dateKey]!, nom5, nom10, real5, real10 };
      break;
    }
    if (!latest) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: url,
        message: "BoE breakevens: no row with all four yields populated",
      });
    }

    const observedAt = boeDateToIso(latest.date);
    const payloadHash = await sha256Hex(body);
    const be5 = latest.nom5 - latest.real5;
    const be10 = latest.nom10 - latest.real10;
    const observations: RawObservation[] = [
      { indicatorId: "breakeven_5y",      value: be5,           observedAt, sourceId: SOURCE_ID, payloadHash },
      { indicatorId: "breakeven_10y",     value: be10,          observedAt, sourceId: SOURCE_ID, payloadHash },
      { indicatorId: "gilt_il_10y_real",  value: latest.real10, observedAt, sourceId: SOURCE_ID, payloadHash },
    ];
    return { observations, sourceUrl: url, fetchedAt: new Date().toISOString() };
  },
};

function parseNum(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (t === "" || t.toLowerCase() === "n/a") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

registerAdapter(boeBreakevensAdapter);
