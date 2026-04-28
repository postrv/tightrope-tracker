/**
 * Cloudflare Turnstile server-side verification.
 *
 * The browser-side widget produces a token that proves a human (or a
 * weighted-pass automated client) interacted with the challenge. Turnstile
 * is *not* secure on its own — the token MUST be verified server-side via
 * `https://challenges.cloudflare.com/turnstile/v0/siteverify` before the
 * request is treated as trusted.
 *
 * Tokens are single-use and short-lived (~5 min). We bind them to the
 * client IP for an extra check the verifier does for us, and we propagate
 * any siteverify errors back to the caller as a structured failure rather
 * than a generic 500 — that way the frontend can prompt the user to retry
 * the challenge instead of treating it as a server bug.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Cloudflare's published always-pass test secret. Useful as a dev fallback. */
export const TEST_ALWAYS_PASS_SECRET = "1x0000000000000000000000000000000AA";

export interface TurnstileVerifyResult {
  ok: boolean;
  /** Cloudflare's error codes when ok=false: e.g. "invalid-input-response", "timeout-or-duplicate". */
  errorCodes: readonly string[];
}

interface SiteverifyResponse {
  success: boolean;
  "error-codes"?: readonly string[];
}

export async function verifyTurnstile(
  token: string,
  secret: string,
  remoteIp: string | null,
): Promise<TurnstileVerifyResult> {
  if (!token || typeof token !== "string") {
    return { ok: false, errorCodes: ["missing-input-response"] };
  }
  if (!secret || typeof secret !== "string") {
    // Surface the misconfiguration explicitly rather than letting siteverify
    // return "missing-input-secret" — the operator needs to know it's their fault.
    return { ok: false, errorCodes: ["missing-input-secret"] };
  }

  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);
  if (remoteIp) body.set("remoteip", remoteIp);

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { ok: false, errorCodes: [`siteverify-http-${res.status}`] };
    }
    const data = (await res.json()) as SiteverifyResponse;
    return {
      ok: Boolean(data.success),
      errorCodes: data["error-codes"] ?? [],
    };
  } catch (err) {
    return {
      ok: false,
      errorCodes: [err instanceof Error && err.name === "TimeoutError" ? "siteverify-timeout" : "siteverify-network"],
    };
  }
}
