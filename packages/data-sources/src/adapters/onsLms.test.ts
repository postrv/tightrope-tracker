import { describe, expect, it } from "vitest";
import { onsLmsAdapter } from "./onsLms.js";
import { AdapterError } from "../lib/errors.js";

function onsPayload(latestValue: number, month: "JAN" | "FEB" | "MAR" = "FEB", year = "2026"): string {
  return JSON.stringify({
    description: { title: "mock series" },
    months: [
      { date: `${year} ${month === "FEB" ? "JAN" : "FEB"}`, year, month: month === "FEB" ? "JAN" : "FEB", value: "0" },
      { date: `${year} ${month}`, year, month, value: String(latestValue) },
    ],
  });
}

function mockJson(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

/**
 * The adapter talks to two ONS endpoints:
 *   1. GET https://api.beta.ons.gov.uk/v1/search?content_type=timeseries&cdids=<CDID>
 *      -> returns an `items[].uri` like `/employmentandlabourmarket/.../timeseries/mgsx/lms`
 *   2. GET https://www.ons.gov.uk{uri}/data
 *      -> returns the `months[]` envelope we parse.
 * Tests mock both.
 */
function searchPayload(cdid: string, dataset: string): string {
  const uri = `/mock/${cdid.toLowerCase()}/${dataset.toLowerCase()}`;
  return JSON.stringify({ items: [{ uri, cdid }] });
}

describe("onsLmsAdapter", () => {
  it("returns an observation per series plus the derived V/U ratio", async () => {
    // Map URL CDIDs to deterministic values.
    const table: Record<string, number> = {
      MGSX: 4.3,   // unemployment
      LF2S: 21.8,  // inactivity
      LF69: 2800,  // health inactivity in '000s -> adapter divides by 1000 => 2.8m
      A3WW: 2.1,   // real regular pay yoy
      AP2Y: 820,   // vacancies (000s)
      MGSC: 1400,  // unemployed level (000s)
    };
    const datasetFor: Record<string, string> = {
      MGSX: "LMS", LF2S: "LMS", LF69: "LMS", MGSC: "LMS",
      AP2Y: "UNEM", A3WW: "EMP",
    };
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as URL | Request).toString();
      // 1. Search request: resolve CDID -> URI.
      const search = url.match(/api\.beta\.ons\.gov\.uk\/v1\/search\?.*cdids=([A-Z0-9]+)/);
      if (search) {
        const cdid = search[1]!;
        return mockJson(searchPayload(cdid, datasetFor[cdid] ?? "LMS"));
      }
      // 2. Data request: www.ons.gov.uk/.../timeseries/<cdid_lower>/<dataset>/data
      const data = url.match(/\/mock\/([a-z0-9]+)\/[a-z]+\/data$/);
      if (data) {
        const cdid = data[1]!.toUpperCase();
        const v = table[cdid];
        if (v === undefined) throw new Error(`no mock for ${cdid}`);
        return mockJson(onsPayload(v));
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await onsLmsAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch);
    const byId = Object.fromEntries(result.observations.map((o) => [o.indicatorId, o]));
    expect(byId.unemployment!.value).toBe(4.3);
    expect(byId.inactivity_rate!.value).toBe(21.8);
    expect(byId.inactivity_health!.value).toBeCloseTo(2.8, 6);
    expect(byId.real_regular_pay!.value).toBe(2.1);
    expect(byId.vacancies_per_unemployed!.value).toBeCloseTo(820 / 1400, 8);
    expect(byId.unemployment!.observedAt).toBe("2026-02-01T00:00:00Z");
    expect(byId.unemployment!.sourceId).toBe("ons_lms");
    expect(byId.unemployment!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws AdapterError when the ONS search returns no match", async () => {
    const fetchImpl = async () => mockJson(JSON.stringify({ items: [] }));
    await expect(
      onsLmsAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it("throws AdapterError when the data fetch fails", async () => {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as URL | Request).toString();
      if (url.includes("api.beta.ons.gov.uk")) return mockJson(searchPayload("MGSX", "LMS"));
      return mockJson("boom", 503);
    };
    await expect(
      onsLmsAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it("throws AdapterError when the data endpoint returns non-JSON", async () => {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as URL | Request).toString();
      if (url.includes("api.beta.ons.gov.uk")) return mockJson(searchPayload("MGSX", "LMS"));
      return mockJson("<html>not json</html>");
    };
    await expect(
      onsLmsAdapter.fetch(fetchImpl as unknown as typeof globalThis.fetch),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});
