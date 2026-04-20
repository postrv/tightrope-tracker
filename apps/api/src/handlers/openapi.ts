import { openapiSpec } from "@tightrope/shared/openapi";
import { json } from "../lib/router.js";

/**
 * Serve the OpenAPI 3.1 document that describes this worker.
 *
 * The spec ships inside the bundle via `@tightrope/shared/openapi` —
 * esbuild inlines the JSON at build time, so serving it is a single
 * `JSON.stringify` with no DB/KV hop. The drift-guard test in
 * `apps/api/src/tests/openapi.test.ts` asserts the served document
 * matches the published spec and that every documented path is routed.
 *
 * Cached aggressively (1 hour at browser + edge): the spec changes only
 * when the API contract changes, which triggers a deploy and busts the
 * cache naturally via the new worker version.
 */
export async function handleOpenapi(req: Request): Promise<Response> {
  const url = new URL(req.url);
  for (const key of url.searchParams.keys()) {
    return json({ error: `unknown query parameter: ${key}`, code: "BAD_QUERY" }, 400);
  }

  return json(openapiSpec, 200, {
    "Cache-Control": "public, max-age=3600, s-maxage=3600",
  });
}
