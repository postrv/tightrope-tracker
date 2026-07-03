import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEditorialDigest } from "../pipeline/digest";
import { DEFAULT_CURATOR_PUBLIC_URL } from "../env";
import { makeEnv, makeFakeDb, makeKv, type FakeCaptureRow } from "./helpers";

/**
 * The editorial digest emits ready-to-paste approve/reject curls for every
 * pending capture. Those must target CURATOR_PUBLIC_URL so preview/local
 * digests point at the right host (6a) and never hardcode the production
 * custom domain.
 */
function pendingRow(over: Partial<FakeCaptureRow> = {}): FakeCaptureRow {
  return {
    id: 7,
    source_id: "sp_global_pmi",
    indicator_id: "services_pmi",
    kind: "observation",
    captured_at: "2026-07-01T05:00:00Z",
    source_url: "https://example.test/pmi",
    content_sha256: "hash-1",
    raw_r2_key: null,
    observed_at: "2026-06-30",
    released_at: null,
    value: 48.8,
    payload: null,
    quote: null,
    confidence: 0.9,
    verification: null,
    status: "pending",
    decided_by: null,
    decided_at: null,
    published_observation_key: null,
    model_id: null,
    prompt_version: "v1",
    created_at: "2026-07-01T05:00:00Z",
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

async function runDigest(extra: Record<string, unknown>): Promise<string> {
  let posted = "";
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    posted = (JSON.parse(init.body) as { text: string }).text;
    return new Response("ok");
  });
  const db = makeFakeDb({ captures: [pendingRow()] });
  const env = makeEnv({ db, kv: makeKv().kv, extra: { ALERT_WEBHOOK_URL: "https://hook.test", ...extra } });
  await sendEditorialDigest(env, new Date("2026-07-03T06:30:00Z"));
  return posted;
}

describe("editorial digest — approve/reject curls target CURATOR_PUBLIC_URL", () => {
  it("uses CURATOR_PUBLIC_URL when set (preview/local host)", async () => {
    const text = await runDigest({ CURATOR_PUBLIC_URL: "https://curator-preview.example.test" });
    expect(text).toContain("https://curator-preview.example.test/admin/captures/7/approve");
    expect(text).toContain("https://curator-preview.example.test/admin/captures/7/reject");
    expect(text).not.toContain(DEFAULT_CURATOR_PUBLIC_URL);
  });

  it("falls back to the production custom domain when the var is unset", async () => {
    const text = await runDigest({});
    expect(text).toContain(DEFAULT_CURATOR_PUBLIC_URL + "/admin/captures/7/approve");
  });

  it("strips a trailing slash on the configured base URL", async () => {
    const text = await runDigest({ CURATOR_PUBLIC_URL: "https://curator.example.test/" });
    expect(text).toContain("https://curator.example.test/admin/captures/7/approve");
    expect(text).not.toContain("example.test//admin");
  });
});
