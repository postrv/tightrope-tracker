/**
 * ONS Real-Time Indicators adapter.
 *
 * Two indicators, two provenance modes:
 *   - `payroll_mom` (live, ONS timeseries K54L):
 *       Despite the legacy indicator id, the upstream series is AWE
 *       whole-economy regular-pay index (EMP dataset) -- an index level,
 *       not a PAYE payroll MoM %. The indicator definition in
 *       packages/shared/src/indicators.ts has been updated to reflect that.
 *       A proper PAYE-RTI-backed payroll-change indicator needs a CDID that
 *       isn't exposed through the public beta search API today; until it is,
 *       we fetch and store the regular-pay index so the labour pillar keeps
 *       a wage-adjacent live signal.
 *
 *   - `dd_failure_rate` (fixture):
 *       ONS publishes the direct-debit failure rate as an Excel indicator
 *       inside the RTI Excel bundle, not as a queryable timeseries. We
 *       mirror the headline figure from a hand-curated fixture and refresh
 *       on each RTI release.
 */
import rtiFixture from "../fixtures/ons-rti.json" with { type: "json" };
import type {
  AdapterResult,
  DataSourceAdapter,
  HistoricalFetchResult,
  RawObservation,
} from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError, fetchOrThrow } from "../lib/errors.js";
import { historicalPayloadHash, sha256Hex } from "../lib/hash.js";
import { parseOnsMonthly, parseOnsMonthlySeries } from "./onsPsf.js";
import { resolveOnsDataUrl } from "./onsCommon.js";
import { buildHistoricalResult, rangeUtcBounds } from "../lib/historical.js";

const SOURCE_ID = "ons_rti";

const PAYROLL = { cdid: "K54L", dataset: "EMP" } as const; // PAYE payroll, MoM %

interface RtiFixture {
  observed_at: string;
  dd_failure_rate: { value: number };
  source_url: string;
}

export const onsRtiAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "ONS Real-Time Indicators",
  async fetch(fetchImpl): Promise<AdapterResult> {
    const observations: RawObservation[] = [];
    const payrollUrl = await resolveOnsDataUrl(fetchImpl, SOURCE_ID, PAYROLL.cdid, PAYROLL.dataset);
    const res = await fetchOrThrow(fetchImpl, SOURCE_ID, payrollUrl, { headers: { accept: "application/json" } });
    const body = await res.text();
    const parsed = parseOnsMonthly(body, SOURCE_ID, payrollUrl);
    const hash = await sha256Hex(body);
    observations.push({
      indicatorId: "payroll_mom",
      value: parsed.value,
      observedAt: parsed.observedAt,
      sourceId: SOURCE_ID,
      payloadHash: hash,
      ...(parsed.releasedAt ? { releasedAt: parsed.releasedAt } : {}),
    });

    // DD failure rate fixture fallback.
    const fx = rtiFixture as unknown as RtiFixture;
    if (fx && typeof fx.dd_failure_rate?.value === "number") {
      const fHash = await sha256Hex(JSON.stringify(fx));
      observations.push({
        indicatorId: "dd_failure_rate",
        value: fx.dd_failure_rate.value,
        observedAt: fx.observed_at,
        sourceId: SOURCE_ID,
        payloadHash: fHash,
      });
    }

    if (observations.length === 0) {
      throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: payrollUrl, message: "ONS RTI: no observations parsed" });
    }
    return { observations, sourceUrl: payrollUrl, fetchedAt: new Date().toISOString() };
  },
  async fetchHistorical(fetchImpl, opts): Promise<HistoricalFetchResult> {
    // Only PAYE payroll has a public ONS historical series; dd_failure_rate
    // remains fixture-driven in the live path.
    const observations: RawObservation[] = [];
    const { fromMs, toMs } = rangeUtcBounds(opts);
    const payrollUrl = await resolveOnsDataUrl(fetchImpl, SOURCE_ID, PAYROLL.cdid, PAYROLL.dataset);
    const res = await fetchOrThrow(fetchImpl, SOURCE_ID, payrollUrl, { headers: { accept: "application/json" } });
    const body = await res.text();
    const series = parseOnsMonthlySeries(body, SOURCE_ID, payrollUrl);
    let skippedOutOfRange = 0;
    for (const point of series) {
      const ms = Date.parse(point.observedAt);
      if (!Number.isFinite(ms)) continue;
      if (ms < fromMs || ms > toMs) { skippedOutOfRange++; continue; }
      observations.push({
        indicatorId: "payroll_mom",
        value: point.value,
        observedAt: point.observedAt,
        sourceId: SOURCE_ID,
        payloadHash: await historicalPayloadHash("payroll_mom", point.observedAt, point.value),
        ...(point.releasedAt ? { releasedAt: point.releasedAt } : {}),
      });
    }
    const notes: string[] = ["dd_failure_rate is fixture-only; not emitted in historical mode"];
    if (skippedOutOfRange > 0) notes.push(`${skippedOutOfRange} months outside requested range`);
    return buildHistoricalResult(observations, payrollUrl, notes);
  },
};

registerAdapter(onsRtiAdapter);
