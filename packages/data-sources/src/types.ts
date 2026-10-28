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
  /** A degraded candidate that the live ingestion pipeline must not publish:
   * for example, a guarded local fallback, an older provider snapshot, or an
   * unavailable stored-head check. Observations are retained for diagnostics.
   * Omit for deliberate editorial/manual sources such as OBR vintages. */
  fallbackReason?: string;
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

/** Optional context passed to adapters at runtime (secrets, config). */
export interface AdapterContext {
  secrets?: Record<string, string | undefined>;
  /**
   * Newest published observation from `sourceId` strictly before `beforeIso`.
   * EIA Brent uses this to pair its dated USD price with the relay-fed BoE FX
   * fix from the same or a preceding day. A later FX release must not reprice
   * an already-published Brent period. Absent in dev/probe scripts, where the
   * Brent adapter falls back to its fixture. Housebuilders also use this
   * lookup to prevent delayed provider data replacing a newer verified head.
   */
  getObservationBefore?: (
    indicatorId: string,
    sourceId: string,
    beforeIso: string,
  ) => Promise<{ value: number; observedAt: string } | null>;
  /** Published rows in [fromIso, beforeIso), ordered by observedAt. Historical
   * Brent uses one D1 read for the BoE fixes needed by an EIA date range. */
  getObservationsInRange?: (
    indicatorId: string,
    sourceId: string,
    fromIso: string,
    beforeIso: string,
  ) => Promise<Array<{ value: number; observedAt: string }>>;
}

/** Adapter contract -- every source must implement this. */
export interface DataSourceAdapter {
  id: string;
  name: string;
  fetch(fetchImpl: typeof globalThis.fetch, ctx?: AdapterContext): Promise<AdapterResult>;
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
    ctx?: AdapterContext,
  ): Promise<HistoricalFetchResult>;
}
