// Directly invoke adapters against live endpoints to find what's actually failing.
// Run: node scripts/probe-adapters.mjs

import { onsLmsAdapter } from "../packages/data-sources/src/adapters/onsLms.ts";
import { onsPsfAdapter } from "../packages/data-sources/src/adapters/onsPsf.ts";
import { onsRtiAdapter } from "../packages/data-sources/src/adapters/onsRti.ts";
import { govUkRssAdapter } from "../packages/data-sources/src/adapters/govUkRss.ts";

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
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`FAIL (${ms}ms) — ${err.name}: ${err.message}`);
    if (err.sourceUrl) console.log(`  url: ${err.sourceUrl}`);
    if (err.status) console.log(`  status: ${err.status}`);
    if (err.cause) console.log(`  cause: ${err.cause.message || err.cause}`);
  }
}

await probe("ons_lms", onsLmsAdapter);
await probe("ons_psf", onsPsfAdapter);
await probe("ons_rti", onsRtiAdapter);
await probe("gov_uk", govUkRssAdapter);
