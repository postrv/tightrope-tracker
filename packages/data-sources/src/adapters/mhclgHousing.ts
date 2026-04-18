/**
 * MHCLG / DLUHC housing statistics adapter.
 *
 * MHCLG releases are XLSX/ODS attachments behind gov.uk collection pages --
 * no stable CSV-over-HTTP endpoint. Live and historical paths are both
 * fixture-backed: each MHCLG quarterly release is manually extracted from the
 * HTML statistical release page and added to `housing.json` (live, just the
 * latest quarter) and `housing-history.json` (curated quarterly back-series).
 *
 * Methodology (both paths use the same formulas; see housing-history.json's
 * `methodology` block for the primary-source rationale):
 *   - housing_trajectory = completions_sa_quarterly * 4 / 300,000 * 100
 *   - planning_consents  = residential_decisions_granted_quarterly / 11,500 * 100
 *
 * The `fetchHistorical` path emits observations with the `hist:` payload-hash
 * convention so writeHistoricalObservations accepts them; this distinguishes
 * curated history from both live (raw sha256 of the upstream payload) and
 * seed (`seed_*` prefix) rows in the audit trail.
 *
 * TODO(source):
 *   - https://www.gov.uk/government/statistics/housing-supply-net-additional-dwellings-england
 *   - https://www.gov.uk/government/statistical-data-sets/live-tables-on-planning-application-statistics
 */
import fixture from "../fixtures/housing.json" with { type: "json" };
import history from "../fixtures/housing-history.json" with { type: "json" };
import type {
  AdapterResult,
  DataSourceAdapter,
  HistoricalFetchResult,
  RawObservation,
} from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError } from "../lib/errors.js";
import { historicalPayloadHash, sha256Hex } from "../lib/hash.js";
import { buildHistoricalResult, rangeUtcBounds } from "../lib/historical.js";

const SOURCE_ID = "mhclg";
const FIXTURE_URL = "local:fixtures/housing.json";
const HISTORY_FIXTURE_URL = "local:fixtures/housing-history.json";

interface HousingFixture {
  observed_at: string;
  housing_trajectory?: { value: number };
  planning_consents?: { value: number };
  source_url?: string;
}

interface HistoryPoint {
  observed_at: string;
  housing_trajectory?: { value: number | null };
  planning_consents?: { value: number | null };
}

interface HistoryFixture {
  points: readonly HistoryPoint[];
}

export const mhclgHousingAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "MHCLG housing statistics (fixture-backed)",
  async fetch(_fetchImpl): Promise<AdapterResult> {
    const data = fixture as unknown as HousingFixture;
    if (!data) {
      throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: FIXTURE_URL, message: "MHCLG: fixture missing" });
    }
    const hash = await sha256Hex(JSON.stringify(data));
    const observations: RawObservation[] = [];
    if (typeof data.housing_trajectory?.value === "number") {
      observations.push({
        indicatorId: "housing_trajectory",
        value: data.housing_trajectory.value,
        observedAt: data.observed_at,
        sourceId: SOURCE_ID,
        payloadHash: hash,
      });
    }
    if (typeof data.planning_consents?.value === "number") {
      observations.push({
        indicatorId: "planning_consents",
        value: data.planning_consents.value,
        observedAt: data.observed_at,
        sourceId: SOURCE_ID,
        payloadHash: hash,
      });
    }
    if (observations.length === 0) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: FIXTURE_URL,
        message: "MHCLG: fixture yielded zero observations",
      });
    }
    return { observations, sourceUrl: data.source_url ?? FIXTURE_URL, fetchedAt: new Date().toISOString() };
  },
  async fetchHistorical(_fetchImpl, opts): Promise<HistoricalFetchResult> {
    const { fromMs, toMs } = rangeUtcBounds(opts);
    const data = history as unknown as HistoryFixture;
    const observations: RawObservation[] = [];
    let skippedNull = 0;
    let skippedOutOfRange = 0;

    for (const point of data.points) {
      const ms = Date.parse(point.observed_at);
      if (!Number.isFinite(ms)) continue;
      if (ms < fromMs || ms > toMs) { skippedOutOfRange++; continue; }
      for (const indicatorId of ["housing_trajectory", "planning_consents"] as const) {
        const val = point[indicatorId]?.value;
        if (typeof val !== "number" || !Number.isFinite(val)) {
          if (val === null) skippedNull++;
          continue;
        }
        observations.push({
          indicatorId,
          value: val,
          observedAt: point.observed_at,
          sourceId: SOURCE_ID,
          payloadHash: await historicalPayloadHash(indicatorId, point.observed_at, val),
        });
      }
    }

    // Ensure ascending order by observedAt, then indicatorId for deterministic output.
    observations.sort((a, b) =>
      a.observedAt < b.observedAt ? -1
      : a.observedAt > b.observedAt ? 1
      : a.indicatorId < b.indicatorId ? -1
      : a.indicatorId > b.indicatorId ? 1 : 0,
    );

    const notes: string[] = [];
    if (skippedOutOfRange > 0) notes.push(`${skippedOutOfRange} quarters outside requested range`);
    if (skippedNull > 0) notes.push(`${skippedNull} null series values skipped (unextracted primary figures)`);
    return buildHistoricalResult(observations, HISTORY_FIXTURE_URL, notes);
  },
};

registerAdapter(mhclgHousingAdapter);
