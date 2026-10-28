#!/usr/bin/env node
/** Consolidated 8,770-row proposal: offline plan by default.
 * --check-production --config=/abs/wrangler.json
 * only reads D1. --apply requires separate explicit approval and uses the
 * existing audited historical pipeline with overwrite=false. This runner
 * never writes headline/pillar history or recomputes scores. */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { backfillObservations } from "../apps/ingest/src/pipelines/backfillObservations.ts";
import { guardLeadingBaselineBackfill } from "../apps/ingest/src/pipelines/leadingBaselineGuard.ts";
import { buildHistoricalResult } from "../packages/data-sources/src/lib/historical.ts";

const archive = new URL("../data/exports/baseline-2019-primary-2026-10-28/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", archive), "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const args = process.argv.slice(2);
if (args.some((a) => a !== "--apply" && a !== "--check-production" && !a.startsWith("--config="))) throw new Error("Unknown argument");
const apply = args.includes("--apply");
const checkProduction = args.includes("--check-production");
const configPath = args.find((a) => a.startsWith("--config="))?.slice("--config=".length);
if ((apply || checkProduction) && !configPath?.startsWith("/")) throw new Error("Explicit absolute Wrangler config required");
if (manifest.overwrite !== false || manifest.candidateRows !== 8770 || manifest.scoreHistoryWrites !== 0) throw new Error("Unreviewed operation scope");
const bytes = await readFile(new URL(manifest.candidateFile, archive));
if (sha(bytes) !== "bad910e7715eeba5e7b47c240a126ea4de0ff276575cd502b83305e214e322a7" || sha(bytes) !== manifest.candidateSha256) throw new Error("Unreviewed candidate archive");
const candidateSet = JSON.parse(bytes);
if (JSON.stringify(candidateSet.proofs) !== JSON.stringify(manifest.proofs)) throw new Error("Unreviewed primary evidence list");
for (const proof of manifest.proofs) {
  if (sha(await readFile(new URL(proof.file, archive))) !== proof.sha256) throw new Error(`Primary proof SHA mismatch: ${proof.file}`);
}
const fingerprint = (o) => JSON.stringify([o.indicatorId, o.observedAt, o.value, o.sourceId, o.payloadHash, o.releasedAt ?? null]);
const sources = [];
for (const expected of manifest.sources) {
  const capturedBytes = await readFile(new URL(expected.file, archive));
  if (sha(capturedBytes) !== expected.sha256) throw new Error(`Source capture SHA mismatch: ${expected.id}`);
  const captured = JSON.parse(capturedBytes);
  const candidates = candidateSet.adapters.find((a) => a.id === expected.id);
  if (!candidates || candidates.observations.length !== expected.expectedCandidates || candidates.sourceSha256 !== expected.sha256
    || captured.sourceUrl !== expected.sourceUrl || candidates.sourceUrl !== expected.sourceUrl) throw new Error(`Source manifest mismatch: ${expected.id}`);
  if (expected.id === "boe_breakevens" && new URL(expected.sourceUrl).searchParams.get("SeriesCodes") !== "IUDSIZC") throw new Error("Wrong breakeven economic series");
  const verified = new Set(captured.observations.map(fingerprint));
  if (candidates.observations.some((o) => !verified.has(fingerprint(o)))) throw new Error(`Candidate absent from archived source capture: ${expected.id}`);
  sources.push({ ...expected, observations: candidates.observations });
}
const observations = sources.flatMap((s) => s.observations);
if (sources.length !== 9 || observations.length !== 8770) throw new Error("Unreviewed source/observation counts");
guardLeadingBaselineBackfill([], observations, manifest.originalFirstReferenceDayByIndicator);
const pairEvidence = JSON.parse(await readFile(new URL("eia-pairing-review.json", archive), "utf8"));
function verifyEiaFxPairs(existing) {
  // EIA values depend on the reviewed FX additions and retained existing FX
  // vintages. Check that exact pairing before importing either source.
  const fx = [...existing.filter((r) => r.indicator_id === "gbp_usd" && r.source_id === "boe_fx"),
    ...observations.filter((o) => o.indicatorId === "gbp_usd").map((o) => ({ observed_at: o.observedAt, value: o.value }))]
    .sort((a, b) => b.observed_at.localeCompare(a.observed_at));
  const prices = new Map(observations.filter((o) => o.indicatorId === "brent_gbp").map((o) => [o.observedAt.slice(0, 10), o.value]));
  for (const pair of pairEvidence.pairs) {
    const before = `${pair.period}T23:59:59.999Z`;
    const fix = fx.find((r) => r.observed_at < before);
    if (!fix || fix.observed_at !== pair.fxObservedAt || fix.value !== pair.gbpUsd
      || Math.round(pair.usdPerBarrel / fix.value * 100) / 100 !== pair.gbpPerBarrel
      || prices.get(pair.period) !== pair.gbpPerBarrel || pair.fxLagCalendarDays > 5) throw new Error(`Reviewed EIA/FX pair changed: ${pair.period}`);
  }
  if (pairEvidence.pairs.length !== 1396) throw new Error("Unreviewed EIA pairing count");
  return pairEvidence.pairs.length;
}
const referenceBytes = await readFile(new URL(manifest.referenceObservationFile, archive));
const referenceScoreBytes = await readFile(new URL(manifest.referenceScoreFile, archive));
if (sha(referenceBytes) !== manifest.referenceObservationSha256 || sha(referenceScoreBytes) !== manifest.sourceSnapshotSha256) throw new Error("Frozen reference capture changed");
verifyEiaFxPairs(JSON.parse(referenceBytes));
console.log(JSON.stringify({ mode: apply ? "apply" : checkProduction ? "read-only-production-preflight" : "offline-plan-only",
  capturedPayloadKind: manifest.captureKind, candidateRows: observations.length, sources: sources.map((s) => ({ id: s.id, count: s.observations.length, sha256: s.sha256 })),
  baselineEligible: manifest.baselineEligibleRows, covidExcluded: manifest.covidExcludedRows, overwrite: false,
  frozenHeadlineReplay: manifest.frozenReplay, scoreHistoryWrites: 0 }, null, 2));
if (!apply && !checkProduction) process.exit(0);

const { getPlatformProxy } = createRequire(import.meta.url)("wrangler");
const proxy = await getPlatformProxy({ configPath, envFiles: [], persist: false, remoteBindings: true });
const query = "SELECT indicator_id,observed_at,value,source_id,ingested_at,payload_hash,released_at FROM indicator_observations ORDER BY indicator_id,observed_at";
try {
  const before = (await proxy.env.DB.prepare(query).all()).results;
  const preflight = guardLeadingBaselineBackfill(before, observations, manifest.originalFirstReferenceDayByIndicator);
  const eiaFxPairsVerified = verifyEiaFxPairs(before);
  const preflightReport = { checkedAt: new Date().toISOString(), productionPreflight: preflight, existingRawRows: before.length,
    sourceFilesShaVerified: sources.length, eiaFxPairsVerified, candidateSha256: manifest.candidateSha256,
    productionObservationWrites: 0, productionAuditWrites: 0, scoreHistoryWrites: 0 };
  console.log(JSON.stringify(preflightReport, null, 2));
  await writeFile(fileURLToPath(new URL("preflight.json", archive)), JSON.stringify(preflightReport, null, 2) + "\n");
  if (!apply) process.exitCode = 0;
  else {
    const startedAt = new Date().toISOString();
    const results = [];
    for (const source of sources) {
      // Re-read before each adapter to detect unreviewed overlapping imports.
      const current = (await proxy.env.DB.prepare(query).all()).results;
      guardLeadingBaselineBackfill(current, observations, manifest.originalFirstReferenceDayByIndicator);
      const sourceScope = guardLeadingBaselineBackfill(current, source.observations,
        Object.fromEntries([...new Set(source.observations.map((o) => o.indicatorId))].map((id) => [id, manifest.originalFirstReferenceDayByIndicator[id]])));
      if (!sourceScope.missing) { results.push({ adapter: source.id, rowsWritten: 0, alreadyPresent: sourceScope.alreadyPresent }); continue; }
      const adapter = { id: source.id, name: `Reviewed leading-history replay ${source.id}`,
        fetch: async () => { throw new Error("Live/network fetching is disabled"); },
        fetchHistorical: async () => buildHistoricalResult(source.observations, source.sourceUrl,
          ["Reviewed official current-vintage capture; missing leading reference dates only; overwrite=false; no as-known score reconstruction"]),
      };
      const result = await backfillObservations(proxy.env, adapter, {
        from: new Date("2019-01-01"), to: new Date("2024-08-01"), dryRun: false, overwrite: false,
      });
      if (result.rowsRejected.length || result.rowsWritten !== sourceScope.missing) throw new Error(`Unexpected write result for ${source.id}; inspect audit before continuing`);
      results.push(result);
      console.log(JSON.stringify({ adapter: source.id, rowsWritten: result.rowsWritten, rowsRejected: result.rowsRejected.length }));
    }
    const after = (await proxy.env.DB.prepare(query).all()).results;
    const finalScope = guardLeadingBaselineBackfill(after, observations, manifest.originalFirstReferenceDayByIndicator);
    const afterKeys = new Map(after.map((r) => [`${r.indicator_id}|${r.observed_at}`, r]));
    const changedExisting = before.filter((r) => JSON.stringify(afterKeys.get(`${r.indicator_id}|${r.observed_at}`)) !== JSON.stringify(r));
    const result = { startedAt, completedAt: new Date().toISOString(), originalRawRows: before.length, finalRawRows: after.length,
      rowsInserted: results.reduce((sum, r) => sum + r.rowsWritten, 0), finalScope, originalKeysWithChangedFields: changedExisting.length,
      changedExisting, results, candidateSha256: manifest.candidateSha256, overwrite: false, scoreHistoryWrites: 0,
      note: "Historical inserts use INSERT OR IGNORE; any changed pre-existing fields require review for concurrent live ingestion. Recompute and public coverage disclosure are separate steps." };
    await writeFile(fileURLToPath(new URL("applied.json", archive)), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
    if (finalScope.missing !== 0 || changedExisting.length) throw new Error("Post-backfill verification requires review");
  }
} finally { await proxy.dispose(); }
