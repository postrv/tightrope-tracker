import { describe, expect, it, vi } from "vitest";
import { resolveOnsDataUrl } from "./onsCommon.js";
import { AdapterError } from "../lib/errors.js";

/**
 * ONS search resolver correctness.
 *
 * Regression: the old resolver did `items.find(...dataset match...) ?? items[0]`
 * — so if the caller asked for CDID "MGSX" with dataset "lms" but the
 * search returned a URI like `.../abcd/revisions` (different series, or a
 * stale index entry), the resolver silently returned it. That becomes a
 * production bug where the adapter fetches the wrong series and writes
 * wrong data to the DB.
 *
 * The resolver should:
 *   - throw when `items` is empty
 *   - throw when no item's URI contains the requested CDID
 *   - throw when `dataset` is supplied and no item matches that dataset
 *   - NOT silently fall back to `items[0]` when the match is missing
 */
function mockJson(body: unknown): () => Response {
  // Return a factory so each call gets a fresh Response (Response bodies
  // can only be consumed once, so two `await expect(...).rejects` calls
  // on the same fetch stub would otherwise fail with "Body is unusable").
  const encoded = JSON.stringify(body);
  return () => new Response(encoded, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fetchStub(responder: () => Response) {
  return vi.fn().mockImplementation(async () => responder());
}

describe("resolveOnsDataUrl", () => {
  it("returns the www.ons.gov.uk /data URL when a single item matches the CDID + dataset", async () => {
    const fetchImpl = fetchStub(mockJson({
      items: [
        { uri: "/employmentandlabourmarket/peoplenotinwork/unemployment/timeseries/mgsx/lms", cdid: "MGSX" },
      ],
    }));
    const url = await resolveOnsDataUrl(fetchImpl as never, "ons_lms", "MGSX", "lms");
    expect(url).toBe("https://www.ons.gov.uk/employmentandlabourmarket/peoplenotinwork/unemployment/timeseries/mgsx/lms/data");
  });

  it("picks the dataset-matching item when multiple items are returned", async () => {
    const fetchImpl = fetchStub(mockJson({
      items: [
        { uri: "/some/other/timeseries/mgsx/otherset", cdid: "MGSX" },
        { uri: "/employmentandlabourmarket/timeseries/mgsx/lms", cdid: "MGSX" },
      ],
    }));
    const url = await resolveOnsDataUrl(fetchImpl as never, "ons_lms", "MGSX", "lms");
    expect(url).toBe("https://www.ons.gov.uk/employmentandlabourmarket/timeseries/mgsx/lms/data");
  });

  it("throws AdapterError when the search returns zero items", async () => {
    const fetchImpl = fetchStub(mockJson({ items: [] }));
    await expect(
      resolveOnsDataUrl(fetchImpl as never, "ons_lms", "MGSX", "lms"),
    ).rejects.toThrow(AdapterError);
    await expect(
      resolveOnsDataUrl(fetchImpl as never, "ons_lms", "MGSX", "lms"),
    ).rejects.toThrow(/no timeseries URI/);
  });

  it("throws AdapterError when no item's URI contains the requested CDID (prevents wrong-series fallback)", async () => {
    // This is the core regression. Old code silently returned items[0]
    // when the dataset-match failed — so a stale/irrelevant URL would
    // drive the fetch step. The resolver must refuse to pick an item
    // that doesn't at least contain the CDID in its URI.
    const fetchImpl = fetchStub(mockJson({
      items: [
        { uri: "/some/unrelated/timeseries/abcd/lms", cdid: "ABCD" },
      ],
    }));
    await expect(
      resolveOnsDataUrl(fetchImpl as never, "ons_lms", "MGSX", "lms"),
    ).rejects.toThrow(AdapterError);
    await expect(
      resolveOnsDataUrl(fetchImpl as never, "ons_lms", "MGSX", "lms"),
    ).rejects.toThrow(/MGSX/);
  });

  it("throws AdapterError when a dataset is requested but only a different-dataset URI contains the CDID", async () => {
    // The resolver must refuse to fall back to items[0] if the dataset
    // suffix doesn't match — otherwise an old/rebased timeseries would
    // silently replace the intended one.
    const fetchImpl = fetchStub(mockJson({
      items: [
        { uri: "/employmentandlabourmarket/timeseries/mgsx/revisions", cdid: "MGSX" },
      ],
    }));
    await expect(
      resolveOnsDataUrl(fetchImpl as never, "ons_lms", "MGSX", "lms"),
    ).rejects.toThrow(/dataset lms/);
  });

  it("without a dataset hint, accepts any item whose URI contains the CDID", async () => {
    // No dataset => take the first item, but still verify the CDID.
    const fetchImpl = fetchStub(mockJson({
      items: [
        { uri: "/a/b/timeseries/mgsx/lms", cdid: "MGSX" },
      ],
    }));
    const url = await resolveOnsDataUrl(fetchImpl as never, "ons_lms", "MGSX");
    expect(url).toBe("https://www.ons.gov.uk/a/b/timeseries/mgsx/lms/data");
  });

  it("throws when the search response is not JSON", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response("<!doctype html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }));
    await expect(
      resolveOnsDataUrl(fetchImpl as never, "ons_lms", "MGSX", "lms"),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("matches the CDID case-insensitively (ONS returns lowercase in URIs)", async () => {
    const fetchImpl = fetchStub(mockJson({
      items: [
        { uri: "/e/l/timeseries/mgsx/lms", cdid: "MGSX" },
      ],
    }));
    // Caller passes upper-case; URI is lower-case.
    const url = await resolveOnsDataUrl(fetchImpl as never, "ons_lms", "MGSX", "LMS");
    expect(url).toContain("/mgsx/lms/data");
  });
});
