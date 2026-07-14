/**
 * Hard per-call ceiling on Workers AI calls (lib/ai.ts). During the
 * 2026-07-14 Workers AI degradation, hung `env.AI.run` calls never resolved:
 * each pinned a sweep pool-worker until the platform killed the isolate at
 * the cron cap, dangling the in-flight spec's audit row at 'started' and
 * budget-starving everything queued behind it. The ceiling converts a hang
 * into an ordinary retryable model-call failure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { docToMarkdown, runModelJson, runModelText } from "../lib/ai";
import type { Env } from "../env";

afterEach(() => vi.useRealTimers());

function hangingEnv(): Env {
  return {
    AI: {
      run: () => new Promise(() => undefined), // never resolves
      toMarkdown: () => new Promise(() => undefined),
    },
  } as unknown as Env;
}

const MSGS = [{ role: "user", content: "x" }];

describe("AI call timeout", () => {
  it("rejects a hung JSON-mode call with AI_TIMEOUT instead of hanging forever", async () => {
    vi.useFakeTimers();
    const p = runModelJson(hangingEnv(), "model", MSGS, { type: "object" });
    const assertion = expect(p).rejects.toThrow(/AI_TIMEOUT.*exceeded 150s/);
    await vi.advanceTimersByTimeAsync(150_001);
    await assertion;
  });

  it("rejects a hung schema-free call", async () => {
    vi.useFakeTimers();
    const p = runModelText(hangingEnv(), "model", MSGS);
    const assertion = expect(p).rejects.toThrow(/AI_TIMEOUT/);
    await vi.advanceTimersByTimeAsync(150_001);
    await assertion;
  });

  it("rejects a hung toMarkdown conversion", async () => {
    vi.useFakeTimers();
    const p = docToMarkdown(hangingEnv(), "doc.xlsx", new ArrayBuffer(4), "application/vnd.ms-excel");
    const assertion = expect(p).rejects.toThrow(/AI_TIMEOUT.*toMarkdown/);
    await vi.advanceTimersByTimeAsync(150_001);
    await assertion;
  });

  it("a fast call resolves normally and clears its timer", async () => {
    const env = {
      AI: { run: async () => ({ response: "ok" }) },
    } as unknown as Env;
    await expect(runModelText(env, "model", MSGS)).resolves.toBe("ok");
  });
});
