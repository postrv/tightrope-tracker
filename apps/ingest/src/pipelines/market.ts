import {
  eiaBrentAdapter,
  growthSentimentAdapter,
  lseFtse250Adapter,
  eodhdHousebuildersAdapter,
} from "@tightrope/data-sources";
import type { Env } from "../env.js";
import { isUkCloseCatchup, isUkMarketHours, isUkOpenRecovery } from "../lib/time.js";
import { runAdapterSafe } from "./runAdapter.js";

/**
 * Market pipeline. Runs on the every-5-minute cron, but throttles to UK market
 * hours (07:00-16:30 Europe/London), plus two post-close checks at 16:35 and
 * 18:05 London. A gate ending at 16:30 could never collect today's close:
 * the equity adapters deliberately reject its unfinished bar until 16:35.
 * Recompute continues outside these fetch windows.
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
 * and completed equity closes. FTSE runs once at 07:00 recovery and twice
 * after close; housebuilders run in the two close checks and the existing
 * 02:00 fiscal pipeline. This budgets 18 EODHD constituent/index calls per
 * weekday (three index calls plus three five-issuer composites), within the
 * existing 20-call allowance. Sentiment/Brent keep the five-minute polling.
 */
export async function ingestMarket(
  env: Env,
  opts: { now?: Date; force?: boolean } = {},
): Promise<{ ran: boolean }> {
  const now = opts.now ?? new Date();
  const closeCatchup = isUkCloseCatchup(now);
  if (!opts.force && !isUkMarketHours(now) && !closeCatchup) {
    return { ran: false };
  }
  // Each adapter runs under runAdapterSafe so one upstream failure doesn't
  // block the rest of the pipeline or the downstream recompute.
  await runAdapterSafe(env, eiaBrentAdapter);
  await runAdapterSafe(env, growthSentimentAdapter);
  if (opts.force || closeCatchup || isUkOpenRecovery(now)) {
    await runAdapterSafe(env, lseFtse250Adapter);
  }
  if (opts.force || closeCatchup) {
    await runAdapterSafe(env, eodhdHousebuildersAdapter);
  }
  return { ran: true };
}
