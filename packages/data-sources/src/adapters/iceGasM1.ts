/**
 * UK natural-gas front-month adapter (fixture-backed).
 *
 * The M+1 NBP settlement is published daily by ICE Endex but requires a
 * commercial feed to consume via API. We mirror the published settlement
 * headline on a weekly editorial cadence via `fixtures/gas-m1.json` and
 * guard against silent rot with `assertFixtureFresh`: if the fixture's
 * `observed_at` drifts past 14 days, the adapter raises an `AdapterError`
 * so the miss is visible in `/admin/health` and the ingest audit log.
 *
 * TODO(source): replace with a licensed ICE Endex API once budget permits
 * or a free Ofgem/Elexon spot-price mirror lands.
 */
import fixture from "../fixtures/gas-m1.json" with { type: "json" };
import type { AdapterResult, DataSourceAdapter } from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";
import { assertFixtureFresh } from "../lib/fixtureFreshness.js";

const SOURCE_ID = "ice_gas";
const FIXTURE_URL = "local:fixtures/gas-m1.json";
const MAX_FIXTURE_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

interface GasFixture {
  observed_at: string;
  gas_m1: { value: number; unit: string };
  source_url: string;
}

export const iceGasM1Adapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "ICE UK Natural Gas front-month (fixture-backed)",
  async fetch(): Promise<AdapterResult> {
    const data = fixture as unknown as GasFixture;
    if (!data || typeof data.gas_m1?.value !== "number" || !Number.isFinite(data.gas_m1.value)) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: FIXTURE_URL,
        message: "gas_m1 fixture missing numeric value",
      });
    }
    assertFixtureFresh(data.observed_at, MAX_FIXTURE_AGE_MS, SOURCE_ID, FIXTURE_URL);
    const hash = await sha256Hex(JSON.stringify(data));
    return {
      observations: [{
        indicatorId: "gas_m1",
        value: data.gas_m1.value,
        observedAt: data.observed_at,
        sourceId: SOURCE_ID,
        payloadHash: hash,
      }],
      sourceUrl: data.source_url ?? FIXTURE_URL,
      fetchedAt: new Date().toISOString(),
    };
  },
};

registerAdapter(iceGasM1Adapter);
