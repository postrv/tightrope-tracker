import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../env.js";
import type { ScoreSnapshot } from "@tightrope/shared";

// Mock the pipeline stages so dispatchCron's control flow can be exercised
// without a real D1/upstream. recomputeScores is the one we drive per-test.
const { recomputeMock, ingestMarketMock, todayMock } = vi.hoisted(() => ({
  recomputeMock: vi.fn(),
  ingestMarketMock: vi.fn(async () => undefined),
  todayMock: vi.fn(async () => undefined),
}));
vi.mock("../pipelines/recompute.js", () => ({ recomputeScores: recomputeMock }));
vi.mock("../pipelines/market.js", () => ({ ingestMarket: ingestMarketMock }));
vi.mock("../pipelines/todayMovements.js", () => ({ updateTodayMovements: todayMock }));

const { dispatchCron } = await import("../index.js");

const FAKE_SNAPSHOT = { headline: { value: 50 } } as unknown as ScoreSnapshot;

function makeCtx(): { ctx: ExecutionContext; settle: () => Promise<unknown[]> } {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => tasks.push(p),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.all(tasks) };
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response("ok"));
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  recomputeMock.mockReset();
  ingestMarketMock.mockClear();
  todayMock.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("dead-man heartbeat", () => {
  it("fires at the end of a fully-successful recompute", async () => {
    recomputeMock.mockResolvedValue(FAKE_SNAPSHOT);
    const env = { HEARTBEAT_URL: "https://hc.test/ping" } as unknown as Env;
    const { ctx, settle } = makeCtx();

    await dispatchCron("*/5 * * * *", env, ctx);
    await settle();

    const heartbeatCalls = fetchSpy.mock.calls.filter((c) => c[0] === "https://hc.test/ping");
    expect(heartbeatCalls).toHaveLength(1);
    expect((heartbeatCalls[0]![1] as RequestInit).method).toBe("GET");
  });

  it("does NOT fire when recompute skips (returns null)", async () => {
    recomputeMock.mockResolvedValue(null);
    const env = { HEARTBEAT_URL: "https://hc.test/ping" } as unknown as Env;
    const { ctx, settle } = makeCtx();

    await dispatchCron("*/5 * * * *", env, ctx);
    await settle();

    expect(fetchSpy.mock.calls.some((c) => c[0] === "https://hc.test/ping")).toBe(false);
  });

  it("does NOT fire when recompute throws (runStage swallows to null)", async () => {
    recomputeMock.mockRejectedValue(new Error("recompute boom"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = { HEARTBEAT_URL: "https://hc.test/ping" } as unknown as Env;
    const { ctx, settle } = makeCtx();

    await dispatchCron("*/5 * * * *", env, ctx);
    await settle();

    expect(fetchSpy.mock.calls.some((c) => c[0] === "https://hc.test/ping")).toBe(false);
  });

  it("is a no-op when HEARTBEAT_URL is unset even on success", async () => {
    recomputeMock.mockResolvedValue(FAKE_SNAPSHOT);
    const env = {} as unknown as Env;
    const { ctx, settle } = makeCtx();

    await dispatchCron("*/5 * * * *", env, ctx);
    await settle();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// --- cron_miss alerting ----------------------------------------------------

interface RecordedInsert { sql: string; bindings: readonly unknown[] }

function makeCronMissEnv(opts: { webhook?: string; kv?: Map<string, string> } = {}): {
  env: Env;
  inserts: RecordedInsert[];
  kv: Map<string, string>;
} {
  const inserts: RecordedInsert[] = [];
  const kv = opts.kv ?? new Map<string, string>();
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...bindings: unknown[]) => ({
          run: async () => { inserts.push({ sql, bindings }); return { success: true }; },
        }),
      }),
    },
    KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => { kv.set(k, v); },
    },
    ALERT_WEBHOOK_URL: opts.webhook,
  } as unknown as Env;
  return { env, inserts, kv };
}

describe("cron_miss alerting", () => {
  it("writes the audit row AND pages the webhook, then records the dedupe mark", async () => {
    const { env, inserts, kv } = makeCronMissEnv({ webhook: "https://hooks.test/x" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await dispatchCron("99 99 99 99 99", env);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.sql).toContain("cron_miss");
    // Webhook posted with the offending pattern.
    const webhookCalls = fetchSpy.mock.calls.filter((c) => c[0] === "https://hooks.test/x");
    expect(webhookCalls).toHaveLength(1);
    const body = JSON.parse((webhookCalls[0]![1] as RequestInit).body as string);
    expect(body.text).toContain("99 99 99 99 99");
    // Dedupe mark stored.
    expect(kv.get("alert:cron_miss:99 99 99 99 99")).toBeTruthy();
  });

  it("does not re-page a cron_miss already alerted this window", async () => {
    const kv = new Map<string, string>([["alert:cron_miss:99 99 99 99 99", "2026-07-03T00:00:00Z"]]);
    const { env } = makeCronMissEnv({ webhook: "https://hooks.test/x", kv });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await dispatchCron("99 99 99 99 99", env);

    expect(fetchSpy.mock.calls.some((c) => c[0] === "https://hooks.test/x")).toBe(false);
  });
});
