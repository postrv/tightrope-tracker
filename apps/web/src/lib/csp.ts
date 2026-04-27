/**
 * Content-Security-Policy construction (SEC-10).
 *
 * The previous CSP allowed `'unsafe-inline'` in `script-src`, which gave
 * any successful HTML injection a free path to executable script. The audit
 * recommendation was: per-request nonce, every legitimate inline script
 * carries it, drop `'unsafe-inline'`.
 *
 * Style-src deliberately keeps `'unsafe-inline'` — every section uses
 * `style="..."` attributes (band colours, dynamic widths) and CSP nonces
 * don't apply to inline-style attributes. The XSS impact via inline style
 * is bounded (no script execution, no CSS expression() in modern browsers),
 * so this is an acceptable, documented trade-off.
 *
 * The nonce is base64url-encoded, 16 bytes (128 bits) of entropy. That is:
 *   - Long enough that brute-forcing inside a request lifetime is hopeless.
 *   - Short enough to keep header size negligible.
 *   - Charset-restricted to A-Z a-z 0-9 - _ so it can't escape an HTML
 *     attribute context if it ever appeared raw in markup.
 */

export interface CspOptions {
  /** Per-request CSP nonce. Must be generated fresh for every response. */
  nonce: string;
  /** True for /embed/* responses (relaxed frame-ancestors / form-action). */
  isEmbed: boolean;
}

const NONCE_BYTES = 16;

/**
 * Cryptographically random nonce, base64url-encoded.
 *
 * Uses `crypto.getRandomValues` rather than `Math.random` — the latter is
 * predictable and has been used in real CSP-bypass exploits.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildCsp({ nonce, isEmbed }: CspOptions): string {
  const directives = [
    "default-src 'self'",
    // Style-src keeps 'unsafe-inline' for inline `style="..."` attributes.
    // Browsers treat 'nonce-X' on style-src as applying only to <style>
    // elements, never to attributes — and our SVG charts rely on dynamic
    // style attributes for band colours, bar widths, etc.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    // SEC-10: 'unsafe-inline' removed; every inline script must carry the
    // per-request nonce. External scripts (Astro-bundled, Plausible) are
    // both 'self' now — SEC-12 self-hosts plausible.js under /vendor.
    `script-src 'self' 'nonce-${nonce}'`,
    // Plausible events still POST to plausible.io via the script's
    // `data-api` attribute; that's why connect-src retains the host even
    // though script-src no longer needs it.
    "connect-src 'self' https://plausible.io https://tightropetracker.uk https://api.tightropetracker.uk",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'self'",
    "upgrade-insecure-requests",
    // Frame / form policy diverges between the embed surface (third parties
    // can iframe us, no form posting) and the main site (only own-origin
    // frames, own-origin form posts).
    isEmbed ? "frame-ancestors *" : "frame-ancestors 'self'",
    isEmbed ? "form-action 'none'" : "form-action 'self'",
  ];
  return directives.join("; ");
}
