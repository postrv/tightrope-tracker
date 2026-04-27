/**
 * KV cache helpers with a single canonical TTL. Writers TTL 6h as a safety net
 * per AGENT_CONTRACTS.md; readers are expected to fall back to D1 on miss.
 */

export const CACHE_TTL_SECONDS = 60 * 60 * 6; // 6 hours

/**
 * Maximum age of a stamped cache entry before the read-through gate considers
 * it stale and refetches from D1. Editorial caches (delivery, timeline) use
 * this so a published correction propagates within ~30 minutes rather than
 * waiting up to the 6h KV TTL — the previous behaviour invisibly served a
 * stale array until the TTL expired.
 */
export const EDITORIAL_FRESHNESS_MS = 30 * 60_000;

export async function kvGetJson<T>(env: Env, key: string): Promise<T | null> {
  return env.KV.get<T>(key, "json");
}

export async function kvPutJson<T>(env: Env, key: string, value: T): Promise<void> {
  await env.KV.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL_SECONDS });
}

/**
 * Read-through cache: try KV first; on miss (or stale, when an `isFresh`
 * predicate is supplied and rejects the cached value), call `loader`,
 * write-back, return. The loader is only awaited if the cache missed
 * or was rejected as stale.
 *
 * `isFresh` lets callers distinguish "data exists but is too old to
 * trust" from "no data at all". Use it for derived caches whose
 * upstream (KV, recompute) may pause for longer than the KV TTL —
 * without the predicate, the consumer would serve six-hour-stale
 * values until the TTL expired.
 */
export async function readThrough<T>(
  env: Env,
  key: string,
  loader: () => Promise<T>,
  ctx?: ExecutionContext,
  isFresh?: (cached: T) => boolean,
): Promise<T> {
  const cached = await kvGetJson<T>(env, key);
  if (cached !== null && cached !== undefined && (isFresh === undefined || isFresh(cached))) {
    return cached;
  }
  const fresh = await loader();
  // Fire-and-forget write-back. Use waitUntil if we have a context so the
  // request doesn't block on the KV write.
  const write = kvPutJson(env, key, fresh);
  if (ctx) ctx.waitUntil(write); else await write;
  return fresh;
}

interface Stamped<T> {
  __cachedAt: string;
  value: T;
}

/**
 * Read-through cache for derived/editorial values whose underlying data has
 * no natural timestamp the predicate can lean on. Wraps the cached value in
 * `{ __cachedAt, value }` so the gate can age the cache out independently
 * of the 6h KV TTL.
 *
 * On a cold cache (or pre-stamp shape), the loader runs and the wrapped
 * value is written back. If a reader sees a value too old to trust, it
 * falls through to D1 and refreshes — closing the "editorial correction
 * invisible for hours" gap that an unconditional `readThrough` had.
 */
export async function readThroughStamped<T>(
  env: Env,
  key: string,
  loader: () => Promise<T>,
  ctx?: ExecutionContext,
  maxAgeMs: number = EDITORIAL_FRESHNESS_MS,
): Promise<T> {
  const cached = await kvGetJson<Stamped<T>>(env, key);
  const stampedAt = cached?.__cachedAt;
  if (stampedAt) {
    const age = Date.now() - Date.parse(stampedAt);
    if (Number.isFinite(age) && age < maxAgeMs) return cached!.value;
  }
  const fresh = await loader();
  const stamped: Stamped<T> = { __cachedAt: new Date().toISOString(), value: fresh };
  const write = kvPutJson(env, key, stamped);
  if (ctx) ctx.waitUntil(write); else await write;
  return fresh;
}
