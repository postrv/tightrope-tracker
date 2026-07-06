// BoE IADB relay: fetch the raw CSV payloads on a runner (GitHub Actions egress
// can still reach the endpoint; Cloudflare Workers egress has been ASN-blocked
// with HTTP 500 since 2026-06-10) and POST each to the ingest admin relay
// endpoint, which replays it through the existing adapter machinery.
//
// Run: node --import tsx scripts/relay-boe.mjs         (tsx resolves the .ts
//   adapter imports; node 20 can't strip types natively).
//   --dry   fetch + parse locally against the live IADB, but skip the POST legs
//           and the recompute — proves fetch + URL construction without touching
//           production.
//
// Exits non-zero if any relay leg failed, so CI can open a tracking issue.
//
// The series codes come from the adapter modules themselves (exported), so the
// URL this script builds can never drift from what the adapters request; the
// local parse reuses each adapter's own fetch(), so the parse can't drift either.

import { boeYieldsAdapter, BOE_YIELDS_SERIES_CODES } from "../packages/data-sources/src/adapters/boeYields.ts";
import { boeFxAdapter, BOE_FX_SERIES_CODES } from "../packages/data-sources/src/adapters/boeFx.ts";
import { boeBreakevensAdapter, BOE_BREAKEVENS_SERIES_CODES } from "../packages/data-sources/src/adapters/boeBreakevens.ts";
import { boeMortgageRatesAdapter, BOE_MORTGAGE_SERIES_CODE } from "../packages/data-sources/src/adapters/boeMortgageRates.ts";
import { buildBoEIadbUrl, BOE_FETCH_HEADERS } from "../packages/data-sources/src/lib/boe.ts";

const DRY = process.argv.includes("--dry");
const INGEST_URL = (process.env.INGEST_URL ?? "https://ingest.tightropetracker.uk").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.RELAY_ADMIN_TOKEN ?? "";

/** The four BoE adapters, each with the exact series-code constant it requests. */
const LEGS = [
  { id: "boe_yields", adapter: boeYieldsAdapter, seriesCodes: BOE_YIELDS_SERIES_CODES },
  { id: "boe_fx", adapter: boeFxAdapter, seriesCodes: BOE_FX_SERIES_CODES },
  { id: "boe_breakevens", adapter: boeBreakevensAdapter, seriesCodes: BOE_BREAKEVENS_SERIES_CODES },
  { id: "boe_mortgage_rates", adapter: boeMortgageRatesAdapter, seriesCodes: BOE_MORTGAGE_SERIES_CODE },
];

/** A fetch that returns an already-fetched CSV body — used to parse locally. */
const replayFetchFor = (body) => async () =>
  new Response(body, { status: 200, headers: { "content-type": "text/csv" } });

/** Fetch the raw IADB CSV for one series set, using the adapter's own URL construction. */
async function fetchCsv(seriesCodes) {
  const url = buildBoEIadbUrl(seriesCodes);
  const res = await fetch(url, { headers: BOE_FETCH_HEADERS });
  if (!res.ok) throw new Error(`IADB fetch HTTP ${res.status} ${res.statusText}`);
  const body = await res.text();
  if (!body.trim()) throw new Error("IADB returned an empty body");
  return { url, body };
}

async function relayLeg({ id, adapter, seriesCodes }) {
  const t0 = Date.now();
  const { body } = await fetchCsv(seriesCodes);

  // Parse through the SAME adapter machinery — validates the payload and reports
  // the latest values. In --dry this IS the validation (a parse failure fails
  // the leg). In live mode it's best-effort telemetry; the server re-parses
  // authoritatively and owns pass/fail (a malformed payload still relays so the
  // server's audit/DLQ path records it).
  let observations = null;
  let parseError = null;
  try {
    observations = (await adapter.fetch(replayFetchFor(body))).observations;
  } catch (err) {
    parseError = err;
  }

  if (DRY) {
    if (parseError) throw parseError;
    return { ms: Date.now() - t0, bytes: body.length, observations, dry: true };
  }

  const postRes = await fetch(`${INGEST_URL}/admin/relay?adapter=${id}`, {
    method: "POST",
    headers: { "content-type": "text/csv", "x-admin-token": ADMIN_TOKEN },
    body,
  });
  let payload = null;
  try {
    payload = await postRes.json();
  } catch {
    /* non-JSON error body */
  }
  if (!postRes.ok || !payload || payload.ok !== true) {
    throw new Error(`relay POST ${postRes.status}: ${payload ? JSON.stringify(payload) : "(non-JSON response)"}`);
  }
  return { ms: Date.now() - t0, bytes: body.length, observations, server: payload };
}

function summarise(observations) {
  if (!observations || observations.length === 0) return "(no observations)";
  return observations.map((o) => `${o.indicatorId}=${o.value}@${o.observedAt.slice(0, 10)}`).join(", ");
}

async function main() {
  if (!DRY && !ADMIN_TOKEN) {
    console.error("RELAY_ADMIN_TOKEN is not set — refusing to POST. Use --dry to fetch + parse only.");
    process.exit(2);
  }
  console.log(`BoE relay ${DRY ? "(dry run — fetch + parse only, no POST)" : `→ ${INGEST_URL}`}`);

  const failed = [];
  for (const leg of LEGS) {
    process.stdout.write(`\n=== ${leg.id} ===\n`);
    try {
      const r = await relayLeg(leg);
      if (r.dry) {
        console.log(`OK (${r.ms}ms, ${r.bytes}B) parsed: ${summarise(r.observations)}`);
      } else {
        console.log(`OK (${r.ms}ms, ${r.bytes}B) server: status=${r.server.status} rowsWritten=${r.server.rowsWritten}`);
        console.log(`  fetched latest: ${summarise(r.observations)}`);
      }
    } catch (err) {
      failed.push(leg.id);
      console.log(`FAIL — ${err.name ?? "Error"}: ${err.message}`);
    }
  }

  // Kick a recompute so the relayed values reach the public snapshot immediately
  // (the 5-minute cron would do it anyway — this makes the run self-contained).
  // Non-fatal: a failed recompute must not flip an otherwise-green run red.
  if (!DRY && failed.length < LEGS.length) {
    try {
      const res = await fetch(`${INGEST_URL}/admin/run?source=recompute`, {
        method: "POST",
        headers: { "x-admin-token": ADMIN_TOKEN },
      });
      console.log(`\nrecompute: HTTP ${res.status}`);
    } catch (err) {
      console.warn(`\nrecompute kick failed (non-fatal): ${err.message}`);
    }
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} of ${LEGS.length} BoE relay leg(s) FAILED: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log(`\nAll ${LEGS.length} BoE relay legs OK`);
}

await main();
