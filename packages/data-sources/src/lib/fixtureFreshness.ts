import { AdapterError } from "./errors.js";

/**
 * Assert that a fixture's declared `observed_at` is recent enough that we
 * can defensibly emit an observation for it. If the fixture has drifted
 * past `maxAgeMs`, throw an `AdapterError` so the ingest audit shows a
 * loud failure rather than silently re-emitting stale data on every cron.
 *
 * Fixture-backed adapters (OBR EFO, LSE housebuilders, ICE gas, LSEG
 * FTSE 250, etc.) are editorially refreshed, not API-driven. Without a
 * freshness guard, a forgotten editorial refresh means the adapter
 * cheerfully writes the same observation every 5 minutes, resetting the
 * `ingested_at` timestamp while the underlying figure quietly rots. A
 * hostile reader inspecting the live API snapshot sees "Updated 08:47
 * UTC" next to a price that last moved six months ago. That's exactly
 * the class of silent staleness this guard exists to prevent.
 *
 * @param observedAt ISO-8601 timestamp from the fixture
 * @param maxAgeMs   Threshold above which the fixture is considered stale
 * @param sourceId   Adapter source id, propagated into the AdapterError
 * @param sourceUrl  Source URL (or `local:fixtures/...`) for error context
 * @param now        Clock injection for testing; defaults to `Date.now()`
 */
export function assertFixtureFresh(
  observedAt: string,
  maxAgeMs: number,
  sourceId: string,
  sourceUrl: string,
  now: number = Date.now(),
): void {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) {
    throw new AdapterError({
      sourceId,
      sourceUrl,
      message: `fixture observed_at '${observedAt}' is not a valid ISO-8601 timestamp`,
    });
  }
  const ageMs = now - observedMs;
  if (ageMs > maxAgeMs) {
    const ageDays = (ageMs / 86_400_000).toFixed(1);
    const maxDays = (maxAgeMs / 86_400_000).toFixed(1);
    throw new AdapterError({
      sourceId,
      sourceUrl,
      message: `fixture is stale: observed_at was ${ageDays} days ago, threshold ${maxDays} days. Refresh the fixture and redeploy.`,
    });
  }
}
