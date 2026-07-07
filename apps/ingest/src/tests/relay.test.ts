import { describe, expect, it } from "vitest";
import { handleRelay } from "../relay.js";
import type { Env } from "../env.js";

/**
 * A small recorded-shape BoE IADB CSV for the gilt-yields series
 * (DATE, IUDMNZC 10y, IUDLNZC 20y). Values sit inside the plausibility bounds
 * (gilt_10y/gilt_30y ∈ [0,10]) so the gate writes them rather than quarantining.
 */
const YIELDS_CSV = [
  "DATE,IUDMNZC,IUDLNZC",
  "01 Jul 2026,4.62,5.12",
  "02 Jul 2026,4.58,5.09",
  "03 Jul 2026,4.61,5.14",
].join("\n");

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * D1 + DLQ + KV stub for the relay endpoint. It records every write, answers the
 * two SELECT-backs runAdapter issues (readPreviousLive → none; lastSuccessPayloadHash),
 * captures batched observation writes, and — crucially for the 'unchanged' case —
 * remembers the payload_hash of the last success/unchanged audit row per source so
 * a byte-identical replay resolves to 'unchanged'.
 */
function makeEnv(opts: { token?: string } = {}): {
  env: Env;
  runs: Array<{ sql: string; bindings: readonly unknown[] }>;
  dlqSends: unknown[];
} {
  const runs: Array<{ sql: string; bindings: readonly unknown[] }> = [];
  const dlqSends: unknown[] = [];
  const auditSource = new Map<string, string>(); // audit row id -> source_id (from openAudit)
  const lastSuccessHash = new Map<string, string>(); // source_id -> last success/unchanged payload_hash
  const backoffStore = new Map<string, string>();

  interface Stmt {
    sql: string;
    bindings: readonly unknown[];
    bind: (...b: unknown[]) => Stmt;
    run: () => Promise<{ success: true }>;
    first: <T>() => Promise<T | null>;
    all: <T>() => Promise<{ results: T[] }>;
  }
  const makeStmt = (sql: string, bindings: readonly unknown[] = []): Stmt => ({
    sql,
    bindings,
    bind: (...b: unknown[]) => makeStmt(sql, b),
    run: async () => {
      const norm = sql.replace(/\s+/g, " ").trim();
      if (norm.startsWith("INSERT INTO ingestion_audit")) {
        // openAudit: bindings = [id, source_id, started_at, source_url]
        auditSource.set(bindings[0] as string, bindings[1] as string);
      } else if (norm.startsWith("UPDATE ingestion_audit")) {
        // closeAuditSuccess: bindings = [status, completed_at, rows_written, payload_hash, error, id]
        const status = bindings[0] as string;
        const payloadHash = bindings[3] as string | undefined;
        const sourceId = auditSource.get(bindings[5] as string);
        if (sourceId && payloadHash && (status === "success" || status === "unchanged")) {
          lastSuccessHash.set(sourceId, payloadHash);
        }
      }
      runs.push({ sql, bindings });
      return { success: true };
    },
    first: async <T>() => {
      const norm = sql.replace(/\s+/g, " ").trim();
      if (/SELECT payload_hash FROM ingestion_audit/i.test(norm)) {
        const hash = lastSuccessHash.get(bindings[0] as string);
        return (hash ? { payload_hash: hash } : null) as unknown as T | null;
      }
      return null as unknown as T | null;
    },
    // readPreviousLive → no prior live rows, so the jump gate is skipped.
    all: async <T>() => ({ results: [] as T[] }),
  });

  const kv = {
    async get(k: string) {
      return k.startsWith("admin-backoff:") ? (backoffStore.get(k) ?? null) : null;
    },
    async put(k: string, v: string) {
      if (k.startsWith("admin-backoff:")) backoffStore.set(k, v);
    },
    async delete(k: string) {
      if (k.startsWith("admin-backoff:")) backoffStore.delete(k);
    },
  };

  const env = {
    DB: {
      prepare: (sql: string) => makeStmt(sql),
      // writeObservations batches the indicator_observations INSERTs — record
      // each so tests can assert the rows that landed.
      batch: async (stmts: Array<{ sql: string; bindings: readonly unknown[] }>) => {
        for (const s of stmts) runs.push({ sql: s.sql, bindings: s.bindings });
        return [];
      },
    },
    DLQ: {
      send: async (m: unknown) => {
        dlqSends.push(m);
      },
    },
    ADMIN_TOKEN: opts.token ?? "test-token",
    KV: kv,
  } as unknown as Env;
  return { env, runs, dlqSends };
}

function makeReq(
  csv: string | null,
  opts: { adapter?: string | null; token?: string | null; method?: string; headers?: Record<string, string> } = {},
): Request {
  const adapter = opts.adapter === undefined ? "boe_yields" : opts.adapter;
  const qs = adapter === null ? "" : `?adapter=${encodeURIComponent(adapter)}`;
  const headers: Record<string, string> = { "content-type": "text/csv", ...(opts.headers ?? {}) };
  if (opts.token !== null) headers["x-admin-token"] = opts.token ?? "test-token";
  return new Request(`https://ingest.example/admin/relay${qs}`, {
    method: opts.method ?? "POST",
    headers,
    ...(csv === null ? {} : { body: csv }),
  });
}

const relayUrl = (req: Request): URL => new URL(req.url);

describe("handleRelay — auth", () => {
  it("rejects non-POST with 405", async () => {
    const { env } = makeEnv();
    const req = makeReq(null, { method: "GET" });
    const res = await handleRelay(req, env, relayUrl(req));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("rejects a missing admin token with 401", async () => {
    const { env } = makeEnv();
    const req = makeReq(YIELDS_CSV, { token: null });
    const res = await handleRelay(req, env, relayUrl(req));
    expect(res.status).toBe(401);
  });

  it("rejects a wrong admin token with 401", async () => {
    const { env } = makeEnv({ token: "real-token" });
    const req = makeReq(YIELDS_CSV, { token: "wrong-token" });
    const res = await handleRelay(req, env, relayUrl(req));
    expect(res.status).toBe(401);
  });

  it("returns 503 when ADMIN_TOKEN is not configured", async () => {
    const { env } = makeEnv();
    (env as unknown as { ADMIN_TOKEN: string | undefined }).ADMIN_TOKEN = undefined;
    const req = makeReq(YIELDS_CSV);
    const res = await handleRelay(req, env, relayUrl(req));
    expect(res.status).toBe(503);
  });
});

describe("handleRelay — adapter allowlist + body validation", () => {
  it("400s a missing ?adapter param without opening an audit row", async () => {
    const { env, runs } = makeEnv();
    const req = makeReq(YIELDS_CSV, { adapter: null });
    const res = await handleRelay(req, env, relayUrl(req));
    expect(res.status).toBe(400);
    expect(runs.some((r) => r.sql.includes("ingestion_audit"))).toBe(false);
  });

  it("404s an unknown adapter without opening an audit row", async () => {
    const { env, runs } = makeEnv();
    const req = makeReq(YIELDS_CSV, { adapter: "totally_made_up" });
    const res = await handleRelay(req, env, relayUrl(req));
    expect(res.status).toBe(404);
    expect(runs.some((r) => r.sql.includes("ingestion_audit"))).toBe(false);
  });

  it("404s a real-but-not-allowlisted adapter (only the four BoE adapters may relay)", async () => {
    const { env } = makeEnv();
    const req = makeReq(YIELDS_CSV, { adapter: "ons_psf" });
    const res = await handleRelay(req, env, relayUrl(req));
    expect(res.status).toBe(404);
  });

  it("400s an empty body", async () => {
    const { env } = makeEnv();
    const req = makeReq("   \n  ");
    const res = await handleRelay(req, env, relayUrl(req));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("empty");
  });

  it("400s an oversized body", async () => {
    const { env } = makeEnv();
    const req = makeReq("a".repeat(MAX_BODY_BYTES + 1));
    const res = await handleRelay(req, env, relayUrl(req));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("exceeds");
  });
});

describe("handleRelay — happy path", () => {
  it("replays the CSV through the adapter, writes observations, and closes a success audit row", async () => {
    const { env, runs } = makeEnv();
    const req = makeReq(YIELDS_CSV, { adapter: "boe_yields" });
    const res = await handleRelay(req, env, relayUrl(req));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; adapter: string; status: string; rowsWritten: number };
    expect(body).toEqual({ ok: true, adapter: "boe_yields", status: "success", rowsWritten: 2 });

    // Observations landed via the batched INSERT OR REPLACE, taking the most
    // recent populated row (03 Jul: 4.61 / 5.14).
    const obs = runs.filter((r) => r.sql.includes("INSERT OR REPLACE INTO indicator_observations"));
    expect(obs).toHaveLength(2);
    const flat = obs.flatMap((r) => r.bindings as unknown[]);
    expect(flat).toContain("gilt_10y");
    expect(flat).toContain("gilt_30y");
    expect(flat).toContain(4.61);
    expect(flat).toContain(5.14);

    // Audit row closed as success with rows_written = 2.
    const close = runs.find((r) => r.sql.includes("UPDATE ingestion_audit"));
    expect(close, "audit row closed").toBeDefined();
    expect(close!.bindings[0]).toBe("success");
    expect(close!.bindings[2]).toBe(2);
  });

  it("marks a byte-identical replay as 'unchanged' (same payload hash as the prior success)", async () => {
    const { env } = makeEnv();
    const first = makeReq(YIELDS_CSV, { adapter: "boe_yields" });
    const firstRes = await handleRelay(first, env, relayUrl(first));
    expect(((await firstRes.json()) as { status: string }).status).toBe("success");

    // Same env, same bytes → the audit closer sees the matching last-success hash.
    const second = makeReq(YIELDS_CSV, { adapter: "boe_yields" });
    const secondRes = await handleRelay(second, env, relayUrl(second));
    const body = (await secondRes.json()) as { ok: boolean; status: string; rowsWritten: number };
    expect(secondRes.status).toBe(200);
    expect(body.status).toBe("unchanged");
    // Rows are still (re)written idempotently, so rowsWritten stays 2.
    expect(body.rowsWritten).toBe(2);
  });
});

describe("handleRelay — malformed payload", () => {
  it("routes a parse failure through the failure-audit + DLQ path and never throws out of the handler", async () => {
    const { env, runs, dlqSends } = makeEnv();
    // Ragged row (2 cells under a 3-column header) → parseCsv throws.
    const malformed = "DATE,IUDMNZC,IUDLNZC\n03 Jul 2026,4.61";
    const req = makeReq(malformed, { adapter: "boe_yields" });

    // The handler must resolve (not reject) even though the adapter throws.
    const res = await handleRelay(req, env, relayUrl(req));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; adapter: string; status: string; rowsWritten: number };
    expect(body).toEqual({ ok: false, adapter: "boe_yields", status: "failure", rowsWritten: 0 });

    // Failure audit row written + one DLQ message enqueued.
    expect(runs.some((r) => r.sql.includes("status = 'failure'"))).toBe(true);
    expect(dlqSends).toHaveLength(1);
    // No observation ever landed.
    expect(runs.some((r) => r.sql.includes("INSERT OR REPLACE INTO indicator_observations"))).toBe(false);
  });
});

function makeBackfillReq(qs: string): Request {
  return new Request(`https://ingest.example/admin/relay?adapter=boe_yields${qs}`, {
    method: "POST",
    headers: { "content-type": "text/csv", "x-admin-token": "test-token" },
    body: YIELDS_CSV,
  });
}

describe("handleRelay — backfill mode", () => {
  it("400s an unknown mode", async () => {
    const { env } = makeEnv();
    const req = makeBackfillReq("&mode=nonsense");
    const res = await handleRelay(req, env, relayUrl(req));
    expect(res.status).toBe(400);
  });

  it("400s backfill without a from date, and rejects malformed or inverted ranges", async () => {
    const { env } = makeEnv();
    for (const qs of ["&mode=backfill", "&mode=backfill&from=30-06-2026", "&mode=backfill&from=2026-07-05&to=2026-06-30"]) {
      const req = makeBackfillReq(qs);
      const res = await handleRelay(req, env, relayUrl(req));
      expect(res.status).toBe(400);
    }
  });

  it("replays the CSV through fetchHistorical: hist rows written under a :historical audit row", async () => {
    const { env, runs } = makeEnv();
    const req = makeBackfillReq("&mode=backfill&from=2026-06-30&to=2026-07-05&overwrite=true");
    const res = await handleRelay(req, env, relayUrl(req));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; mode: string; rowsWritten: number; rowsRejected: number };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("backfill");
    expect(body.rowsWritten).toBeGreaterThan(0);
    expect(body.rowsRejected).toBe(0);

    // Audit row opened under the :historical source id.
    expect(
      runs.some((r) => r.sql.includes("INSERT INTO ingestion_audit") && r.bindings.includes("boe_yields:historical")),
    ).toBe(true);
    // Observation writes are the historical tier: hist:-prefixed payload hashes.
    const obsWrites = runs.filter((r) => r.sql.includes("INSERT OR REPLACE INTO indicator_observations"));
    expect(obsWrites.length).toBeGreaterThan(0);
    expect(obsWrites.every((r) => r.bindings.some((b) => typeof b === "string" && b.startsWith("hist:")))).toBe(true);
  });

  it("honours dryRun: reports without writing any observation rows", async () => {
    const { env, runs } = makeEnv();
    const req = makeBackfillReq("&mode=backfill&from=2026-06-30&dryRun=true");
    const res = await handleRelay(req, env, relayUrl(req));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dryRun: boolean; rowsWritten: number };
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.rowsWritten).toBe(0);
    expect(runs.some((r) => r.sql.includes("INSERT OR REPLACE INTO indicator_observations"))).toBe(false);
  });
});
