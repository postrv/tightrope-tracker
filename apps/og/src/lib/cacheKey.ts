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
 * We strip the incoming search string and rebuild the Request with a clean GET
 * so the Cache API stores and matches by pathname (+ a deploy-busted epoch)
 * alone. Headers are deliberately dropped to keep the cache key independent
 * of incoming Cookie / Authorization etc.; OG cards are public and never
 * personalise per-caller.
 *
 * `OG_CACHE_EPOCH` is an operator-controlled bust: bump it when card copy or
 * the snapshot the cards render has changed and the 30-minute s-maxage would
 * otherwise keep serving the previous PNG. Attackers cannot rotate this —
 * incoming `?v=` is stripped before the epoch is applied.
 *
 * NB: the Cache API requires a GET request for both `match` and `put`.
 */
export const OG_CACHE_EPOCH = "2026-09-01";

export function ogCacheKey(req: Request): Request {
  const url = new URL(req.url);
  url.search = "";
  url.searchParams.set("v", OG_CACHE_EPOCH);
  return new Request(url.toString(), { method: "GET" });
}
