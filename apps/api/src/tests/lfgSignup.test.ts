/**
 * Tests for POST /api/v1/lfg-signup.
 *
 * The handler talks to up to three external services — Turnstile siteverify,
 * Brevo `/v3/contacts` (primary), and a Zapier webhook (fallback) — and we
 * want every branch and switching rule to be pinned. We mock global fetch
 * with a URL-dispatching stub so each test can shape the upstream response
 * explicitly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleLfgSignup } from "../handlers/lfgSignup.js";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const BREVO = "https://api.brevo.com/v3/contacts";
const ZAPIER = "https://hooks.zapier.com/hooks/catch/12345/abc/";

interface FetchStub {
  siteverify: { ok: boolean; success?: boolean; errorCodes?: string[]; status?: number };
  upstream: { ok: boolean; status?: number; bodyJson?: unknown };
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
    if (url.startsWith(BREVO) || url.startsWith(ZAPIER) || url.startsWith("https://hooks.zapier.com/")) {
      const u = behaviour.upstream;
      const status = u.status ?? (u.ok ? 200 : 502);
      // 204 (No Content) MUST NOT have a body per HTTP spec; the Response
      // constructor throws if you try. Brevo returns 204 on contact-updated.
      const body = status === 204
        ? null
        : u.bodyJson !== undefined ? JSON.stringify(u.bodyJson) : (u.ok ? "OK" : "fail");
      return new Response(body, {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected url", { status: 599 });
  }) as unknown as typeof fetch;
}

/** Env defaulting to Brevo-primary (LFG_API_KEY set). */
function envWith(overrides: Partial<Env> = {}): Env {
  return {
    TURNSTILE_SECRET_KEY: "test-secret",
    LFG_SIGNUP_API_URL: ZAPIER,
    BREVO_LIST_NUMBER: "127",
    LFG_API_KEY: "xkeysib-test-key",
    ...overrides,
  } as unknown as Env;
}

/** Env with Brevo key cleared — exercises the Zapier fallback path. */
function envZapierOnly(overrides: Partial<Env> = {}): Env {
  return envWith({ LFG_API_KEY: "", ...overrides } as Partial<Env>);
}

function jsonReq(body: unknown, ip = "203.0.113.1"): Request {
  return new Request("https://api.tightropetracker.uk/api/v1/lfg-signup", {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-connecting-ip": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Capture every outbound fetch the handler makes for shape assertions. */
function captureFetch(behaviour: FetchStub): { stub: typeof fetch; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    if (url.startsWith(SITEVERIFY)) {
      const sv = behaviour.siteverify;
      if (!sv.ok) return new Response("nope", { status: sv.status ?? 502 });
      return new Response(JSON.stringify({ success: sv.success ?? true }), { status: 200 });
    }
    const u = behaviour.upstream;
    const body = u.bodyJson !== undefined ? JSON.stringify(u.bodyJson) : (u.ok ? "OK" : "fail");
    return new Response(body, { status: u.status ?? (u.ok ? 200 : 502) });
  }) as unknown as typeof fetch;
  return { stub, calls };
}

describe("POST /api/v1/lfg-signup — common validation", () => {
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

  it("returns 502 UPSTREAM_ERROR when no backend is configured", async () => {
    const res = await handleLfgSignup(
      jsonReq({ email: "jane@example.com", turnstileToken: "tok" }),
      envWith({ LFG_API_KEY: "", LFG_SIGNUP_API_URL: "" } as Partial<Env>),
    );
    expect(res.status).toBe(502);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});

describe("POST /api/v1/lfg-signup — Brevo direct path", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hits api.brevo.com when LFG_API_KEY is set (Brevo wins over Zapier URL)", async () => {
    const { stub, calls } = captureFetch({ siteverify: { ok: true, success: true }, upstream: { ok: true, status: 201 } });
    vi.stubGlobal("fetch", stub);
    await handleLfgSignup(
      jsonReq({ email: "jane@example.com", turnstileToken: "tok" }),
      envWith(), // Brevo + Zapier both configured
    );
    const upstream = calls.find((c) => c.url.startsWith("https://api.brevo.com"));
    const zapier = calls.find((c) => c.url.startsWith("https://hooks.zapier.com"));
    expect(upstream).toBeDefined();
    expect(zapier).toBeUndefined();
  });

  it("sends api-key header + JSON content-type to Brevo", async () => {
    const { stub, calls } = captureFetch({ siteverify: { ok: true, success: true }, upstream: { ok: true, status: 201 } });
    vi.stubGlobal("fetch", stub);
    await handleLfgSignup(
      jsonReq({ email: "jane@example.com", turnstileToken: "tok" }),
      envWith({ LFG_API_KEY: "xkeysib-secret" } as Partial<Env>),
    );
    const brevo = calls.find((c) => c.url === "https://api.brevo.com/v3/contacts")!;
    const headers = new Headers(brevo.init?.headers ?? {});
    expect(headers.get("api-key")).toBe("xkeysib-secret");
    expect(headers.get("content-type")).toMatch(/application\/json/);
  });

  it("forwards the right body shape to Brevo", async () => {
    const { stub, calls } = captureFetch({ siteverify: { ok: true, success: true }, upstream: { ok: true, status: 201 } });
    vi.stubGlobal("fetch", stub);
    await handleLfgSignup(
      jsonReq({
        email: " Jane@Example.COM ",
        firstName: "Jane\nDoe",
        postcode: "EX4 4QJ",
        source: "tightrope-mp",
        mpInterest: true,
        weeklyUpdates: true,
        turnstileToken: "tok",
      }),
      envWith(),
    );
    const brevo = calls.find((c) => c.url === "https://api.brevo.com/v3/contacts")!;
    const body = JSON.parse(String(brevo.init!.body!));
    expect(body).toMatchObject({
      email: "jane@example.com",      // lowercased + trimmed
      attributes: {
        FIRSTNAME: "JaneDoe",         // newline stripped
        POSTCODE: "EX4 4QJ",
        SOURCE: "tightrope-mp",
        MP_INTEREST: true,
        WEEKLY_DIGEST: true,
      },
      listIds: [127],                  // numeric, from BREVO_LIST_NUMBER
      updateEnabled: true,
      emailBlacklisted: false,
      smsBlacklisted: false,
    });
  });

  it("omits empty optional attributes so an existing Brevo contact's values aren't clobbered", async () => {
    const { stub, calls } = captureFetch({ siteverify: { ok: true, success: true }, upstream: { ok: true, status: 201 } });
    vi.stubGlobal("fetch", stub);
    await handleLfgSignup(
      jsonReq({ email: "jane@example.com", turnstileToken: "tok" }),
      envWith(),
    );
    const brevo = calls.find((c) => c.url === "https://api.brevo.com/v3/contacts")!;
    const body = JSON.parse(String(brevo.init!.body!));
    expect(body.attributes).not.toHaveProperty("FIRSTNAME");
    expect(body.attributes).not.toHaveProperty("POSTCODE");
    // SOURCE / MP_INTEREST / WEEKLY_DIGEST are always present (always-defined values).
    expect(body.attributes).toHaveProperty("SOURCE");
    expect(body.attributes).toHaveProperty("MP_INTEREST");
    expect(body.attributes).toHaveProperty("WEEKLY_DIGEST");
  });

  it("returns 200 ok on Brevo 204 (existing contact updated)", async () => {
    vi.stubGlobal("fetch", stubFetch({ siteverify: { ok: true, success: true }, upstream: { ok: true, status: 204 } }));
    const res = await handleLfgSignup(
      jsonReq({ email: "jane@example.com", turnstileToken: "tok" }),
      envWith(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 502 UPSTREAM_ERROR when Brevo returns 401 (bad api-key)", async () => {
    vi.stubGlobal("fetch", stubFetch({
      siteverify: { ok: true, success: true },
      upstream: { ok: false, status: 401, bodyJson: { code: "unauthorized", message: "Key not found" } },
    }));
    const res = await handleLfgSignup(
      jsonReq({ email: "jane@example.com", turnstileToken: "tok" }),
      envWith(),
    );
    expect(res.status).toBe(502);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("returns 502 UPSTREAM_ERROR when Brevo returns 400 (e.g. invalid list)", async () => {
    vi.stubGlobal("fetch", stubFetch({
      siteverify: { ok: true, success: true },
      upstream: { ok: false, status: 400, bodyJson: { code: "invalid_parameter", message: "List 0 not found" } },
    }));
    const res = await handleLfgSignup(
      jsonReq({ email: "jane@example.com", turnstileToken: "tok" }),
      envWith(),
    );
    expect(res.status).toBe(502);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});

describe("POST /api/v1/lfg-signup — Zapier fallback path", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hits Zapier when LFG_API_KEY is unset and LFG_SIGNUP_API_URL is set", async () => {
    const { stub, calls } = captureFetch({ siteverify: { ok: true, success: true }, upstream: { ok: true } });
    vi.stubGlobal("fetch", stub);
    await handleLfgSignup(
      jsonReq({ email: "jane@example.com", turnstileToken: "tok" }),
      envZapierOnly(),
    );
    const upstream = calls.find((c) => c.url.startsWith("https://hooks.zapier.com"));
    const brevo = calls.find((c) => c.url.startsWith("https://api.brevo.com"));
    expect(upstream).toBeDefined();
    expect(brevo).toBeUndefined();
  });

  it("forwards the youcanjustdostuff-shaped payload to Zapier", async () => {
    const { stub, calls } = captureFetch({ siteverify: { ok: true, success: true }, upstream: { ok: true } });
    vi.stubGlobal("fetch", stub);
    await handleLfgSignup(
      jsonReq({
        email: "jane@example.com",
        firstName: "Jane",
        postcode: "EX4 4QJ",
        source: "tightrope-mp",
        weeklyUpdates: true,
        turnstileToken: "tok",
      }),
      envZapierOnly(),
    );
    const zapier = calls.find((c) => c.url.startsWith("https://hooks.zapier.com"))!;
    const body = JSON.parse(String(zapier.init!.body!));
    expect(body).toMatchObject({
      firstName: "Jane",
      lastName: "",
      email: "jane@example.com",
      phoneNumber: "",
      postcode: "EX4 4QJ",
      bio: "",
      listIds: [127],
      source: "tightrope-tracker",
      sourceVariant: "tightrope-mp",
      weeklyUpdates: true,
    });
  });

  it("rejects non-https LFG_SIGNUP_API_URL (SSRF defence)", async () => {
    vi.stubGlobal("fetch", stubFetch({ siteverify: { ok: true, success: true }, upstream: { ok: true } }));
    const res = await handleLfgSignup(
      jsonReq({ email: "jane@example.com", turnstileToken: "tok" }),
      envZapierOnly({ LFG_SIGNUP_API_URL: "http://evil.example.com/" } as Partial<Env>),
    );
    expect(res.status).toBe(502);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("returns 502 UPSTREAM_ERROR when Zapier returns non-2xx (e.g. 404 dead hook)", async () => {
    vi.stubGlobal("fetch", stubFetch({
      siteverify: { ok: true, success: true },
      upstream: { ok: false, status: 404 },
    }));
    const res = await handleLfgSignup(
      jsonReq({ email: "jane@example.com", turnstileToken: "tok" }),
      envZapierOnly(),
    );
    expect(res.status).toBe(502);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("coerces non-boolean weeklyUpdates values to false (no truthy strings)", async () => {
    const { stub, calls } = captureFetch({ siteverify: { ok: true, success: true }, upstream: { ok: true } });
    vi.stubGlobal("fetch", stub);
    await handleLfgSignup(
      jsonReq({ email: "x@y.com", turnstileToken: "tok", weeklyUpdates: "true" }),
      envZapierOnly(),
    );
    const zapier = calls.find((c) => c.url.startsWith("https://hooks.zapier.com"))!;
    const body = JSON.parse(String(zapier.init!.body!));
    expect(body.weeklyUpdates).toBe(false);
  });
});
