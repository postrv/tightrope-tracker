import { describe, expect, it } from "vitest";
import { handleCorrectionCreate } from "../corrections.js";
import type { Env } from "../env.js";

/**
 * Stub D1 that records every INSERT and supports a single-row response for
 * SELECT queries. The corrections handler issues exactly one INSERT per call
 * and (optionally) one SELECT-back for the 201 body.
 */
function makeEnv(opts: {
  token?: string;
  failOnInsert?: Error;
} = {}): {
  env: Env;
  inserts: Array<{ sql: string; bindings: readonly unknown[] }>;
} {
  const inserts: Array<{ sql: string; bindings: readonly unknown[] }> = [];
  interface Stmt {
    sql: string;
    bindings: readonly unknown[];
    bind: (...b: unknown[]) => Stmt;
    run: () => Promise<{ success: true }>;
    first: () => Promise<unknown>;
  }
  const makeStatement = (sql: string, bindings: readonly unknown[] = []): Stmt => ({
    sql,
    bindings,
    bind: (...b: unknown[]) => makeStatement(sql, b),
    run: async () => {
      if (opts.failOnInsert) throw opts.failOnInsert;
      if (sql.trim().toUpperCase().startsWith("INSERT")) {
        inserts.push({ sql, bindings });
      }
      return { success: true };
    },
    first: async () => null,
  });
  // SEC-13: adminAuthGate touches KV for admin-backoff:* keys. Provide a
  // minimal in-memory KV stub so the tests don't have to track them.
  const backoffStore = new Map<string, string>();
  const kv = {
    async get(k: string) { return k.startsWith("admin-backoff:") ? (backoffStore.get(k) ?? null) : null; },
    async put(k: string, v: string) { if (k.startsWith("admin-backoff:")) backoffStore.set(k, v); },
    async delete(k: string) { if (k.startsWith("admin-backoff:")) backoffStore.delete(k); },
  };
  const env = {
    DB: { prepare: (sql: string) => makeStatement(sql) },
    ADMIN_TOKEN: opts.token ?? "test-token",
    KV: kv,
  } as unknown as Env;
  return { env, inserts };
}

function makeReq(
  body: unknown,
  opts: { token?: string | null; method?: string } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.token !== null) headers["x-admin-token"] = opts.token ?? "test-token";
  return new Request("https://ingest.example/admin/correction", {
    method: opts.method ?? "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleCorrectionCreate", () => {
  it("rejects non-POST methods with 405", async () => {
    const { env } = makeEnv();
    const res = await handleCorrectionCreate(
      new Request("https://ingest.example/admin/correction", { method: "GET" }),
      env,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("rejects missing admin token with 401", async () => {
    const { env } = makeEnv();
    const res = await handleCorrectionCreate(
      makeReq({ affectedIndicator: "x", originalValue: "a", correctedValue: "b", reason: "r" }, { token: null }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects wrong admin token with 401 (constant-time compare)", async () => {
    const { env } = makeEnv({ token: "real-token" });
    const res = await handleCorrectionCreate(
      makeReq(
        { affectedIndicator: "x", originalValue: "a", correctedValue: "b", reason: "r" },
        { token: "wrong-token" },
      ),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns 503 when ADMIN_TOKEN is not configured", async () => {
    const { env } = makeEnv();
    (env as unknown as { ADMIN_TOKEN: string | undefined }).ADMIN_TOKEN = undefined;
    const res = await handleCorrectionCreate(
      makeReq({ affectedIndicator: "x", originalValue: "a", correctedValue: "b", reason: "r" }),
      env,
    );
    expect(res.status).toBe(503);
  });

  it("rejects non-JSON body with 400", async () => {
    const { env } = makeEnv();
    const res = await handleCorrectionCreate(
      new Request("https://ingest.example/admin/correction", {
        method: "POST",
        headers: { "x-admin-token": "test-token", "content-type": "text/plain" },
        body: "not json",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it.each([
    ["missing affectedIndicator", { originalValue: "a", correctedValue: "b", reason: "r" }],
    ["missing originalValue", { affectedIndicator: "x", correctedValue: "b", reason: "r" }],
    ["missing correctedValue", { affectedIndicator: "x", originalValue: "a", reason: "r" }],
    ["missing reason", { affectedIndicator: "x", originalValue: "a", correctedValue: "b" }],
    ["empty reason", { affectedIndicator: "x", originalValue: "a", correctedValue: "b", reason: "" }],
    ["empty affectedIndicator", { affectedIndicator: "", originalValue: "a", correctedValue: "b", reason: "r" }],
  ])("rejects %s with 400", async (_name, body) => {
    const { env, inserts } = makeEnv();
    const res = await handleCorrectionCreate(makeReq(body), env);
    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  it("rejects unreasonably large reason (> 2000 chars) with 400", async () => {
    const { env, inserts } = makeEnv();
    const res = await handleCorrectionCreate(
      makeReq({
        affectedIndicator: "x",
        originalValue: "a",
        correctedValue: "b",
        reason: "x".repeat(2001),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  it("rejects invalid publishedAt with 400", async () => {
    const { env, inserts } = makeEnv();
    const res = await handleCorrectionCreate(
      makeReq({
        affectedIndicator: "x",
        originalValue: "a",
        correctedValue: "b",
        reason: "r",
        publishedAt: "not a date",
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  it("writes valid correction to D1 and returns 201 with the created row", async () => {
    const { env, inserts } = makeEnv();
    const res = await handleCorrectionCreate(
      makeReq({
        affectedIndicator: "planning_consents",
        originalValue: "7,300",
        correctedValue: "7,200",
        reason: "Re-derived from the Q4 2025 MHCLG release; the rounded figure was superseded.",
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = await res.json() as {
      id: string; publishedAt: string; affectedIndicator: string;
      originalValue: string; correctedValue: string; reason: string;
    };
    expect(body.affectedIndicator).toBe("planning_consents");
    expect(body.originalValue).toBe("7,300");
    expect(body.correctedValue).toBe("7,200");
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    expect(inserts).toHaveLength(1);
    const [insert] = inserts;
    expect(insert!.sql).toMatch(/INSERT INTO corrections/i);
    // bindings order: id, published_at, affected_indicator, original_value, corrected_value, reason
    expect(insert!.bindings[0]).toBe(body.id);
    expect(insert!.bindings[1]).toBe(body.publishedAt);
    expect(insert!.bindings[2]).toBe("planning_consents");
    expect(insert!.bindings[3]).toBe("7,300");
    expect(insert!.bindings[4]).toBe("7,200");
    expect(insert!.bindings[5]).toMatch(/Re-derived/);
  });

  it("accepts an explicit publishedAt (for backfilling a historical correction)", async () => {
    const { env, inserts } = makeEnv();
    const res = await handleCorrectionCreate(
      makeReq({
        affectedIndicator: "planning_consents",
        originalValue: "7,300",
        correctedValue: "7,200",
        reason: "Retroactively logged.",
        publishedAt: "2026-04-17T10:30:00Z",
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { publishedAt: string };
    expect(body.publishedAt).toBe("2026-04-17T10:30:00.000Z");
    expect(inserts[0]!.bindings[1]).toBe("2026-04-17T10:30:00.000Z");
  });

  it("returns 409 on primary-key collision (duplicate id)", async () => {
    const { env } = makeEnv({
      failOnInsert: new Error("UNIQUE constraint failed: corrections.id"),
    });
    const res = await handleCorrectionCreate(
      makeReq({
        affectedIndicator: "x",
        originalValue: "a",
        correctedValue: "b",
        reason: "r",
      }),
      env,
    );
    expect(res.status).toBe(409);
  });

  it("returns 500 on other D1 errors, logging but not leaking the message", async () => {
    const { env } = makeEnv({ failOnInsert: new Error("some other db boom") });
    const res = await handleCorrectionCreate(
      makeReq({
        affectedIndicator: "x",
        originalValue: "a",
        correctedValue: "b",
        reason: "r",
      }),
      env,
    );
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).not.toContain("some other db boom");
  });
});
