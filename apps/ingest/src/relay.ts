import {
  boeBreakevensAdapter,
  boeFxAdapter,
  boeMortgageRatesAdapter,
  boeYieldsAdapter,
  type DataSourceAdapter,
} from "@tightrope/data-sources";
import type { Env } from "./env.js";
import { timingSafeEqual } from "./admin.js";
import { adminAuthGate } from "./lib/adminBackoff.js";
import { runAdapter, type RunAdapterOutcome } from "./pipelines/runAdapter.js";
import { sanitizeForLog } from "./lib/sanitize.js";

/**
 * `POST /admin/relay?adapter=<id>` — replay a BoE IADB CSV payload that a
 * GitHub Actions runner fetched on our behalf.
 *
 * Incident (2026-06-10): the BoE IADB CSV endpoint returns HTTP 500 to requests
 * from Cloudflare Workers egress IPs — an ASN block, not a header/UA issue
 * (identical requests succeed from residential IPs and GitHub Actions runners).
 * That froze the four BoE adapters and their six indicators. This endpoint moves
 * ONLY the network hop off Cloudflare: the runner fetches the raw CSV and POSTs
 * it here, and we replay it through the *exact same* adapter machinery — parser,
 * plausibility gate, audit row (success / unchanged / partial via payload hash),
 * and DLQ-on-parse-failure — so the data path, provenance, and health surfaces
 * are byte-for-byte identical to a normal adapter run.
 *
 * Behind the same ADMIN_TOKEN + constant-time check + per-IP backoff as
 * `/admin/run`. The request body is the raw CSV text; the handler wraps it in a
 * 200 text/csv Response and hands that to the adapter as its fetch impl, so the
 * adapter builds and "requests" its own URL exactly as it always does — the URL
 * is ignored, only the network egress changed.
 *
 * Relaying is restricted to the four BoE adapters by an explicit allowlist —
 * replaying arbitrary adapters through an injected payload is forbidden.
 */

/** The ONLY adapters that may be relayed. Arbitrary-adapter relay is forbidden. */
const RELAY_ADAPTERS: Readonly<Record<string, DataSourceAdapter>> = {
  boe_yields: boeYieldsAdapter,
  boe_fx: boeFxAdapter,
  boe_breakevens: boeBreakevensAdapter,
  boe_mortgage_rates: boeMortgageRatesAdapter,
};

/** Cap the relayed payload. A 2-year daily IADB CSV is a few tens of KB; 2MB is generous. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function handleRelay(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });
  }
  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    return json({ error: "ADMIN_TOKEN not configured" }, 503);
  }
  // SEC-13: per-IP exponential backoff on failed auth (see admin.ts).
  const auth = await adminAuthGate(env, req, {
    verifyToken: (provided) => provided !== null && timingSafeEqual(provided, expected),
  });
  if (!auth.ok) return auth.response;

  const adapterId = url.searchParams.get("adapter");
  if (!adapterId) {
    return json({ error: "missing ?adapter= (one of: " + Object.keys(RELAY_ADAPTERS).join(", ") + ")" }, 400);
  }
  const adapter = RELAY_ADAPTERS[adapterId];
  if (!adapter) {
    // 404: the adapter is either unknown or not on the relay allowlist. We do
    // not distinguish, so this endpoint can't be used to probe adapter ids.
    return json({ error: `adapter '${adapterId}' is not relay-allowed` }, 404);
  }

  // Early reject on a declared oversized body before buffering it.
  const declaredLen = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return json({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }, 400);
  }

  let body: string;
  try {
    body = await req.text();
  } catch {
    return json({ error: "could not read request body" }, 400);
  }
  if (body.trim().length === 0) {
    return json({ error: "empty body — expected the raw IADB CSV text" }, 400);
  }
  // Re-check the real size (the content-length header may be absent or lie).
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    return json({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }, 400);
  }

  // Hand the adapter a fetch that returns the posted CSV for whatever URL it
  // requests. It then runs through the standard runAdapter: parse, plausibility
  // gate, audit close (success/unchanged/partial by payload hash — a byte-
  // identical repoll lands 'unchanged' exactly like a live run), and, on a parse
  // failure, closeAuditFailure + DLQ. The bounded retry never fires here (a
  // replay fetch can't throw a retryable AdapterError).
  const replayFetch = (async () =>
    new Response(body, { status: 200, headers: { "content-type": "text/csv" } })) as unknown as typeof globalThis.fetch;

  let outcome: RunAdapterOutcome | undefined;
  try {
    await runAdapter(env, adapter, {
      fetchImpl: replayFetch,
      onOutcome: (o) => {
        outcome = o;
      },
    });
  } catch (err) {
    // runAdapter has already written the failure audit row and enqueued the DLQ
    // message before re-throwing — we swallow so the handler never throws, and
    // report the failure to the caller so the relay leg is flagged.
    console.warn(`relay: adapter '${adapterId}' failed — ${sanitizeForLog((err as Error)?.message ?? String(err))}`);
    return json({ ok: false, adapter: adapterId, status: "failure", rowsWritten: 0 }, 502);
  }

  return json(
    {
      ok: true,
      adapter: adapterId,
      status: outcome?.status ?? "success",
      rowsWritten: outcome?.rowsWritten ?? 0,
    },
    200,
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
