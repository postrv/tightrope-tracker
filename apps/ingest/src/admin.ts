import { getAdapter, listAdapters } from "@tightrope/data-sources";
import type { Env } from "./env.js";
import { backfillHistoricalScores } from "./pipelines/backfill.js";
import { backfillObservations, type BackfillObservationsResult } from "./pipelines/backfillObservations.js";
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
 *   backfill-observations               — fetch historical indicator_observations
 *                                          from an upstream source; query params:
 *                                            adapter   (required, or 'all')
 *                                            from      (ISO date, default today-365d)
 *                                            to        (ISO date, default yesterday)
 *                                            dryRun    (default false)
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
        if (!Number.isFinite(days) || days < 1 || days > 800) {
          return json({ error: "days must be an integer 1-800" }, 400);
        }
        const overwrite = url.searchParams.get("overwrite") !== "false";
        const result = await backfillHistoricalScores(env, { days, overwrite });
        return json({ ok: true, source, ...result });
      }
      case "backfill-observations": {
        const adapterId = url.searchParams.get("adapter");
        const fromStr = url.searchParams.get("from");
        const toStr = url.searchParams.get("to");
        const dryRun = url.searchParams.get("dryRun") === "true";
        const overwrite = url.searchParams.get("overwrite") !== "false";

        if (!adapterId) return json({ error: "missing ?adapter= (use 'all' for every adapter with a historical mode)" }, 400);

        const today = new Date();
        const utcTodayStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
        const defaultFrom = new Date(utcTodayStart - 365 * 24 * 60 * 60 * 1000);
        const defaultTo = new Date(utcTodayStart - 24 * 60 * 60 * 1000);
        const from = parseDateParam(fromStr) ?? defaultFrom;
        const to = parseDateParam(toStr) ?? defaultTo;
        if (!from || !to) return json({ error: "invalid ?from / ?to (expected ISO date)" }, 400);
        if (from.getTime() > to.getTime()) return json({ error: "?from must be <= ?to" }, 400);

        if (adapterId === "all") {
          const targets = listAdapters().filter((a) => typeof a.fetchHistorical === "function");
          const results: Array<BackfillObservationsResult | { adapter: string; ok: false; error: string }> = [];
          let succeeded = 0;
          for (const a of targets) {
            try {
              const r = await backfillObservations(env, a, { from, to, dryRun, overwrite });
              results.push(r);
              succeeded++;
            } catch (err) {
              console.error(`backfill-observations ${a.id} failed`, err);
              results.push({ adapter: a.id, ok: false, error: sanitizeErrMsg(err) });
            }
          }
          return json({
            ok: succeeded > 0,
            source,
            adapter: "all",
            from: from.toISOString(),
            to: to.toISOString(),
            attempted: targets.length,
            succeeded,
            results,
          }, succeeded === 0 && targets.length > 0 ? 502 : 200);
        }

        const adapter = getAdapter(adapterId);
        if (!adapter) return json({ error: `unknown adapter '${adapterId}'` }, 400);
        if (typeof adapter.fetchHistorical !== "function") {
          return json({ error: `adapter '${adapterId}' has no historical mode` }, 400);
        }
        const result = await backfillObservations(env, adapter, { from, to, dryRun, overwrite });
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
      case "purge-cache": {
        // Bust every public-facing KV key so the next consumer rebuilds
        // from D1. Operator escape hatch for after editorial changes
        // (delivery commitments, timeline events, corrections) where
        // the read-through caches lack a freshness predicate.
        // Idempotent: KV.delete on a missing key is a no-op. Per-key
        // failures are reported separately so a single transient outage
        // doesn't fail the whole purge.
        const keys = [
          "score:latest",
          "score:history:90d",
          "delivery:latest",
          "timeline:latest",
          "movements:today",
        ] as const;
        const purged: string[] = [];
        const failed: string[] = [];
        for (const k of keys) {
          try {
            await env.KV.delete(k);
            purged.push(k);
          } catch (err) {
            console.warn(`purge-cache: KV.delete('${k}') failed: ${(err as Error)?.message ?? String(err)}`);
            failed.push(k);
          }
        }
        return json({ ok: true, source, purged, ...(failed.length > 0 ? { failed } : {}) });
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

/**
 * Parse an ISO-8601 date string (YYYY-MM-DD or a full timestamp) into a Date,
 * normalised to UTC midnight. Returns null for missing / malformed input.
 */
function parseDateParam(raw: string | null): Date | null {
  if (raw === null || raw === "") return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function sanitizeErrMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Strip newlines and cap length so admin JSON stays tidy.
  return raw.replace(/\s+/g, " ").slice(0, 500);
}
