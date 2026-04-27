/**
 * KV cache helpers with a single canonical TTL. Writers TTL 6h as a safety net
 * per AGENT_CONTRACTS.md; readers are expected to fall back to D1 on miss.
 */

export const CACHE_TTL_SECONDS = 60 * 60 * 6; // 6 hours

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
