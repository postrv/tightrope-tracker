import type { Env } from "./env.js";
import { timingSafeEqual } from "./admin.js";
import { adminAuthGate } from "./lib/adminBackoff.js";

/**
 * `POST /admin/correction` — write one row to the public corrections log.
 *
 * The corrections page is the single most load-bearing accountability feature
 * on the site: it promises "every correction to a published figure, dated,
 * with the original value, the corrected value, and the reason". That promise
 * is only worth the paper it's printed on if there is an actual write path
 * from the team to the published table. This is it.
 *
 * Behind the same `ADMIN_TOKEN` as the rest of `/admin/*`. Accepts a JSON
 * body; validates required fields and max lengths; allocates a UUID for `id`
 * unless the caller provides one; returns 201 with the created row on
 * success, 409 on primary-key collision.
 */
export async function handleCorrectionCreate(req: Request, env: Env): Promise<Response> {
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

  const parsed = parseCorrectionInput(payload);
  if (!parsed.ok) {
    return json({ error: parsed.error }, 400);
  }

  const row = parsed.value;
  try {
    await env.DB
      .prepare(
        `INSERT INTO corrections
           (id, published_at, affected_indicator, original_value, corrected_value, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.id, row.publishedAt, row.affectedIndicator, row.originalValue, row.correctedValue, row.reason)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE\s+constraint/i.test(msg)) {
      return json({ error: "correction with that id already exists" }, 409);
    }
    console.error(`admin correction insert failed: ${msg}`);
    return json({ error: "internal error" }, 500);
  }

  return json(row, 201);
}

interface CorrectionRow {
  id: string;
  publishedAt: string;
  affectedIndicator: string;
  originalValue: string;
  correctedValue: string;
  reason: string;
}

type ParseResult =
  | { ok: true; value: CorrectionRow }
  | { ok: false; error: string };

/**
 * Validate the POST body. Rejects missing / empty required fields, strings
 * over the maximum length (reason capped at 2000 to protect row size), and
 * malformed ISO timestamps. Returns a normalised row on success with an id
 * allocated if the caller didn't supply one.
 */
function parseCorrectionInput(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object") return { ok: false, error: "body must be a JSON object" };
  const input = raw as Record<string, unknown>;

  const affectedIndicator = requireString(input.affectedIndicator, "affectedIndicator", 128);
  if (!affectedIndicator.ok) return affectedIndicator;
  const originalValue = requireString(input.originalValue, "originalValue", 256);
  if (!originalValue.ok) return originalValue;
  const correctedValue = requireString(input.correctedValue, "correctedValue", 256);
  if (!correctedValue.ok) return correctedValue;
  const reason = requireString(input.reason, "reason", 2000);
  if (!reason.ok) return reason;

  let publishedAt: string;
  if (input.publishedAt === undefined || input.publishedAt === null) {
    publishedAt = new Date().toISOString();
  } else if (typeof input.publishedAt !== "string") {
    return { ok: false, error: "publishedAt must be an ISO-8601 string" };
  } else {
    const ms = Date.parse(input.publishedAt);
    if (!Number.isFinite(ms)) {
      return { ok: false, error: "publishedAt is not a valid ISO-8601 timestamp" };
    }
    publishedAt = new Date(ms).toISOString();
  }

  let id: string;
  if (input.id === undefined || input.id === null) {
    id = globalThis.crypto.randomUUID();
  } else {
    const parsedId = requireString(input.id, "id", 64);
    if (!parsedId.ok) return parsedId;
    id = parsedId.value;
  }

  return {
    ok: true,
    value: {
      id,
      publishedAt,
      affectedIndicator: affectedIndicator.value,
      originalValue: originalValue.value,
      correctedValue: correctedValue.value,
      reason: reason.value,
    },
  };
}

type StringResult = { ok: true; value: string } | { ok: false; error: string };
function requireString(v: unknown, field: string, maxLen: number): StringResult {
  if (typeof v !== "string") return { ok: false, error: `${field} is required` };
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
