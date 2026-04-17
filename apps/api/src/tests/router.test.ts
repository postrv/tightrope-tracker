import { describe, expect, it } from "vitest";
import { Router, json, notSeeded, preflight } from "../lib/router.js";

function stubEnv(): Env {
  return {} as unknown as Env;
}

function stubCtx(): ExecutionContext {
  return { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
}

describe("Router", () => {
  it("matches registered GET routes", async () => {
    const r = new Router().get("/a", () => json({ ok: true }));
    const res = await r.handle(new Request("https://x/a"), stubEnv(), stubCtx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 404 with machine-readable body for unknown routes", async () => {
    const r = new Router().get("/a", () => json({ ok: true }));
    const res = await r.handle(new Request("https://x/missing"), stubEnv(), stubCtx());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found", code: "NOT_FOUND" });
  });

  it("returns 405 for known paths with wrong method", async () => {
    const r = new Router().get("/a", () => json({ ok: true }));
    const res = await r.handle(new Request("https://x/a", { method: "POST" }), stubEnv(), stubCtx());
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, OPTIONS");
  });

  it("handles OPTIONS preflight for any registered GET path", async () => {
    const r = new Router().get("/a", () => json({ ok: true }));
    const res = await r.handle(new Request("https://x/a", { method: "OPTIONS" }), stubEnv(), stubCtx());
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("json helper sets CORS + cache headers", () => {
    const res = json({ a: 1 });
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toContain("max-age=60");
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=300");
  });

  it("preflight helper returns 204 with allow headers", () => {
    const res = preflight();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
  });

  it("json forces Cache-Control no-store on 4xx responses", () => {
    const res = json({ error: "bad" }, 400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("json forces Cache-Control no-store on 5xx responses", () => {
    const res = json({ error: "boom" }, 500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("notSeeded returns a 503 with NOT_SEEDED code and no-store", async () => {
    const res = notSeeded();
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ code: "NOT_SEEDED" });
  });
});
