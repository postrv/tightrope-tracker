import type { Iso8601 } from "@tightrope/shared";

/** A single observation harvested from a data source. */
export interface RawObservation {
  indicatorId: string;
  value: number;
  observedAt: Iso8601;
  sourceId: string;
  payloadHash: string;
  /**
   * Publication date, i.e. when the upstream actually made the observation
   * public. Distinct from `observedAt` for time-lagged releases (ONS PSF,
   * LMS, RTI — monthly reference period, ~3-6 week release lag). Adapters
   * that know the release date MUST set this so the backfill pipeline can
   * clip out data that would have been future-published on the target day
   * (lookahead bias). Adapters where published ≈ observed (daily BoE gilt
   * yields, daily FX) may omit the field; consumers fall back to
   * `observedAt` in that case.
   */
  releasedAt?: Iso8601;
}

/** Result returned from an adapter's `fetch()` call. */
export interface AdapterResult {
  observations: RawObservation[];
  sourceUrl: string;
  fetchedAt: Iso8601;
  /**
   * Marks adapters that legitimately return zero observations. gov.uk RSS
   * is the canonical example: it harvests timeline-event candidates (side-
   * channel) and never emits observations. Without this flag, the
   * pipeline would mark every gov.uk run as "partial" for the audit log
   * because rows_written === 0.
   *
   * Omit (or set false) for normal observation-emitting adapters. Set
   * true if zero-observations-returned is a success signal.
   */
  emitsNoObservations?: boolean;
}

/** Inclusive UTC date range for historical fetches. */
export interface HistoricalRange {
  from: Date;
  to: Date;
}

/** Options passed to `fetchHistorical`. */
export type HistoricalFetchOptions = HistoricalRange;

/**
 * Result returned from an adapter's `fetchHistorical()` call.
 *
 * `earliestObservedAt` / `latestObservedAt` bound the window the adapter
 * actually populated (not the requested window) so operators can see at a
 * glance whether the upstream returned fewer rows than asked for. `notes`
 * is a free-form channel for row-level skip reasons or unit caveats the
 * writer should surface in the admin response without failing the run.
 */
export interface HistoricalFetchResult {
  observations: RawObservation[];
  sourceUrl: string;
  fetchedAt: Iso8601;
  earliestObservedAt: Iso8601 | null;
  latestObservedAt: Iso8601 | null;
  notes?: string[];
}

/** Adapter contract -- every source must implement this. */
export interface DataSourceAdapter {
  id: string;
  name: string;
  fetch(fetchImpl: typeof globalThis.fetch): Promise<AdapterResult>;
  /**
   * Optional: bulk fetch of historical observations over `[opts.from, opts.to]`.
   * Adapters that have no public historical source (fixture-backed live path)
   * should either omit this method or throw `AdapterError`. All emitted
   * observations MUST carry a `payload_hash` prefixed `hist:` so the writer
   * and any downstream SQL can distinguish historical from live and seed rows.
   */
  fetchHistorical?(
    fetchImpl: typeof globalThis.fetch,
    opts: HistoricalFetchOptions,
  ): Promise<HistoricalFetchResult>;
}
