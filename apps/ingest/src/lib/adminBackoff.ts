import type { Env } from "../env.js";

/**
 * SEC-13: per-IP exponential backoff on failed admin-token attempts.
 *
 * The shared `ADMIN_TOKEN` is a 32-byte secret so an online brute-force is
 * already infeasible — but a per-IP backoff is cheap defence-in-depth. It:
 *   - turns sustained probing into KV writes that show up in metrics,
 *   - protects a misconfigured client from accidentally hammering the
 *     admin endpoints in a tight loop,
 *   - and gives us a forensic trail (count + lastFailedAt per IP) if
 *     we ever need to investigate.
 *
 * State is stored in KV under `admin-backoff:<ip>` as a small JSON blob
 * `{ attempts, lockedUntil }`. KV TTL is set to the *expected lifetime* of
 * the lockout (or a 1h floor for the attempt counter on stale IPs) so
 * benign actors recover automatically without operator intervention.
 *
 * The token check itself remains constant-time (`timingSafeEqual` in
 * `admin.ts`); this layer adds friction *around* the check, not inside it.
 */
export const ADMIN_BACKOFF_KEY_PREFIX = "admin-backoff:";

/** Lockout decision per attempt count (1-indexed; the *new* attempt). */
export interface BackoffDecision {
  lockoutSeconds: number;
}

/**
 * Exponential backoff with two grace failures and a 15-minute cap.
 *
 *   attempts <= 2   → 0s   (typo recovery, no friction)
 *   attempts == 3   → 30s
 *   attempts == 4   → 60s
 *   attempts == 5   → 120s
 *   attempts == 6   → 300s
 *   attempts >= 7   → 900s (15-minute ceiling)
 *
 * The ceiling matters: a benign misconfigured client must self-heal in
 * under an hour without operator action. Anything above the ceiling is
 * also redundant — at 900s/attempt, brute-forcing a 32-byte secret is
 * astronomically infeasible.
 */
export function decideBackoff(attempts: number): BackoffDecision {
  if (attempts <= 2) return { lockoutSeconds: 0 };
  if (attempts === 3) return { lockoutSeconds: 30 };
  if (attempts === 4) return { lockoutSeconds: 60 };
  if (attempts === 5) return { lockoutSeconds: 120 };
  if (attempts === 6) return { lockoutSeconds: 300 };
  return { lockoutSeconds: 900 };
}

interface BackoffState {
  attempts: number;
  /** Epoch ms after which a new attempt is allowed. 0 means no lockout. */
  lockedUntil: number;
}

function keyFor(ip: string): string {
  return `${ADMIN_BACKOFF_KEY_PREFIX}${ip}`;
}

async function readState(env: Env, ip: string): Promise<BackoffState> {
  const raw = await env.KV.get(keyFor(ip));
  if (!raw) return { attempts: 0, lockedUntil: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<BackoffState>;
    return {
      attempts: typeof parsed.attempts === "number" ? parsed.attempts : 0,
      lockedUntil: typeof parsed.lockedUntil === "number" ? parsed.lockedUntil : 0,
    };
  } catch {
    return { attempts: 0, lockedUntil: 0 };
  }
}

async function writeState(env: Env, ip: string, state: BackoffState, ttlSeconds: number): Promise<void> {
  // KV requires expirationTtl >= 60. The TTL governs how long the attempt
  // history sticks around for a benign IP that goes idle — too short and
  // we lose the backoff context across the lockout itself; too long and
  // the IP carries a bad-state shadow forever.
  const ttl = Math.max(60, ttlSeconds);
  await env.KV.put(keyFor(ip), JSON.stringify(state), { expirationTtl: ttl });
}

/**
 * Returns the current backoff state for `ip`. `lockedUntil` is null if no
 * lockout is active *as of `now`*; otherwise it's the epoch-ms moment when
 * a new attempt becomes allowed.
 */
export async function isLockedOut(
  env: Env,
  ip: string,
  now: number,
): Promise<{ lockedUntil: number | null; attempts: number }> {
  const state = await readState(env, ip);
  const active = state.lockedUntil > now ? state.lockedUntil : null;
  return { lockedUntil: active, attempts: state.attempts };
}

/**
 * Records a failed auth attempt for `ip` and returns the resulting state.
 * Increments the attempt counter, computes the new lockout window per
 * `decideBackoff`, and persists with a TTL long enough to outlive the
 * lockout itself (so the counter is still there when the lockout ends).
 */
export async function recordFailure(
  env: Env,
  ip: string,
  now: number,
): Promise<{ lockedUntil: number | null; attempts: number }> {
  const prev = await readState(env, ip);
  const attempts = prev.attempts + 1;
  const { lockoutSeconds } = decideBackoff(attempts);
  const lockedUntil = lockoutSeconds > 0 ? now + lockoutSeconds * 1000 : 0;
  // Keep the counter alive at least 1h past the lockout so the *next*
  // failure (after lockout expires but within memory) still escalates.
  const ttlSeconds = Math.max(3600, lockoutSeconds + 3600);
  await writeState(env, ip, { attempts, lockedUntil }, ttlSeconds);
  return { lockedUntil: lockedUntil > 0 ? lockedUntil : null, attempts };
}

/**
 * Clears the failure counter for `ip` (called after a successful auth so
 * an operator who fat-fingered their token isn't stuck behind their own
 * earlier failures).
 */
export async function clearFailures(env: Env, ip: string): Promise<void> {
  await env.KV.delete(keyFor(ip));
}

/**
 * Returns the verified client IP from Cloudflare, or `"no-ip"` as a stable
 * fallback when the header is absent.
 *
 * Unlike the public API rate limiter (where fail-open is the right answer
 * because legitimate header-less callers exist), the *admin* path should
 * always fail closed: if we can't identify the caller we still want to
 * apply backoff using a shared "no-ip" bucket. The blast radius of one
 * shared lockout is tiny — admin endpoints serve only operators, who can
 * tolerate brief friction in exchange for guaranteed coverage.
 */
export function clientIpForAdmin(req: Request): string {
  const v = req.headers.get("cf-connecting-ip");
  return v && v.length > 0 ? v : "no-ip";
}

/**
 * Convenience: full admin auth flow. Checks lockout, verifies the token
 * (caller-supplied function), records the failure / clears the counter,
 * and returns either `{ ok: true }` for green-light or `{ ok: false,
 * response: Response }` with the appropriate 401 / 429 + Retry-After.
 *
 * The token check is delegated to `verifyToken` so the constant-time
 * comparison stays where it lives (`admin.ts:timingSafeEqual`).
 */
export interface AdminAuthDeps {
  /** Returns true when the provided token matches `env.ADMIN_TOKEN`. */
  verifyToken(provided: string | null): boolean;
}

export async function adminAuthGate(
  env: Env,
  req: Request,
  deps: AdminAuthDeps,
  now: number = Date.now(),
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const ip = clientIpForAdmin(req);
  const state = await isLockedOut(env, ip, now);
  if (state.lockedUntil !== null) {
    const retryAfter = Math.max(1, Math.ceil((state.lockedUntil - now) / 1000));
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: "too many attempts; try again later" }), {
        status: 429,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "Retry-After": String(retryAfter),
        },
      }),
    };
  }

  const provided = req.headers.get("x-admin-token");
  if (!deps.verifyToken(provided)) {
    const after = await recordFailure(env, ip, now);
    if (after.lockedUntil !== null) {
      // Keep the failure log loud enough to surface in metrics: a sustained
      // run will show as repeated lockouts on the same IP.
      console.warn(`admin auth lockout: ip=${ip} attempts=${after.attempts}`);
    }
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorised" }), {
        status: 401,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    };
  }

  // Successful auth: clear any prior failure counter (best-effort).
  await clearFailures(env, ip).catch(() => undefined);
  return { ok: true };
}
