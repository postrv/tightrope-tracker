/**
 * KV-backed sliding-window rate limiter for the OG worker.
 *
 * 60 req / 60s / IP — tighter than the public API (120/min) because share-card
 * endpoints are not human-driven. A real social-network crawler hits each
 * card once; anything above this rate is either a misbehaving client or
 * adversarial traffic.
 *
 * This is defence-in-depth on top of the Cloudflare Cache API normalisation
 * (see `cacheKey.ts`): cache hits never reach this code, so a healthy
 * cache-hit rate keeps KV writes negligible and the limit only bites on the
 * cache-miss path that actually consumes WASM render time.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
}

export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
}

const DEFAULTS: RateLimitOptions = { limit: 60, windowSeconds: 60 };

export async function enforceRateLimit(
  env: Env,
  ip: string,
  now: number = Date.now(),
  opts: RateLimitOptions = DEFAULTS,
): Promise<RateLimitResult> {
  const { limit, windowSeconds } = opts;
  const bucket = Math.floor(now / (windowSeconds * 1000));
  const key = `og-rate:${ip}:${bucket}`;
  const resetAt = (bucket + 1) * windowSeconds * 1000;

  const current = parseInt((await env.KV.get(key)) ?? "0", 10);
  const next = current + 1;
  const ttl = Math.max(60, windowSeconds * 2);
  await env.KV.put(key, String(next), { expirationTtl: ttl });

  const allowed = next <= limit;
  const remaining = Math.max(0, limit - next);
  return { allowed, remaining, resetAt, limit };
}

/** Pure decision function exposed for unit tests. */
export function decide(
  priorCount: number,
  opts: RateLimitOptions = DEFAULTS,
): { allowed: boolean; remaining: number } {
  const next = priorCount + 1;
  return {
    allowed: next <= opts.limit,
    remaining: Math.max(0, opts.limit - next),
  };
}

/**
 * Returns the verified client IP from Cloudflare, or null if the header is
 * absent or empty.
 *
 * Returning null is deliberate (SEC-9): the previous "unknown" sentinel put
 * every header-less caller into the same KV bucket, which would rate-limit
 * legitimate traffic *collectively* if cf-connecting-ip were ever missing
 * (e.g. a bypass route, an internal worker-to-worker fetch). Callers should
 * treat null as "cannot rate-limit this request" and let it through, while
 * emitting a metric so unexpected header loss is visible.
 *
 * Only `cf-connecting-ip` is trusted: x-forwarded-for / x-real-ip are
 * client-controlled and would let an attacker rotate IPs to bypass the cap.
 */
export function clientIp(req: Request): string | null {
  const v = req.headers.get("cf-connecting-ip");
  return v && v.length > 0 ? v : null;
}
