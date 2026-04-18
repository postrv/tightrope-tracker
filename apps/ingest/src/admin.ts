import type { Env } from "./env.js";
import { ingestDelivery } from "./pipelines/delivery.js";
import { ingestFiscal } from "./pipelines/fiscal.js";
import { ingestLabour } from "./pipelines/labour.js";
import { ingestMarket } from "./pipelines/market.js";
import { recomputeScores } from "./pipelines/recompute.js";
import { updateTodayMovements } from "./pipelines/todayMovements.js";

/**
 * Constant-time string equality. A plain `===` leaks length + match-position
 * information via timing, which is exploitable for short shared secrets.
 * Encoding to bytes first avoids surface differences between multi-byte chars.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ae = new TextEncoder().encode(a);
  const be = new TextEncoder().encode(b);
  if (ae.length !== be.length) return false;
  let diff = 0;
  for (let i = 0; i < ae.length; i++) diff |= ae[i]! ^ be[i]!;
  return diff === 0;
}

/**
 * `/admin/run?source=<pipeline>` behind a shared-token header. Intended for
 * dev + on-call manual runs; not for the public. Valid sources: market,
 * fiscal, labour, delivery, recompute, today.
 */
export async function handleAdminRun(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });
  }
  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    return json({ error: "ADMIN_TOKEN not configured" }, 503);
  }
  const provided = req.headers.get("x-admin-token");
  if (!provided || !timingSafeEqual(provided, expected)) {
    return json({ error: "unauthorised" }, 401);
  }
  const source = url.searchParams.get("source");
  if (!source) return json({ error: "missing ?source=" }, 400);

  try {
    switch (source) {
      case "market": {
        const r = await ingestMarket(env, { force: true });
        return json({ ok: true, source, ran: r.ran });
      }
      case "fiscal": {
        await ingestFiscal(env);
        return json({ ok: true, source });
      }
      case "labour": {
        await ingestLabour(env);
        return json({ ok: true, source });
      }
      case "delivery": {
        const r = await ingestDelivery(env);
        return json({ ok: true, source, ...r });
      }
      case "recompute": {
        const snap = await recomputeScores(env);
        return json({ ok: true, source, snapshot: snap === null ? "no-data" : "ok" });
      }
      case "today": {
        const m = await updateTodayMovements(env);
        return json({ ok: true, source, count: m.length });
      }
      default:
        return json({ error: `unknown source '${source}'` }, 400);
    }
  } catch (err) {
    console.error(`admin run failed: source=${source}`, err);
    return json({ error: "internal error" }, 500);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
