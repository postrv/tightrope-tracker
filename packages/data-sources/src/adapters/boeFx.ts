/**
 * Bank of England IADB -- Sterling exchange rates.
 *
 * Series codes:
 *   XUDLUSS  -- spot USD per GBP (daily, BoE spot fix)
 *   XUDLBK67 -- GBP effective (trade-weighted) exchange rate index
 *
 * Same CSV shape as the gilt adapter; we share the CSV helpers.
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

const SOURCE_ID = "boe_fx";
const SERIES_CODES = "XUDLUSS,XUDLBK67";

export const boeFxAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "Bank of England -- GBP/USD & GBP effective index",
  async fetch(fetchImpl): Promise<AdapterResult> {
    const url = buildBoEIadbUrl(SERIES_CODES);
    const res = await fetchOrThrow(fetchImpl, SOURCE_ID, url, {
      headers: BOE_FETCH_HEADERS,
    });
    const body = await res.text();
    assertLooksLikeCsv(SOURCE_ID, url, body);
    const rows = parseCsv(body);
    if (rows.length === 0) {
      throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: url, message: "BoE fx: no rows in CSV payload" });
    }
    const first = rows[0]!;
    const dateKey = "DATE" in first ? "DATE" : "Date" in first ? "Date" : null;
    const usdKey = "XUDLUSS" in first ? "XUDLUSS" : null;
    const twiKey = "XUDLBK67" in first ? "XUDLBK67" : null;
    if (!dateKey || !usdKey || !twiKey) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: url,
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
      throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: url, message: "BoE fx: no parseable numeric rows" });
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
    return { observations, sourceUrl: url, fetchedAt: new Date().toISOString() };
  },
  async fetchHistorical(fetchImpl, opts): Promise<HistoricalFetchResult> {
    return fetchBoeFxHistorical(fetchImpl, opts);
  },
};

async function fetchBoeFxHistorical(
  fetchImpl: typeof globalThis.fetch,
  opts: HistoricalFetchOptions,
): Promise<HistoricalFetchResult> {
  const url = buildBoEIadbUrl(SERIES_CODES, { from: opts.from, to: opts.to });
  const res = await fetchOrThrow(fetchImpl, SOURCE_ID, url, { headers: BOE_FETCH_HEADERS });
  const body = await res.text();
  assertLooksLikeCsv(SOURCE_ID, url, body);
  const rows = parseCsv(body);
  if (rows.length === 0) {
    throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: url, message: "BoE fx: no rows in CSV payload" });
  }
  const first = rows[0]!;
  const dateKey = "DATE" in first ? "DATE" : "Date" in first ? "Date" : null;
  const usdKey = "XUDLUSS" in first ? "XUDLUSS" : null;
  const twiKey = "XUDLBK67" in first ? "XUDLBK67" : null;
  if (!dateKey || !usdKey || !twiKey) {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: url,
      message: `BoE fx: unexpected columns ${Object.keys(first).join("|")}`,
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

    const usd = parseNum(row[usdKey]);
    const twi = parseNum(row[twiKey]);
    if (usd === null && twi === null) {
      skippedBlank++;
      continue;
    }
    if (usd !== null) {
      observations.push({
        indicatorId: "gbp_usd",
        value: usd,
        observedAt,
        sourceId: SOURCE_ID,
        payloadHash: await historicalPayloadHash("gbp_usd", observedAt, usd),
      });
    }
    if (twi !== null) {
      observations.push({
        indicatorId: "gbp_twi",
        value: twi,
        observedAt,
        sourceId: SOURCE_ID,
        payloadHash: await historicalPayloadHash("gbp_twi", observedAt, twi),
      });
    }
  }

  const notes: string[] = [];
  if (skippedBlank > 0) notes.push(`${skippedBlank} blank rows skipped (BoE quiet days)`);
  return buildHistoricalResult(observations, url, notes);
}

function parseNum(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (t === "" || t.toLowerCase() === "n/a") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

registerAdapter(boeFxAdapter);
