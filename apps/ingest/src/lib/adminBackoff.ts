/**
 * SEC-13: per-IP exponential backoff on failed admin-token attempts.
 *
 * The implementation now lives in `@tightrope/shared` (adminGate.ts) so the
 * ingest and curator workers share ONE gate — see that module for the full
 * rationale and behaviour. This file is a thin re-export that preserves every
 * existing import path (`./lib/adminBackoff.js`) and call signature; the
 * accompanying `adminBackoff.test.ts` exercises the same surface unchanged.
 */
export {
  ADMIN_BACKOFF_KEY_PREFIX,
  decideBackoff,
  isLockedOut,
  recordFailure,
  clearFailures,
  clientIpForAdmin,
  adminAuthGate,
} from "@tightrope/shared";
export type { BackoffDecision, AdminAuthDeps } from "@tightrope/shared";
