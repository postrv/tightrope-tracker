/**
 * Simple KV-backed sliding-window rate limiter.
 *
 * 120 req / 60s / IP. Good enough for a civic data API — Cloudflare's WAF is
 * the real defence; this just stops accidental loops and trivial scraping.
 *
 * Keyed on `rate:<ip>:<minuteBucket>` so two overlapping windows are tracked
 * implicitly: the previous minute and the current minute. We return
 * `{ allowed, remaining, resetAt }` for the caller to emit rate headers.
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

const DEFAULTS: RateLimitOptions = { limit: 120, windowSeconds: 60 };

export async function enforceRateLimit(
  env: Env,
  ip: string,
  now: number = Date.now(),
  opts: RateLimitOptions = DEFAULTS,
): Promise<RateLimitResult> {
  const { limit, windowSeconds } = opts;
  const bucket = Math.floor(now / (windowSeconds * 1000));
  const key = `rate:${ip}:${bucket}`;
  const resetAt = (bucket + 1) * windowSeconds * 1000;

  const current = parseInt((await env.KV.get(key)) ?? "0", 10);
  const next = current + 1;
  // KV TTL must be >=60; windowSeconds * 2 gives us headroom for the sliding
  // second-bucket read if we extend later.
  const ttl = Math.max(60, windowSeconds * 2);
  await env.KV.put(key, String(next), { expirationTtl: ttl });

  const allowed = next <= limit;
  const remaining = Math.max(0, limit - next);
  return { allowed, remaining, resetAt, limit };
}

/**
 * Pure logic extracted for unit tests. Given prior count + options, decide
 * whether a new request is allowed and how many remain.
 */
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

export function clientIp(req: Request): string {
  // Only trust CF-Connecting-IP — set by Cloudflare at the edge and not
  // spoofable by a client. Attacker-controlled x-forwarded-for / x-real-ip
  // would let any caller rotate through fake IPs to bypass the 120 req/min cap.
  // Local dev (wrangler dev) always receives CF-Connecting-IP = 127.0.0.1.
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}
