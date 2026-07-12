import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSource, htmlToText } from "../pipeline/capture";
import { sha256HexBytes } from "../lib/hash";
import { makeEnv, makeFakeDb, observationSpec, type FakeCaptureRow } from "./helpers";

const HTML = "<html><head><style>.x{color:red}</style></head><body><p>The UK Services PMI registered 48.8 in June 2026.</p><script>evil()</script></body></html>";

function stubFetch(body = HTML) {
  vi.stubGlobal("fetch", async () => new Response(body, { status: 200 }));
}

function captureRow(over: Partial<FakeCaptureRow>): FakeCaptureRow {
  return {
    id: 1,
    source_id: "sp_global_pmi",
    indicator_id: "services_pmi",
    kind: "observation",
    captured_at: "2026-06-01T00:00:00Z",
    source_url: "https://example.test/pmi",
    content_sha256: "seed",
    raw_r2_key: null,
    observed_at: null,
    released_at: null,
    value: null,
    payload: null,
    quote: null,
    confidence: null,
    verification: null,
    status: "auto_published",
    decided_by: "auto",
    decided_at: null,
    published_observation_key: null,
    model_id: null,
    prompt_version: "v1",
    created_at: "2026-06-01T00:00:00Z",
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("capture — fetch, hash, dedupe, archive", () => {
  it("returns an artefact with a byte sha, archive key, and stripped text on first capture", async () => {
    stubFetch();
    const puts: Array<{ key: string }> = [];
    const env = makeEnv({ db: makeFakeDb(), extra: { ARCHIVE: { put: async (key: string) => void puts.push({ key }) } as never } });
    const res = await captureSource(env, observationSpec(), { force: false });
    expect(res).not.toBe("unchanged");
    if (res === "unchanged") throw new Error("unreachable");
    expect(res.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.rawR2Key).toMatch(/^curator\/sp_global_pmi\/\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.html$/);
    expect(res.text).toContain("The UK Services PMI registered 48.8 in June 2026.");
    expect(res.text).not.toContain("evil()"); // script stripped
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe(res.rawR2Key);
  });

  it("short-circuits to 'unchanged' when the hash matches the source's latest capture", async () => {
    stubFetch();
    const sha = await sha256HexBytes(new TextEncoder().encode(HTML));
    const db = makeFakeDb({ captures: [captureRow({ content_sha256: sha })] });
    const res = await captureSource(makeEnv({ db }), observationSpec(), { force: false });
    expect(res).toBe("unchanged");
  });

  it("force=true re-captures even when the hash is unchanged", async () => {
    stubFetch();
    const sha = await sha256HexBytes(new TextEncoder().encode(HTML));
    const db = makeFakeDb({ captures: [captureRow({ content_sha256: sha })] });
    const res = await captureSource(makeEnv({ db }), observationSpec(), { force: true });
    expect(res).not.toBe("unchanged");
  });

  it("anchored lines from a LATER section survive the combined multi-URL truncation", async () => {
    // Regression for the 2026-07-12 combiner bug: per-section truncation
    // carried spec.anchorTerms, but the final combined truncation didn't —
    // two ~20k sections squeezed head-first into one 20k budget dropped the
    // second section's headline sentences entirely (mhclg_housing's planning
    // figures never reached the model on any attempt).
    const filler = Array.from({ length: 1400 }, (_, i) => `<p>Row ${i}: statistic ${i * 3} of table for 2026 values.</p>`).join("");
    const sectionA = `<html><body>${filler}</body></html>`;
    const sectionB = `<html><body><p>Authorities granted 6,700 residential applications in the quarter of 2026.</p>${filler}</body></html>`;
    const bodies = new Map([
      ["https://example.test/a", sectionA],
      ["https://example.test/b", sectionB],
    ]);
    vi.stubGlobal("fetch", async (url: string) => new Response(bodies.get(String(url)) ?? "", { status: 200 }));
    const spec = observationSpec({
      urls: ["https://example.test/a", "https://example.test/b"],
      anchorTerms: ["residential applications", "granted"],
    });
    const env = makeEnv({ db: makeFakeDb() });
    const res = await captureSource(env, spec, { force: true });
    if (res === "unchanged") throw new Error("unreachable");
    // Both sections are ~20k+ of digit-dense filler; without anchors on the
    // combined pass the section-B headline is crowded out by section A.
    expect(res.text).toContain("granted 6,700 residential applications");
  });
});

describe("htmlToText", () => {
  it("drops script/style, collapses whitespace, decodes entities", () => {
    const out = htmlToText("<p>Headroom is &pound;9.9bn &mdash; the&nbsp;lowest.</p><script>x</script>");
    expect(out).toContain("Headroom is £9.9bn — the lowest.");
    expect(out).not.toContain("script");
  });

  it("turns block boundaries into newlines so sentences don't glue together", () => {
    const out = htmlToText("<li>First point</li><li>Second point</li>");
    expect(out.split("\n")).toEqual(["First point", "Second point"]);
  });

  it("decodes numeric character references", () => {
    expect(htmlToText("<p>2.34&#37; failure</p>")).toContain("2.34% failure");
  });
});
