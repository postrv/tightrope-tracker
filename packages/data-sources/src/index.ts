// Re-exported by the ingest worker. Individual adapters live in ./adapters/.
export * from "./types.js";
export * from "./registry.js";
export { AdapterError, fetchOrThrow } from "./lib/errors.js";
export { sha256Hex, historicalPayloadHash } from "./lib/hash.js";

// Import adapters for their `registerAdapter(...)` side-effect so consumers can
// call `listAdapters()` / `getAdapter(id)` after `import "@tightrope/data-sources"`.
export { boeYieldsAdapter } from "./adapters/boeYields.js";
export { boeFxAdapter } from "./adapters/boeFx.js";
export { boeSoniaAdapter } from "./adapters/boeSonia.js";
export { boeBreakevensAdapter } from "./adapters/boeBreakevens.js";
export { lseHousebuildersAdapter } from "./adapters/lseHousebuilders.js";
export { eiaBrentAdapter } from "./adapters/eiaBrent.js";
export { growthSentimentAdapter } from "./adapters/growthSentiment.js";
export { obrEfoAdapter } from "./adapters/obrEfo.js";
export { onsPsfAdapter } from "./adapters/onsPsf.js";
export { onsLmsAdapter } from "./adapters/onsLms.js";
export { onsRtiAdapter } from "./adapters/onsRti.js";
export { moneyfactsMortgageAdapter } from "./adapters/moneyfactsMortgage.js";
export { mhclgHousingAdapter } from "./adapters/mhclgHousing.js";
export {
  govUkRssAdapter,
  fetchGovUkCandidates,
  parseAtomEntries,
  DELIVERY_DEPARTMENTS,
  type TimelineEventCandidate,
  type GovUkResult,
} from "./adapters/govUkRss.js";
