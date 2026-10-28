#!/usr/bin/env node
/** LOCAL FILES ONLY; never queries/mutates production or publishes SQL.
 * Run after the approved runner completes and normal recompute refreshes scores:
 * node --import tsx scripts/finalize-baseline-2019-audit.mjs \
 *   --input=/abs/post-apply-D1-dump.json --snapshot=/abs/current-score.json \
 *   --sql-output=/abs/resolved-disclosure.sql
 * Input dump uses audit-data.mjs's observations/audits/quarantines JSON shape.
 * The unresolved SQL template is retained; a separate resolved file is emitted.
 */
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINE_START_ISO, COVID_EXCLUDE_START_ISO, COVID_EXCLUDE_END_ISO,
  PILLAR_ORDER, selectBaselineObservations } from "../packages/shared/src/index.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const archive = new URL("../data/exports/baseline-2019-primary-2026-10-28/", import.meta.url);
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const input = arg("input"), snapshotPath = arg("snapshot"), sqlOutput = arg("sql-output");
if (!input || !snapshotPath || !sqlOutput) throw new Error("Required: --input=post-apply-D1-dump.json --snapshot=current-score.json --sql-output=resolved-disclosure.sql");
const load = async (url) => JSON.parse(await readFile(url, "utf8"));
let applied;
try { applied = await load(new URL("applied.json", archive)); }
catch (error) {
  if (error.code === "ENOENT") throw new Error("applied.json is absent: the 8,770-row operation is not verified complete; no audit or SQL files changed");
  throw error;
}
const manifest = await load(new URL("manifest.json", archive));
const candidateBytes = await readFile(new URL(manifest.candidateFile, archive));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const approvedSha = "bad910e7715eeba5e7b47c240a126ea4de0ff276575cd502b83305e214e322a7";
if (manifest.candidateRows !== 8770 || digest(candidateBytes) !== approvedSha || applied.candidateSha256 !== approvedSha
  || applied.rowsInserted !== 8770 || applied.overwrite !== false || applied.scoreHistoryWrites !== 0
  || applied.originalRawRows < 8294 || applied.originalKeysWithChangedFields !== 0
  || applied.finalScope?.missing !== 0 || applied.finalScope?.alreadyPresent !== 8770
  || applied.finalRawRows !== applied.originalRawRows + 8770
  || !Number.isFinite(Date.parse(applied.startedAt)) || !Number.isFinite(Date.parse(applied.completedAt))
  || !applied.startedAt.endsWith("Z") || !applied.completedAt.endsWith("Z")
  || Date.parse(applied.completedAt) < Date.parse(applied.startedAt)) throw new Error("Applied record does not prove the reviewed complete missing-only operation");
const expectedCounts = new Map(manifest.sources.map((s) => [s.id, s.expectedCandidates]));
if (applied.results?.length !== 9 || new Set(applied.results.map((r) => r.adapter)).size !== 9
  || applied.results.some((r) => r.rowsWritten !== expectedCounts.get(r.adapter)
  || r.rowsRejected?.length !== 0)) throw new Error("Applied record does not prove all nine reviewed source results");

const inputBytes = await readFile(resolve(input));
const dump = JSON.parse(inputBytes);
const rows = Array.isArray(dump[0]?.results) ? dump[0].results : dump;
const candidateSet = JSON.parse(candidateBytes);
const candidates = candidateSet.adapters.flatMap((s) => s.observations);
const byKey = new Map(rows.map((r) => [`${r.indicator_id}|${r.observed_at}`, r]));
for (const c of candidates) {
  const r = byKey.get(`${c.indicatorId}|${c.observedAt}`);
  if (!r || r.value !== c.value || r.source_id !== c.sourceId || r.payload_hash !== c.payloadHash
    || (r.released_at ?? null) !== (c.releasedAt ?? null)) throw new Error(`Post-apply source verification failed: ${c.indicatorId} ${c.observedAt}`);
}
const snapshotBytes = await readFile(resolve(snapshotPath));
const snapshot = JSON.parse(snapshotBytes);
if (!Number.isFinite(snapshot.headline?.value) || !Number.isFinite(Date.parse(snapshot.headline.updatedAt))
  || !PILLAR_ORDER.every((p) => Number.isFinite(snapshot.pillars?.[p]?.value))
  || Date.parse(snapshot.headline.updatedAt) < Date.parse(applied.completedAt)) throw new Error("A normal recompute AFTER complete application is required");
const beforeRows = await load(new URL(manifest.referenceObservationFile, archive));
const eligible = (r) => Date.parse(r.observed_at) >= Date.parse(BASELINE_START_ISO)
  && !(Date.parse(r.observed_at) >= Date.parse(COVID_EXCLUDE_START_ISO) && Date.parse(r.observed_at) <= Date.parse(COVID_EXCLUDE_END_ISO));
const beforeBaseline = selectBaselineObservations(beforeRows).filter(eligible);
const afterBaseline = selectBaselineObservations(rows).filter(eligible);
const coverage = Object.keys(manifest.originalFirstReferenceDayByIndicator).map((id) => {
  const before = beforeBaseline.filter((r) => r.indicator_id === id).length;
  const after = afterBaseline.filter((r) => r.indicator_id === id).length;
  const eligibleAddedByBackfill = candidates.filter((c) => c.indicatorId === id && eligible({ observed_at: c.observedAt })).length;
  return { indicatorId: id, eligibleAtReference: before, eligibleAfter: after, eligibleAddedByBackfill,
    otherCanonicalChangeSinceReference: after - before - eligibleAddedByBackfill };
});
if (coverage.length !== 17 || coverage.reduce((sum, r) => sum + r.eligibleAddedByBackfill, 0) !== 8375) {
  throw new Error("Post-apply canonical coverage does not match the 8,375 eligible additions; inspect concurrent source changes");
}

const template = await readFile(new URL("../db/patches/correct-2026-10-28-baseline-coverage.sql", import.meta.url), "utf8");
const sql = template.replaceAll("__BASELINE_STARTED_AT_FROM_APPLIED_JSON__", applied.startedAt)
  .replaceAll("__BASELINE_COMPLETED_AT_FROM_APPLIED_JSON__", applied.completedAt);
if (sql.includes("__BASELINE_")) throw new Error("Unresolved disclosure timestamp placeholder");
const auditPath = resolve(root, "data/exports/quality-audit-2026-10-28.json");
const prior = await load(auditPath);
const work = await mkdtemp(join(tmpdir(), "tightrope-baseline-audit-"));
let fresh;
try {
  const structuralOutput = join(work, "structural.json");
  await run(process.execPath, ["--import", "tsx", resolve(root, "scripts/audit-data.mjs"),
    `--input=${resolve(input)}`, `--output=${structuralOutput}`], { cwd: root });
  fresh = await load(structuralOutput);
} finally { await rm(work, { recursive: true, force: true }); }
const exceptions = await load(new URL(manifest.reviewedHistoricalExceptionsFile, archive));
const matchesException = (flag) => exceptions.exceptions.some((e) => e.indicatorId === flag.indicatorId
  && e.observedAt === flag.observedAt && Math.abs(e.value - flag.value) < 1e-9);
const unreviewedRangeFlags = fresh.issues.outsidePlausibility.filter((flag) => !matchesException(flag));
const verified = { status: "APPLIED_SOURCE_VALUES_AND_COVERAGE_VERIFIED", startedAt: applied.startedAt,
  completedAt: applied.completedAt, candidateSha256: approvedSha, rowsInserted: 8770,
  referenceRows: 8294, originalRowsVerifiedUnchanged: applied.originalRawRows, finalRawRows: rows.length,
  sourceGroups: 9, registeredInputs: 17, baselineEligibleAdded: 8375, covidExcluded: 395,
  sourceValuesVerified: candidates.length, overwrite: false, publishedScoreHistoryRewritten: false,
  frozenCurrentReadingReplay: manifest.frozenReplay, earlierFrozenReplay: manifest.earlierFrozenReplay,
  actualCurrentRecompute: { headline: snapshot.headline.value, updatedAt: snapshot.headline.updatedAt,
    pillars: Object.fromEntries(PILLAR_ORDER.map((p) => [p, snapshot.pillars[p].value])), stale: snapshot.headline.stale === true },
  rawOutsideLiveBoundsFlags: fresh.issues.outsidePlausibility.length,
  reviewedHistoricalRangeFlags: fresh.issues.outsidePlausibility.filter(matchesException).length,
  unreviewedRangeFlags, livePlausibilityBoundsChanged: false, coverage,
  sourceVintageNote: "Current-vintage baseline history; ONS revision timestamps are not original publication times. BoE reference times are not publication times. Published historical scores are retained.",
  inputSha256: digest(inputBytes), actualSnapshotFileSha256: digest(snapshotBytes),
  disclosureSql: resolve(sqlOutput), disclosurePublished: false,
  nextStep: "Publish the resolved disclosure SQL, clear timeline:latest, then verify the public correction/timeline and current score. This local script publishes nothing." };
const report = { ...prior, ...fresh,
  priorAuditReference: { generatedAt: prior.generatedAt, inputSha256: prior.inputSha256 },
  leadingBaselineCoverage: verified,
  proposedLeadingBaselineCoverage: { ...prior.proposedLeadingBaselineCoverage,
    status: "applied and source-verified; disclosure SQL prepared but not published by this workflow" },
};
exceptions.status = "INGESTED_AND_MATCHED_TO_POST_APPLY_RAW_RANGE_FLAGS";
exceptions.actualRawOutsideLiveBoundsFlags = fresh.issues.outsidePlausibility.length;
exceptions.unreviewedRangeFlags = unreviewedRangeFlags;
await writeFile(resolve(sqlOutput), sql);
await writeFile(auditPath, JSON.stringify(report, null, 2) + "\n");
await writeFile(new URL("historical-live-bound-exceptions.json", archive), JSON.stringify(exceptions, null, 2) + "\n");
await writeFile(new URL("production-verification.json", archive), JSON.stringify(verified, null, 2) + "\n");
const readmePath = resolve(root, "data/exports/README.md");
const readme = await readFile(readmePath, "utf8");
await writeFile(readmePath, readme.replace("Preparation status: **proposal only; no production baseline writes**.",
  `Application status: **8,770 observations verified after application completed at ${applied.completedAt}**. Disclosure publication is verified separately.`));
console.log(JSON.stringify({ rowsInserted: 8770, existingRowsPreserved: applied.originalRawRows,
  baselineEligibleAdded: 8375, covidExcluded: 395, actualHeadline: snapshot.headline.value,
  rawRangeFlags: verified.rawOutsideLiveBoundsFlags, reviewedRangeFlags: verified.reviewedHistoricalRangeFlags,
  unreviewedRangeFlags: unreviewedRangeFlags.length, sqlOutput: resolve(sqlOutput), productionWritesByThisScript: 0 }, null, 2));
