import { dmoGiltPortfolioAdapter, eodhdHousebuildersAdapter, obrEfoAdapter, onsPsfAdapter } from "@tightrope/data-sources";
import type { Env } from "../env.js";
import { runAdapterSafe } from "./runAdapter.js";

export async function ingestFiscal(env: Env): Promise<void> {
  await runAdapterSafe(env, obrEfoAdapter);
  await runAdapterSafe(env, onsPsfAdapter);
  await runAdapterSafe(env, dmoGiltPortfolioAdapter);
  await runAdapterSafe(env, eodhdHousebuildersAdapter);
}
