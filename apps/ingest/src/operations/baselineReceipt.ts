// Node-only operator evidence helper. Worker entry points never import this.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface ExpectedBaselineScope {
  candidateSha256: string;
  candidateRows: number;
  sourceCounts: ReadonlyMap<string, number>;
  minimumOriginalRows: number;
}
export interface CompleteBaselineReceipt {
  state: "COMPLETE_VERIFIED";
  candidateSha256: string;
  startedAt: string;
  completedAt: string;
  originalRawRows: number;
  finalRawRows: number;
  rowsInserted: number;
  finalScope: { missing: number; alreadyPresent: number };
  originalKeysWithChangedFields: number;
  changedExisting: unknown[];
  beforeSnapshotFile: "attempt-before-observations.json";
  beforeSnapshotSha256: string;
  beforeSnapshotRows: number;
  results: { adapter: string; rowsWritten: number; rowsRejected: unknown[] }[];
  overwrite: false;
  scoreHistoryWrites: 0;
  [key: string]: unknown;
}

const reconcile = (reason: string) => new Error(`${reason}. Preserve attempt.json, any failure diagnostic and ingestion audits; reconcile the operation before an explicitly reviewed recovery. No automatic resume or receipt replacement is allowed`);

async function readOptional(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw reconcile(`Unreadable existing evidence at ${path}`);
  }
}

/** Shared by the runner and finalizer: a zero-write retry or partial source
 * application is never accepted as proof of the complete reviewed operation. */
export function assertCompleteBaselineReceipt(value: unknown, expected: ExpectedBaselineScope): asserts value is CompleteBaselineReceipt {
  const r = value as Partial<CompleteBaselineReceipt> | null;
  if (!r || r.state !== "COMPLETE_VERIFIED" || r.candidateSha256 !== expected.candidateSha256
    || r.rowsInserted !== expected.candidateRows || r.overwrite !== false || r.scoreHistoryWrites !== 0
    || typeof r.originalRawRows !== "number" || !Number.isInteger(r.originalRawRows) || r.originalRawRows < expected.minimumOriginalRows
    || r.originalKeysWithChangedFields !== 0 || !Array.isArray(r.changedExisting) || r.changedExisting.length !== 0
    || r.finalScope?.missing !== 0 || r.finalScope?.alreadyPresent !== expected.candidateRows
    || r.finalRawRows !== r.originalRawRows + expected.candidateRows
    || r.beforeSnapshotFile !== "attempt-before-observations.json"
    || typeof r.beforeSnapshotSha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.beforeSnapshotSha256)
    || r.beforeSnapshotRows !== r.originalRawRows
    || typeof r.startedAt !== "string" || typeof r.completedAt !== "string"
    || !r.startedAt.endsWith("Z") || !r.completedAt.endsWith("Z")
    || !Number.isFinite(Date.parse(r.startedAt)) || !Number.isFinite(Date.parse(r.completedAt))
    || Date.parse(r.completedAt) < Date.parse(r.startedAt)
    || !Array.isArray(r.results) || r.results.length !== expected.sourceCounts.size
    || new Set(r.results.map((s) => s.adapter)).size !== expected.sourceCounts.size
    || r.results.some((s) => s.rowsWritten !== expected.sourceCounts.get(s.adapter)
      || !Array.isArray(s.rowsRejected) || s.rowsRejected.length !== 0)) {
    throw reconcile("Existing result is not a verified complete success receipt");
  }
}

export async function readBaselineBeforeSnapshot(directory: string, receipt: CompleteBaselineReceipt): Promise<unknown[]> {
  const bytes = await readFile(join(directory, receipt.beforeSnapshotFile));
  if (createHash("sha256").update(bytes).digest("hex") !== receipt.beforeSnapshotSha256) throw reconcile("Actual pre-application archive hash disagrees with the receipt");
  const rows: unknown = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(rows) || rows.length !== receipt.beforeSnapshotRows) throw reconcile("Actual pre-application archive row count disagrees with the receipt");
  return rows;
}

/** Claim one initial application before any production writes. Completed
 * retries only read and verify; partial/unreceipted history fails closed. */
export async function prepareBaselineAttempt(
  directory: string,
  expected: ExpectedBaselineScope,
  current: { missing: number; alreadyPresent: number; originalRawRows: number; beforeObservations?: readonly unknown[] },
): Promise<{ kind: "already-complete"; receipt: CompleteBaselineReceipt } | { kind: "new"; attemptId: string; startedAt: string; beforeSnapshotFile: "attempt-before-observations.json"; beforeSnapshotSha256: string }> {
  if (!Number.isInteger(current.originalRawRows) || current.originalRawRows < expected.minimumOriginalRows
    || !Number.isInteger(current.missing) || !Number.isInteger(current.alreadyPresent)
    || current.missing < 0 || current.alreadyPresent < 0
    || current.missing + current.alreadyPresent !== expected.candidateRows) throw reconcile("Current database does not match the reviewed operation scope");
  const receipt = await readOptional(join(directory, "applied.json"));
  if (receipt !== undefined) {
    assertCompleteBaselineReceipt(receipt, expected);
    if (current.missing !== 0 || current.alreadyPresent !== expected.candidateRows) throw reconcile("Successful receipt disagrees with current reviewed-candidate coverage");
    await readBaselineBeforeSnapshot(directory, receipt);
    return { kind: "already-complete", receipt };
  }
  if (await readOptional(join(directory, "attempt.json")) !== undefined) throw reconcile("A prior attempt has no complete success receipt");
  if (current.missing !== expected.candidateRows || current.alreadyPresent !== 0) throw reconcile("Some reviewed history already exists without a complete success receipt");
  if (!Array.isArray(current.beforeObservations) || current.beforeObservations.length !== current.originalRawRows) throw reconcile("Actual pre-application observations were not supplied");
  const beforeSnapshotFile = "attempt-before-observations.json" as const;
  const beforeBytes = JSON.stringify(current.beforeObservations, null, 2) + "\n";
  const beforeSnapshotSha256 = createHash("sha256").update(beforeBytes).digest("hex");
  const attempt = { state: "ATTEMPT_STARTED", attemptId: randomUUID(), startedAt: new Date().toISOString(),
    candidateSha256: expected.candidateSha256, candidateRows: expected.candidateRows,
    initialMissing: current.missing, initialAlreadyPresent: current.alreadyPresent,
    originalRawRows: current.originalRawRows, beforeSnapshotFile, beforeSnapshotSha256,
    beforeSnapshotRows: current.originalRawRows, overwrite: false, scoreHistoryWrites: 0 };
  try { await writeFile(join(directory, beforeSnapshotFile), beforeBytes, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw reconcile("An actual before-state archive already exists and was preserved");
    throw error;
  }
  try { await writeFile(join(directory, "attempt.json"), JSON.stringify(attempt, null, 2) + "\n", { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw reconcile("Another attempt already claimed this operation");
    throw error;
  }
  return { kind: "new", attemptId: attempt.attemptId, startedAt: attempt.startedAt, beforeSnapshotFile, beforeSnapshotSha256 };
}

/** Success-named evidence is created only after full verification, and never
 * replaces an earlier receipt, even if two processes race locally. */
export async function writeBaselineSuccess(directory: string, receipt: unknown, expected: ExpectedBaselineScope): Promise<void> {
  assertCompleteBaselineReceipt(receipt, expected);
  const attempt = await readOptional(join(directory, "attempt.json")) as { startedAt?: string; candidateSha256?: string; originalRawRows?: number; beforeSnapshotSha256?: string } | undefined;
  if (!attempt || attempt.startedAt !== receipt.startedAt || attempt.candidateSha256 !== expected.candidateSha256
    || attempt.originalRawRows !== receipt.originalRawRows || attempt.beforeSnapshotSha256 !== receipt.beforeSnapshotSha256) throw reconcile("Success result does not match its retained initial attempt");
  await readBaselineBeforeSnapshot(directory, receipt);
  try { await writeFile(join(directory, "applied.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw reconcile("A success receipt already exists and was preserved");
    throw error;
  }
}

export async function writeBaselineFailure(directory: string, diagnostic: unknown): Promise<void> {
  // A retry must not erase the first failure window or its partial-write facts.
  await writeFile(join(directory, "failed-attempt.json"), JSON.stringify(diagnostic, null, 2) + "\n", { flag: "wx" });
}
