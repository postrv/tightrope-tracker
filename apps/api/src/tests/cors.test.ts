import { describe, expect, it } from "vitest";
import { CORS_HEADERS, withCors } from "../lib/cors.js";
import { json } from "../lib/router.js";

describe("CORS", () => {
  it("sets star origin", () => {
    expect(CORS_HEADERS["Access-Control-Allow-Origin"]).toBe("*");
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toContain("GET");
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toContain("OPTIONS");
  });

  it("withCors layers over an existing Response", () => {
    const plain = new Response("hi", { status: 200, headers: { "X-Pre": "yes" } });
    const wrapped = withCors(plain);
    expect(wrapped.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(wrapped.headers.get("X-Pre")).toBe("yes");
  });

  it("json helper includes all CORS headers", () => {
    const res = json({ hello: "world" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
  });
});
