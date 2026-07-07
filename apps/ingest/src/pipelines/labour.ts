import { onsLmsAdapter, onsRtiAdapter } from "@tightrope/data-sources";
import type { Env } from "../env.js";
import { runAdapterSafe } from "./runAdapter.js";

export async function ingestLabour(env: Env): Promise<void> {
  await runAdapterSafe(env, onsLmsAdapter);
  await runAdapterSafe(env, onsRtiAdapter);
  // mortgage_2y_fix (BoE IUMBV34, effective new-business rate) is fed by the
  // Actions relay since 2026-07-07 -- the IADB blocks Workers egress, so
  // boeMortgageRatesAdapter is not run from this cron. See relay-boe.yml and
  // POST /admin/relay.
}
