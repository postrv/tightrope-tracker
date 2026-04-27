/**
 * EIA Europe Brent Spot Price, priced in GBP (fixture-backed).
 *
 * The canonical Brent series is the EIA daily table. The EIA's free publication
 * is an XLS file which is not parseable from a Cloudflare Worker; the EIA Open
 * Data API requires a registration key. We therefore mirror the daily EIA value
 * via a hand-curated fixture -- refreshed weekly -- and convert to GBP using
 * the BoE 4pm spot fix captured in the same fixture snapshot.
 *
 * Brent in GBP is an OBR proxy for the CPI energy subcomponent and fuel-duty
 * receipts: OBR's medium-term CPI profile bakes in a Brent path that comes
 * straight from the futures curve at forecast close.
 *
 * TODO(source): https://www.eia.gov/dnav/pet/hist/rbrted.htm -- replace with a
 * live feed once either (a) ingest supports XLS parsing, or (b) we subscribe
 * to a commodity API that ships a JSON daily close.
 */
import fixture from "../fixtures/brent.json" with { type: "json" };
import history from "../fixtures/brent-history.json" with { type: "json" };
import type {
  AdapterResult,
  DataSourceAdapter,
  HistoricalFetchResult,
  RawObservation,
} from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError } from "../lib/errors.js";
import { historicalPayloadHash, sha256Hex } from "../lib/hash.js";
import { assertFixtureFresh } from "../lib/fixtureFreshness.js";
import { buildHistoricalResult, rangeUtcBounds } from "../lib/historical.js";

const SOURCE_ID = "eia_brent";
const FIXTURE_URL = "local:fixtures/brent.json";
const HISTORY_FIXTURE_URL = "local:fixtures/brent-history.json";
// EIA / BoE 4pm fix is editorially refreshed weekly. 14 days matches the
// other weekly fixtures (FTSE 250, ICE gas) and gives a ~one-week grace
// period before the guard trips.
const MAX_FIXTURE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

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

export const eiaBrentAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "EIA Brent spot in GBP (fixture-backed)",
  async fetch(_fetchImpl): Promise<AdapterResult> {
    const data = fixture as unknown as BrentFixture;
    if (!data || typeof data.brent_gbp?.value !== "number") {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: FIXTURE_URL,
        message: "Brent: fixture missing brent_gbp.value",
      });
    }
    // Without this guard a forgotten editorial refresh would silently
    // re-emit the same value indefinitely while ingested_at advanced.
    // Trip loudly into the audit log instead.
    assertFixtureFresh(data.observed_at, MAX_FIXTURE_AGE_MS, SOURCE_ID, FIXTURE_URL);
    const hash = await sha256Hex(JSON.stringify(data));
    return {
      observations: [{
        indicatorId: "brent_gbp",
        value: data.brent_gbp.value,
        observedAt: data.observed_at,
        sourceId: SOURCE_ID,
        payloadHash: hash,
      }],
      sourceUrl: data.source_url ?? FIXTURE_URL,
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
