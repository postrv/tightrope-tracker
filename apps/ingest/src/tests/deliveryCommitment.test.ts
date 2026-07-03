import { describe, expect, it } from "vitest";
import { handleDeliveryCommitmentPatch } from "../deliveryCommitment.js";
import type { Env } from "../env.js";

/**
 * Stub D1 for the delivery-commitment admin endpoint. Records every run()
 * (INSERT/UPDATE) and answers the two SELECT-back queries the handler issues:
 *   - existence check: `SELECT id FROM delivery_commitments WHERE id = ?`
 *   - closeAuditSuccess payload_hash lookup: `... FROM ingestion_audit ...`
 */
function makeEnv(opts: {
  token?: string;
  /** ids that exist in delivery_commitments (existence SELECT returns a row). */
  existingIds?: readonly string[];
} = {}): {
  env: Env;
  runs: Array<{ sql: string; bindings: readonly unknown[] }>;
  kvDeletes: string[];
} {
  const existing = new Set(opts.existingIds ?? ["housing_target"]);
  const runs: Array<{ sql: string; bindings: readonly unknown[] }> = [];
  const kvDeletes: string[] = [];

  interface Stmt {
    sql: string;
    bindings: readonly unknown[];
    bind: (...b: unknown[]) => Stmt;
    run: () => Promise<{ success: true }>;
    first: <T>() => Promise<T | null>;
  }
  const makeStatement = (sql: string, bindings: readonly unknown[] = []): Stmt => ({
    sql,
    bindings,
    bind: (...b: unknown[]) => makeStatement(sql, b),
    run: async () => {
      runs.push({ sql, bindings });
      return { success: true };
    },
    first: async <T>() => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.includes("FROM delivery_commitments")) {
        const id = bindings[0] as string;
        return (existing.has(id) ? { id } : null) as unknown as T | null;
      }
      // lastSuccessPayloadHash lookup — no prior success → status 'success'.
      return null as unknown as T | null;
    },
  });

  // adminAuthGate touches admin-backoff:* keys; the handler deletes
  // delivery:latest. Track deletes; namespace the backoff store.
  const backoffStore = new Map<string, string>();
  const kv = {
    async get(k: string) { return k.startsWith("admin-backoff:") ? (backoffStore.get(k) ?? null) : null; },
    async put(k: string, v: string) { if (k.startsWith("admin-backoff:")) backoffStore.set(k, v); },
    async delete(k: string) {
      kvDeletes.push(k);
      if (k.startsWith("admin-backoff:")) backoffStore.delete(k);
    },
  };
  const env = {
    DB: { prepare: (sql: string) => makeStatement(sql) },
    ADMIN_TOKEN: opts.token ?? "test-token",
    KV: kv,
  } as unknown as Env;
  return { env, runs, kvDeletes };
}

function makeReq(body: unknown, opts: { token?: string | null; method?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== null) headers["x-admin-token"] = opts.token ?? "test-token";
  return new Request("https://ingest.example/admin/delivery-commitment", {
    method: opts.method ?? "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleDeliveryCommitmentPatch — auth", () => {
  it("rejects non-POST with 405", async () => {
    const { env } = makeEnv();
    const res = await handleDeliveryCommitmentPatch(
      new Request("https://ingest.example/admin/delivery-commitment", { method: "GET" }),
      env,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("rejects a missing admin token with 401", async () => {
    const { env } = makeEnv();
    const res = await handleDeliveryCommitmentPatch(
      makeReq({ id: "housing_target", status: "slipping" }, { token: null }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a wrong admin token with 401", async () => {
    const { env } = makeEnv({ token: "real-token" });
    const res = await handleDeliveryCommitmentPatch(
      makeReq({ id: "housing_target", status: "slipping" }, { token: "wrong-token" }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns 503 when ADMIN_TOKEN is not configured", async () => {
    const { env } = makeEnv();
    (env as unknown as { ADMIN_TOKEN: string | undefined }).ADMIN_TOKEN = undefined;
    const res = await handleDeliveryCommitmentPatch(makeReq({ id: "housing_target", status: "slipping" }), env);
    expect(res.status).toBe(503);
  });
});

describe("handleDeliveryCommitmentPatch — allowlist + validation", () => {
  it("rejects an unknown field", async () => {
    const { env, runs } = makeEnv();
    const res = await handleDeliveryCommitmentPatch(
      makeReq({ id: "housing_target", status: "slipping", department: "MHCLG" }),
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("department");
    // No UPDATE issued on a rejected body.
    expect(runs.some((r) => r.sql.includes("UPDATE delivery_commitments"))).toBe(false);
  });

  it("rejects a body with no updatable fields", async () => {
    const { env } = makeEnv();
    const res = await handleDeliveryCommitmentPatch(makeReq({ id: "housing_target" }), env);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("at least one");
  });

  it("rejects a missing id", async () => {
    const { env } = makeEnv();
    const res = await handleDeliveryCommitmentPatch(makeReq({ status: "slipping" }), env);
    expect(res.status).toBe(400);
  });

  it("rejects an invalid status against the CHECK value set", async () => {
    const { env } = makeEnv();
    const res = await handleDeliveryCommitmentPatch(
      makeReq({ id: "housing_target", status: "on-track" }),
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("status must be one of");
  });

  it("accepts every documented status value", async () => {
    for (const status of ["on_track", "slipping", "missed", "shipped"] as const) {
      const { env } = makeEnv();
      const res = await handleDeliveryCommitmentPatch(makeReq({ id: "housing_target", status }), env);
      expect(res.status, status).toBe(200);
    }
  });

  it("404s an unknown id without writing an audit row", async () => {
    const { env, runs } = makeEnv({ existingIds: ["housing_target"] });
    const res = await handleDeliveryCommitmentPatch(
      makeReq({ id: "does_not_exist", status: "slipping" }),
      env,
    );
    expect(res.status).toBe(404);
    expect(runs.some((r) => r.sql.includes("ingestion_audit"))).toBe(false);
    expect(runs.some((r) => r.sql.includes("UPDATE delivery_commitments"))).toBe(false);
  });
});

describe("handleDeliveryCommitmentPatch — happy path", () => {
  it("UPDATEs only the supplied columns plus updated_at, and returns them", async () => {
    const { env, runs } = makeEnv();
    const res = await handleDeliveryCommitmentPatch(
      makeReq({ id: "housing_target", latest: "1.5m started", status: "slipping", notes: "revised" }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; id: string; updated: Record<string, string>; updatedAt: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe("housing_target");
    expect(body.updated).toEqual({ latest: "1.5m started", status: "slipping", notes: "revised" });
    expect(Number.isFinite(Date.parse(body.updatedAt))).toBe(true);

    const update = runs.find((r) => r.sql.includes("UPDATE delivery_commitments"));
    expect(update, "an UPDATE was issued").toBeDefined();
    expect(update!.sql).toContain("latest = ?");
    expect(update!.sql).toContain("status = ?");
    expect(update!.sql).toContain("notes = ?");
    expect(update!.sql).toContain("updated_at = ?");
    // Never touches a column the caller didn't send.
    expect(update!.sql).not.toContain("source_url = ?");
    expect(update!.sql).not.toContain("department = ?");
    // Bind order: [latest, status, notes, updatedAt, id].
    expect(update!.bindings[0]).toBe("1.5m started");
    expect(update!.bindings.at(-1)).toBe("housing_target");
  });

  it("writes an ingestion_audit row under source_id delivery_commitments_admin", async () => {
    const { env, runs } = makeEnv();
    await handleDeliveryCommitmentPatch(makeReq({ id: "housing_target", status: "shipped" }), env);
    const auditInsert = runs.find(
      (r) => r.sql.includes("INSERT INTO ingestion_audit"),
    );
    expect(auditInsert, "audit row opened").toBeDefined();
    expect(auditInsert!.bindings).toContain("delivery_commitments_admin");
    // closeAuditSuccess issues the closing UPDATE on ingestion_audit.
    expect(runs.some((r) => r.sql.includes("UPDATE ingestion_audit"))).toBe(true);
  });

  it("purges the delivery:latest KV cache on success", async () => {
    const { env, kvDeletes } = makeEnv();
    await handleDeliveryCommitmentPatch(makeReq({ id: "housing_target", status: "slipping" }), env);
    expect(kvDeletes).toContain("delivery:latest");
  });

  it("trims whitespace on string fields", async () => {
    const { env, runs } = makeEnv();
    await handleDeliveryCommitmentPatch(makeReq({ id: "housing_target", notes: "  spaced  " }), env);
    const update = runs.find((r) => r.sql.includes("UPDATE delivery_commitments"));
    expect(update!.bindings[0]).toBe("spaced");
  });
});
