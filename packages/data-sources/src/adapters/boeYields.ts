/**
 * Bank of England IADB -- 10y and 30y nominal gilt yields.
 *
 * Series codes:
 *   IUDMNPY  -- 10-year nominal par yield
 *   IUDMNZC  -- 30-year nominal par yield (long end proxy)
 *
 * The IADB CSV endpoint returns a small table: DATE, IUDMNPY, IUDMNZC.
 * We take the most recent row with at least one non-empty yield.
 */
import type { AdapterResult, DataSourceAdapter, RawObservation } from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError, fetchOrThrow } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";
import { assertLooksLikeCsv, boeDateToIso, parseCsv } from "../lib/csv.js";
import { buildBoEIadbUrl, BOE_FETCH_HEADERS } from "../lib/boe.js";

const SOURCE_ID = "boe_yields";
const SERIES_CODES = "IUDMNPY,IUDMNZC";

export const boeYieldsAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "Bank of England -- gilt yields (IUDMNPY, IUDMNZC)",
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
    const tenKey = findKey(rows[0]!, ["IUDMNPY"]);
    const thirtyKey = findKey(rows[0]!, ["IUDMNZC"]);
    if (!dateKey || !tenKey || !thirtyKey) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: url,
        message: `BoE yields: unexpected columns ${Object.keys(rows[0]!).join("|")}`,
      });
    }

    // Walk from the bottom to find the most recent row with usable data.
    let latest: { date: string; ten: number | null; thirty: number | null } | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      const ten = parseNum(row[tenKey]);
      const thirty = parseNum(row[thirtyKey]);
      if (ten === null && thirty === null) continue;
      latest = { date: row[dateKey]!, ten, thirty };
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
    if (latest.thirty !== null) {
      observations.push({ indicatorId: "gilt_30y", value: latest.thirty, observedAt, sourceId: SOURCE_ID, payloadHash });
    }
    return { observations, sourceUrl: url, fetchedAt: new Date().toISOString() };
  },
};

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
