/**
 * OpenAPI drift guard.
 *
 * This test exists so the published spec and the actually-routed code
 * can never disagree. If a new endpoint is added and forgotten in the
 * spec — or a spec path is documented but not wired — CI fails here.
 *
 * The spec is loaded from `@tightrope/shared/openapi`, which is the
 * single source of truth that both the API worker (at `/api/v1/openapi.json`)
 * and the web app (at `/openapi.json`, rendered by Scalar at `/docs`)
 * serve verbatim.
 */
import { describe, expect, it } from "vitest";
import { openapiSpec } from "@tightrope/shared/openapi";
import { router } from "../index.js";
import { handleOpenapi } from "../handlers/openapi.js";

/** Known error codes emitted by the worker. If you add one, document it. */
const EXPECTED_ERROR_CODES: readonly string[] = [
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "BAD_QUERY",
  "MISSING_PARAM",
  "BAD_POSTCODE",
  "RATE_LIMITED",
  "NOT_SEEDED",
  "DB_ERROR",
  "UPSTREAM_ERROR",
  "INTERNAL",
];

describe("OpenAPI spec shape", () => {
  it("is OpenAPI 3.1.x", () => {
    expect(openapiSpec.openapi).toMatch(/^3\.1(\.|$)/);
  });

  it("names Tightrope's production API server", () => {
    const urls = (openapiSpec.servers ?? []).map((s) => s.url);
    expect(urls).toContain("https://api.tightropetracker.uk");
  });

  it("declares non-empty info.title + info.version", () => {
    expect(openapiSpec.info?.title).toBeTruthy();
    expect(openapiSpec.info?.version).toBeTruthy();
  });

  it("documents every known error code in the Error schema enum", () => {
    const errorSchema = openapiSpec.components?.schemas?.Error;
    expect(errorSchema, "components.schemas.Error must exist").toBeDefined();
    const codeEnum = errorSchema?.properties?.code?.enum as readonly string[] | undefined;
    expect(codeEnum).toBeDefined();
    for (const code of EXPECTED_ERROR_CODES) {
      expect(codeEnum).toContain(code);
    }
  });

  it("every path is GET-only (the API is read-only)", () => {
    for (const [path, item] of Object.entries(openapiSpec.paths ?? {})) {
      const methods = Object.keys(item ?? {}).filter((k) =>
        ["get", "put", "post", "patch", "delete", "options", "head"].includes(k),
      );
      expect(methods, `path ${path}`).toEqual(["get"]);
    }
  });
});

describe("OpenAPI ↔ router parity", () => {
  it("every router GET path is documented in the spec", () => {
    const routerPaths = [...router.listPaths("GET")].sort();
    const specPaths = Object.keys(openapiSpec.paths ?? {}).sort();
    for (const p of routerPaths) {
      expect(specPaths, `router path ${p} must be documented`).toContain(p);
    }
  });

  it("every documented path is registered in the router", () => {
    const routerPaths = new Set(router.listPaths("GET"));
    for (const p of Object.keys(openapiSpec.paths ?? {})) {
      expect(
        routerPaths.has(p),
        `documented path ${p} must be routed`,
      ).toBe(true);
    }
  });
});

describe("GET /api/v1/openapi.json handler", () => {
  it("returns 200 with JSON content-type", async () => {
    const res = await handleOpenapi(new Request("https://api.tightropetracker.uk/api/v1/openapi.json"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
  });

  it("sets CORS open origin", async () => {
    const res = await handleOpenapi(new Request("https://api.tightropetracker.uk/api/v1/openapi.json"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns the same spec object the shared package exports", async () => {
    const res = await handleOpenapi(new Request("https://api.tightropetracker.uk/api/v1/openapi.json"));
    const body = await res.json();
    // Document-level fields are the ones tooling reads first; assert them.
    expect(body).toMatchObject({
      openapi: openapiSpec.openapi,
      info: { title: openapiSpec.info.title, version: openapiSpec.info.version },
    });
    expect(Object.keys((body as { paths: object }).paths).sort()).toEqual(
      Object.keys(openapiSpec.paths).sort(),
    );
  });

  it("caches aggressively — the spec changes rarely", async () => {
    const res = await handleOpenapi(new Request("https://api.tightropetracker.uk/api/v1/openapi.json"));
    const cc = res.headers.get("Cache-Control") ?? "";
    // Accept any max-age >= 300s (5 minutes); we want edge caching.
    const match = cc.match(/(?:s-)?max-age=(\d+)/);
    expect(match, `Cache-Control should specify a max-age: got ${cc}`).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(300);
  });

  it("rejects unknown query parameters", async () => {
    const res = await handleOpenapi(
      new Request("https://api.tightropetracker.uk/api/v1/openapi.json?bogus=1"),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("BAD_QUERY");
  });
});
