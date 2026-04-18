import type { Env } from "./env.js";
import { backfillHistoricalScores } from "./pipelines/backfill.js";
import { ingestDelivery } from "./pipelines/delivery.js";
import { ingestFiscal } from "./pipelines/fiscal.js";
import { ingestLabour } from "./pipelines/labour.js";
import { ingestMarket } from "./pipelines/market.js";
import { purgeSyntheticHistory } from "./pipelines/purge.js";
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
 * dev + on-call manual runs; not for the public.
 *
 * Valid sources:
 *   market | fiscal | labour | delivery — run a single ingestion pipeline
 *   recompute                           — recompute live scores from the
 *                                          latest observations
 *   today                               — refresh today_movements snapshots
 *   backfill-scores                     — rebuild historical headline and
 *                                          pillar scores from indicator
 *                                          observations; query params:
 *                                            days      (default 90, max 365)
 *                                            overwrite (default true)
 *   purge-synthetic-history             — delete seed synthetic history;
 *                                          dry-run unless &confirm=yes
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
      case "backfill-scores": {
        const daysRaw = url.searchParams.get("days");
        const days = daysRaw === null ? 90 : Number.parseInt(daysRaw, 10);
        if (!Number.isFinite(days) || days < 1 || days > 365) {
          return json({ error: "days must be an integer 1-365" }, 400);
        }
        const overwrite = url.searchParams.get("overwrite") !== "false";
        const result = await backfillHistoricalScores(env, { days, overwrite });
        return json({ ok: true, source, ...result });
      }
      case "purge-synthetic-history": {
        const dryRun = url.searchParams.get("confirm") !== "yes";
        const result = await purgeSyntheticHistory(env, { dryRun });
        return json({
          ok: true,
          source,
          ...result,
          ...(dryRun ? { note: "Dry run. Re-invoke with &confirm=yes to actually delete." } : {}),
        });
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
