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
import type { AdapterResult, DataSourceAdapter } from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";
import { assertFixtureFresh } from "../lib/fixtureFreshness.js";

const SOURCE_ID = "lseg";
const FIXTURE_URL = "local:fixtures/ftse-250.json";
const MAX_FIXTURE_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

interface Ftse250Fixture {
  observed_at: string;
  ftse_250: { value: number; unit: string };
  source_url: string;
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
};

registerAdapter(lseFtse250Adapter);
