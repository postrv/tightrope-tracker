import type { ScoreHistory, ScoreSnapshot } from "@tightrope/shared";

/**
 * Minimal structural KV surface these primers need — just the `put` overload
 * they call. Deliberately not `@cloudflare/workers-types`' `KVNamespace`:
 * that type is declared both as an ambient global (what the apps' tsconfig
 * `types` array surfaces on `Env.KV`) and as a module export, and the two
 * declarations have subtly incompatible `get` overloads, so a param typed as
 * the imported `KVNamespace` rejects a caller's global-typed `env.KV`. A
 * structural subset accepts both and documents exactly what we touch.
 */
export interface KvWriter {
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

/**
 * KV key holding the current score snapshot. Written ONLY through
 * `primeSnapshotCache` below — the single-writer invariant that this
 * package exists to enforce (previously written by three independent code
 * paths: ingest recompute, the api score handler, and web db). Read sites
 * (api/web/og) still reference the literal string.
 */
export const SNAPSHOT_CACHE_KEY = "score:latest";

/** KV key holding the 90-day downsampled score history. Written ONLY through
 * `primeHistoryCache`. */
export const HISTORY_CACHE_KEY = "score:history:90d";

/**
 * 6h safety-net TTL on both cache entries (per AGENT_CONTRACTS.md). Readers
 * apply their own 30-minute freshness gate and fall back to D1 on miss, so
 * the TTL is only a backstop against a wedged writer, never the freshness
 * contract.
 */
export const SNAPSHOT_CACHE_TTL_SECONDS = 60 * 60 * 6;
export const HISTORY_CACHE_TTL_SECONDS = 60 * 60 * 6;

/**
 * The ONLY writer of `score:latest`. Ingest recompute (every 5 min) and the
 * api/web D1-fallback re-prime paths all route through here so a new
 * snapshot field (e.g. `sourceHealth`) can never ship dark by updating one
 * writer and forgetting the others.
 */
export async function primeSnapshotCache(
  kv: KvWriter,
  snapshot: ScoreSnapshot,
): Promise<void> {
  await kv.put(SNAPSHOT_CACHE_KEY, JSON.stringify(snapshot), {
    expirationTtl: SNAPSHOT_CACHE_TTL_SECONDS,
  });
}

/**
 * The ONLY writer of `score:history:90d`. Ingest recompute and the api
 * history handler's cache-miss write-back both route through here.
 */
export async function primeHistoryCache(
  kv: KvWriter,
  history: ScoreHistory,
): Promise<void> {
  await kv.put(HISTORY_CACHE_KEY, JSON.stringify(history), {
    expirationTtl: HISTORY_CACHE_TTL_SECONDS,
  });
}
