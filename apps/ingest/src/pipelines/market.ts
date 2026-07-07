import {
  eiaBrentAdapter,
  growthSentimentAdapter,
  lseFtse250Adapter,
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
 * BoE adapters (yields, FX, breakevens) are NOT run here since 2026-07-07:
 * the IADB blocks Cloudflare Workers egress (HTTP 500, since 2026-06-10), so
 * their network leg runs on a GitHub Actions runner instead -- the relay-boe
 * workflow POSTs the raw CSVs to /admin/relay weekdays 09:30 UTC, which
 * replays them through the same runAdapter machinery. Running them here too
 * only generated a guaranteed failure + DLQ entry every 5 minutes. BoE daily
 * series are T+1, so the daily relay loses no freshness vs this cron.
 *
 * Remaining adapters: OBR-proxy (Brent-in-GBP, growth sentiment composite)
 * and the FTSE 250 close. Housebuilders live in the fiscal pipeline (daily
 * via EODHD, free-tier rate limit).
 */
export async function ingestMarket(
  env: Env,
  opts: { now?: Date; force?: boolean } = {},
): Promise<{ ran: boolean }> {
  if (!opts.force && !isUkMarketHours(opts.now ?? new Date())) {
    return { ran: false };
  }
  // Each adapter runs under runAdapterSafe so one upstream failure doesn't
  // block the rest of the pipeline or the downstream recompute.
  await runAdapterSafe(env, eiaBrentAdapter);
  await runAdapterSafe(env, growthSentimentAdapter);
  await runAdapterSafe(env, lseFtse250Adapter);
  return { ran: true };
}
