import { eiaBrentAdapter } from "@tightrope/data-sources";
import type { Env } from "../env.js";
import { backfillObservations, type BackfillObservationsResult } from "./backfillObservations.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 14;

/**
 * Fill recent EIA price dates after the BoE FX relay has landed. EIA can
 * publish several daily prices between market ingest runs, while the live
 * adapter only emits its newest print. Existing observations are preserved:
 * a later revision of EIA's history must not silently change a frozen date.
 */
export async function backfillRecentBrent(
  env: Env,
  now: Date = new Date(),
): Promise<BackfillObservationsResult> {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return backfillObservations(env, eiaBrentAdapter, {
    from: new Date(todayUtc - LOOKBACK_DAYS * DAY_MS),
    to: new Date(todayUtc - 1),
    dryRun: false,
    overwrite: false,
  });
}
