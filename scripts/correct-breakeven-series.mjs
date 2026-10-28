#!/usr/bin/env node
/** Reviewed one-off source-definition correction, not a baseline extension.
 * Plan only: node --import tsx scripts/correct-breakeven-series.mjs
 * Apply after review: append --apply --config=/absolute/wrangler.json
 * Reads no env files; Wrangler supplies its authenticated D1 binding.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { boeBreakevensAdapter } from "../packages/data-sources/src/adapters/boeBreakevens.ts";
import { prepareBreakevenCorrection, applyBreakevenCorrection } from "../apps/ingest/src/pipelines/correctBreakevenSeries.ts";
import { runAdapter } from "../apps/ingest/src/pipelines/runAdapter.ts";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply" && !arg.startsWith("--config="))) throw new Error("Unknown argument");
const apply = args.includes("--apply");
const configPath = args.find((arg) => arg.startsWith("--config="))?.slice("--config=".length);
if (apply && !configPath?.startsWith("/")) throw new Error("Apply requires an explicit absolute Wrangler config path");
const before = JSON.parse(await readFile(new URL("../data/exports/breakeven-before-correction-2026-10-28.json", import.meta.url), "utf8"));
const csv = await readFile(new URL("../data/exports/boe-inflation-source-2026-10-28.csv", import.meta.url), "utf8");
const sourceCsvSha256 = createHash("sha256").update(csv).digest("hex");
if (sourceCsvSha256 !== "183bfd76cbc5d2cd13a508a5600cdf2a7b0a94afa09e580d161c61cfd9207473") throw new Error("Unreviewed primary source CSV");
const sourceUrl = "https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&SeriesCodes=IUDSIZC%2CIUDSNZC%2CIUDSRZC&Datefrom=01%2FJan%2F2024&Dateto=28%2FOct%2F2026&UsingCodes=Y";
const replayFetch = async () => new Response(csv, { headers: { "content-type": "text/csv" } });
const official = await boeBreakevensAdapter.fetchHistorical(replayFetch, { from: new Date("2024-01-01"), to: new Date("2026-10-28T23:59:59Z") });
const plan = await prepareBreakevenCorrection(before, official.observations, { url: sourceUrl, csvSha256: sourceCsvSha256 });
if (plan.updates.length !== 1066 || plan.beforeSha256 !== "1e34a817d4fd2bd602cec8188f93827e68d3d686047e5cbc8118b1b9153500c6") throw new Error("Unreviewed before-state");
console.log(JSON.stringify({ mode: apply ? "apply" : "plan-only", existingKeys: plan.updates.length,
  beforeSha256: plan.beforeSha256, sourceCsvSha256, atomicPlanBytes: new TextEncoder().encode(JSON.stringify(plan.updates)).byteLength,
  newDates: 0, scoreHistoryWrites: 0 }, null, 2));
if (!apply) process.exit(0);

const { getPlatformProxy } = createRequire(import.meta.url)("wrangler");
const proxy = await getPlatformProxy({ configPath, envFiles: [], persist: false, remoteBindings: true });
try {
  const applied = await applyBreakevenCorrection(proxy.env.DB, plan);
  // Verify and restore a normal live head through the same adapter/gate/audit
  // path. The payload was captured externally because BoE blocks Worker egress;
  // record its ACTUAL three-series source URL, not the replay request's URL.
  const verifiedRelayAdapter = { ...boeBreakevensAdapter, fetch: async () => ({ ...await boeBreakevensAdapter.fetch(replayFetch), sourceUrl }) };
  let liveOutcome;
  await runAdapter(proxy.env, verifiedRelayAdapter, { onOutcome: (outcome) => { liveOutcome = outcome; } });
  const after = await proxy.env.DB.prepare("SELECT indicator_id,source_id,observed_at,value,released_at,payload_hash,ingested_at FROM indicator_observations WHERE indicator_id='breakeven_5y' ORDER BY observed_at").all();
  const byKey = new Map(plan.updates.map((row) => [row.before.observed_at, row.value]));
  const mismatches = after.results.filter((row) => byKey.get(row.observed_at) !== row.value);
  if (after.results.length !== 1066 || mismatches.length) throw new Error("Post-correction verification failed");
  const result = { ...applied, liveOutcome, rowsVerified: after.results.length, mismatches: mismatches.length,
    latest: after.results.at(-1), sourceCsvSha256, beforeSha256: plan.beforeSha256, scoreHistoryWrites: 0 };
  const output = fileURLToPath(new URL("../data/exports/breakeven-correction-applied-2026-10-28.json", import.meta.url));
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally { await proxy.dispose(); }
