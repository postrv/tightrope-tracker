import type { Env } from "../env";
import { CAPTURE_SPECS } from "../sources/registry";
import { isRelaySpec, type ArtefactFormat, type CaptureSpec } from "../types";
import { captureFromParts, type ArtefactPart } from "../pipeline/capture";
import { extractVerifyPersist } from "./sweep";
import { closeAudit, openAudit, type CloseAuditOpts, type CuratorAuditStatus } from "./audit";

/**
 * `POST /admin/relay-artefact?spec=<id>` — the curator's artefact relay, the
 * follow-link cousin of the ingest worker's BoE `POST /admin/relay`.
 *
 * Some upstreams block Cloudflare Workers egress (obr.uk → HTTP 403, same
 * upstream-WAF class as the BoE IADB block) or expose the figure only in a
 * binary the Worker shouldn't fetch/parse itself (the ONS DD-failure xlsx). For
 * a spec marked `fetchVia:"relay"`, a GitHub Actions runner fetches the artefact
 * (doing any follow-link discovery with the SAME shared code the Worker uses)
 * and POSTs the raw bytes here. This endpoint then runs the EXACT same pipeline
 * the sweep runs from the capture stage onward — hash short-circuit vs the last
 * capture, R2 archive, extract, verify, decide/persist, and one ingestion_audit
 * row closed exactly once (same invariant as runSpec). Only the network hop
 * moves off Cloudflare.
 *
 * Restricted to relay-marked specs by an explicit allowlist — relaying an
 * arbitrary spec through injected bytes is forbidden.
 */

/** 4MB cap — an EFO exec-summary PDF / an ONS monthly workbook is a couple of MB. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const VALID_FORMATS: ReadonlySet<string> = new Set<ArtefactFormat>(["html", "pdf", "atom", "xlsx"]);

/** The ONLY specs that may be relayed (fetchVia:"relay"). Built once at module load. */
const RELAY_SPECS: ReadonlyMap<string, CaptureSpec> = new Map(
  CAPTURE_SPECS.filter(isRelaySpec).map((s) => [s.sourceId, s]),
);

export async function handleRelayArtefact(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });

  const specId = url.searchParams.get("spec");
  if (!specId) {
    return json({ error: `missing ?spec= (one of: ${[...RELAY_SPECS.keys()].join(", ")})` }, 400);
  }
  const spec = RELAY_SPECS.get(specId);
  if (!spec) {
    // 404 for unknown OR non-relay specs alike, so the endpoint can't be used to
    // probe which spec ids exist / are relay-marked.
    return json({ error: `spec '${specId}' is not relay-enabled` }, 404);
  }

  // Format hint: the runner sends x-artefact-format (a discovery follow can flip
  // an html spec to a pdf/xlsx release); fall back to the spec's own format.
  const format = (req.headers.get("x-artefact-format") ?? spec.discover?.releaseFormat ?? spec.format) as ArtefactFormat;
  if (!VALID_FORMATS.has(format)) return json({ error: `invalid artefact format '${format}'` }, 400);

  // Size cap: reject early on a declared oversized body, then re-check the real size.
  const declaredLen = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return json({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }, 400);
  }
  let buf: ArrayBuffer;
  try {
    buf = await req.arrayBuffer();
  } catch {
    return json({ error: "could not read request body" }, 400);
  }
  const bytes = new Uint8Array(buf);
  if (bytes.length === 0) return json({ error: "empty body — expected the raw artefact bytes" }, 400);
  if (bytes.length > MAX_BODY_BYTES) return json({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }, 400);

  const artefactUrl = req.headers.get("x-artefact-url") ?? spec.urls[0] ?? `curator:${spec.sourceId}`;
  // `?force=true` re-extracts even if the artefact hash is unchanged (the Tue/Wed
  // pre-deadline relay); default respects the hash short-circuit (the daily relay).
  const force = url.searchParams.get("force") === "true";
  const parts: ArtefactPart[] = [{ url: artefactUrl, bytes, format }];

  // Same audit invariant as the sweep: open once, close EXACTLY once (finally).
  const handle = await openAudit(env.DB, spec.sourceId, artefactUrl);
  let audit: { status: CuratorAuditStatus; opts: CloseAuditOpts } = { status: "failure", opts: { error: "relay did not complete" } };
  let responseBody: Record<string, unknown> = { ok: false, spec: spec.sourceId, status: "failure" };
  let httpStatus = 502;

  try {
    const cap = await captureFromParts(env, spec, parts, { force });
    if (cap === "unchanged") {
      audit = { status: "unchanged", opts: { payloadHash: null } };
      responseBody = { ok: true, spec: spec.sourceId, status: "unchanged", rows: 0 };
      httpStatus = 200;
    } else {
      const rows = await extractVerifyPersist(env, spec, cap);
      audit = { status: "success", opts: { rowsWritten: rows, payloadHash: `ai:${cap.contentSha256}` } };
      responseBody = { ok: true, spec: spec.sourceId, status: "success", rows };
      httpStatus = 200;
    }
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    audit = { status: "failure", opts: { error: message } };
    responseBody = { ok: false, spec: spec.sourceId, status: "failure", error: message };
    httpStatus = 502;
    console.warn(`relay-artefact: spec '${spec.sourceId}' failed: ${message}`);
  } finally {
    try {
      await closeAudit(env.DB, handle, audit.status, audit.opts);
    } catch (e) {
      console.error(`relay-artefact: FAILED to close audit for '${spec.sourceId}': ${(e as Error)?.message ?? String(e)}`);
    }
  }

  return json(responseBody, httpStatus);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
