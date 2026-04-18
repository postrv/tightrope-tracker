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

const SOURCE_ID = "boe_sonia";
const SERIES_CODES = "IUDSOIA";

const WINDOW_DAYS = 252; // ~1 year of business days

export const boeSoniaAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "Bank of England -- SONIA (12m proxy)",
  async fetch(fetchImpl): Promise<AdapterResult> {
    // 252-day rolling average needs ~1y of history; buildBoEIadbUrl defaults to 2y.
    const url = buildBoEIadbUrl(SERIES_CODES);
    const res = await fetchOrThrow(fetchImpl, SOURCE_ID, url, {
      headers: BOE_FETCH_HEADERS,
    });
    const body = await res.text();
    assertLooksLikeCsv(SOURCE_ID, url, body);
    const rows = parseCsv(body);
    if (rows.length === 0) {
      throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: url, message: "SONIA: no rows in CSV payload" });
    }
    const first = rows[0]!;
    const dateKey = "DATE" in first ? "DATE" : "Date" in first ? "Date" : null;
    const rateKey = "IUDSOIA" in first ? "IUDSOIA" : null;
    if (!dateKey || !rateKey) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: url,
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
      throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: url, message: "SONIA: no parseable rows" });
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
    return { observations: [observation], sourceUrl: url, fetchedAt: new Date().toISOString() };
  },
  async fetchHistorical(fetchImpl, opts): Promise<HistoricalFetchResult> {
    return fetchBoeSoniaHistorical(fetchImpl, opts);
  },
};

/**
 * Historical SONIA 12m proxy: emit one observation per business day in
 * `[from, to]` equal to the rolling mean of the preceding `WINDOW_DAYS`
 * SONIA prints (inclusive of the day itself). The fetch window is widened
 * by ~400 calendar days beyond `from` so every day in range has enough
 * prior data to compute its mean; days that still fall short (e.g. at the
 * very start of the IADB history) are omitted and counted in `notes`.
 */
async function fetchBoeSoniaHistorical(
  fetchImpl: typeof globalThis.fetch,
  opts: HistoricalFetchOptions,
): Promise<HistoricalFetchResult> {
  const WARMUP_DAYS = 400;
  const extendedFrom = new Date(opts.from.getTime() - WARMUP_DAYS * 24 * 60 * 60 * 1000);
  const url = buildBoEIadbUrl(SERIES_CODES, { from: extendedFrom, to: opts.to });
  const res = await fetchOrThrow(fetchImpl, SOURCE_ID, url, { headers: BOE_FETCH_HEADERS });
  const body = await res.text();
  assertLooksLikeCsv(SOURCE_ID, url, body);
  const rows = parseCsv(body);
  if (rows.length === 0) {
    throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: url, message: "SONIA: no rows in CSV payload" });
  }
  const first = rows[0]!;
  const dateKey = "DATE" in first ? "DATE" : "Date" in first ? "Date" : null;
  const rateKey = "IUDSOIA" in first ? "IUDSOIA" : null;
  if (!dateKey || !rateKey) {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: url,
      message: `SONIA: unexpected columns ${Object.keys(first).join("|")}`,
    });
  }

  // Oldest-to-newest ordered pairs. IADB emits newest-first for multi-day CSVs
  // most of the time, but we don't rely on that — we sort after parsing.
  const series: Array<{ iso: string; ms: number; rate: number }> = [];
  for (const row of rows) {
    const rate = parseNum(row[rateKey]);
    const date = row[dateKey];
    if (rate === null || !date) continue;
    const iso = boeDateToIso(date);
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;
    series.push({ iso, ms, rate });
  }
  series.sort((a, b) => a.ms - b.ms);
  if (series.length === 0) {
    throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: url, message: "SONIA: no parseable rows" });
  }

  const { fromMs, toMs } = rangeUtcBounds(opts);
  const observations: RawObservation[] = [];
  let windowShortfall = 0;

  for (let i = 0; i < series.length; i++) {
    const entry = series[i]!;
    if (entry.ms < fromMs || entry.ms > toMs) continue;
    if (i + 1 < WINDOW_DAYS) {
      windowShortfall++;
      continue;
    }
    let sum = 0;
    for (let j = i + 1 - WINDOW_DAYS; j <= i; j++) sum += series[j]!.rate;
    const avg = sum / WINDOW_DAYS;
    observations.push({
      indicatorId: "sonia_12m",
      value: avg,
      observedAt: entry.iso,
      sourceId: SOURCE_ID,
      payloadHash: await historicalPayloadHash("sonia_12m", entry.iso, avg),
    });
  }

  const notes: string[] = [];
  if (windowShortfall > 0) {
    notes.push(`${windowShortfall} days skipped (fewer than ${WINDOW_DAYS} prior SONIA prints)`);
  }
  return buildHistoricalResult(observations, url, notes);
}

function parseNum(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (t === "" || t.toLowerCase() === "n/a") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

registerAdapter(boeSoniaAdapter);
