import { moneyfactsMortgageAdapter, onsLmsAdapter, onsRtiAdapter } from "@tightrope/data-sources";
import type { Env } from "../env.js";
import { runAdapterSafe } from "./runAdapter.js";

export async function ingestLabour(env: Env): Promise<void> {
  await runAdapterSafe(env, onsLmsAdapter);
  await runAdapterSafe(env, onsRtiAdapter);
  await runAdapterSafe(env, moneyfactsMortgageAdapter);
}
