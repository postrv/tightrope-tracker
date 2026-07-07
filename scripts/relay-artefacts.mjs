// Curator artefact relay: fetch the relay-marked capture specs' artefacts on a
// GitHub Actions runner (whose egress reaches upstreams that 403 Cloudflare
// Workers — obr.uk; and the ONS xlsx the Worker shouldn't fetch itself) and
// POST each to the curator's `POST /admin/relay-artefact`, which runs the exact
// same capture→extract→verify→persist pipeline the sweep runs.
//
// Discovery is SHARED, not forked: this script imports fetchArtefactParts from
// the curator's own capture stage, so the follow-link discovery a runner does
// is byte-for-byte the discovery a Worker sweep would do.
//
// Run: node --import tsx scripts/relay-artefacts.mjs        (tsx resolves the
//   script's .ts curator imports; node 20 can't strip types natively).
//   --dry   fetch + discover the artefact(s) locally but skip every POST — proves
//           discovery + fetch against the live sites without touching production.
//
// Exits non-zero if any relay leg failed, so CI can open a tracking issue.

import { CAPTURE_SPECS } from "../apps/curator/src/sources/registry.ts";
import { isRelaySpec } from "../apps/curator/src/types.ts";
import { fetchArtefactParts } from "../apps/curator/src/pipeline/capture.ts";

const DRY = process.argv.includes("--dry");
const FORCE = process.argv.includes("--force"); // Tue/Wed pre-deadline: re-extract even if unchanged.
const CURATOR_URL = (process.env.CURATOR_URL ?? "https://curator.tightropetracker.uk").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.CURATOR_ADMIN_TOKEN ?? "";

const CONTENT_TYPE = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  atom: "application/atom+xml",
  html: "text/html",
};

const RELAY_SPECS = CAPTURE_SPECS.filter(isRelaySpec);

async function relaySpec(spec) {
  const t0 = Date.now();
  // Same discovery + fetch the Worker capture stage would do — shared code.
  const parts = await fetchArtefactParts(spec);
  if (parts.length !== 1) {
    // The relay endpoint accepts one artefact per POST; relay specs are
    // single-artefact by contract. Fail loudly rather than silently drop parts.
    throw new Error(`spec ${spec.sourceId} produced ${parts.length} parts; relay expects exactly 1`);
  }
  const part = parts[0];
  const summary = `${part.format} ${part.bytes.length}B from ${part.url}`;

  if (DRY) return { ms: Date.now() - t0, dry: true, summary };

  const q = FORCE ? "&force=true" : "";
  const res = await fetch(`${CURATOR_URL}/admin/relay-artefact?spec=${encodeURIComponent(spec.sourceId)}${q}`, {
    method: "POST",
    headers: {
      "content-type": CONTENT_TYPE[part.format] ?? "application/octet-stream",
      "x-admin-token": ADMIN_TOKEN,
      "x-artefact-format": part.format,
      "x-artefact-url": part.url,
    },
    body: part.bytes,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok || !payload || payload.ok !== true) {
    throw new Error(`relay POST ${res.status}: ${payload ? JSON.stringify(payload) : "(non-JSON response)"}`);
  }
  return { ms: Date.now() - t0, summary, server: payload };
}

async function main() {
  if (!DRY && !ADMIN_TOKEN) {
    console.error("CURATOR_ADMIN_TOKEN is not set — refusing to POST. Use --dry to fetch + discover only.");
    process.exit(2);
  }
  console.log(`Curator artefact relay ${DRY ? "(dry run — fetch + discover only, no POST)" : `→ ${CURATOR_URL}`}${FORCE ? " [force]" : ""}`);
  console.log(`Relay specs: ${RELAY_SPECS.map((s) => s.sourceId).join(", ") || "(none)"}`);

  const failed = [];
  for (const spec of RELAY_SPECS) {
    process.stdout.write(`\n=== ${spec.sourceId} ===\n`);
    try {
      const r = await relaySpec(spec);
      if (r.dry) {
        console.log(`OK (${r.ms}ms) discovered: ${r.summary}`);
      } else {
        console.log(`OK (${r.ms}ms) discovered: ${r.summary}`);
        console.log(`  server: status=${r.server.status} rows=${r.server.rows ?? 0}`);
      }
    } catch (err) {
      failed.push(spec.sourceId);
      console.log(`FAIL — ${err.name ?? "Error"}: ${err.message}`);
    }
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} of ${RELAY_SPECS.length} curator relay leg(s) FAILED: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log(`\nAll ${RELAY_SPECS.length} curator relay legs OK`);
}

await main();
