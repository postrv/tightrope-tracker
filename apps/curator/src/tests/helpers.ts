import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../env";
import type { CaptureSpec } from "../types";

/**
 * Shared test doubles (NOT a *.test.ts file, so vitest never collects it).
 * A purpose-built in-memory D1 recognising exactly the queries the curator
 * pipeline issues (SQL matched by substring, tables kept as plain arrays/maps),
 * plus KV and Workers-AI stubs. Deliberately not a SQL engine — same idiom as
 * apps/ingest/src/tests/*.
 */

export interface FakeCaptureRow {
  id: number;
  source_id: string;
  indicator_id: string | null;
  kind: string;
  captured_at: string;
  source_url: string;
  content_sha256: string;
  raw_r2_key: string | null;
  observed_at: string | null;
  released_at: string | null;
  value: number | null;
  payload: string | null;
  quote: string | null;
  confidence: number | null;
  verification: string | null;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  published_observation_key: string | null;
  model_id: string | null;
  prompt_version: string | null;
  created_at: string;
}

export interface FakeLatestObservation {
  indicator_id: string;
  source_id: string;
  observed_at: string;
  value: number;
  ingested_at: string;
  released_at: string | null;
}

export interface FakeDb {
  db: D1Database;
  captures: FakeCaptureRow[];
  corrections: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
  timelineEvents: Array<Record<string, unknown>>;
  observationWrites: Array<{ indicatorId: string; observedAt: string; value: number; sourceId: string; payloadHash: string; releasedAt: string | null }>;
  /** What readLatestObservations returns (verify G4/G6, staleness, digest). */
  latestObservations: FakeLatestObservation[];
  /** Exact (indicator|observed_at) -> currently published value (corrections check). */
  publishedByKey: Map<string, number>;
}

export function makeFakeDb(seed: Partial<Pick<FakeDb, "captures" | "latestObservations" | "publishedByKey">> = {}): FakeDb {
  const state: FakeDb = {
    db: null as unknown as D1Database,
    captures: seed.captures ?? [],
    corrections: [],
    audit: [],
    timelineEvents: [],
    observationWrites: [],
    latestObservations: seed.latestObservations ?? [],
    publishedByKey: seed.publishedByKey ?? new Map(),
  };
  let nextId = state.captures.reduce((m, c) => Math.max(m, c.id), 0) + 1;

  function exec(sql: string, b: readonly unknown[]) {
    return {
      first: async <T>(): Promise<T | null> => {
        // insertCapture: INSERT ... RETURNING id
        if (sql.includes("INSERT INTO curator_captures") && sql.includes("RETURNING id")) {
          const row = captureFromInsert(sql, b, nextId++);
          state.captures.push(row);
          return { id: row.id } as unknown as T;
        }
        // latestCaptureSha
        if (sql.includes("SELECT content_sha256 FROM curator_captures")) {
          const sourceId = b[0] as string;
          const rows = state.captures.filter((c) => c.source_id === sourceId);
          const last = rows[rows.length - 1];
          return (last ? { content_sha256: last.content_sha256 } : null) as unknown as T | null;
        }
        // existence check (ingest quarantine path, unused here but supported)
        if (sql.includes("SELECT 1 AS one FROM curator_captures")) {
          const sha = b[1] as string;
          return (state.captures.some((c) => c.content_sha256 === sha) ? { one: 1 } : null) as unknown as T | null;
        }
        // getCapture
        if (sql.includes("SELECT * FROM curator_captures WHERE id = ?")) {
          const id = b[0] as number;
          return (state.captures.find((c) => c.id === id) ?? null) as unknown as T | null;
        }
        // readPublishedValueAt
        if (sql.includes("SELECT value FROM indicator_observations WHERE indicator_id = ? AND observed_at = ?")) {
          const key = `${b[0]}|${b[1]}`;
          const v = state.publishedByKey.get(key);
          return (v === undefined ? null : { value: v }) as unknown as T | null;
        }
        return null;
      },
      all: async <T>(): Promise<{ results: T[] }> => {
        // readLatestObservations (two-tier selector)
        if (sql.includes("ROW_NUMBER() OVER") && sql.includes("indicator_observations")) {
          return { results: state.latestObservations as unknown as T[] };
        }
        // listCaptures by status
        if (sql.includes("SELECT id, source_id, indicator_id, kind, value, confidence, status, created_at, observed_at")) {
          const status = b[0] as string;
          return { results: state.captures.filter((c) => c.status === status) as unknown as T[] };
        }
        // listPending by kind + source
        if (sql.includes("WHERE status = 'pending' AND kind = ? AND source_id = ?")) {
          const [kind, sourceId] = b as [string, string];
          return { results: state.captures.filter((c) => c.status === "pending" && c.kind === kind && c.source_id === sourceId) as unknown as T[] };
        }
        // digest: auto_published
        if (sql.includes("WHERE status = 'auto_published'")) {
          return { results: state.captures.filter((c) => c.status === "auto_published") as unknown as T[] };
        }
        // digest: approved milestones
        if (sql.includes("status = 'approved' AND kind = 'delivery_milestone'")) {
          return { results: state.captures.filter((c) => c.status === "approved" && c.kind === "delivery_milestone") as unknown as T[] };
        }
        return { results: [] };
      },
      run: async (): Promise<{ success: true }> => {
        if (sql.includes("INSERT INTO ingestion_audit")) {
          state.audit.push({ sql, bindings: b });
        } else if (sql.includes("UPDATE ingestion_audit")) {
          state.audit.push({ sql, bindings: b, update: true });
        } else if (sql.includes("INSERT OR REPLACE INTO indicator_observations")) {
          const [indicatorId, observedAt, value, sourceId, , payloadHash, releasedAt] = b as [string, string, number, string, string, string, string | null];
          state.observationWrites.push({ indicatorId, observedAt, value, sourceId, payloadHash, releasedAt });
          state.publishedByKey.set(`${indicatorId}|${observedAt}`, value);
        } else if (sql.includes("INSERT OR IGNORE INTO corrections")) {
          const [id, published_at, affected_indicator, original_value, corrected_value, reason] = b as string[];
          if (!state.corrections.some((c) => c.id === id)) {
            state.corrections.push({ id, published_at, affected_indicator, original_value, corrected_value, reason });
          }
        } else if (sql.includes("INSERT INTO timeline_events")) {
          state.timelineEvents.push({ sql, bindings: b });
        } else if (sql.includes("UPDATE curator_captures") && sql.includes("SET status = 'superseded'")) {
          const [indicatorId, observedAt, exceptId] = b as [string, string, number];
          for (const c of state.captures) {
            if (c.indicator_id === indicatorId && c.observed_at === observedAt && c.id !== exceptId && ["pending", "shadow", "quarantined"].includes(c.status)) {
              c.status = "superseded";
            }
          }
        } else if (sql.includes("UPDATE curator_captures") && sql.includes("SET status = ?, decided_by = ?")) {
          const [status, decidedBy, decidedAt, publishedKey, id] = b as [string, string | null, string, string | null, number];
          const row = state.captures.find((c) => c.id === id);
          if (row) {
            row.status = status;
            row.decided_by = decidedBy;
            row.decided_at = decidedAt;
            if (publishedKey) row.published_observation_key = publishedKey;
          }
        } else if (sql.includes("UPDATE curator_captures SET payload = ?")) {
          const [payload, id] = b as [string, number];
          const row = state.captures.find((c) => c.id === id);
          if (row) row.payload = payload;
        }
        return { success: true };
      },
    };
  }

  const prepare = (sql: string) => {
    const stmt = {
      bind: (...b: unknown[]) => exec(sql, b),
      first: async <T>() => exec(sql, []).first<T>(),
      all: async <T>() => exec(sql, []).all<T>(),
      run: async () => exec(sql, []).run(),
    };
    return stmt;
  };

  state.db = { prepare } as unknown as D1Database;
  return state;
}

/** Map an INSERT INTO curator_captures (...) bind array to a stored row. */
function captureFromInsert(_sql: string, b: readonly unknown[], id: number): FakeCaptureRow {
  const [
    source_id,
    indicator_id,
    kind,
    captured_at,
    source_url,
    content_sha256,
    raw_r2_key,
    observed_at,
    released_at,
    value,
    payload,
    quote,
    confidence,
    verification,
    status,
    decided_by,
    decided_at,
    published_observation_key,
    model_id,
    prompt_version,
  ] = b;
  return {
    id,
    source_id: source_id as string,
    indicator_id: (indicator_id as string) ?? null,
    kind: kind as string,
    captured_at: captured_at as string,
    source_url: source_url as string,
    content_sha256: content_sha256 as string,
    raw_r2_key: (raw_r2_key as string) ?? null,
    observed_at: (observed_at as string) ?? null,
    released_at: (released_at as string) ?? null,
    value: (value as number) ?? null,
    payload: (payload as string) ?? null,
    quote: (quote as string) ?? null,
    confidence: (confidence as number) ?? null,
    verification: (verification as string) ?? null,
    status: status as string,
    decided_by: (decided_by as string) ?? null,
    decided_at: (decided_at as string) ?? null,
    published_observation_key: (published_observation_key as string) ?? null,
    model_id: (model_id as string) ?? null,
    prompt_version: (prompt_version as string) ?? null,
    created_at: new Date().toISOString(),
  };
}

// --- KV ---------------------------------------------------------------------

export function makeKv(): { kv: { get: (k: string) => Promise<string | null>; put: (k: string, v: string, o?: { expirationTtl?: number }) => Promise<void>; delete: (k: string) => Promise<void> }; store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    kv: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v);
      },
      delete: async (k: string) => {
        store.delete(k);
      },
    },
  };
}

// --- Workers AI -------------------------------------------------------------

export interface FakeAiOptions {
  /** Return the raw model `response` string for a run call. Inspect messages to branch primary/secondary, or `response_format` to branch schema-mode vs the schema-free rescue. */
  run?: (model: string, inputs: { messages: Array<{ role: string; content: string }>; response_format?: unknown }) => string;
  toMarkdown?: (file: { name: string }) => { format: "markdown"; data: string } | { format: "error"; error: string };
}

export function makeAi(opts: FakeAiOptions): { AI: unknown; calls: Array<{ model: string; messages: Array<{ role: string; content: string }>; response_format?: unknown }> } {
  const calls: Array<{ model: string; messages: Array<{ role: string; content: string }>; response_format?: unknown }> = [];
  const AI = {
    run: async (model: string, inputs: { messages: Array<{ role: string; content: string }>; response_format?: unknown }) => {
      calls.push({ model, messages: inputs.messages, response_format: inputs.response_format });
      const response = opts.run ? opts.run(model, inputs) : "{}";
      return { response };
    },
    toMarkdown: async (file: { name: string }) => (opts.toMarkdown ? opts.toMarkdown(file) : { format: "markdown", data: "" }),
  };
  return { AI, calls };
}

/** Is this the G5 secondary framing? (the fact-checker persona). */
export function isSecondaryFraming(messages: Array<{ role: string; content: string }>): boolean {
  return messages.some((m) => m.role === "system" && m.content.includes("meticulous fact-checker"));
}

// --- Env assembly -----------------------------------------------------------

export function makeEnv(parts: { db?: FakeDb; kv?: ReturnType<typeof makeKv>["kv"]; ai?: unknown; extra?: Partial<Env> }): Env {
  return {
    DB: parts.db?.db,
    KV: parts.kv,
    AI: parts.ai,
    ARCHIVE: { put: async () => undefined, get: async () => null },
    CURATOR_MODE: "live",
    ...parts.extra,
  } as unknown as Env;
}

// --- Spec + extraction fixtures --------------------------------------------

export function observationSpec(over: Partial<CaptureSpec> = {}): CaptureSpec {
  return {
    sourceId: "sp_global_pmi",
    kind: "observation",
    indicatorIds: ["services_pmi"],
    urls: ["https://example.test/pmi"],
    format: "html",
    cadence: "monthly",
    // min/max are DERIVED from the shared PLAUSIBILITY table (services_pmi
    // [30,72]); the spec only carries maxDelta. Exercising the derived path.
    plausibility: { services_pmi: { maxDelta: 8 } },
    agreementTolerance: 0.5,
    allowAutoPublish: true,
    modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    promptVersion: "v1",
    ...over,
  };
}

/**
 * A derive-bearing spec mirroring mhclg_housing's shape: one single-component
 * derived indicator + one two-component (summed) derived indicator, real
 * shared PLAUSIBILITY ids so the G3/G4 derived path is exercised for real.
 * Formulas are simplified (÷1000×100 style) so expected values are obvious.
 */
export function derivedSpec(over: Partial<CaptureSpec> = {}): CaptureSpec {
  return observationSpec({
    sourceId: "mhclg_housing",
    indicatorIds: ["housing_trajectory", "planning_consents"],
    urls: ["https://example.test/housing", "https://example.test/planning"],
    cadence: "quarterly",
    plausibility: { housing_trajectory: { maxDelta: 30 }, planning_consents: { maxDelta: 46 } },
    derive: {
      housing_trajectory: {
        components: [
          { key: "completions_q", label: "Quarterly completions", unit: "dwellings", description: "raw quarterly count", min: 5_000, max: 100_000 },
        ],
        compute: (v) => (v.completions_q! * 4 / 300_000) * 100,
      },
      planning_consents: {
        components: [
          { key: "major_granted", label: "Major decisions granted", unit: "decisions", description: "major count", min: 100, max: 15_000 },
          { key: "minor_granted", label: "Minor decisions granted", unit: "decisions", description: "minor count", min: 1_000, max: 30_000 },
        ],
        compute: (v) => ((v.major_granted! + v.minor_granted!) / 11_500) * 100,
      },
    },
    ...over,
  });
}
