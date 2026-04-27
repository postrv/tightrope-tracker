import { boeMortgageRatesAdapter, onsLmsAdapter, onsRtiAdapter } from "@tightrope/data-sources";
import type { Env } from "../env.js";
import { runAdapterSafe } from "./runAdapter.js";

export async function ingestLabour(env: Env): Promise<void> {
  await runAdapterSafe(env, onsLmsAdapter);
  await runAdapterSafe(env, onsRtiAdapter);
  // Switched from moneyfactsMortgageAdapter (advertised rate, fixture-fed)
  // to boeMortgageRatesAdapter (effective new-business rate, BoE IADB
  // IUMBV34 live). This is a deliberate series-semantics shift: BoE is the
  // canonical reference an economist would cite. Existing Moneyfacts
  // observations remain in indicator_observations until the next backfill
  // run replaces them with BoE history.
  await runAdapterSafe(env, boeMortgageRatesAdapter);
}
