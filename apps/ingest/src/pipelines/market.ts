import {
  boeBreakevensAdapter,
  boeFxAdapter,
  boeSoniaAdapter,
  boeYieldsAdapter,
  eiaBrentAdapter,
  growthSentimentAdapter,
  lseHousebuildersAdapter,
} from "@tightrope/data-sources";
import type { Env } from "../env.js";
import { isUkMarketHours } from "../lib/time.js";
import { runAdapter } from "./runAdapter.js";

/**
 * Market pipeline. Runs on the every-5-minute cron, but throttles to UK market
 * hours (07:00-16:30 Europe/London) so we don't hammer the BoE IADB endpoint
 * overnight. Outside market hours we still tick the recompute pipeline
 * but skip the fetches.
 *
 * Adapter ordering:
 *   1. BoE IADB live adapters (yields, FX, SONIA, breakevens) -- hit the same
 *      origin so we serialise to stay polite.
 *   2. Fixture-backed OBR-proxy adapters (housebuilders, Brent-in-GBP, growth
 *      sentiment composite) -- these are local reads, do no I/O against the
 *      public internet, but are fired through the same runAdapter path so they
 *      appear in the ingestion_audit log and surface in the observability UI.
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
  await runAdapter(env, boeYieldsAdapter);
  await runAdapter(env, boeFxAdapter);
  await runAdapter(env, boeSoniaAdapter);
  await runAdapter(env, boeBreakevensAdapter);
  // OBR-proxy fixture reads. Cheap and local; order is alphabetic for log sanity.
  await runAdapter(env, eiaBrentAdapter);
  await runAdapter(env, growthSentimentAdapter);
  await runAdapter(env, lseHousebuildersAdapter);
  return { ran: true };
}
