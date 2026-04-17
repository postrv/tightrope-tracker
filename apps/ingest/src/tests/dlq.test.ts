import { describe, expect, it, vi } from "vitest";
import type { Message, MessageBatch } from "@cloudflare/workers-types";
import { handleDlqBatch } from "../index.js";
import type { Env } from "../env.js";
import type { DlqPayload } from "../types.js";

function makeMessage(id: string, body: DlqPayload): Message<DlqPayload> {
  return {
    id,
    timestamp: new Date(),
    body,
    attempts: 3,
    ack: () => undefined,
    retry: () => undefined,
  } as unknown as Message<DlqPayload>;
}

function makeBatch(messages: Message<DlqPayload>[]): MessageBatch<DlqPayload> {
  return {
    messages,
    queue: "tightrope-ingest-dlq",
    metadata: {} as unknown,
    ackAll: () => undefined,
    retryAll: () => undefined,
  } as unknown as MessageBatch<DlqPayload>;
}

interface RecordedInsert {
  sql: string;
  bindings: readonly unknown[];
}

function makeRecordingEnv(): { env: Env; inserts: RecordedInsert[] } {
  const inserts: RecordedInsert[] = [];
  const env: Env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...bindings: unknown[]) => ({
          run: async () => {
            inserts.push({ sql, bindings });
            return { success: true };
          },
        }),
      }),
    },
  } as unknown as Env;
  return { env, inserts };
}

describe("handleDlqBatch", () => {
  it("logs each failed message and calls ackAll", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ackAll = vi.fn();
    const batch = {
      ...makeBatch([makeMessage("m-1", { sourceId: "boe_yields", reason: "fetch_timeout", message: "upstream 504" })]),
      ackAll,
    } as unknown as MessageBatch<DlqPayload>;
    const { env } = makeRecordingEnv();
    await handleDlqBatch(batch, env);
    expect(errSpy).toHaveBeenCalled();
    expect(ackAll).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it("writes a dlq-status audit row per message", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { env, inserts } = makeRecordingEnv();
    const batch = makeBatch([
      makeMessage("m-1", { sourceId: "boe_yields", reason: "fetch_timeout" }),
      makeMessage("m-2", { sourceId: "ons_lms", reason: "parse_error", sourceUrl: "https://example.test" }),
    ]);
    await handleDlqBatch(batch, env);
    errSpy.mockRestore();

    expect(inserts.length).toBe(2);
    for (const i of inserts) {
      expect(i.sql).toContain("ingestion_audit");
      expect(i.bindings.some((v) => v === "boe_yields" || v === "ons_lms")).toBe(true);
    }
  });

  it("acks the batch even when the audit write fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ackAll = vi.fn();
    const env: Env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => {
              throw new Error("D1 unavailable");
            },
          }),
        }),
      },
    } as unknown as Env;
    const batch = {
      ...makeBatch([makeMessage("m-1", { sourceId: "boe_yields", reason: "fetch_timeout" })]),
      ackAll,
    } as unknown as MessageBatch<DlqPayload>;
    await handleDlqBatch(batch, env);
    expect(ackAll).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it("does not include secret-shaped fields in log output", async () => {
    const messages: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      messages.push(a.map(String).join(" "));
    });
    const { env } = makeRecordingEnv();
    // Payload deliberately includes a fake secret-like field; handler must not log the whole body.
    const batch = makeBatch([
      makeMessage("m-1", { sourceId: "boe_yields", reason: "fetch_timeout", message: "upstream 504", detail: { token: "sk_fake_AAAA" } }),
    ]);
    await handleDlqBatch(batch, env);
    errSpy.mockRestore();
    expect(messages.some((m) => m.includes("sk_fake_AAAA"))).toBe(false);
  });
});
