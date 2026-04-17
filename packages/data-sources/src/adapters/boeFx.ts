/**
 * Bank of England IADB -- Sterling exchange rates.
 *
 * Series codes:
 *   XUDLUSS  -- spot USD per GBP (daily, BoE spot fix)
 *   XUDLBK67 -- GBP effective (trade-weighted) exchange rate index
 *
 * Same CSV shape as the gilt adapter; we share the CSV helpers.
 */
import type { AdapterResult, DataSourceAdapter, RawObservation } from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError, fetchOrThrow } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";
import { boeDateToIso, parseCsv } from "../lib/csv.js";

const SOURCE_ID = "boe_fx";
const URL =
  "https://www.bankofengland.co.uk/boeapps/iadb/fromshowcolumns.asp?csv.x=yes&CodeVer=new&SeriesCodes=XUDLUSS,XUDLBK67";

export const boeFxAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "Bank of England -- GBP/USD & GBP effective index",
  async fetch(fetchImpl): Promise<AdapterResult> {
    const res = await fetchOrThrow(fetchImpl, SOURCE_ID, URL, {
      headers: { accept: "text/csv,*/*;q=0.5" },
    });
    const body = await res.text();
    const rows = parseCsv(body);
    if (rows.length === 0) {
      throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: URL, message: "BoE fx: no rows in CSV payload" });
    }
    const first = rows[0]!;
    const dateKey = "DATE" in first ? "DATE" : "Date" in first ? "Date" : null;
    const usdKey = "XUDLUSS" in first ? "XUDLUSS" : null;
    const twiKey = "XUDLBK67" in first ? "XUDLBK67" : null;
    if (!dateKey || !usdKey || !twiKey) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: URL,
        message: `BoE fx: unexpected columns ${Object.keys(first).join("|")}`,
      });
    }

    let latest: { date: string; usd: number | null; twi: number | null } | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      const usd = parseNum(row[usdKey]);
      const twi = parseNum(row[twiKey]);
      if (usd === null && twi === null) continue;
      latest = { date: row[dateKey]!, usd, twi };
      break;
    }
    if (!latest) {
      throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: URL, message: "BoE fx: no parseable numeric rows" });
    }

    const observedAt = boeDateToIso(latest.date);
    const payloadHash = await sha256Hex(body);
    const observations: RawObservation[] = [];
    if (latest.usd !== null) {
      observations.push({ indicatorId: "gbp_usd", value: latest.usd, observedAt, sourceId: SOURCE_ID, payloadHash });
    }
    if (latest.twi !== null) {
      observations.push({ indicatorId: "gbp_twi", value: latest.twi, observedAt, sourceId: SOURCE_ID, payloadHash });
    }
    return { observations, sourceUrl: URL, fetchedAt: new Date().toISOString() };
  },
};

function parseNum(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (t === "" || t.toLowerCase() === "n/a") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

registerAdapter(boeFxAdapter);
