import {
  boeBreakevensAdapter,
  boeFxAdapter,
  boeSoniaAdapter,
  boeYieldsAdapter,
  eiaBrentAdapter,
  growthSentimentAdapter,
  iceGasM1Adapter,
  lseFtse250Adapter,
  twelveDataHousebuildersAdapter,
} from "@tightrope/data-sources";
import type { Env } from "../env.js";
import { isUkMarketHours } from "../lib/time.js";
import { runAdapterSafe } from "./runAdapter.js";

/**
 * Market pipeline. Runs on the every-5-minute cron, but throttles to UK market
 * hours (07:00-16:30 Europe/London) so we don't hammer the BoE IADB endpoint
 * overnight. Outside market hours we still tick the recompute pipeline
 * but skip the fetches.
 *
 * Adapter ordering:
 *   1. BoE IADB live adapters (yields, FX, SONIA, breakevens) -- hit the same
 *      origin so we serialise to stay polite.
 *   2. OBR-proxy adapters (housebuilders via Twelve Data, Brent-in-GBP, growth
 *      sentiment composite). Housebuilders now hit a live API (falls back to
 *      fixture if TWELVE_DATA_KEY is unset); the rest are still fixture-backed.
 */
export async function ingestMarket(
  env: Env,
  opts: { now?: Date; force?: boolean } = {},
): Promise<{ ran: boolean }> {
  if (!opts.force && !isUkMarketHours(opts.now ?? new Date())) {
    return { ran: false };
  }
  // Fire each BoE adapter serially -- they hit the same origin and a serial
  // flow is both kinder on the origin and easier to reason about in logs.
  // Each runs under runAdapterSafe so one upstream failure doesn't block the
  // rest of the pipeline or the downstream recompute. runAdapter already
  // records the failure to ingestion_audit and the DLQ; we swallow here so
  // the caller can proceed to the next adapter and ultimately to recompute.
  await runAdapterSafe(env, boeYieldsAdapter);
  await runAdapterSafe(env, boeFxAdapter);
  await runAdapterSafe(env, boeSoniaAdapter);
  await runAdapterSafe(env, boeBreakevensAdapter);
  await runAdapterSafe(env, eiaBrentAdapter);
  await runAdapterSafe(env, growthSentimentAdapter);
  await runAdapterSafe(env, twelveDataHousebuildersAdapter);
  await runAdapterSafe(env, iceGasM1Adapter);
  await runAdapterSafe(env, lseFtse250Adapter);
  return { ran: true };
}
