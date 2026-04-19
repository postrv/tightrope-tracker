/**
 * ONS endpoint helper.
 *
 * ONS retired the v0 api.ons.gov.uk/timeseries/... JSON endpoint. The current
 * canonical flow is:
 *
 *   1. Resolve a CDID (and optional dataset) to a URI via the beta search API:
 *        GET https://api.beta.ons.gov.uk/v1/search?content_type=timeseries&cdids=MGSX
 *   2. Fetch the timeseries JSON from www.ons.gov.uk at that URI with `/data`
 *      appended:
 *        GET https://www.ons.gov.uk/employmentandlabourmarket/peoplenotinwork/unemployment/timeseries/mgsx/lms/data
 *
 * The data payload shape (months[]/years[]/quarters[]) is unchanged, so the
 * existing parseOnsMonthly parser continues to work.
 */
import { AdapterError, fetchOrThrow } from "../lib/errors.js";

const BETA_SEARCH = "https://api.beta.ons.gov.uk/v1/search";
const WWW_BASE = "https://www.ons.gov.uk";

interface SearchItem { uri?: string; cdid?: string }
interface SearchResponse { items?: SearchItem[] }

/**
 * Resolve a CDID (optionally scoped to a dataset) to the `/data` URL on
 * www.ons.gov.uk. Throws AdapterError if the search returns no match.
 */
export async function resolveOnsDataUrl(
  fetchImpl: typeof globalThis.fetch,
  sourceId: string,
  cdid: string,
  dataset?: string,
): Promise<string> {
  const params = new URLSearchParams({ content_type: "timeseries", cdids: cdid });
  const searchUrl = `${BETA_SEARCH}?${params.toString()}`;
  const res = await fetchOrThrow(fetchImpl, sourceId, searchUrl, {
    headers: { accept: "application/json" },
  });
  const body = await res.text();
  let parsed: SearchResponse;
  try {
    parsed = JSON.parse(body) as SearchResponse;
  } catch (cause) {
    throw new AdapterError({
      sourceId,
      sourceUrl: searchUrl,
      message: `ONS search response for CDID ${cdid} was not valid JSON`,
      cause,
    });
  }
  const items = parsed.items ?? [];
  // ONS URIs end in `/{cdid_lower}/{dataset_lower}`. When a dataset is
  // supplied we require an exact match on the trailing suffix — without a
  // dataset, any item whose URI contains the CDID substring is
  // acceptable. The resolver must NEVER fall back to an arbitrary
  // items[0] pick, because the ONS search occasionally returns hits from
  // legacy or revision-history URIs whose CDID does not match the one
  // the caller actually requested. Silently returning such a hit would
  // drive the adapter to fetch the wrong series.
  const cdidLower = cdid.toLowerCase();
  const candidates = items.filter(
    (it) => typeof it.uri === "string" && it.uri.toLowerCase().includes(`/${cdidLower}/`),
  );
  let pick: { uri?: string } | undefined;
  if (dataset) {
    const suffix = `/${dataset.toLowerCase()}`;
    pick = candidates.find(
      (it) => typeof it.uri === "string" && it.uri.toLowerCase().endsWith(suffix),
    );
    if (!pick) {
      throw new AdapterError({
        sourceId,
        sourceUrl: searchUrl,
        message: `ONS: no timeseries URI for CDID ${cdid} (dataset ${dataset}) — ${items.length} result${items.length === 1 ? "" : "s"} but none end in '${suffix}'`,
      });
    }
  } else {
    pick = candidates[0];
  }
  if (!pick || typeof pick.uri !== "string" || pick.uri.length === 0) {
    throw new AdapterError({
      sourceId,
      sourceUrl: searchUrl,
      message: `ONS: no timeseries URI for CDID ${cdid}${dataset ? ` (dataset ${dataset})` : ""}`,
    });
  }
  return `${WWW_BASE}${pick.uri}/data`;
}
