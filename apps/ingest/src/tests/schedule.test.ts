import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CRON_BRANCHES, dispatchCron, isKnownCron } from "../index.js";
import type { Env } from "../env.js";

const here = dirname(fileURLToPath(import.meta.url));
const WRANGLER_PATH = join(here, "..", "..", "wrangler.toml");

/** Tiny targeted parser: we only need the schedule entries off `[triggers].crons`. */
function readWranglerSchedules(): string[] {
  const toml = readFileSync(WRANGLER_PATH, "utf8");
  const triggersHeader = toml.indexOf("[triggers]");
  if (triggersHeader === -1) throw new Error("[triggers] block missing in wrangler.toml");
  const after = toml.slice(triggersHeader);
  const listStart = after.indexOf("[", after.indexOf("crons"));
  const listEnd = after.indexOf("]", listStart);
  if (listStart === -1 || listEnd === -1) throw new Error("crons = [...] list not found");
  const listBody = after.slice(listStart + 1, listEnd);
  // Strip `# ...` comments on every line, then match every quoted scalar.
  const decommented = listBody.replace(/#[^\n]*/g, "");
  const matches = [...decommented.matchAll(/"([^"]+)"/g)];
  if (matches.length === 0) throw new Error("no schedule entries found in crons list");
  return matches.map((m) => m[1]!);
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

describe("scheduled dispatch", () => {
  it("CRON_BRANCHES mirrors wrangler.toml exactly", () => {
    const fromToml = new Set(readWranglerSchedules());
    const fromCode = new Set(Object.keys(CRON_BRANCHES));
    expect(fromCode).toEqual(fromToml);
  });

  it("isKnownCron returns true for declared patterns", () => {
    for (const c of Object.keys(CRON_BRANCHES)) {
      expect(isKnownCron(c)).toBe(true);
    }
  });

  it("isKnownCron returns false for undeclared patterns", () => {
    expect(isKnownCron("1 1 1 1 1")).toBe(false);
    expect(isKnownCron("")).toBe(false);
  });

  it("records a cron_miss audit row for an undeclared pattern", async () => {
    const { env, inserts } = makeRecordingEnv();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await dispatchCron("99 99 99 99 99", env);
    errSpy.mockRestore();

    expect(inserts.length).toBe(1);
    expect(inserts[0]!.sql).toContain("ingestion_audit");
    const matched = inserts[0]!.bindings.some((v) => typeof v === "string" && v.includes("99 99 99 99 99"));
    expect(matched).toBe(true);
  });
});
