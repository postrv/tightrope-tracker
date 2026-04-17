import type { Iso8601 } from "@tightrope/shared";

/** A single observation harvested from a data source. */
export interface RawObservation {
  indicatorId: string;
  value: number;
  observedAt: Iso8601;
  sourceId: string;
  payloadHash: string;
}

/** Result returned from an adapter's `fetch()` call. */
export interface AdapterResult {
  observations: RawObservation[];
  sourceUrl: string;
  fetchedAt: Iso8601;
}

/** Adapter contract -- every source must implement this. */
export interface DataSourceAdapter {
  id: string;
  name: string;
  fetch(fetchImpl: typeof globalThis.fetch): Promise<AdapterResult>;
}
