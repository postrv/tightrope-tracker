/**
 * UK housebuilder composite via EODHD or official LSE end-of-day closes.
 *
 * Equal-weighted composite of Persimmon, Barratt Redrow, Taylor Wimpey,
 * Berkeley, Vistry — rebased to 100 at the 2019 average closing price.
 * When EODHD is unavailable, requires all five official LSE closes for one
 * completed session. The editorial fixture is the final guarded fallback.
 *
 * EODHD free tier: 20 req/day. Each constituent requires one call,
 * so a full fetch uses 5 of 20. Run once daily (fiscal pipeline, 02:00 UTC).
 */
import type { AdapterContext, AdapterResult, DataSourceAdapter, RawObservation } from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError, fetchOrThrow } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";
import { assertFixtureFresh } from "../lib/fixtureFreshness.js";
import { londonCloseIso } from "../lib/londonClose.js";
import fixture from "../fixtures/housebuilders.json" with { type: "json" };

const SOURCE_ID = "eodhd_housebuilders";
const API_BASE = "https://eodhd.com/api/eod";
const LSE_API_BASE = "https://apidata.londonstockexchange.com/rdp/v1/pricing";
const FIXTURE_URL = "local:fixtures/housebuilders.json";
const MAX_FIXTURE_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days, fallback only
// Bound both connection/header latency and the response body. A stalled
// issuer must not leave the daily ingest audit open indefinitely.
const CONSTITUENT_TIMEOUT_MS = 10_000;

interface Constituent {
  symbol: string;
  lseTidm: string;
  lseRic: string;
  rebase2019: number;
}

const CONSTITUENTS: Constituent[] = [
  { symbol: "PSN",  lseTidm: "PSN",  lseRic: "PSN.L",  rebase2019: 2010.47 },
  { symbol: "BTRW", lseTidm: "BTRW", lseRic: "BTRW.L", rebase2019: 603.15 },
  { symbol: "TW",   lseTidm: "TW.",  lseRic: "TW.L",   rebase2019: 163.26 },
  { symbol: "BKG",  lseTidm: "BKG",  lseRic: "BKGH.L", rebase2019: 4684.43 },
  { symbol: "VTY",  lseTidm: "VTY",  lseRic: "VTYV.L", rebase2019: 919.61 },
];

// A changing subset would change the basket itself and break comparability.
const MIN_CONSTITUENTS = CONSTITUENTS.length;

interface EodhdCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjusted_close: number;
  volume: number;
}

function fetchFromFixture(fallbackReason: string): AdapterResult {
  const data = fixture as { observed_at: string; housebuilder_idx: { value: number }; source_url: string };
  // Fallback only: tripping the freshness guard here means BOTH the live
  // EODHD path and the editorial fixture have rotted. Surface it as a loud
  // AdapterError rather than silently re-emitting a stale composite on every
  // cron tick. Matches the 14-day guard on the sibling fixture-backed
  // adapters (LSEG FTSE 250, EIA Brent).
  assertFixtureFresh(data.observed_at, MAX_FIXTURE_AGE_MS, SOURCE_ID, FIXTURE_URL);
  return {
    observations: [{
      indicatorId: "housebuilder_idx",
      value: data.housebuilder_idx.value,
      observedAt: data.observed_at,
      sourceId: SOURCE_ID,
      payloadHash: "fixture-fallback",
    }],
    sourceUrl: FIXTURE_URL,
    fetchedAt: new Date().toISOString(),
    fallbackReason: `live retrieval unavailable; serving guarded fixture: ${fallbackReason}`,
  };
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function londonCalendarDate(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** An older live row would become the latest ingestion and move the shared
 * current-live ceiling backwards. Keep genuine older data for diagnostics,
 * but mark it degraded so runAdapter leaves stored observations untouched.
 * Production always supplies this lookup; source-only probes may omit it. */
async function guardStoredHead(result: AdapterResult, ctx?: AdapterContext): Promise<AdapterResult> {
  if (result.fallbackReason || !ctx?.getObservationBefore) return result;
  const reject = (reason: string): AdapterResult => ({ ...result, fallbackReason: reason });
  try {
    const stored = await ctx.getObservationBefore("housebuilder_idx", SOURCE_ID, new Date().toISOString());
    if (!stored) return result;
    const candidateMs = Date.parse(result.observations[0]!.observedAt);
    const storedMs = Date.parse(stored.observedAt);
    if (!Number.isFinite(candidateMs) || !Number.isFinite(storedMs)) {
      return reject("housebuilder stored-head verification returned an invalid reference timestamp; candidate withheld");
    }
    if (candidateMs < storedMs) {
      return reject("housebuilder provider candidate predates the stored verified head; retaining the newer reading");
    }
    return result; // equal timestamps allow legitimate same-session revisions
  } catch {
    return reject("housebuilder stored-head verification unavailable; candidate withheld");
  }
}

/** A deadline covers both HTTP headers and the body, even when an injected
 * fetch ignores abort. Error text is deliberately bounded and contains no URL
 * (the EODHD URL contains a secret). */
async function fetchJsonWithinDeadline(
  fetchImpl: typeof globalThis.fetch,
  url: string,
): Promise<unknown> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let readingBody = false;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error("constituent request timed out"));
      }, CONSTITUENT_TIMEOUT_MS);
    });
    return await Promise.race([
      (async () => {
        const res = await fetchOrThrow(fetchImpl, SOURCE_ID, url, { signal: controller.signal });
        readingBody = true;
        return await res.json() as unknown;
      })(),
      timeout,
    ]);
  } catch (err) {
    const reason = controller.signal.aborted
      ? `request timed out after ${CONSTITUENT_TIMEOUT_MS}ms`
      : readingBody ? "invalid JSON"
        : err instanceof AdapterError && err.status ? `HTTP ${err.status}` : "network fetch failed";
    throw new Error(reason);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function fetchConstituent(
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
  symbol: string,
  failures: string[],
): Promise<EodhdCandle[]> {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86_400_000);
  const url = `${API_BASE}/${symbol}.LSE?api_token=${apiKey}&fmt=json&from=${formatDate(from)}&to=${formatDate(to)}&order=d`;
  let candles: EodhdCandle[];
  try {
    candles = await fetchJsonWithinDeadline(fetchImpl, url) as EodhdCandle[];
  } catch (err) {
    const reason = (err as Error).message;
    console.warn(`${SOURCE_ID}: ${symbol}: ${reason}`);
    failures.push(`${symbol}: ${reason}`);
    return [];
  }

  if (!Array.isArray(candles) || candles.length === 0) {
    console.warn(`${SOURCE_ID}: no candles returned for ${symbol}`);
    failures.push(`${symbol}: no candles returned`);
    return [];
  }

  // Providers can expose today's daily bar before the cash session closes.
  // Keep the whole window so the composite can use a common completed
  // session even when one constituent's latest bar is delayed.
  return candles.filter((candle) => {
    if (!candle || typeof candle.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(candle.date)) return false;
    const dayMs = Date.parse(`${candle.date}T00:00:00Z`);
    if (!Number.isFinite(dayMs) || new Date(dayMs).toISOString().slice(0, 10) !== candle.date) return false;
    const closeMs = Date.parse(londonCloseIso(candle.date));
    // Allow the closing auction five minutes to settle, matching FTSE 250.
    return Number.isFinite(closeMs) && closeMs + 5 * 60_000 <= to.getTime()
      && Number.isFinite(candle.close) && candle.close > 0;
  });
}

function officialDateToYmd(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})$/.exec(value);
  if (!match) return null;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const ymd = `${match[3]}-${String(months.indexOf(match[2]!) + 1).padStart(2, "0")}-${match[1]!.padStart(2, "0")}`;
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === ymd ? ymd : null;
}

/** Public endpoints advertised by LSE's own quote-page FinancialDataProvider.
 * RIC identities were resolved using its /rdp/v1/ric?tidm= endpoint and recorded
 * alongside the 28 October source captures. OFF_CLOSE is essential: the last
 * trade field can be a different price after the closing auction. */
async function fetchLseOfficialCloses(
  fetchImpl: typeof globalThis.fetch,
  failures: string[],
): Promise<AdapterResult | null> {
  const nowMs = Date.now();
  const closes = await Promise.all(CONSTITUENTS.map(async (constituent) => {
    try {
      const payload = await fetchJsonWithinDeadline(fetchImpl, `${LSE_API_BASE}?ric=${constituent.lseRic}`) as {
        statusCode?: number; data?: Record<string, unknown>;
      } | null;
      const data = payload?.data;
      if (payload?.statusCode !== 200 || !data
        || data.TIDM !== constituent.lseTidm
        || (data.RIC !== `/${constituent.lseRic}` && data.RIC !== constituent.lseRic)
        || data.CURRENCY !== "GBX"
        || data.PERIOD_DESCRIPTION !== "Closed"
        || data.PERIOD_CDE !== "c"
        || data["TRD_STATUS-PERIOD_CDE"] !== "Normal - Closed") {
        throw new Error("identity, currency or completed-session status did not match");
      }
      const date = officialDateToYmd(data.OFF_CLS_DT);
      const priceText = data.OFF_CLOSE;
      const close = typeof priceText === "string" && /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(priceText)
        ? Number(priceText.replaceAll(",", "")) : NaN;
      if (!date || !Number.isFinite(close) || close <= 0
        || Date.parse(londonCloseIso(date)) + 5 * 60_000 > nowMs) {
        throw new Error("missing official close or session not yet completed");
      }
      return { constituent, date, close };
    } catch (err) {
      failures.push(`LSE ${constituent.symbol}: ${(err as Error).message}`);
      return null;
    }
  }));
  const complete = closes.filter((row) => row !== null);
  if (complete.length !== CONSTITUENTS.length) return null;
  if (new Set(complete.map(row => row.date)).size !== 1) {
    failures.push("LSE official closes do not share one completed session");
    return null;
  }
  const composite = complete.reduce((sum, row) => sum + row.close / row.constituent.rebase2019 * 100, 0) / complete.length;
  const payloadHash = await sha256Hex(complete.map(row => `${row.constituent.symbol}:${row.close}`).join("|"));
  return {
    observations: [{
      indicatorId: "housebuilder_idx",
      value: Math.round(composite * 10) / 10,
      observedAt: londonCloseIso(complete[0]!.date),
      sourceId: SOURCE_ID,
      payloadHash,
    }],
    // Representative actually fetched primary endpoint; every constituent's
    // URL and original response are retained in the recorded provenance.
    sourceUrl: `${LSE_API_BASE}?ric=${CONSTITUENTS[0]!.lseRic}`,
    fetchedAt: new Date().toISOString(),
  };
}

export const eodhdHousebuildersAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "EODHD / LSE -- UK housebuilder composite (completed daily closes)",
  async fetch(fetchImpl, ctx?: AdapterContext): Promise<AdapterResult> {
    const apiKey = ctx?.secrets?.EODHD_API_KEY;
    if (!apiKey) {
      const failures = ["no EODHD_API_KEY in context"];
      return guardStoredHead(await fetchLseOfficialCloses(fetchImpl, failures)
        ?? fetchFromFixture(failures.join("; ")), ctx);
    }

    const sessions = new Map<string, Map<string, { close: number; rebased: number }>>();
    const failures: string[] = [];

    for (const c of CONSTITUENTS) {
      const candles = await fetchConstituent(fetchImpl, apiKey, c.symbol, failures);
      for (const candle of candles) {
        const session = sessions.get(candle.date) ?? new Map();
        // One issuer contributes once per session, even if a malformed
        // upstream response repeats a row.
        if (!session.has(c.symbol)) session.set(c.symbol, {
          close: candle.close,
          rebased: (candle.close / c.rebase2019) * 100,
        });
        sessions.set(candle.date, session);
      }
    }

    const latestDate = [...sessions.keys()].sort().reverse()
      .find((date) => sessions.get(date)!.size >= MIN_CONSTITUENTS);
    if (!latestDate) {
      failures.unshift(`fewer than ${MIN_CONSTITUENTS} EODHD constituents share a completed session`);
      return guardStoredHead(await fetchLseOfficialCloses(fetchImpl, failures)
        ?? fetchFromFixture(failures.join("; ")), ctx);
    }

    const session = sessions.get(latestDate)!;
    const rebasedValues = [...session.values()].map((part) => part.rebased);
    const rawParts = [...session.entries()].map(([symbol, part]) => `${symbol}:${part.close}`);
    const composite = rebasedValues.reduce((a, b) => a + b, 0) / rebasedValues.length;
    const observedAt = londonCloseIso(latestDate);
    const today = londonCalendarDate();
    // EODHD can be delayed even on the following morning. Check LSE whenever
    // its full basket predates the London calendar day; LSE's parser itself
    // enforces the completed-session cutoff.
    // Weekends/holidays are safe: only an actual common official close date
    // can advance the observation; the current calendar date is never emitted.
    if (latestDate < today) {
      const lse = await fetchLseOfficialCloses(fetchImpl, failures);
      if (lse && Date.parse(lse.observations[0]!.observedAt) > Date.parse(observedAt)) return guardStoredHead(lse, ctx);
    }
    const payloadHash = await sha256Hex(rawParts.join("|"));

    const observations: RawObservation[] = [{
      indicatorId: "housebuilder_idx",
      value: Math.round(composite * 10) / 10,
      observedAt,
      sourceId: SOURCE_ID,
      payloadHash,
    }];

    return guardStoredHead({
      observations,
      sourceUrl: `https://eodhd.com/api/eod/?exchange=LSE`,
      fetchedAt: new Date().toISOString(),
    }, ctx);
  },
};

registerAdapter(eodhdHousebuildersAdapter);
