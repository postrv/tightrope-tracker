/**
 * OpenAPI 3.1 specification for the Tightrope public API.
 *
 * Single source of truth — imported verbatim by:
 *   - apps/api (served at https://api.tightropetracker.uk/api/v1/openapi.json)
 *   - apps/web (served at https://tightropetracker.uk/openapi.json, rendered
 *               by Scalar at https://tightropetracker.uk/docs)
 *
 * A drift-guard test at apps/api/src/tests/openapi.test.ts asserts that
 * every documented path is registered in the router and vice versa, so
 * the spec and the code cannot silently diverge.
 */
import spec from "./openapi.json" with { type: "json" };

/**
 * Minimal structural type for the fields consumers and tests read. We
 * intentionally don't import the full `openapi-types` package: the spec
 * is hand-authored JSON, not a generated schema, and a tiny local type
 * keeps the shared package dependency-free.
 */
export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly summary?: string;
    readonly description?: string;
  };
  readonly servers?: ReadonlyArray<{ readonly url: string; readonly description?: string }>;
  readonly paths: Readonly<Record<string, unknown>>;
  readonly components?: {
    readonly schemas?: Readonly<Record<string, {
      readonly properties?: Readonly<Record<string, { readonly enum?: readonly string[] }>>;
    }>>;
  };
}

export const openapiSpec: OpenApiDocument = spec as OpenApiDocument;

/** Sorted list of every documented path — handy for tests and tooling. */
export const DOCUMENTED_PATHS: readonly string[] = Object.freeze(
  Object.keys(openapiSpec.paths).sort(),
);
