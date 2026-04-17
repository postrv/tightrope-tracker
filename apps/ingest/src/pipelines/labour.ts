import { moneyfactsMortgageAdapter, onsLmsAdapter, onsRtiAdapter } from "@tightrope/data-sources";
import type { Env } from "../env.js";
import { runAdapter } from "./runAdapter.js";

export async function ingestLabour(env: Env): Promise<void> {
  await runAdapter(env, onsLmsAdapter);
  await runAdapter(env, onsRtiAdapter);
  await runAdapter(env, moneyfactsMortgageAdapter);
}
