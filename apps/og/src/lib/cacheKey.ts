/**
 * Edge-cache key normalisation for the OG worker.
 *
 * The Cloudflare Cache API keys on the full request URL by default, so a
 * request like `/og/headline-score.png?nonce=$RANDOM` is treated as a
 * distinct cache entry from `/og/headline-score.png`. That behaviour is the
 * primary DoS amplifier on this worker: an attacker can issue arbitrary
 * cache-buster queries to force a fresh Satori → resvg WASM render on every
 * request.
 *
 * We strip the search string and rebuild the Request with a clean GET so the
 * Cache API stores and matches by pathname alone. Headers are deliberately
 * dropped to keep the cache key independent of incoming Cookie / Authorization
 * etc.; OG cards are public and never personalise per-caller.
 *
 * NB: the Cache API requires a GET request for both `match` and `put`.
 */
export function ogCacheKey(req: Request): Request {
  const url = new URL(req.url);
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}
