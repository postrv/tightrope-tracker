/**
 * Tests for `readThroughStamped` — the freshness-gated read-through used by
 * editorial endpoints (delivery, timeline) where the underlying value has
 * no natural timestamp the predicate can read.
 *
 * Pinned so a future change can't accidentally remove the gate and let a
 * stale editorial array sit in KV for the full 6h TTL — the regression
 * the audit caught.
 */
import { describe, expect, it } from "vitest";
import { readThroughStamped, EDITORIAL_FRESHNESS_MS } from "../lib/cache.js";

interface KvWrite { key: string; value: string; ttl: number | undefined }

function makeKv(initial?: { key: string; raw: string }): {
  KV: { get: (key: string, mode: "json") => Promise<unknown>; put: (key: string, val: string, opts?: { expirationTtl?: number }) => Promise<void> };
  writes: KvWrite[];
} {
  const store = new Map<string, string>();
  if (initial) store.set(initial.key, initial.raw);
  const writes: KvWrite[] = [];
  return {
    KV: {
      get: async (key: string, mode: "json") => {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return mode === "json" ? JSON.parse(raw) : raw;
      },
      put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
        store.set(key, value);
        writes.push({ key, value, ttl: opts?.expirationTtl });
      },
    },
    writes,
  };
}

describe("readThroughStamped", () => {
  it("returns the cached value when the stamp is fresh", async () => {
    const stamped = JSON.stringify({
      __cachedAt: new Date(Date.now() - 60_000).toISOString(),
      value: ["fresh"],
    });
    const { KV, writes } = makeKv({ key: "k", raw: stamped });
    const env = { KV } as unknown as Env;
    let loaderCalls = 0;
    const result = await readThroughStamped<string[]>(env, "k", async () => {
      loaderCalls++;
      return ["loaded"];
    });
    expect(result).toEqual(["fresh"]);
    expect(loaderCalls).toBe(0);
    expect(writes).toEqual([]);
  });

  it("falls through to the loader when the stamp is older than the freshness window", async () => {
    const stamped = JSON.stringify({
      __cachedAt: new Date(Date.now() - EDITORIAL_FRESHNESS_MS - 60_000).toISOString(),
      value: ["stale"],
    });
    const { KV, writes } = makeKv({ key: "k", raw: stamped });
    const env = { KV } as unknown as Env;
    let loaderCalls = 0;
    const result = await readThroughStamped<string[]>(env, "k", async () => {
      loaderCalls++;
      return ["loaded"];
    });
    expect(result).toEqual(["loaded"]);
    expect(loaderCalls).toBe(1);
    // Loader output written back, wrapped in stamp envelope.
    expect(writes.length).toBe(1);
    const envelope = JSON.parse(writes[0]!.value) as { __cachedAt: string; value: string[] };
    expect(envelope.value).toEqual(["loaded"]);
    expect(envelope.__cachedAt).toBeTruthy();
  });

  it("treats unstamped legacy cache entries as stale and refetches", async () => {
    // Pre-stamp shape — bare array. Should not be returned; the gate refetches.
    const { KV, writes } = makeKv({ key: "k", raw: JSON.stringify(["legacy"]) });
    const env = { KV } as unknown as Env;
    let loaderCalls = 0;
    const result = await readThroughStamped<string[]>(env, "k", async () => {
      loaderCalls++;
      return ["loaded"];
    });
    expect(result).toEqual(["loaded"]);
    expect(loaderCalls).toBe(1);
    expect(writes.length).toBe(1);
  });

  it("calls the loader on a cache miss", async () => {
    const { KV, writes } = makeKv();
    const env = { KV } as unknown as Env;
    const result = await readThroughStamped<string[]>(env, "k", async () => ["loaded"]);
    expect(result).toEqual(["loaded"]);
    expect(writes.length).toBe(1);
  });

  it("respects a custom maxAgeMs", async () => {
    const stamped = JSON.stringify({
      __cachedAt: new Date(Date.now() - 5_000).toISOString(),
      value: ["fresh"],
    });
    const { KV } = makeKv({ key: "k", raw: stamped });
    const env = { KV } as unknown as Env;
    // 1 second window: the 5s-old stamp is now stale.
    let loaderCalls = 0;
    const result = await readThroughStamped<string[]>(env, "k", async () => {
      loaderCalls++;
      return ["loaded"];
    }, undefined, 1_000);
    expect(result).toEqual(["loaded"]);
    expect(loaderCalls).toBe(1);
  });
});
