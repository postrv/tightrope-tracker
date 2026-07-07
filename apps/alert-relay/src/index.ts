import type { Request as CfRequest, Response as CfResponse } from "@cloudflare/workers-types";
import { EmailMessage } from "cloudflare:email";
import { timingSafeEqual } from "@tightrope/shared";
import { buildAlertEmail } from "./mime";

/**
 * Webhook → email bridge (see wrangler.toml header). Accepts the Slack-shaped
 * alert POST both the ingest and curator workers emit and forwards it to the
 * operator's inbox via the zone's Email Routing.
 *
 *   POST /hook/<RELAY_TOKEN>   body: {"text": "..."}  → 200 {"ok":true}
 *
 * Everything else 404/405/401; body over MAX_TEXT_BYTES or without a usable
 * `text` is 400. Failures to send return 502 so the posting worker's
 * postAlert logs a warning (it never throws).
 */

const MAX_TEXT_BYTES = 64 * 1024;
const DESTINATION = "laurence.avent@gmail.com";

interface Env {
  ALERT_EMAIL: { send(message: EmailMessage): Promise<void> };
  RELAY_TOKEN?: string;
}

export default {
  async fetch(request: CfRequest, env: Env): Promise<CfResponse> {
    const url = new URL(request.url);
    const token = url.pathname.match(/^\/hook\/([A-Za-z0-9_-]+)$/)?.[1];
    if (!token) return json(404, { ok: false, error: "not found" });
    if (request.method !== "POST") return json(405, { ok: false, error: "POST only" });
    if (!env.RELAY_TOKEN || !timingSafeEqual(token, env.RELAY_TOKEN)) {
      return json(401, { ok: false, error: "bad token" });
    }

    let text: string;
    try {
      const body = (await request.json()) as { text?: unknown };
      if (typeof body.text !== "string" || body.text.trim().length === 0) {
        return json(400, { ok: false, error: "body must be {\"text\": string}" });
      }
      text = body.text;
    } catch {
      return json(400, { ok: false, error: "invalid JSON" });
    }
    if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) {
      return json(400, { ok: false, error: "text too large" });
    }

    const email = buildAlertEmail(text, DESTINATION, new Date());
    try {
      await env.ALERT_EMAIL.send(new EmailMessage(email.from, DESTINATION, email.raw));
    } catch (err) {
      console.error(`alert-relay: send failed: ${(err as Error)?.message ?? String(err)}`);
      return json(502, { ok: false, error: "email send failed" });
    }
    return json(200, { ok: true });
  },
};

function json(status: number, body: unknown): CfResponse {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }) as unknown as CfResponse;
}
