import type { DeliveryStatus } from "@tightrope/shared";
import type { Env } from "./env.js";
import { timingSafeEqual } from "./admin.js";
import { adminAuthGate } from "./lib/adminBackoff.js";
import { closeAuditFailure, closeAuditSuccess, openAudit } from "./lib/audit.js";
import { sha256Hex } from "./lib/hash.js";

/**
 * `POST /admin/delivery-commitment` — patch one row of the editorial
 * delivery scorecard.
 *
 * Until now `delivery_commitments` had zero runtime write path: the only way
 * to move a scorecard row was a hand-run SQL patch + `wrangler d1 execute`.
 * This is the substrate the Phase 3 approval queue publishes commitment
 * drafts through.
 *
 * Behind the same `ADMIN_TOKEN` + constant-time check + per-IP backoff as
 * `/admin/run` and `/admin/correction`. Body is a strict field allowlist:
 *   { id, latest?, status?, notes?, source_url?, source_label? }
 * At least one updatable field is required; unknown fields are rejected;
 * `status` is validated against the schema's documented value set. On
 * success the row's `updated_at` is bumped, the `delivery:latest` KV cache
 * is purged so the correction propagates within one cache window, and an
 * `ingestion_audit` row is written under source `delivery_commitments_admin`.
 */
const SOURCE_ID = "delivery_commitments_admin";
const DELIVERY_CACHE_KEY = "delivery:latest";

/** Columns a caller may patch. `id` selects the row; `updated_at` is set by us. */
const UPDATABLE_FIELDS = ["latest", "status", "notes", "source_url", "source_label"] as const;
type UpdatableField = (typeof UPDATABLE_FIELDS)[number];
const ALLOWED_FIELDS: ReadonlySet<string> = new Set<string>(["id", ...UPDATABLE_FIELDS]);

// Mirrors the delivery_commitments.status value set documented in
// db/migrations/0001_initial.sql (on_track | slipping | missed | shipped) —
// the same set as @tightrope/shared's DeliveryStatus union.
const VALID_STATUSES: ReadonlySet<DeliveryStatus> = new Set<DeliveryStatus>([
  "on_track",
  "slipping",
  "missed",
  "shipped",
]);

const MAX_LEN: Record<UpdatableField, number> = {
  latest: 256,
  status: 32,
  notes: 2000,
  source_url: 512,
  source_label: 256,
};

export async function handleDeliveryCommitmentPatch(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });
  }
  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    return json({ error: "ADMIN_TOKEN not configured" }, 503);
  }
  // SEC-13: per-IP exponential backoff on failed auth (see admin.ts).
  const auth = await adminAuthGate(env, req, {
    verifyToken: (provided) => provided !== null && timingSafeEqual(provided, expected),
  });
  if (!auth.ok) return auth.response;

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }

  const parsed = parseInput(payload);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const { id, updates } = parsed.value;

  // 404 before any audit row: an unknown id is a client error, not an
  // ingestion attempt worth recording.
  const existing = await env.DB
    .prepare("SELECT id FROM delivery_commitments WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!existing) {
    return json({ error: `unknown delivery commitment id '${id}'` }, 404);
  }

  const updatedAt = new Date().toISOString();
  const handle = await openAudit(env.DB, { sourceId: SOURCE_ID, sourceUrl: `admin:delivery_commitment/${id}` });
  try {
    // Dynamic SET clause over the allowlisted columns only — column names come
    // from the fixed UPDATABLE_FIELDS list, never from caller input; values are
    // always bound.
    const cols = Object.keys(updates) as UpdatableField[];
    const setSql = [...cols.map((c) => `${c} = ?`), "updated_at = ?"].join(", ");
    const bindings = [...cols.map((c) => updates[c]!), updatedAt, id];
    await env.DB
      .prepare(`UPDATE delivery_commitments SET ${setSql} WHERE id = ?`)
      .bind(...bindings)
      .run();

    // Purge the read-through editorial cache so the change is visible within
    // one cache window rather than waiting out the 6h KV TTL. Best-effort: the
    // authoritative write already landed, so a KV outage must not 500.
    await env.KV.delete(DELIVERY_CACHE_KEY).catch(() => undefined);

    const payloadHash = await sha256Hex(JSON.stringify({ id, updates, updatedAt }));
    await closeAuditSuccess(env.DB, handle, { rowsWritten: 1, payloadHash });
  } catch (err) {
    await closeAuditFailure(env.DB, handle, err);
    console.error(`admin delivery-commitment update failed for id='${id}': ${(err as Error)?.message ?? String(err)}`);
    return json({ error: "internal error" }, 500);
  }

  return json({ ok: true, id, updated: updates, updatedAt }, 200);
}

interface ParsedInput {
  id: string;
  updates: Partial<Record<UpdatableField, string>>;
}
type ParseResult = { ok: true; value: ParsedInput } | { ok: false; error: string };

function parseInput(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const input = raw as Record<string, unknown>;

  // Strict allowlist: reject any unknown field so a typo'd key can't silently
  // no-op.
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) return { ok: false, error: `unknown field '${key}'` };
  }

  const idRes = requireString(input.id, "id", 128);
  if (!idRes.ok) return idRes;
  const id = idRes.value;

  const updates: Partial<Record<UpdatableField, string>> = {};
  for (const field of UPDATABLE_FIELDS) {
    const v = input[field];
    if (v === undefined) continue;
    const res = requireString(v, field, MAX_LEN[field]);
    if (!res.ok) return res;
    if (field === "status" && !VALID_STATUSES.has(res.value as DeliveryStatus)) {
      return { ok: false, error: `status must be one of on_track, slipping, missed, shipped` };
    }
    updates[field] = res.value;
  }

  if (Object.keys(updates).length === 0) {
    return { ok: false, error: "at least one updatable field is required (latest, status, notes, source_url, source_label)" };
  }

  return { ok: true, value: { id, updates } };
}

type StringResult = { ok: true; value: string } | { ok: false; error: string };
function requireString(v: unknown, field: string, maxLen: number): StringResult {
  if (typeof v !== "string") return { ok: false, error: `${field} must be a string` };
  const trimmed = v.trim();
  if (trimmed.length === 0) return { ok: false, error: `${field} must not be empty` };
  if (trimmed.length > maxLen) return { ok: false, error: `${field} exceeds ${maxLen} chars` };
  return { ok: true, value: trimmed };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
