/**
 * FTSE 250 index-level adapter (fixture-backed).
 *
 * LSEG doesn't expose a free API for index closes. The adapter reads a
 * weekly-refreshed editorial fixture and guards against silent rot with
 * `assertFixtureFresh`: a fixture older than 14 days raises an
 * `AdapterError` so the miss surfaces via `/admin/health` rather than a
 * stale number continuing to paint green on the dashboard.
 *
 * TODO(source): swap for a licensed LSEG index-level vendor once free
 * alternatives are ruled out.
 */
import fixture from "../fixtures/ftse-250.json" with { type: "json" };
import history from "../fixtures/ftse-250-history.json" with { type: "json" };
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

const SOURCE_ID = "lseg";
const FIXTURE_URL = "local:fixtures/ftse-250.json";
const HISTORY_FIXTURE_URL = "local:fixtures/ftse-250-history.json";
const MAX_FIXTURE_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

interface Ftse250Fixture {
  observed_at: string;
  ftse_250: { value: number; unit: string };
  source_url: string;
}

interface Ftse250HistoryPoint {
  observed_at: string;
  value: number;
}

interface Ftse250HistoryFixture {
  points: readonly Ftse250HistoryPoint[];
}

export const lseFtse250Adapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "LSEG FTSE 250 (fixture-backed)",
  async fetch(): Promise<AdapterResult> {
    const data = fixture as unknown as Ftse250Fixture;
    if (!data || typeof data.ftse_250?.value !== "number" || !Number.isFinite(data.ftse_250.value)) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: FIXTURE_URL,
        message: "ftse_250 fixture missing numeric value",
      });
    }
    assertFixtureFresh(data.observed_at, MAX_FIXTURE_AGE_MS, SOURCE_ID, FIXTURE_URL);
    const hash = await sha256Hex(JSON.stringify(data));
    return {
      observations: [{
        indicatorId: "ftse_250",
        value: data.ftse_250.value,
        observedAt: data.observed_at,
        sourceId: SOURCE_ID,
        payloadHash: hash,
      }],
      sourceUrl: data.source_url ?? FIXTURE_URL,
      fetchedAt: new Date().toISOString(),
    };
  },
  // Historical mode reads ftse-250-history.json (Yahoo ^FTMC daily closes
  // 2024-07 → 2026-04). Yahoo's prints can drift ~1% from the LSEG closing-
  // auction print on the most recent days; the live `fetch()` above remains
  // the authority for the head value, so historical rows never overwrite a
  // live row at the same observedAt.
  async fetchHistorical(_fetchImpl, opts): Promise<HistoricalFetchResult> {
    const { fromMs, toMs } = rangeUtcBounds(opts);
    const data = history as unknown as Ftse250HistoryFixture;
    const observations: RawObservation[] = [];
    let skippedOutOfRange = 0;

    for (const point of data.points) {
      const ms = Date.parse(point.observed_at);
      if (!Number.isFinite(ms)) continue;
      if (ms < fromMs || ms > toMs) { skippedOutOfRange++; continue; }
      if (typeof point.value !== "number" || !Number.isFinite(point.value)) continue;
      observations.push({
        indicatorId: "ftse_250",
        value: point.value,
        observedAt: point.observed_at,
        sourceId: SOURCE_ID,
        payloadHash: await historicalPayloadHash("ftse_250", point.observed_at, point.value),
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

registerAdapter(lseFtse250Adapter);
