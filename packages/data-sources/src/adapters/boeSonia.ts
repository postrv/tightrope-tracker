/**
 * Bank of England IADB -- 12-month compounded SONIA index (proxy for the
 * 12m SONIA forward used by the market pressure pillar).
 *
 * Series code:
 *   IUDSOIA  -- SONIA, daily
 *
 * We derive a 12m approximation as a 252-trading-day rolling average of daily
 * SONIA fixings. This is a simple, explainable proxy; the spec allows a
 * compounded-SONIA 12m series as a proxy until we wire in a proper OIS curve.
 * TODO(source): switch to Refinitiv / ICE OIS curve once we have an API key.
 */
import type { AdapterResult, DataSourceAdapter, RawObservation } from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError, fetchOrThrow } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";
import { boeDateToIso, parseCsv } from "../lib/csv.js";

const SOURCE_ID = "boe_sonia";
const URL =
  "https://www.bankofengland.co.uk/boeapps/iadb/fromshowcolumns.asp?csv.x=yes&CodeVer=new&SeriesCodes=IUDSOIA";

const WINDOW_DAYS = 252; // ~1 year of business days

export const boeSoniaAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "Bank of England -- SONIA (12m proxy)",
  async fetch(fetchImpl): Promise<AdapterResult> {
    const res = await fetchOrThrow(fetchImpl, SOURCE_ID, URL, {
      headers: { accept: "text/csv,*/*;q=0.5" },
    });
    const body = await res.text();
    const rows = parseCsv(body);
    if (rows.length === 0) {
      throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: URL, message: "SONIA: no rows in CSV payload" });
    }
    const first = rows[0]!;
    const dateKey = "DATE" in first ? "DATE" : "Date" in first ? "Date" : null;
    const rateKey = "IUDSOIA" in first ? "IUDSOIA" : null;
    if (!dateKey || !rateKey) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: URL,
        message: `SONIA: unexpected columns ${Object.keys(first).join("|")}`,
      });
    }

    // Build an ordered series of (iso, rate) pairs from oldest to newest.
    const series: Array<{ iso: string; rate: number }> = [];
    for (const row of rows) {
      const rate = parseNum(row[rateKey]);
      const date = row[dateKey];
      if (rate === null || !date) continue;
      series.push({ iso: boeDateToIso(date), rate });
    }
    if (series.length === 0) {
      throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: URL, message: "SONIA: no parseable rows" });
    }

    const tail = series.slice(-WINDOW_DAYS);
    const avg = tail.reduce((acc, s) => acc + s.rate, 0) / tail.length;
    const latest = series[series.length - 1]!;

    const payloadHash = await sha256Hex(body);
    const observation: RawObservation = {
      indicatorId: "sonia_12m",
      value: avg,
      observedAt: latest.iso,
      sourceId: SOURCE_ID,
      payloadHash,
    };
    return { observations: [observation], sourceUrl: URL, fetchedAt: new Date().toISOString() };
  },
};

function parseNum(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (t === "" || t.toLowerCase() === "n/a") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

registerAdapter(boeSoniaAdapter);
