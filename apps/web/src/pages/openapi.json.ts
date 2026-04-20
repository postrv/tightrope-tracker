import type { APIRoute } from "astro";
import { openapiSpec } from "@tightrope/shared/openapi";

/**
 * Canonical OpenAPI document for the Tightrope public API, served
 * same-origin so the Scalar renderer at /docs can load it without
 * loosening CSP. The API worker serves an identical copy at
 * https://api.tightropetracker.uk/api/v1/openapi.json; both read from
 * the same source in @tightrope/shared.
 *
 * Cached for 1 hour. The spec only changes when the API contract
 * changes, which triggers a new deploy and a fresh bundle.
 */
export const prerender = false;

export const GET: APIRoute = () => {
  return new Response(JSON.stringify(openapiSpec), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
      "Vary": "Origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
};
