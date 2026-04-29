/**
 * EIA Europe Brent Spot Price, priced in GBP.
 *
 * Live path: EIA Open Data v2 API for Brent spot (series `EPCBRENT`,
 * facet `RBRTE` = Europe Brent dated FOB) divided by BoE IADB XUDLUSS
 * spot fix (USD per GBP) to produce a daily GBP-per-barrel reading.
 *
 * Falls back to the editorial weekly fixture when:
 *   - EIA_API_KEY is not present (dev / tests / probe scripts)
 *   - either upstream returns no usable rows
 *   - the EIA print and the BoE fix are more than 7 days apart (a stale
 *     pairing that would silently misprice Brent)
 *
 * Brent in GBP is an OBR proxy for the CPI energy subcomponent and fuel-
 * duty receipts: OBR's medium-term CPI profile bakes in a Brent path that
 * comes straight from the futures curve at forecast close.
 */
import fixture from "../fixtures/brent.json" with { type: "json" };
import history from "../fixtures/brent-history.json" with { type: "json" };
import type {
  AdapterContext,
  AdapterResult,
  DataSourceAdapter,
  HistoricalFetchResult,
  RawObservation,
} from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError, fetchOrThrow } from "../lib/errors.js";
import { historicalPayloadHash, sha256Hex } from "../lib/hash.js";
import { assertFixtureFresh } from "../lib/fixtureFreshness.js";
import { buildHistoricalResult, rangeUtcBounds } from "../lib/historical.js";
import { assertLooksLikeCsv, boeDateToIso, parseCsv } from "../lib/csv.js";
import { buildBoEIadbUrl, BOE_FETCH_HEADERS } from "../lib/boe.js";

const SOURCE_ID = "eia_brent";
const FIXTURE_URL = "local:fixtures/brent.json";
const HISTORY_FIXTURE_URL = "local:fixtures/brent-history.json";
// EIA / BoE 4pm fix is editorially refreshed weekly when used as a
// fallback. 14 days matches the other weekly fixtures and gives a ~one-
// week grace before the guard trips.
const MAX_FIXTURE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
// EIA spot prints and BoE FX should land within a day of each other on
// weekdays. 7 days of skew is generous — past that we don't trust the
// pairing and fall back rather than print an arithmetically-stale GBP
// number.
const MAX_PAIRING_SKEW_MS = 7 * 24 * 60 * 60 * 1000;

const EIA_BASE = "https://api.eia.gov/v2/petroleum/pri/spt/data/";
const EIA_BRENT_SERIES = "EPCBRENT";

interface BrentFixture {
  observed_at: string;
  brent_gbp: { value: number; unit: string };
  source_url: string;
}

interface BrentHistoryPoint {
  observed_at: string;
  value: number;
}

interface BrentHistoryFixture {
  points: readonly BrentHistoryPoint[];
}

interface EiaResponse {
  response?: {
    data?: Array<{
      period?: string;
      value?: string | number;
      duoarea?: string;
    }>;
  };
}

async function fetchEiaBrentUsd(
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
): Promise<{ value: number; period: string } | null> {
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("frequency", "daily");
  params.set("data[0]", "value");
  params.set("facets[series][]", EIA_BRENT_SERIES);
  params.set("sort[0][column]", "period");
  params.set("sort[0][direction]", "desc");
  params.set("length", "10");
  const url = `${EIA_BASE}?${params.toString()}`;
  let res: Response;
  try {
    res = await fetchOrThrow(fetchImpl, SOURCE_ID, url);
  } catch (err) {
    console.warn(`${SOURCE_ID}: EIA fetch failed -- ${(err as Error)?.message ?? String(err)}`);
    return null;
  }
  let body: EiaResponse;
  try {
    body = (await res.json()) as EiaResponse;
  } catch {
    console.warn(`${SOURCE_ID}: EIA response not JSON`);
    return null;
  }
  const rows = body.response?.data ?? [];
  for (const r of rows) {
    if (!r.period) continue;
    const v = typeof r.value === "string" ? Number(r.value) : r.value;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
    return { value: v, period: r.period };
  }
  // Diagnostic: surface enough signal in tail logs to triage which facet
  // / parameter combo EIA is rejecting. Live audit on 2026-04-29 traced
  // a 12-day silent fall-through to this branch: the upstream replied with
  // an empty rows array, so the adapter quietly served the editorial
  // fixture every cron tick.
  const sample = rows.slice(0, 3).map((r) => ({ period: r.period, duoarea: r.duoarea, value: r.value }));
  console.warn(
    `${SOURCE_ID}: EIA returned no usable Brent rows (count=${rows.length}, sample=${JSON.stringify(sample)})`,
  );
  return null;
}

async function fetchBoeUsdPerGbp(
  fetchImpl: typeof globalThis.fetch,
): Promise<{ value: number; date: string } | null> {
  const url = buildBoEIadbUrl("XUDLUSS");
  let res: Response;
  try {
    res = await fetchOrThrow(fetchImpl, SOURCE_ID, url, { headers: BOE_FETCH_HEADERS });
  } catch (err) {
    console.warn(`${SOURCE_ID}: BoE FX fetch failed -- ${(err as Error)?.message ?? String(err)}`);
    return null;
  }
  let text: string;
  try {
    text = await res.text();
    assertLooksLikeCsv(SOURCE_ID, url, text);
  } catch {
    console.warn(`${SOURCE_ID}: BoE FX response not CSV`);
    return null;
  }
  const rows = parseCsv(text);
  if (rows.length === 0) return null;
  const dateKey = "DATE" in rows[0]! ? "DATE" : "Date" in rows[0]! ? "Date" : null;
  const fxKey = "XUDLUSS" in rows[0]! ? "XUDLUSS" : null;
  if (!dateKey || !fxKey) return null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const raw = row[fxKey];
    if (!raw) continue;
    const v = Number(raw.trim());
    if (!Number.isFinite(v) || v <= 0) continue;
    return { value: v, date: row[dateKey]! };
  }
  return null;
}

async function liveObservation(
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
): Promise<{ observation: RawObservation; sourceUrl: string } | null> {
  const [eia, fx] = await Promise.all([
    fetchEiaBrentUsd(fetchImpl, apiKey),
    fetchBoeUsdPerGbp(fetchImpl),
  ]);
  if (!eia || !fx) return null;
  const eiaIso = `${eia.period}T00:00:00Z`;
  const fxIso = boeDateToIso(fx.date);
  const skewMs = Math.abs(Date.parse(eiaIso) - Date.parse(fxIso));
  if (!Number.isFinite(skewMs) || skewMs > MAX_PAIRING_SKEW_MS) {
    console.warn(`${SOURCE_ID}: EIA (${eia.period}) and BoE FX (${fx.date}) more than 7 days apart, falling back`);
    return null;
  }
  const brentGbp = eia.value / fx.value;
  if (!Number.isFinite(brentGbp) || brentGbp <= 0) return null;
  // Use the EIA period as the observation date (Brent is the upstream we
  // care about here; the FX fix is the converter, not the signal).
  const payloadHash = await sha256Hex(`eia:${eia.period}:${eia.value}|boe:${fx.date}:${fx.value}`);
  return {
    observation: {
      indicatorId: "brent_gbp",
      value: Math.round(brentGbp * 100) / 100,
      observedAt: eiaIso,
      sourceId: SOURCE_ID,
      payloadHash,
    },
    sourceUrl: `${EIA_BASE}?series=${EIA_BRENT_SERIES}`,
  };
}

async function fixtureObservation(): Promise<{ observation: RawObservation; sourceUrl: string }> {
  const data = fixture as unknown as BrentFixture;
  if (!data || typeof data.brent_gbp?.value !== "number") {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: FIXTURE_URL,
      message: "Brent: fixture missing brent_gbp.value",
    });
  }
  // Fallback only: the freshness guard tripping here means BOTH the EIA
  // live path and the editorial fixture have rotted — surface that loudly.
  assertFixtureFresh(data.observed_at, MAX_FIXTURE_AGE_MS, SOURCE_ID, FIXTURE_URL);
  const hash = await sha256Hex(JSON.stringify(data));
  return {
    observation: {
      indicatorId: "brent_gbp",
      value: data.brent_gbp.value,
      observedAt: data.observed_at,
      sourceId: SOURCE_ID,
      payloadHash: hash,
    },
    sourceUrl: data.source_url ?? FIXTURE_URL,
  };
}

export const eiaBrentAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "EIA Brent spot in GBP -- live (fixture fallback)",
  async fetch(fetchImpl, ctx?: AdapterContext): Promise<AdapterResult> {
    const apiKey = ctx?.secrets?.EIA_API_KEY;
    if (apiKey) {
      const live = await liveObservation(fetchImpl, apiKey);
      if (live) {
        return {
          observations: [live.observation],
          sourceUrl: live.sourceUrl,
          fetchedAt: new Date().toISOString(),
        };
      }
      console.warn(`${SOURCE_ID}: EIA/BoE live path unavailable, falling back to fixture`);
    }
    const { observation, sourceUrl } = await fixtureObservation();
    return {
      observations: [observation],
      sourceUrl,
      fetchedAt: new Date().toISOString(),
    };
  },
  // Historical mode reads brent-history.json (EIA RBRTE daily spot ÷ BoE
  // XUDLUSS GBP/USD daily fix, 2024-07 → 2026-04). Days where either
  // upstream had no print are dropped at fixture-build time.
  async fetchHistorical(_fetchImpl, opts): Promise<HistoricalFetchResult> {
    const { fromMs, toMs } = rangeUtcBounds(opts);
    const data = history as unknown as BrentHistoryFixture;
    const observations: RawObservation[] = [];
    let skippedOutOfRange = 0;

    for (const point of data.points) {
      const ms = Date.parse(point.observed_at);
      if (!Number.isFinite(ms)) continue;
      if (ms < fromMs || ms > toMs) { skippedOutOfRange++; continue; }
      if (typeof point.value !== "number" || !Number.isFinite(point.value)) continue;
      observations.push({
        indicatorId: "brent_gbp",
        value: point.value,
        observedAt: point.observed_at,
        sourceId: SOURCE_ID,
        payloadHash: await historicalPayloadHash("brent_gbp", point.observed_at, point.value),
      });
    }

    observations.sort((a, b) =>
      a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0,
    );

    const notes: string[] = [];
    if (skippedOutOfRange > 0) notes.push(`${skippedOutOfRange} days outside requested range`);
    return buildHistoricalResult(observations, HISTORY_FIXTURE_URL, notes);
  },
};

registerAdapter(eiaBrentAdapter);
