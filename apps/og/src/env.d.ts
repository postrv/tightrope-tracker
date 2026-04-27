export {};

declare global {
  interface Env {
    DB: D1Database;
    KV: KVNamespace;
    /**
     * R2 bucket holding our TTF fonts. The bucket is optional in dev — if the
     * binding is undefined we fall back to fetching from the web on first use.
     */
    FONTS: R2Bucket | undefined;
    ENVIRONMENT: "production" | "preview" | "development";
  }

  /**
   * Cloudflare's Cache API extends the standard `CacheStorage` with a
   * pre-opened `default` cache (the same one the edge HTTP cache uses).
   * lib.dom declares `CacheStorage` without it, and workers-types declares
   * its own version — but with both libs loaded, the DOM one wins. Merge
   * the property in here so `caches.default` is type-safe in this worker.
   */
  interface CacheStorage {
    readonly default: Cache;
  }
}
