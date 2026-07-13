/**
 * EIA Europe Brent Spot Price, priced in GBP.
 *
 * Live path: EIA Open Data v2 API for Brent spot (facet `series` = `RBRTE`,
 * Europe Brent dated FOB — NOT `EPCBRENT`, which is the PRODUCT facet code;
 * querying it as a series returned an empty rows array and silently dropped
 * the adapter onto the fixture from ~2026-06-29 until the fixture's own
 * freshness guard tripped on 2026-07-12) divided by the BoE XUDLUSS 4pm fix
 * (USD per GBP) to produce a daily GBP-per-barrel reading. The fix is read
 * from OUR OWN ingested `gbp_usd` series via ctx.getLatestObservation — the
 * BoE IADB endpoint has been ASN-blocked from Workers egress since
 * 2026-06-10 (see the Actions relay), so fetching it directly from this
 * adapter was failing on every tick.
 *
 * Falls back to the editorial weekly fixture when:
 *   - EIA_API_KEY is not present (dev / tests / probe scripts)
 *   - either input is unavailable (EIA empty, no published gbp_usd)
 *   - the EIA print and the fix are more than 7 days apart (a stale
 *     pairing that would silently misprice Brent)
 * When the fixture path ALSO fails its freshness guard, the thrown error
 * carries the live-path failure reason so the audit row explains the root
 * cause rather than just "fixture is stale".
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
// The v2 SERIES facet id for daily Europe Brent Spot FOB. EIA's own API
// browser confirms it (facets=series;&series=RBRTE). EPCBRENT — used here
// until 2026-07-13 — is the PRODUCT facet code; as a series facet it matches
// nothing, and EIA replies 200 with zero rows rather than an error.
const EIA_BRENT_SERIES = "RBRTE";

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

/**
 * USD-per-GBP fix from OUR OWN ingested `gbp_usd` series (relay-fed daily).
 * Replaces the direct BoE IADB fetch, which the upstream ASN block has failed
 * on every tick since 2026-06-10 — the relay already lands this exact series
 * in D1, so re-fetching it here was both broken and redundant.
 */
async function fxFromPublished(
  ctx: AdapterContext | undefined,
): Promise<{ value: number; observedAtIso: string } | null> {
  if (!ctx?.getLatestObservation) {
    console.warn(`${SOURCE_ID}: no getLatestObservation in context (dev/probe run?), cannot pair FX`);
    return null;
  }
  let fx: { value: number; observedAt: string } | null;
  try {
    fx = await ctx.getLatestObservation("gbp_usd");
  } catch (err) {
    console.warn(`${SOURCE_ID}: gbp_usd lookup failed -- ${(err as Error)?.message ?? String(err)}`);
    return null;
  }
  if (!fx || !Number.isFinite(fx.value) || fx.value <= 0) {
    console.warn(`${SOURCE_ID}: no published gbp_usd observation to pair with`);
    return null;
  }
  return { value: fx.value, observedAtIso: fx.observedAt };
}

async function liveObservation(
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
  ctx: AdapterContext | undefined,
): Promise<{ observation: RawObservation; sourceUrl: string } | { reason: string }> {
  const [eia, fx] = await Promise.all([
    fetchEiaBrentUsd(fetchImpl, apiKey),
    fxFromPublished(ctx),
  ]);
  // The reason strings surface in the audit row when the fixture path also
  // fails — "fixture is stale" alone hid a two-week live-path outage in July.
  if (!eia && !fx) return { reason: "EIA returned no usable rows AND no published gbp_usd fix" };
  if (!eia) return { reason: "EIA returned no usable Brent rows" };
  if (!fx) return { reason: "no published gbp_usd fix to pair with" };
  const eiaIso = `${eia.period}T00:00:00Z`;
  const skewMs = Math.abs(Date.parse(eiaIso) - Date.parse(fx.observedAtIso));
  if (!Number.isFinite(skewMs) || skewMs > MAX_PAIRING_SKEW_MS) {
    const reason = `EIA (${eia.period}) and gbp_usd fix (${fx.observedAtIso}) more than 7 days apart`;
    console.warn(`${SOURCE_ID}: ${reason}, falling back`);
    return { reason };
  }
  const brentGbp = eia.value / fx.value;
  if (!Number.isFinite(brentGbp) || brentGbp <= 0) return { reason: `non-finite conversion (${eia.value} / ${fx.value})` };
  // Use the EIA period as the observation date (Brent is the upstream we
  // care about here; the FX fix is the converter, not the signal).
  const payloadHash = await sha256Hex(`eia:${eia.period}:${eia.value}|fx:${fx.observedAtIso}:${fx.value}`);
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
    let liveReason = "no EIA_API_KEY in context";
    if (apiKey) {
      const live = await liveObservation(fetchImpl, apiKey, ctx);
      if ("observation" in live) {
        return {
          observations: [live.observation],
          sourceUrl: live.sourceUrl,
          fetchedAt: new Date().toISOString(),
        };
      }
      liveReason = live.reason;
      console.warn(`${SOURCE_ID}: live path unavailable (${liveReason}), falling back to fixture`);
    }
    try {
      const { observation, sourceUrl } = await fixtureObservation();
      return {
        observations: [observation],
        sourceUrl,
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      // Surface the live-path root cause in the audit row: a bare "fixture is
      // stale" hid a two-week live outage (wrong EIA facet + BoE egress block)
      // in July 2026 — the fixture rotting is the SYMPTOM, not the disease.
      if (err instanceof AdapterError) {
        throw new AdapterError({
          sourceId: SOURCE_ID,
          sourceUrl: FIXTURE_URL,
          message: `${err.message}; live path: ${liveReason}`,
        });
      }
      throw err;
    }
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
