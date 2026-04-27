/**
 * Regression test for the /api/v1/health endpoint's exclusion of
 * retired adapter audit rows.
 *
 * Pre-fix the response included entries for `boe_sonia`, `ice_gas`,
 * `lseg_housebuilders`, and `twelve_data_housebuilders` even though
 * none of those adapters run any more. Operators chased false-positive
 * staleness signals as a result. Now the handler filters them out.
 */
import { describe, expect, it } from "vitest";
import { handleHealth } from "../handlers/health.js";

function makeEnv(rows: Array<{ source_id: string; started_at: string; status: string }>): Env {
  // Permissive stub: every method call returns a shape that satisfies
  // both the .all<T>() and .bind(...).all<T>() patterns used by
  // getLastIngestionAudit and any sibling code.
  const stmt = {
    bind: () => stmt,
    all: async () => ({ results: rows }),
    first: async () => null,
  };
  const env = {
    DB: { prepare: () => stmt },
  } as unknown as Env;
  return env;
}

function makeReq(): Request {
  return new Request("https://api.tightropetracker.uk/api/v1/health");
}

describe("handleHealth — retired-adapter filter", () => {
  it("excludes boe_sonia / ice_gas / lseg_housebuilders / twelve_data_housebuilders from ingestionLastSuccess", async () => {
    const env = makeEnv([
      { source_id: "boe_yields",                started_at: "2026-04-27T10:15:32Z", status: "success" },
      { source_id: "boe_sonia",                 started_at: "2026-04-23T15:30:33Z", status: "success" },
      { source_id: "ice_gas",                   started_at: "2026-04-23T15:30:35Z", status: "success" },
      { source_id: "lseg_housebuilders",        started_at: "2026-04-22T07:46:00Z", status: "success" },
      { source_id: "twelve_data_housebuilders", started_at: "2026-04-22T08:45:49Z", status: "success" },
      { source_id: "ons_psf",                   started_at: "2026-04-27T02:00:37Z", status: "success" },
    ]);

    const res = await handleHealth(makeReq(), env);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      ingestionLastSuccess: Record<string, string>;
    };

    expect(body.ok).toBe(true);
    expect(body.ingestionLastSuccess).toHaveProperty("boe_yields");
    expect(body.ingestionLastSuccess).toHaveProperty("ons_psf");
    expect(body.ingestionLastSuccess).not.toHaveProperty("boe_sonia");
    expect(body.ingestionLastSuccess).not.toHaveProperty("ice_gas");
    expect(body.ingestionLastSuccess).not.toHaveProperty("lseg_housebuilders");
    expect(body.ingestionLastSuccess).not.toHaveProperty("twelve_data_housebuilders");
  });

  it("also drops the :historical sibling of a retired adapter (boe_sonia:historical)", async () => {
    const env = makeEnv([
      { source_id: "boe_sonia:historical", started_at: "2026-04-19T08:17:50Z", status: "success" },
      { source_id: "ons_psf:historical",   started_at: "2026-04-19T08:17:52Z", status: "success" },
    ]);
    const res = await handleHealth(makeReq(), env);
    const body = await res.json() as { ingestionLastSuccess: Record<string, string> };
    expect(body.ingestionLastSuccess).not.toHaveProperty("boe_sonia:historical");
    // Active-source historical siblings are still reported (they're
    // a useful "did backfill last run cleanly" signal for ops).
    expect(body.ingestionLastSuccess).toHaveProperty("ons_psf:historical");
  });

  it("rejects unknown query parameters", async () => {
    const env = makeEnv([]);
    const req = new Request("https://api.tightropetracker.uk/api/v1/health?foo=bar");
    const res = await handleHealth(req, env);
    expect(res.status).toBe(400);
  });
});
