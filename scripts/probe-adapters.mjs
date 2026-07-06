// Directly invoke adapters against live endpoints to find what's actually failing.
// Run: node --import tsx scripts/probe-adapters.mjs   (tsx resolves the .ts imports;
// node 20 can't strip types natively). Exits non-zero if any adapter fails, so
// CI can open an issue on upstream format drift.

import { onsLmsAdapter } from "../packages/data-sources/src/adapters/onsLms.ts";
import { onsPsfAdapter } from "../packages/data-sources/src/adapters/onsPsf.ts";
import { onsRtiAdapter } from "../packages/data-sources/src/adapters/onsRti.ts";
import { govUkRssAdapter } from "../packages/data-sources/src/adapters/govUkRss.ts";
import { boeYieldsAdapter } from "../packages/data-sources/src/adapters/boeYields.ts";
import { boeFxAdapter } from "../packages/data-sources/src/adapters/boeFx.ts";
import { boeBreakevensAdapter } from "../packages/data-sources/src/adapters/boeBreakevens.ts";
import { boeMortgageRatesAdapter } from "../packages/data-sources/src/adapters/boeMortgageRates.ts";

/** @returns {Promise<boolean>} true if the adapter fetched successfully. */
async function probe(name, adapter) {
  process.stdout.write(`\n=== ${name} ===\n`);
  const t0 = Date.now();
  try {
    const res = await adapter.fetch(globalThis.fetch);
    const ms = Date.now() - t0;
    console.log(`OK (${ms}ms) — ${res.observations.length} observations`);
    for (const o of res.observations) {
      console.log(`  ${o.indicatorId} = ${o.value} @ ${o.observedAt}`);
    }
    if (res.candidates) {
      console.log(`  candidates: ${res.candidates.length}`);
      for (const c of res.candidates.slice(0, 3)) {
        console.log(`    - [${c.categorySlug ?? "no-cat"}] ${c.title.substring(0, 70)}`);
      }
    }
    return true;
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`FAIL (${ms}ms) — ${err.name}: ${err.message}`);
    if (err.sourceUrl) console.log(`  url: ${err.sourceUrl}`);
    if (err.status) console.log(`  status: ${err.status}`);
    if (err.cause) console.log(`  cause: ${err.cause.message || err.cause}`);
    return false;
  }
}

const results = [
  ["ons_lms", await probe("ons_lms", onsLmsAdapter)],
  ["ons_psf", await probe("ons_psf", onsPsfAdapter)],
  ["ons_rti", await probe("ons_rti", onsRtiAdapter)],
  ["gov_uk", await probe("gov_uk", govUkRssAdapter)],
  // BoE IADB: blocked from Cloudflare Workers egress since 2026-06-10, so the
  // GitHub-runner probe is the canary for BOTH upstream drift AND whether the
  // Actions relay leg (relay-boe workflow) can still reach the endpoint.
  ["boe_yields", await probe("boe_yields", boeYieldsAdapter)],
  ["boe_fx", await probe("boe_fx", boeFxAdapter)],
  ["boe_breakevens", await probe("boe_breakevens", boeBreakevensAdapter)],
  ["boe_mortgage_rates", await probe("boe_mortgage_rates", boeMortgageRatesAdapter)],
];

const failed = results.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${results.length} adapter(s) FAILED: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\nAll ${results.length} adapters OK`);
