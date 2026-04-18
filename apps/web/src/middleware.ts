import { defineMiddleware } from "astro:middleware";

/**
 * Security headers are set here rather than in `public/_headers` because
 * Astro runs on Cloudflare Pages Functions (SSR), and `_headers` only
 * applies to static asset responses — not to Function output. Every HTML
 * page on this site is SSR'd, so without this middleware the security
 * posture would silently revert to Cloudflare's defaults.
 *
 * Two variants:
 *   /embed/*  — permissive frame-ancestors so third parties can iframe us.
 *               CORP cross-origin, form-action 'none' (read-only),
 *               no X-Frame-Options.
 *   everything else — strict frame-ancestors 'self', X-Frame-Options SAMEORIGIN,
 *               COOP/CORP same-origin, form-action 'self'.
 *
 * The shared block (HSTS, Permissions-Policy, X-Content-Type-Options,
 * Referrer-Policy) is applied to both.
 */

const CSP_COMMON = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: https:",
  "script-src 'self' 'unsafe-inline' https://plausible.io",
  "connect-src 'self' https://plausible.io https://tightropetracker.uk https://api.tightropetracker.uk",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'self'",
  "upgrade-insecure-requests",
];

const CSP_MAIN = [...CSP_COMMON, "frame-ancestors 'self'", "form-action 'self'"].join("; ");
const CSP_EMBED = [...CSP_COMMON, "frame-ancestors *", "form-action 'none'"].join("; ");

const SHARED_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "geolocation=(), camera=(), microphone=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()",
};

export const onRequest = defineMiddleware(async (ctx, next) => {
  const res = await next();
  const isEmbed = ctx.url.pathname.startsWith("/embed/");

  for (const [k, v] of Object.entries(SHARED_HEADERS)) res.headers.set(k, v);
  res.headers.set("Content-Security-Policy", isEmbed ? CSP_EMBED : CSP_MAIN);

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
