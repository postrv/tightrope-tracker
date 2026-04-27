import { defineMiddleware } from "astro:middleware";
import { buildCsp, generateNonce } from "./lib/csp.js";

/**
 * Security headers are set here rather than in `public/_headers` because
 * Astro runs on Cloudflare Pages Functions (SSR), and `_headers` only
 * applies to static asset responses — not to Function output. Every HTML
 * page on this site is SSR'd, so without this middleware the security
 * posture would silently revert to Cloudflare's defaults.
 *
 * Two CSP variants:
 *   /embed/*  — permissive frame-ancestors so third parties can iframe us.
 *               CORP cross-origin, form-action 'none' (read-only),
 *               no X-Frame-Options.
 *   everything else — strict frame-ancestors 'self', X-Frame-Options SAMEORIGIN,
 *               COOP/CORP same-origin, form-action 'self'.
 *
 * SEC-10: per-request nonce makes inline scripts opt-in via
 * `<script nonce={Astro.locals.cspNonce}>`. `'unsafe-inline'` is no longer
 * in `script-src`, so any successful HTML injection that didn't capture
 * the per-request nonce cannot execute.
 *
 * The shared block (HSTS, Permissions-Policy, X-Content-Type-Options,
 * Referrer-Policy) is applied to both CSP variants.
 */

const SHARED_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "geolocation=(), camera=(), microphone=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()",
};

export const onRequest = defineMiddleware(async (ctx, next) => {
  // Generate the per-request CSP nonce *before* rendering so .astro
  // templates can read it from `Astro.locals.cspNonce` and tag every
  // inline <script>. Each request gets a fresh value.
  const nonce = generateNonce();
  ctx.locals.cspNonce = nonce;

  const res = await next();
  const isEmbed = ctx.url.pathname.startsWith("/embed/");

  for (const [k, v] of Object.entries(SHARED_HEADERS)) res.headers.set(k, v);
  res.headers.set("Content-Security-Policy", buildCsp({ nonce, isEmbed }));

  if (isEmbed) {
    res.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    res.headers.delete("X-Frame-Options");
  } else {
    res.headers.set("X-Frame-Options", "SAMEORIGIN");
    res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
    res.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  }

  return res;
});
