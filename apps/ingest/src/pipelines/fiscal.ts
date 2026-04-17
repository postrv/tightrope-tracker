import { obrEfoAdapter, onsPsfAdapter } from "@tightrope/data-sources";
import type { Env } from "../env.js";
import { runAdapter } from "./runAdapter.js";

export async function ingestFiscal(env: Env): Promise<void> {
  await runAdapter(env, obrEfoAdapter);
  await runAdapter(env, onsPsfAdapter);
}
