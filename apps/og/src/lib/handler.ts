/**
 * Top-level request gating for the OG share-card worker.
 *
 * Exported so the cache → rate-limit → render flow can be exercised in a unit
 * test without spinning up Yoga / resvg WASM. `index.ts` wires this to the
 * real router and the live Cloudflare globals.
 */
import { ogCacheKey } from "./cacheKey.js";
import { clientIp, enforceRateLimit, type RateLimitOptions } from "./rateLimit.js";

export interface OgRouteCtx {
  /** The pre-validated URL of the incoming request. */
  url: URL;
  env: Env;
}

export type OgRouter = (ctx: OgRouteCtx) => Promise<Response>;

export interface OgHandlerDeps {
  /** Cache namespace used for read-through edge caching (caches.default in prod). */
  cache: Pick<Cache, "match" | "put">;
  /** Rate-limit options. Override only for tests. */
  rateLimitOptions?: RateLimitOptions;
}

function rateLimitedResponse(resetAt: number, limit: number, now: number): Response {
  const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
  return new Response("rate limit exceeded", {
    status: 429,
    headers: {
      "Content-Type": "text/plain",
      "Retry-After": String(retryAfter),
      "X-RateLimit-Limit": String(limit),
      "X-RateLimit-Remaining": "0",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" },
  });
}

function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

/**
 * Gate-then-render flow:
 *   1. OPTIONS / non-GET handled before any work.
 *   2. Pathname must start with /og/ (defensive 404 against random probing).
 *   3. Cache API match keyed on pathname only — query strings are stripped
 *      so cache-buster queries cannot create distinct entries (SEC-1).
 *   4. On cache miss: enforce per-IP rate limit. Fail-open if the CF header
 *      is absent; we'd rather serve legitimate traffic than DoS the
 *      "unknown" bucket collectively (SEC-9).
 *   5. Run the router. On success, write back to the cache.
 */
export async function handleOgRequest(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  router: OgRouter,
  deps: OgHandlerDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "GET") {
    return new Response("method not allowed", { status: 405, headers: { Allow: "GET, OPTIONS" } });
  }

  const url = new URL(req.url);
  if (!url.pathname.startsWith("/og/")) return notFound();

  const cacheKey = ogCacheKey(req);
  const cached = await deps.cache.match(cacheKey);
  if (cached) return cached;

  const ip = clientIp(req);
  if (ip !== null) {
    const rl = await enforceRateLimit(env, ip, Date.now(), deps.rateLimitOptions).catch((err) => {
      // KV failure must not take the worker down — log and fail-open.
      console.error("og rate-limit KV error", err);
      return null;
    });
    if (rl && !rl.allowed) return rateLimitedResponse(rl.resetAt, rl.limit, Date.now());
  } else {
    console.warn("og rate-limit skipped: cf-connecting-ip missing", url.pathname);
  }

  const response = await router({ url, env });
  if (response.ok) {
    ctx.waitUntil(deps.cache.put(cacheKey, response.clone()));
  }
  return response;
}
