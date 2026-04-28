/**
 * POST /api/v1/lfg-signup
 *
 * Worker-side proxy that captures interest from the Tightrope Tracker site
 * and forwards it to LFG's CRM. The proxy keeps any upstream URL/key out of
 * page source, enforces a Cloudflare Turnstile challenge before any record
 * is created, and gives us one place to rate-limit / shape / audit signups.
 *
 * Backend selection:
 *   - LFG_API_KEY set      → POST direct to Brevo /v3/contacts (primary path).
 *   - else LFG_SIGNUP_API_URL set → POST to that URL (Zapier webhook fallback).
 *   - neither              → 502 UPSTREAM_ERROR.
 *   To switch back to Zapier-only, delete the LFG_API_KEY secret.
 *
 * Contract:
 *   Request body (JSON):
 *     {
 *       email: string,             // required, RFC-shaped
 *       firstName?: string,        // optional, 0..120 chars
 *       postcode?: string,         // optional, 0..16 chars (lightly checked)
 *       source?: "tightrope-card" | "tightrope-mp" | "tightrope-other",
 *       mpInterest?: boolean,      // true iff signup came from the MP-letter card
 *       weeklyUpdates?: boolean,   // true iff user opted in to weekly digest
 *       turnstileToken: string     // required, fresh Turnstile widget token
 *     }
 *   Success: 200 { ok: true }
 *   Failure: 4xx { error, code } where code ∈
 *     BAD_BODY | BAD_EMAIL | TURNSTILE_FAILED | UPSTREAM_ERROR
 *
 * Note: no PII is logged. Turnstile error codes ARE logged so we can debug
 * misconfiguration without recording subjects' tokens or emails.
 */

import { json } from "../lib/router.js";
import { verifyTurnstile, TEST_ALWAYS_PASS_SECRET } from "../lib/turnstile.js";
import { clientIp } from "../lib/rateLimit.js";

/** Soft caps so a misbehaving client can't push a 1MB bio into the upstream. */
const MAX_EMAIL = 254;
const MAX_NAME = 120;
const MAX_POSTCODE = 16;

const ALLOWED_SOURCES = new Set(["tightrope-card", "tightrope-mp", "tightrope-other"]);

const BREVO_CONTACTS_URL = "https://api.brevo.com/v3/contacts";

interface SignupBody {
  email: string;
  firstName?: string;
  postcode?: string;
  source?: string;
  mpInterest?: boolean;
  /**
   * True iff the user explicitly opted in to a weekly AI-generated digest of
   * Tightrope movements. Recorded as the WEEKLY_DIGEST contact attribute in
   * Brevo so a future scheduled worker can pull the segment and emit the
   * digest. Capturing intent now means we have a real audience the moment
   * the digest worker ships.
   */
  weeklyUpdates?: boolean;
  turnstileToken: string;
}

/** Sanitised, validated form of the inbound body — what the upstream forwarders consume. */
interface CleanSignup {
  email: string;
  firstName: string;
  postcode: string;
  sourceVariant: string;
  mpInterest: boolean;
  weeklyUpdates: boolean;
}

/**
 * Lightweight RFC-5322-ish check. Doesn't try to be exhaustive — Brevo will
 * reject a malformed address downstream too. Goal here is to catch obvious
 * typos and prevent header-injection (newlines, control chars) on fields
 * that may end up in email metadata.
 */
function looksLikeEmail(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (s.length < 3 || s.length > MAX_EMAIL) return false;
  if (/[\r\n\t\x00-\x1f\x7f]/.test(s)) return false;
  return /^[^\s<>@",;:\\]+@[^\s<>@",;:\\]+\.[^\s<>@",;:\\]+$/.test(s);
}

function trimmedString(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  // Strip control chars before slicing — header injection / log poisoning defence.
  return v.replace(/[\r\n\t\x00-\x1f\x7f]/g, "").trim().slice(0, max);
}

export async function handleLfgSignup(req: Request, env: Env): Promise<Response> {
  // 1. Parse body.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "request body must be JSON", code: "BAD_BODY" }, 400);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return json({ error: "request body must be a JSON object", code: "BAD_BODY" }, 400);
  }
  const body = raw as Partial<SignupBody>;

  // 2. Validate fields.
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!looksLikeEmail(email)) {
    return json({ error: "valid email required", code: "BAD_EMAIL" }, 400);
  }
  const clean: CleanSignup = {
    email,
    firstName: trimmedString(body.firstName, MAX_NAME),
    postcode: trimmedString(body.postcode, MAX_POSTCODE),
    sourceVariant: ALLOWED_SOURCES.has(String(body.source))
      ? (body.source as string)
      : "tightrope-other",
    mpInterest: body.mpInterest === true,
    weeklyUpdates: body.weeklyUpdates === true,
  };
  const turnstileToken = trimmedString(body.turnstileToken, 4096);
  if (!turnstileToken) {
    return json({ error: "turnstile token required", code: "TURNSTILE_FAILED" }, 400);
  }

  // 3. Verify Turnstile.
  const secret = env.TURNSTILE_SECRET_KEY || TEST_ALWAYS_PASS_SECRET;
  const verify = await verifyTurnstile(turnstileToken, secret, clientIp(req));
  if (!verify.ok) {
    // Don't echo the full error-code list to the client — it's debug telemetry.
    console.warn("turnstile verify failed", verify.errorCodes.join(","));
    return json({ error: "challenge failed — please try again", code: "TURNSTILE_FAILED" }, 400);
  }

  // 4. Forward — Brevo direct if API key is bound, else Zapier fallback.
  if (env.LFG_API_KEY) {
    return forwardToBrevo(env, clean);
  }
  if (env.LFG_SIGNUP_API_URL) {
    return forwardToZapier(env, clean);
  }
  console.error("no upstream configured: LFG_API_KEY and LFG_SIGNUP_API_URL both unset");
  return json({ error: "signup unavailable", code: "UPSTREAM_ERROR" }, 502);
}

/**
 * Brevo `POST /v3/contacts` with `updateEnabled: true` so re-signups upsert
 * cleanly rather than 400ing on duplicate. Optional fields are omitted from
 * the attributes object when empty so we don't clobber existing values on
 * an existing contact.
 *
 * Brevo returns 201 on created, 204 on updated — both are 2xx, both are ok.
 * Errors come back as { code, message } JSON; we surface the code in worker
 * logs (visible via `wrangler tail`) and return UPSTREAM_ERROR to the client.
 */
async function forwardToBrevo(env: Env, c: CleanSignup): Promise<Response> {
  // Brevo workspace attribute schema (per LFG ops): FULL_NAME, EMAIL, BIO,
  // CREATION DATE, POSTCODE. EMAIL + CREATION DATE are populated by Brevo
  // implicitly. Only required fields are name-or-email; the rest are
  // optional and omitted when empty so existing-contact values aren't
  // clobbered on a re-signup.
  //
  // The form captures a single name field (which may be a first name or a
  // full name); we forward verbatim into FULL_NAME. Source / MP-interest
  // discriminators aren't configured as Brevo attributes, so they're
  // dropped from the payload — segmentation is by list membership.
  const attributes: Record<string, unknown> = {};
  if (c.firstName) attributes.FULL_NAME = c.firstName;
  if (c.postcode) attributes.POSTCODE = c.postcode;

  // Segmentation by list, not by attribute: Brevo's boolean attribute handling
  // was unreliable in this workspace, so digest opt-in is encoded as
  // membership of a separate list (BREVO_WEEKLY_LIST_NUMBER, typically 128)
  // instead of a WEEKLY_DIGEST flag. The digest worker will pull list 128;
  // general LFG comms stay on list 127.
  const listId = c.weeklyUpdates
    ? Number(env.BREVO_WEEKLY_LIST_NUMBER) || 0
    : Number(env.BREVO_LIST_NUMBER) || 0;

  const payload = {
    email: c.email,
    attributes,
    listIds: [listId],
    emailBlacklisted: false,
    smsBlacklisted: false,
    updateEnabled: true,
  };

  try {
    const res = await fetch(BREVO_CONTACTS_URL, {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "api-key": env.LFG_API_KEY,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { code?: string; message?: string };
        detail = j?.code ?? j?.message ?? "";
      } catch { /* non-JSON body */ }
      console.error("Brevo upstream non-2xx", res.status, detail);
      return json({ error: "signup failed — please try again", code: "UPSTREAM_ERROR" }, 502);
    }
    return json({ ok: true });
  } catch (err) {
    console.error("Brevo upstream error", err instanceof Error ? err.message : "unknown");
    return json({ error: "signup failed — please try again", code: "UPSTREAM_ERROR" }, 502);
  }
}

/**
 * Zapier webhook fallback. Payload shape mirrors apps/web's sister site
 * (youcanjustdostuff) so a single Brevo Zap can consume both feeds.
 * Reserved as an escape hatch in case Brevo direct breaks — flip back by
 * deleting the LFG_API_KEY secret.
 */
async function forwardToZapier(env: Env, c: CleanSignup): Promise<Response> {
  const upstreamUrl = env.LFG_SIGNUP_API_URL;
  if (!/^https:\/\//.test(upstreamUrl)) {
    console.error("LFG_SIGNUP_API_URL not https");
    return json({ error: "signup unavailable", code: "UPSTREAM_ERROR" }, 502);
  }
  const payload = {
    firstName: c.firstName,
    lastName: "",
    email: c.email,
    phoneNumber: "",
    postcode: c.postcode,
    bio: "",
    listIds: [Number(env.BREVO_LIST_NUMBER) || 0],
    source: "tightrope-tracker",
    sourceVariant: c.sourceVariant,
    mpInterest: c.mpInterest,
    weeklyUpdates: c.weeklyUpdates,
  };
  try {
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) {
      console.error("LFG upstream non-2xx", upstream.status);
      return json({ error: "signup failed — please try again", code: "UPSTREAM_ERROR" }, 502);
    }
    return json({ ok: true });
  } catch (err) {
    console.error("LFG upstream error", err instanceof Error ? err.message : "unknown");
    return json({ error: "signup failed — please try again", code: "UPSTREAM_ERROR" }, 502);
  }
}
