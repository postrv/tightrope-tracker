/**
 * Bank of England IADB -- 10y and 20y nominal gilt yields.
 *
 * Series codes:
 *   IUDMNZC  -- 10-year nominal zero-coupon yield
 *   IUDLNZC  -- 20-year nominal zero-coupon yield
 *
 * The IADB CSV endpoint returns a small table: DATE, IUDMNZC, IUDLNZC.
 * We take the most recent row with at least one non-empty yield.
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
const SERIES_CODES = "IUDMNZC,IUDLNZC";

export const boeYieldsAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "Bank of England -- gilt yields (IUDMNZC, IUDLNZC)",
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
        message: "BoE yields: no rows in CSV payload",
      });
    }
    const dateKey = findKey(rows[0]!, ["DATE", "Date"]);
    const tenKey = findKey(rows[0]!, ["IUDMNZC"]);
    const twentyKey = findKey(rows[0]!, ["IUDLNZC"]);
    if (!dateKey || !tenKey || !twentyKey) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: url,
        message: `BoE yields: unexpected columns ${Object.keys(rows[0]!).join("|")}`,
      });
    }

    // Walk from the bottom to find the most recent row with usable data.
    let latest: { date: string; ten: number | null; twenty: number | null } | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      const ten = parseNum(row[tenKey]);
      const twenty = parseNum(row[twentyKey]);
      if (ten === null && twenty === null) continue;
      latest = { date: row[dateKey]!, ten, twenty };
      break;
    }
    if (!latest) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: url,
        message: "BoE yields: no parseable numeric rows",
      });
    }

    const observedAt = boeDateToIso(latest.date);
    const payloadHash = await sha256Hex(body);
    const observations: RawObservation[] = [];
    if (latest.ten !== null) {
      observations.push({ indicatorId: "gilt_10y", value: latest.ten, observedAt, sourceId: SOURCE_ID, payloadHash });
    }
    if (latest.twenty !== null) {
      observations.push({ indicatorId: "gilt_30y", value: latest.twenty, observedAt, sourceId: SOURCE_ID, payloadHash });
    }
    return { observations, sourceUrl: url, fetchedAt: new Date().toISOString() };
  },
  async fetchHistorical(fetchImpl, opts): Promise<HistoricalFetchResult> {
    return fetchBoeYieldsHistorical(fetchImpl, opts);
  },
};

async function fetchBoeYieldsHistorical(
  fetchImpl: typeof globalThis.fetch,
  opts: HistoricalFetchOptions,
): Promise<HistoricalFetchResult> {
  const url = buildBoEIadbUrl(SERIES_CODES, { from: opts.from, to: opts.to });
  const res = await fetchOrThrow(fetchImpl, SOURCE_ID, url, { headers: BOE_FETCH_HEADERS });
  const body = await res.text();
  assertLooksLikeCsv(SOURCE_ID, url, body);
  const rows = parseCsv(body);
  if (rows.length === 0) {
    throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: url, message: "BoE yields: no rows in CSV payload" });
  }
  const dateKey = findKey(rows[0]!, ["DATE", "Date"]);
  const tenKey = findKey(rows[0]!, ["IUDMNZC"]);
  const twentyKey = findKey(rows[0]!, ["IUDLNZC"]);
  if (!dateKey || !tenKey || !twentyKey) {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: url,
      message: `BoE yields: unexpected columns ${Object.keys(rows[0]!).join("|")}`,
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

    const ten = parseNum(row[tenKey]);
    const twenty = parseNum(row[twentyKey]);
    if (ten === null && twenty === null) {
      skippedBlank++;
      continue;
    }
    if (ten !== null) {
      observations.push({
        indicatorId: "gilt_10y",
        value: ten,
        observedAt,
        sourceId: SOURCE_ID,
        payloadHash: await historicalPayloadHash("gilt_10y", observedAt, ten),
      });
    }
    if (twenty !== null) {
      observations.push({
        indicatorId: "gilt_30y",
        value: twenty,
        observedAt,
        sourceId: SOURCE_ID,
        payloadHash: await historicalPayloadHash("gilt_30y", observedAt, twenty),
      });
    }
  }

  const notes: string[] = [];
  if (skippedBlank > 0) notes.push(`${skippedBlank} blank rows skipped (BoE quiet days)`);
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

registerAdapter(boeYieldsAdapter);
