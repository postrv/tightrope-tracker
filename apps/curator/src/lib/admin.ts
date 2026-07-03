import { adminAuthGate, timingSafeEqual } from "@tightrope/shared";
import type { Env } from "../env";
import type { CaptureStatus } from "../types";
import { getCapture, listCaptures, setCaptureDecision } from "./captures";
import { readPublishedValueAt } from "./observations";
import { approveCapture } from "../pipeline/publish";

/**
 * Review-queue admin surface (AUTOMATION_PLAN Phase 3), ADMIN_TOKEN-gated with
 * the shared timingSafeEqual + per-IP backoff gate (same one ingest uses):
 *
 *   GET  /admin/captures?status=pending      list (id, source, kind, value, confidence, age)
 *   GET  /admin/captures/:id                 detail: quote, gates, diff vs published
 *   POST /admin/captures/:id/approve         → publish path
 *   POST /admin/captures/:id/reject {reason} → status 'rejected', reason recorded
 *   GET  /__healthz                          unauthenticated liveness
 *
 * Everything else 405, matching the ingest worker's posture.
 */

const VALID_STATUSES: ReadonlySet<string> = new Set<CaptureStatus>([
  "shadow",
  "pending",
  "auto_published",
  "approved",
  "rejected",
  "superseded",
  "quarantined",
  "unchanged",
]);

export async function handleFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (pathname === "/__healthz") {
    return new Response("ok", { status: 200 });
  }

  if (pathname.startsWith("/admin/captures")) {
    const gate = await authorise(req, env);
    if (gate) return gate;
    return routeCaptures(req, env, url);
  }

  return new Response("method not allowed", { status: 405 });
}

async function authorise(req: Request, env: Env): Promise<Response | null> {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return json({ error: "ADMIN_TOKEN not configured" }, 503);
  const auth = await adminAuthGate(env, req, {
    verifyToken: (provided) => provided !== null && timingSafeEqual(provided, expected),
  });
  return auth.ok ? null : auth.response;
}

async function routeCaptures(req: Request, env: Env, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean); // ["admin","captures",...]

  // GET /admin/captures?status=
  if (parts.length === 2) {
    if (req.method !== "GET") return methodNotAllowed("GET");
    const status = url.searchParams.get("status") ?? "pending";
    if (!VALID_STATUSES.has(status)) return json({ error: `invalid status '${status}'` }, 400);
    const items = await listCaptures(env.DB, status as CaptureStatus);
    return json({ ok: true, status, count: items.length, captures: items });
  }

  const id = Number.parseInt(parts[2] ?? "", 10);
  if (!Number.isInteger(id) || id <= 0) return json({ error: "invalid capture id" }, 400);
  const action = parts[3];

  // GET /admin/captures/:id
  if (parts.length === 3) {
    if (req.method !== "GET") return methodNotAllowed("GET");
    const detail = await getCapture(env.DB, id);
    if (!detail) return json({ error: `capture ${id} not found` }, 404);
    const published =
      detail.indicatorId && detail.observedAt ? await readPublishedValueAt(env.DB, detail.indicatorId, detail.observedAt) : null;
    return json({
      ok: true,
      capture: detail,
      gates: detail.verification ? safeParse(detail.verification) : null,
      diff: { publishedValue: published, candidateValue: detail.value },
    });
  }

  if (parts.length === 4 && action === "approve") {
    if (req.method !== "POST") return methodNotAllowed("POST");
    const detail = await getCapture(env.DB, id);
    if (!detail) return json({ error: `capture ${id} not found` }, 404);
    if (detail.status !== "pending" && detail.status !== "quarantined") {
      return json({ error: `capture ${id} is '${detail.status}', not reviewable` }, 409);
    }
    const res = await approveCapture(env, detail, "human");
    if (!res.ok) return json({ error: res.error }, 400);
    return json({ ok: true, id, note: res.note });
  }

  if (parts.length === 4 && action === "reject") {
    if (req.method !== "POST") return methodNotAllowed("POST");
    const detail = await getCapture(env.DB, id);
    if (!detail) return json({ error: `capture ${id} not found` }, 404);
    let reason = "";
    try {
      const body = (await req.json()) as { reason?: unknown };
      if (typeof body.reason === "string") reason = body.reason.trim();
    } catch {
      /* reason optional */
    }
    await setCaptureDecision(env.DB, id, "rejected", { decidedBy: `human:reject ${reason}`.slice(0, 200) });
    return json({ ok: true, id, status: "rejected", reason });
  }

  return json({ error: "unknown captures route" }, 404);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function methodNotAllowed(allow: string): Response {
  return new Response("method not allowed", { status: 405, headers: { Allow: allow } });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
