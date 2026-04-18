/**
 * ONS Labour Market Survey adapter.
 *
 * Pulls the following time-series via the ONS beta search API (URI resolve)
 * followed by the www.ons.gov.uk `/data` endpoint:
 *
 *   | Indicator                   | CDID   | Dataset |
 *   |-----------------------------|--------|---------|
 *   | unemployment (16+)          | MGSX   | LMS     |
 *   | inactivity rate (16-64)     | LF2S   | LMS     |
 *   | health inactivity (count,m) | LFK2   | LMS     |
 *   | vacancies (level, 000s)     | AP2Y   | UNEM    |  (used for V/U ratio)
 *   | unemployed (level, 000s)    | MGSC   | LMS     |  (used for V/U ratio)
 *   | real regular pay (YoY %)    | A3WW   | EMP     |
 *
 * TODO(source): confirm CDIDs against the current ONS LMS release -- these are
 * the canonical codes in the LMS bulletin as of this file's authorship. The
 * adapter is resilient to missing values (it emits observations only for
 * series that returned a numeric latest point).
 */
import type { AdapterResult, DataSourceAdapter, RawObservation } from "../types.js";
import { registerAdapter } from "../registry.js";
import { AdapterError, fetchOrThrow } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";
import { parseOnsMonthly } from "./onsPsf.js";
import { resolveOnsDataUrl } from "./onsCommon.js";

const SOURCE_ID = "ons_lms";

interface SeriesSpec {
  indicatorId: string;
  cdid: string;
  dataset: string;
  /** If defined, apply this transform to the raw ONS value before emitting. */
  transform?: (value: number) => number;
}

const SERIES: readonly SeriesSpec[] = [
  { indicatorId: "unemployment",       cdid: "MGSX", dataset: "LMS" },
  { indicatorId: "inactivity_rate",    cdid: "LF2S", dataset: "LMS" },
  // Long-term sick economic inactivity, 16-64, thousands (SA). ONS retired the
  // old LFK2 code during an LMS restatement; LF69 is the live successor.
  // Our indicator expects millions, so the /1000 transform stays.
  { indicatorId: "inactivity_health",  cdid: "LF69", dataset: "LMS", transform: (v) => v / 1000 },
  { indicatorId: "real_regular_pay",   cdid: "A3WW", dataset: "EMP" },
];

// Vacancies-per-unemployed is a derived ratio.
const VACANCIES = { cdid: "AP2Y", dataset: "UNEM" } as const;
const UNEMPLOYED_LEVEL = { cdid: "MGSC", dataset: "LMS" } as const;

export const onsLmsAdapter: DataSourceAdapter = {
  id: SOURCE_ID,
  name: "ONS Labour Market Survey",
  async fetch(fetchImpl): Promise<AdapterResult> {
    const observations: RawObservation[] = [];
    let lastUrl = "https://www.ons.gov.uk/employmentandlabourmarket";

    for (const spec of SERIES) {
      const url = await resolveOnsDataUrl(fetchImpl, SOURCE_ID, spec.cdid, spec.dataset);
      lastUrl = url;
      const res = await fetchOrThrow(fetchImpl, SOURCE_ID, url, { headers: { accept: "application/json" } });
      const body = await res.text();
      const parsed = parseOnsMonthly(body, SOURCE_ID, url);
      const hash = await sha256Hex(body);
      const value = spec.transform ? spec.transform(parsed.value) : parsed.value;
      observations.push({
        indicatorId: spec.indicatorId,
        value,
        observedAt: parsed.observedAt,
        sourceId: SOURCE_ID,
        payloadHash: hash,
      });
    }

    // Derived: vacancies / unemployed.
    try {
      const vUrl = await resolveOnsDataUrl(fetchImpl, SOURCE_ID, VACANCIES.cdid, VACANCIES.dataset);
      const uUrl = await resolveOnsDataUrl(fetchImpl, SOURCE_ID, UNEMPLOYED_LEVEL.cdid, UNEMPLOYED_LEVEL.dataset);
      lastUrl = vUrl;
      const [vRes, uRes] = await Promise.all([
        fetchOrThrow(fetchImpl, SOURCE_ID, vUrl, { headers: { accept: "application/json" } }),
        fetchOrThrow(fetchImpl, SOURCE_ID, uUrl, { headers: { accept: "application/json" } }),
      ]);
      const vBody = await vRes.text();
      const uBody = await uRes.text();
      const v = parseOnsMonthly(vBody, SOURCE_ID, vUrl);
      const u = parseOnsMonthly(uBody, SOURCE_ID, uUrl);
      if (u.value > 0) {
        const ratio = v.value / u.value;
        const hash = await sha256Hex(vBody + "|" + uBody);
        // Use the later of the two observations.
        const observedAt = v.observedAt > u.observedAt ? v.observedAt : u.observedAt;
        observations.push({
          indicatorId: "vacancies_per_unemployed",
          value: ratio,
          observedAt,
          sourceId: SOURCE_ID,
          payloadHash: hash,
        });
      }
    } catch (err) {
      // If derived ratio fails we still return the other series -- but bubble
      // up if we got zero observations total.
      if (observations.length === 0) throw err;
    }

    if (observations.length === 0) {
      throw new AdapterError({ sourceId: SOURCE_ID, sourceUrl: lastUrl, message: "ONS LMS: no observations parsed" });
    }
    return { observations, sourceUrl: lastUrl, fetchedAt: new Date().toISOString() };
  },
};

registerAdapter(onsLmsAdapter);
