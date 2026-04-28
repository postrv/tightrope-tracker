/**
 * Tests for POST /api/v1/lfg-signup.
 *
 * The handler has three external dependencies — JSON body parse, Turnstile
 * siteverify, and the Zapier ingest endpoint — and we want every error
 * branch to map cleanly to a documented response code. We mock global
 * fetch with a stub that dispatches by URL so each test can pin upstream
 * behaviour explicitly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleLfgSignup } from "../handlers/lfgSignup.js";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ZAPIER = "https://hooks.zapier.com/hooks/catch/12345/abc/";

interface FetchStub {
  siteverify: { ok: boolean; success?: boolean; errorCodes?: string[]; status?: number };
  upstream: { ok: boolean; status?: number };
}

function stubFetch(behaviour: FetchStub): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(SITEVERIFY)) {
      const sv = behaviour.siteverify;
      if (!sv.ok) return new Response("nope", { status: sv.status ?? 502 });
      return new Response(
        JSON.stringify({ success: sv.success ?? true, "error-codes": sv.errorCodes ?? [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.startsWith(ZAPIER) || url.startsWith("https://hooks.zapier.com/")) {
      const u = behaviour.upstream;
      return new Response(u.ok ? "OK" : "fail", { status: u.status ?? (u.ok ? 200 : 502) });
    }
    return new Response("unexpected url", { status: 599 });
  }) as unknown as typeof fetch;
}

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    TURNSTILE_SECRET_KEY: "test-secret",
    LFG_SIGNUP_API_URL: ZAPIER,
    BREVO_LIST_NUMBER: "127",
    LFG_API_KEY: "unused",
    ...overrides,
  } as unknown as Env;
}

function jsonReq(body: unknown, ip = "203.0.113.1"): Request {
  return new Request("https://api.tightropetracker.uk/api/v1/lfg-signup", {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-connecting-ip": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/v1/lfg-signup", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", stubFetch({ siteverify: { ok: true, success: true }, upstream: { ok: true } }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns 200 ok:true on a happy-path signup", async () => {
    const res = await handleLfgSignup(
      jsonReq({ email: "jane@example.com", firstName: "Jane", postcode: "EX4 4QJ", turnstileToken: "tok" }),
      envWith(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects non-JSON body with BAD_BODY", async () => {
    const res = await handleLfgSignup(jsonReq("not json"), envWith());
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "BAD_BODY" });
  });

  it("rejects body that is not an object with BAD_BODY", async () => {
    const res = await handleLfgSignup(jsonReq([1, 2, 3]), envWith());
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "BAD_BODY" });
  });

  it("rejects invalid email with BAD_EMAIL", async () => {
    const res = await handleLfgSignup(
      jsonReq({ email: "not-an-email", turnstileToken: "tok" }),
      envWith(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "BAD_EMAIL" });
  });

  it("rejects email with control chars (header-injection defence)", async () => {
    const res = await handleLfgSignup(
      jsonReq({ email: "a@b.com\nBcc: evil@x.com", turnstileToken: "tok" }),
      envWith(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "BAD_EMAIL" });
  });

  it("rejects missing turnstile token with TURNSTILE_FAILED", async () => {
    const res = await handleLfgSignup(jsonReq({ email: "jane@example.com" }), envWith());
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "TURNSTILE_FAILED" });
  });

  it("rejects when siteverify says success:false", async () => {
    vi.stubGlobal("fetch", stubFetch({
      siteverify: { ok: true, success: false, errorCodes: ["timeout-or-duplicate"] },
      upstream: { ok: true },
    }));
    const res = await handleLfgSignup(
      jsonReq({ email: "jane@example.com", turnstileToken: "stale" }),
      envWith(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "TURNSTILE_FAILED" });
  });

  it("rejects when siteverify itself returns 5xx", async () => {
    vi.stubGlobal("fetch", stubFetch({
      siteverify: { ok: false, status: 502 },
      upstream: { ok: true },
    }));
    const res = await handleLfgSignup(
      jsonReq({ email: "jane@example.com", turnstileToken: "tok" }),
      envWith(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "TURNSTILE_FAILED" });
  });

  it("returns 502 UPSTREAM_ERROR when Zapier returns non-2xx", async () => {
    vi.stubGlobal("fetch", stubFetch({
      siteverify: { ok: true, success: true },
      upstream: { ok: false, status: 500 },
    }));
    const res = await handleLfgSignup(
      jsonReq({ email: "jane@example.com", turnstileToken: "tok" }),
      envWith(),
    );
    expect(res.status).toBe(502);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("returns 502 UPSTREAM_ERROR if LFG_SIGNUP_API_URL is unset", async () => {
    const res = await handleLfgSignup(
      jsonReq({ email: "jane@example.com", turnstileToken: "tok" }),
      envWith({ LFG_SIGNUP_API_URL: "" } as Partial<Env>),
    );
    expect(res.status).toBe(502);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("rejects non-https LFG_SIGNUP_API_URL (SSRF defence)", async () => {
    const res = await handleLfgSignup(
      jsonReq({ email: "jane@example.com", turnstileToken: "tok" }),
      envWith({ LFG_SIGNUP_API_URL: "http://evil.example.com/" } as Partial<Env>),
    );
    expect(res.status).toBe(502);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("forwards a sanitised payload to the upstream Zapier endpoint", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const tracked = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(SITEVERIFY)) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response("OK", { status: 200 });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", tracked);

    await handleLfgSignup(
      jsonReq({
        email: "  Jane@Example.COM  ",
        firstName: "Jane\nDoe", // newline must be stripped
        postcode: "EX4 4QJ",
        source: "tightrope-mp",
        mpInterest: true,
        turnstileToken: "tok",
      }),
      envWith(),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(ZAPIER);
    expect(seen[0]!.body).toMatchObject({
      email: "jane@example.com", // lowercased + trimmed
      firstName: "JaneDoe",       // newline stripped
      postcode: "EX4 4QJ",
      listIds: [127],              // numeric, from BREVO_LIST_NUMBER
      source: "tightrope-tracker",
      sourceVariant: "tightrope-mp",
      mpInterest: true,
      weeklyUpdates: false,        // unchecked by default — explicit consent only
    });
  });

  it("forwards weeklyUpdates: true when the user opts in to the digest", async () => {
    const seen: { body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(SITEVERIFY)) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      seen.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response("OK", { status: 200 });
    }) as unknown as typeof fetch);
    await handleLfgSignup(
      jsonReq({ email: "x@y.com", turnstileToken: "tok", weeklyUpdates: true }),
      envWith(),
    );
    expect(seen[0]!.body).toMatchObject({ weeklyUpdates: true });
  });

  it("coerces non-boolean weeklyUpdates values to false (no truthy strings)", async () => {
    const seen: { body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(SITEVERIFY)) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      seen.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response("OK", { status: 200 });
    }) as unknown as typeof fetch);
    // String "true" must NOT count as opt-in — that would let a stale form
    // serialiser (e.g. checkbox value="true") slip past explicit consent.
    await handleLfgSignup(
      jsonReq({ email: "x@y.com", turnstileToken: "tok", weeklyUpdates: "true" }),
      envWith(),
    );
    expect(seen[0]!.body).toMatchObject({ weeklyUpdates: false });
  });

  it("coerces unknown source values to tightrope-other", async () => {
    const seen: { body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(SITEVERIFY)) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      seen.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response("OK", { status: 200 });
    }) as unknown as typeof fetch);
    await handleLfgSignup(
      jsonReq({ email: "x@y.com", turnstileToken: "tok", source: "<script>" }),
      envWith(),
    );
    expect(seen[0]!.body).toMatchObject({ sourceVariant: "tightrope-other" });
  });
});
