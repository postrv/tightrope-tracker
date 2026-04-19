/**
 * Editorial delivery-milestones adapter (fixture-backed).
 *
 * The four indicators here (`new_towns_milestones`, `bics_rollout`,
 * `industrial_strategy`, `smr_programme`) are editorial interpretations of
 * political commitments: percent-of-target-milestones-hit scored against
 * published departmental plans. The underlying sources are gov.uk press
 * releases, select-committee evidence, and departmental dashboards —
 * there is no machine-readable feed for any of them.
 *
 * Before this adapter landed, all four had `provenance: "editorial"` and
 * a 365-day staleness window, which meant the seed-generator values
 * could sit in the public snapshot indefinitely without ever tripping a
 * stale warning. The adapter closes that gap:
 *
 *   - `fixtures/delivery-milestones.json` is the single source of truth;
 *     each indicator carries its own `sourceId` (gov_uk, desnz, dbt) plus
 *     a deep-link `source_url` and a brief methodology note.
 *   - `assertFixtureFresh` with a 90-day threshold rejects stale fixtures
 *     so an abandoned refresh becomes an ingest-audit failure.
 *   - The adapter registers against the `delivery` pillar's ingest
 *     pipeline and runs on the daily `30 2 * * *` cron.
 *
 * TODO(source): when a department publishes a machine-readable milestone
 * feed, spin out a dedicated adapter (e.g. `desnzBics.ts`) and drop the
 * indicator from this fixture.
 */
import fixture from "../fixtures/delivery-milestones.json" with { type: "json" };
import type { AdapterResult, DataSourceAdapter, RawObservation } from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";
import { assertFixtureFresh } from "../lib/fixtureFreshness.js";

const SOURCE_ID = "delivery_milestones";
const FIXTURE_URL = "local:fixtures/delivery-milestones.json";
const MAX_FIXTURE_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days: quarterly cadence + slack

interface MilestoneEntry {
  value: number;
  unit: string;
  sourceId: string;
  source_url: string;
  source_label: string;
  methodology: string;
}

interface MilestoneFixture {
  observed_at: string;
  indicators: Record<string, MilestoneEntry>;
}

export const deliveryMilestonesAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "Editorial delivery milestones (fixture-backed)",
  async fetch(): Promise<AdapterResult> {
    const data = fixture as unknown as MilestoneFixture;
    if (!data || !data.indicators || typeof data.indicators !== "object") {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: FIXTURE_URL,
        message: "delivery-milestones fixture malformed — missing indicators",
      });
    }
    assertFixtureFresh(data.observed_at, MAX_FIXTURE_AGE_MS, SOURCE_ID, FIXTURE_URL);
    const hash = await sha256Hex(JSON.stringify(data));
    const observations: RawObservation[] = [];
    for (const [indicatorId, entry] of Object.entries(data.indicators)) {
      if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
        throw new AdapterError({
          sourceId: SOURCE_ID,
          sourceUrl: FIXTURE_URL,
          message: `delivery-milestones: '${indicatorId}' has non-numeric value`,
        });
      }
      if (typeof entry.sourceId !== "string" || entry.sourceId === "") {
        throw new AdapterError({
          sourceId: SOURCE_ID,
          sourceUrl: FIXTURE_URL,
          message: `delivery-milestones: '${indicatorId}' missing sourceId`,
        });
      }
      observations.push({
        indicatorId,
        value: entry.value,
        observedAt: data.observed_at,
        // Carry the indicator-specific upstream sourceId so /sources
        // renders each milestone against its owning department, not
        // against a blanket 'editorial' catch-all.
        sourceId: entry.sourceId,
        payloadHash: hash,
      });
    }
    if (observations.length === 0) {
      throw new AdapterError({
        sourceId: SOURCE_ID,
        sourceUrl: FIXTURE_URL,
        message: "delivery-milestones fixture yielded zero observations",
      });
    }
    return {
      observations,
      sourceUrl: FIXTURE_URL,
      fetchedAt: new Date().toISOString(),
    };
  },
};

registerAdapter(deliveryMilestonesAdapter);
