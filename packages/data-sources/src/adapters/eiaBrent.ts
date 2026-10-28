/**
 * EIA Europe Brent Spot Price, priced in GBP.
 *
 * Live path: EIA Open Data v2 API for Brent spot (facet `series` = `RBRTE`,
 * Europe Brent dated FOB — NOT `EPCBRENT`, which is the PRODUCT facet code;
 * querying it as a series returned an empty rows array and silently dropped
 * the adapter onto the fixture from ~2026-06-29 until the fixture's own
 * freshness guard tripped on 2026-07-12) divided by the BoE XUDLUSS 4pm fix
 * (USD per GBP) to produce a daily GBP-per-barrel reading. The fix is read
 * from OUR OWN ingested `gbp_usd` series for the Brent price's own date via
 * ctx.getObservationBefore — the BoE IADB endpoint has been ASN-blocked from Workers egress since
 * 2026-06-10 (see the Actions relay), so fetching it directly from this
 * adapter was failing on every tick.
 *
 * Falls back to the editorial weekly fixture when:
 *   - EIA_API_KEY is not present (dev / tests / probe scripts)
 *   - either input is unavailable (EIA empty, no published gbp_usd)
 *   - no same-day or preceding BoE fix within five calendar days of the EIA
 *     print (a long holiday gap we cannot safely price)
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
  HistoricalFetchOptions,
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
// A Thursday fix can be nearest to a Tuesday print across the Easter break.
// Any older fix is too far from the price period.
const MAX_FX_LAG_MS = 5 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

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
    total?: string | number;
    data?: Array<{
      period?: string;
      value?: string | number;
      duoarea?: string;
    }>;
  };
}

type FxFix = { value: number; observedAtIso: string };

/** The price date, not its later publication date, determines the FX fix. */
function pairingError(eiaPeriod: string, fx: FxFix): string | null {
  const eiaMs = Date.parse(`${eiaPeriod}T00:00:00Z`);
  const fxMs = Date.parse(fx.observedAtIso);
  const fxDayMs = Number.isFinite(fxMs)
    ? Date.UTC(new Date(fxMs).getUTCFullYear(), new Date(fxMs).getUTCMonth(), new Date(fxMs).getUTCDate())
    : NaN;
  const lagMs = eiaMs - fxDayMs;
  return !Number.isFinite(lagMs) || lagMs < 0 || lagMs > MAX_FX_LAG_MS
    ? `EIA (${eiaPeriod}) has no same-day or preceding gbp_usd fix within 5 days (nearest ${fx.observedAtIso})`
    : null;
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

/** USD-per-GBP fix from the relay-fed series, bounded to the EIA price date. */
async function fxFromPublished(
  ctx: AdapterContext | undefined,
  beforeIso: string,
): Promise<FxFix | null> {
  if (!ctx?.getObservationBefore) {
    console.warn(`${SOURCE_ID}: no getObservationBefore in context (dev/probe run?), cannot pair FX`);
    return null;
  }
  let fx: { value: number; observedAt: string } | null;
  try {
    fx = await ctx.getObservationBefore("gbp_usd", "boe_fx", beforeIso);
  } catch (err) {
    console.warn(`${SOURCE_ID}: gbp_usd lookup failed -- ${(err as Error)?.message ?? String(err)}`);
    return null;
  }
  if (!fx || !Number.isFinite(fx.value) || fx.value <= 0) {
    console.warn(`${SOURCE_ID}: no published gbp_usd observation before ${beforeIso} to pair with`);
    return null;
  }
  return { value: fx.value, observedAtIso: fx.observedAt };
}

async function liveObservation(
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
  ctx: AdapterContext | undefined,
): Promise<{ observation: RawObservation; sourceUrl: string } | { reason: string }> {
  const eia = await fetchEiaBrentUsd(fetchImpl, apiKey);
  // The reason strings surface in the audit row when the fixture path also
  // fails — "fixture is stale" alone hid a two-week live-path outage in July.
  if (!eia) return { reason: "EIA returned no usable Brent rows" };
  const eiaIso = `${eia.period}T00:00:00Z`;
  const eiaMs = Date.parse(eiaIso);
  if (!Number.isFinite(eiaMs)) return { reason: `invalid EIA period ${eia.period}` };
  // The BoE 16:00 fix on the price date is eligible, but tomorrow's fix is
  // excluded. EIA's weekly publication lag must not cause each new FX relay
  // to reprice the same historical Brent observation.
  const fx = await fxFromPublished(ctx, new Date(eiaMs + DAY_MS).toISOString());
  if (!fx) return { reason: `no published gbp_usd fix on or before EIA period ${eia.period}` };
  const reason = pairingError(eia.period, fx);
  if (reason) {
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

/** Rebuild missing daily Brent history from official EIA prices and the
 * relay-fed BoE FX observations already held in D1. The query is date-bounded
 * and uses one FX read for the whole range. */
async function historicalFromEia(
  fetchImpl: typeof globalThis.fetch,
  opts: HistoricalFetchOptions,
  ctx: AdapterContext,
  apiKey: string,
): Promise<HistoricalFetchResult> {
  const { fromMs, toMs } = rangeUtcBounds(opts);
  const startDay = opts.from.toISOString().slice(0, 10);
  const endDay = opts.to.toISOString().slice(0, 10);
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("frequency", "daily");
  params.set("data[0]", "value");
  params.set("facets[series][]", EIA_BRENT_SERIES);
  params.set("start", startDay);
  params.set("end", endDay);
  params.set("sort[0][column]", "period");
  params.set("sort[0][direction]", "asc");
  params.set("length", "5000");
  const response = await fetchOrThrow(fetchImpl, SOURCE_ID, `${EIA_BASE}?${params.toString()}`);
  const body = (await response.json()) as EiaResponse;
  const rows = body.response?.data;
  if (!Array.isArray(rows)) {
    throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: EIA_BASE, message: "EIA historical response has no data array" });
  }
  const total = Number(body.response?.total ?? rows.length);
  if (Number.isFinite(total) && total > rows.length) {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: EIA_BASE,
      message: `EIA historical response truncated (${rows.length}/${total}); narrow the requested range`,
    });
  }
  // The daily 14-day catch-up should fail its audit if EIA silently returns
  // an empty result (as it did when an incorrect series facet was queried).
  // A short manual range can legitimately contain only a weekend or holiday.
  const rangeDays = Math.floor((toMs - fromMs) / DAY_MS) + 1;
  if (rangeDays >= 7 && rows.length === 0) {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: EIA_BASE,
      message: `EIA returned no Brent prices for ${startDay} to ${endDay}`,
    });
  }

  // Include the five-day grace before the first requested price date. The
  // upper bound includes a same-day 16:00 BoE fix for the final EIA period.
  const fxFrom = new Date(Date.parse(`${startDay}T00:00:00Z`) - MAX_FX_LAG_MS).toISOString();
  const fxBefore = new Date(Date.parse(`${endDay}T00:00:00Z`) + DAY_MS).toISOString();
  const fxRows = await ctx.getObservationsInRange!("gbp_usd", "boe_fx", fxFrom, fxBefore);
  const fixes: FxFix[] = fxRows
    .filter((row) => Number.isFinite(row.value) && row.value > 0 && Number.isFinite(Date.parse(row.observedAt)))
    .map((row) => ({ value: row.value, observedAtIso: row.observedAt }))
    .sort((a, b) => a.observedAtIso.localeCompare(b.observedAtIso));

  const observations: RawObservation[] = [];
  let invalidEiaRows = 0;
  let unpairedEiaRows = 0;
  let fxIndex = 0;
  let nearestFx: FxFix | null = null;
  for (const row of [...rows].sort((a, b) => (a.period ?? "").localeCompare(b.period ?? ""))) {
    const period = row.period;
    if (!period || !/^\d{4}-\d{2}-\d{2}$/.test(period)) { invalidEiaRows++; continue; }
    const periodMs = Date.parse(`${period}T00:00:00Z`);
    const usd = typeof row.value === "string" ? Number(row.value) : row.value;
    if (!Number.isFinite(periodMs) || periodMs < fromMs || periodMs > toMs) continue;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) { invalidEiaRows++; continue; }
    const fxCutoff = new Date(periodMs + DAY_MS).toISOString();
    while (fxIndex < fixes.length && fixes[fxIndex]!.observedAtIso < fxCutoff) {
      nearestFx = fixes[fxIndex]!;
      fxIndex++;
    }
    if (!nearestFx || pairingError(period, nearestFx)) { unpairedEiaRows++; continue; }
    const value = Math.round((usd / nearestFx.value) * 100) / 100;
    const observedAt = `${period}T00:00:00Z`;
    observations.push({
      indicatorId: "brent_gbp",
      value,
      observedAt,
      sourceId: SOURCE_ID,
      payloadHash: `hist:${await sha256Hex(`eia:${period}:${usd}|fx:${nearestFx.observedAtIso}:${nearestFx.value}`)}`,
    });
  }
  const notes: string[] = [];
  if (invalidEiaRows) notes.push(`${invalidEiaRows} EIA rows had no usable date or price`);
  if (unpairedEiaRows) notes.push(`${unpairedEiaRows} EIA price dates lacked a BoE fix within five days`);
  if (rangeDays >= 7 && observations.length === 0) {
    throw new AdapterError({
      sourceId: SOURCE_ID,
      sourceUrl: EIA_BASE,
      message: `No EIA Brent prices could be paired with BoE FX for ${startDay} to ${endDay}`,
    });
  }
  return buildHistoricalResult(observations, `${EIA_BASE}?series=${EIA_BRENT_SERIES}`, notes);
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
  // With EIA credentials and D1 context, historical mode reads official EIA
  // daily prices and joins them to the stored BoE fixes. Offline mode retains
  // brent-history.json (2024-07 → 2026-10) for tests and local probes.
  async fetchHistorical(fetchImpl, opts, ctx): Promise<HistoricalFetchResult> {
    const apiKey = ctx?.secrets?.EIA_API_KEY;
    if (ctx && (apiKey || ctx.getObservationsInRange)) {
      if (!apiKey || !ctx.getObservationsInRange) {
        throw new AdapterError({
          sourceId: SOURCE_ID,
          sourceUrl: EIA_BASE,
          message: "EIA historical backfill requires EIA_API_KEY and D1 BoE FX lookup",
        });
      }
      return historicalFromEia(fetchImpl, opts, ctx, apiKey);
    }
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
