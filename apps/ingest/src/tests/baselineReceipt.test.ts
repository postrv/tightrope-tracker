import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { assertCompleteBaselineReceipt, prepareBaselineAttempt, writeBaselineFailure, writeBaselineSuccess,
  readBaselineBeforeSnapshot,
  type CompleteBaselineReceipt, type ExpectedBaselineScope } from "../operations/baselineReceipt.js";

const sourceCounts = new Map<string, number>([["boe_yields",2648],["boe_fx",2732],["boe_breakevens",1366],
  ["boe_mortgage_rates",65],["ons_lms",335],["ons_psf",134],["ons_rti",66],["mhclg",28],["eia_brent",1396]]);
const expected: ExpectedBaselineScope = { candidateSha256: "a".repeat(64), candidateRows: 8770, sourceCounts, minimumOriginalRows: 8294 };
const actualBefore = Array.from({ length: 8294 }, (_, row) => ({ key: `existing-${row}`, value: row / 10 }));
const beforeHash = createHash("sha256").update(JSON.stringify(actualBefore, null, 2) + "\n").digest("hex");
const missing = { missing: 8770, alreadyPresent: 0, originalRawRows: 8294, beforeObservations: actualBefore };
const present = { missing: 0, alreadyPresent: 8770, originalRawRows: 17064 };
const dirs: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), "tightrope-receipt-test-")); dirs.push(path); return path; }
function complete(startedAt: string): CompleteBaselineReceipt {
  return { state: "COMPLETE_VERIFIED", candidateSha256: expected.candidateSha256, startedAt,
    completedAt: new Date(Date.parse(startedAt) + 1000).toISOString(), originalRawRows: 8294, finalRawRows: 17064,
    rowsInserted: 8770, finalScope: { missing: 0, alreadyPresent: 8770 }, originalKeysWithChangedFields: 0,
    changedExisting: [], results: [...sourceCounts].map(([adapter, rowsWritten]) => ({ adapter, rowsWritten, rowsRejected: [] })),
    beforeSnapshotFile: "attempt-before-observations.json", beforeSnapshotSha256: beforeHash, beforeSnapshotRows: 8294,
    overwrite: false, scoreHistoryWrites: 0 };
}
afterEach(async () => { for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("retained baseline application evidence", () => {
  it("preserves successful receipt bytes/timestamps on a verified all-present retry, using the finalizer's strict validator", async () => {
    const path = await directory();
    const attempt = await prepareBaselineAttempt(path, expected, missing);
    expect(attempt.kind).toBe("new"); if (attempt.kind !== "new") throw new Error("new attempt expected");
    await writeBaselineSuccess(path, complete(attempt.startedAt), expected);
    const receiptPath = join(path, "applied.json");
    const bytes = await readFile(receiptPath, "utf8"), before = await stat(receiptPath), files = await readdir(path);
    const snapshotBytes = await readFile(join(path, "attempt-before-observations.json"), "utf8");
    const retry = await prepareBaselineAttempt(path, expected, present);
    expect(retry.kind).toBe("already-complete");
    expect(await readFile(receiptPath, "utf8")).toBe(bytes);
    expect((await stat(receiptPath)).mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(path)).toEqual(files);
    expect(await readFile(join(path, "attempt-before-observations.json"), "utf8")).toBe(snapshotBytes);
    expect(() => assertCompleteBaselineReceipt(JSON.parse(bytes), expected)).not.toThrow();
    await expect(readBaselineBeforeSnapshot(path, JSON.parse(bytes))).resolves.toEqual(actualBefore);
    // A zero-write retry would be rejected by the SAME validator imported by
    // the finalizer, so it must never replace the preserved original receipt.
    expect(() => assertCompleteBaselineReceipt({ ...JSON.parse(bytes), rowsInserted: 0 }, expected)).toThrow(/not a verified complete/);
  });

  it("refuses partial or all-present unreceipted history before creating attempt/success evidence", async () => {
    const path = await directory();
    for (const scope of [{ missing: 8000, alreadyPresent: 770, originalRawRows: 9064 }, present]) {
      await expect(prepareBaselineAttempt(path, expected, scope)).rejects.toThrow(/reconcile/);
      expect(await readdir(path)).toEqual([]);
    }
  });

  it("preserves a failed attempt/diagnostic and refuses automatic partial recovery", async () => {
    const path = await directory();
    const started = await prepareBaselineAttempt(path, expected, missing);
    if (started.kind !== "new") throw new Error("new attempt expected");
    await writeBaselineFailure(path, { state: "FAILED_RECONCILIATION_REQUIRED", rowsReportedWritten: 2648,
      beforeSnapshotFile: started.beforeSnapshotFile, beforeSnapshotSha256: started.beforeSnapshotSha256 });
    const attempt = await readFile(join(path, "attempt.json"), "utf8");
    const failure = await readFile(join(path, "failed-attempt.json"), "utf8");
    await expect(prepareBaselineAttempt(path, expected, { missing: 6122, alreadyPresent: 2648, originalRawRows: 10942 })).rejects.toThrow(/prior attempt/);
    await expect(writeBaselineFailure(path, { rowsReportedWritten: 0 })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(path, "attempt.json"), "utf8")).toBe(attempt);
    expect(await readFile(join(path, "failed-attempt.json"), "utf8")).toBe(failure);
    expect(JSON.parse(failure).beforeSnapshotSha256).toBe(beforeHash);
    expect(await readdir(path)).not.toContain("applied.json");
  });

  it("creates attempt and success evidence exclusively", async () => {
    const path = await directory();
    const claims = await Promise.allSettled([prepareBaselineAttempt(path, expected, missing), prepareBaselineAttempt(path, expected, missing)]);
    expect(claims.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winning = claims.find((r) => r.status === "fulfilled");
    if (!winning || winning.status !== "fulfilled" || winning.value.kind !== "new") throw new Error("one initial claim expected");
    const result = complete(winning.value.startedAt);
    await writeBaselineSuccess(path, result, expected);
    const bytes = await readFile(join(path, "applied.json"), "utf8");
    await expect(writeBaselineSuccess(path, { ...result, completedAt: new Date(Date.parse(result.completedAt) + 1000).toISOString() }, expected)).rejects.toThrow(/already exists and was preserved/);
    expect(await readFile(join(path, "applied.json"), "utf8")).toBe(bytes);
  });

  it("never creates success-named evidence after incomplete insertion or failed preservation verification", async () => {
    const path = await directory();
    const attempt = await prepareBaselineAttempt(path, expected, missing);
    if (attempt.kind !== "new") throw new Error("new attempt expected");
    const result = complete(attempt.startedAt);
    for (const invalid of [{ ...result, rowsInserted: 6122 }, { ...result, finalScope: { missing: 1, alreadyPresent: 8769 } },
      { ...result, originalKeysWithChangedFields: 1, changedExisting: ["changed"] }]) {
      await expect(writeBaselineSuccess(path, invalid, expected)).rejects.toThrow(/not a verified complete/);
    }
    expect((await readdir(path)).sort()).toEqual(["attempt-before-observations.json","attempt.json"]);
  });

  it("keeps an existing incomplete receipt untouched and requires reconciliation", async () => {
    const path = await directory();
    const bad = JSON.stringify({ rowsInserted: 0, candidateSha256: expected.candidateSha256 });
    await writeFile(join(path, "applied.json"), bad);
    await expect(prepareBaselineAttempt(path, expected, present)).rejects.toThrow(/not a verified complete/);
    expect(await readFile(join(path, "applied.json"), "utf8")).toBe(bad);
    expect(await readdir(path)).toEqual(["applied.json"]);
  });

  it("stops before the application callback if the actual before archive cannot be created exclusively", async () => {
    const path = await directory();
    const snapshotPath = join(path, "attempt-before-observations.json");
    await writeFile(snapshotPath, "retained-before-evidence");
    let applicationEntered = false;
    await expect((async () => {
      await prepareBaselineAttempt(path, expected, missing);
      applicationEntered = true;
    })()).rejects.toThrow(/archive already exists and was preserved/);
    expect(applicationEntered).toBe(false);
    expect(await readFile(snapshotPath, "utf8")).toBe("retained-before-evidence");
    expect(await readdir(path)).toEqual(["attempt-before-observations.json"]);
  });

  it("detects an altered actual before archive in both retry and finalizer verification", async () => {
    const path = await directory();
    const attempt = await prepareBaselineAttempt(path, expected, missing);
    if (attempt.kind !== "new") throw new Error("new attempt expected");
    const receipt = complete(attempt.startedAt);
    await writeBaselineSuccess(path, receipt, expected);
    await writeFile(join(path, receipt.beforeSnapshotFile), JSON.stringify([{ replaced: true }]));
    await expect(prepareBaselineAttempt(path, expected, present)).rejects.toThrow(/archive hash disagrees/);
    await expect(readBaselineBeforeSnapshot(path, receipt)).rejects.toThrow(/archive hash disagrees/);
    expect(JSON.parse(await readFile(join(path, "applied.json"), "utf8"))).toEqual(receipt);
  });
});
