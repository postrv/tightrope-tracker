import { describe, expect, it } from "vitest";
import { ogCacheKey } from "./cacheKey.js";

describe("ogCacheKey", () => {
  it("strips arbitrary query strings so cache-buster floods cannot create distinct keys", () => {
    const a = ogCacheKey(new Request("https://og.tightropetracker.uk/og/headline-score.png?nonce=1"));
    const b = ogCacheKey(new Request("https://og.tightropetracker.uk/og/headline-score.png?nonce=2"));
    const c = ogCacheKey(new Request("https://og.tightropetracker.uk/og/headline-score.png"));
    expect(a.url).toBe(c.url);
    expect(b.url).toBe(c.url);
    expect(new URL(a.url).search).toBe("");
  });

  it("preserves the pathname (different cards remain distinct cache entries)", () => {
    const a = ogCacheKey(new Request("https://og.tightropetracker.uk/og/headline-score.png?x=1"));
    const b = ogCacheKey(new Request("https://og.tightropetracker.uk/og/fiscal-headroom.png?x=1"));
    expect(new URL(a.url).pathname).toBe("/og/headline-score.png");
    expect(new URL(b.url).pathname).toBe("/og/fiscal-headroom.png");
    expect(a.url).not.toBe(b.url);
  });

  it("returns a GET request even if the original was HEAD (Cache API requires GET)", () => {
    const head = new Request("https://og.tightropetracker.uk/og/headline-score.png", { method: "HEAD" });
    const key = ogCacheKey(head);
    expect(key.method).toBe("GET");
  });

  it("does not carry headers from the source request (key independence from incoming headers)", () => {
    const req = new Request("https://og.tightropetracker.uk/og/headline-score.png", {
      headers: { "Cookie": "session=abc", "Authorization": "Bearer xyz" },
    });
    const key = ogCacheKey(req);
    expect(key.headers.get("Cookie")).toBe(null);
    expect(key.headers.get("Authorization")).toBe(null);
  });
});
