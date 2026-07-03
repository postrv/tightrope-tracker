/**
 * SEC-14: anti log-injection.
 *
 * The implementation now lives in `@tightrope/shared` (sanitize.ts) so the
 * ingest and curator workers share ONE helper — see that module for the full
 * rationale. This file is a thin re-export that preserves every existing
 * import path (`./lib/sanitize.js`); the accompanying `sanitize.test.ts`
 * exercises the same surface unchanged.
 */
export { sanitizeForLog } from "@tightrope/shared";
