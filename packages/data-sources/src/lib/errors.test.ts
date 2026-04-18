import { describe, expect, it } from "vitest";
import { DEFAULT_USER_AGENT, fetchOrThrow } from "./errors.js";

/**
 * Without an explicit UA the Cloudflare Workers runtime sends an empty header.
 * ONS returns 403 in that case. Tests here pin down that fetchOrThrow defaults
 * to a non-empty UA and lets callers override it (BoE adapters set their own).
 */
describe("fetchOrThrow", () => {
  it("sets a default User-Agent when the caller does not provide one", async () => {
    let seen: string | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      seen = headers.get("user-agent");
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await fetchOrThrow(fetchImpl, "test_source", "https://example.test/");
    expect(seen).toBe(DEFAULT_USER_AGENT);
  });

  it("lets callers override the User-Agent (case-insensitive)", async () => {
    let seen: string | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      seen = headers.get("user-agent");
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await fetchOrThrow(fetchImpl, "test_source", "https://example.test/", {
      headers: { "User-Agent": "custom/1.0" },
    });
    expect(seen).toBe("custom/1.0");
  });

  it("preserves additional caller-supplied headers alongside the default UA", async () => {
    let acceptSeen: string | null = null;
    let uaSeen: string | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      acceptSeen = headers.get("accept");
      uaSeen = headers.get("user-agent");
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await fetchOrThrow(fetchImpl, "test_source", "https://example.test/", {
      headers: { accept: "application/json" },
    });
    expect(acceptSeen).toBe("application/json");
    expect(uaSeen).toBe(DEFAULT_USER_AGENT);
  });
});
