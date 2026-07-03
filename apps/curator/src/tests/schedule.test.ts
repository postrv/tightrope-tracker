import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CRON_BRANCHES, dispatchCron, jobForCron } from "../index";
import { makeEnv, makeFakeDb, makeKv } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const WRANGLER_PATH = join(here, "..", "..", "wrangler.toml");

/** Same targeted parser the ingest schedule test uses: pull the [triggers].crons list. */
function readWranglerSchedules(): string[] {
  const toml = readFileSync(WRANGLER_PATH, "utf8");
  const triggersHeader = toml.indexOf("[triggers]");
  if (triggersHeader === -1) throw new Error("[triggers] block missing in wrangler.toml");
  const after = toml.slice(triggersHeader);
  const listStart = after.indexOf("[", after.indexOf("crons"));
  const listEnd = after.indexOf("]", listStart);
  const listBody = after.slice(listStart + 1, listEnd);
  const decommented = listBody.replace(/#[^\n]*/g, "");
  const matches = [...decommented.matchAll(/"([^"]+)"/g)];
  if (matches.length === 0) throw new Error("no schedule entries found in crons list");
  return matches.map((m) => m[1]!);
}

describe("curator scheduled dispatch", () => {
  it("CRON_BRANCHES mirrors wrangler.toml exactly", () => {
    expect(new Set(Object.keys(CRON_BRANCHES))).toEqual(new Set(readWranglerSchedules()));
  });

  it("jobForCron resolves declared patterns and rejects undeclared ones", () => {
    expect(jobForCron("0 5 * * 2")).toBe("sweep");
    expect(jobForCron("0 6 * * *")).toBe("poll");
    expect(jobForCron("0 7 * * *")).toBe("staleness");
    expect(jobForCron("99 99 99 99 99")).toBeUndefined();
  });

  it("records a cron_miss audit row for an undeclared pattern", async () => {
    const db = makeFakeDb();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await dispatchCron("99 99 99 99 99", makeEnv({ db, kv: makeKv().kv }));
    errSpy.mockRestore();
    const missRow = db.audit.find((a) => String(a.sql).includes("cron_miss"));
    expect(missRow).toBeDefined();
    expect(JSON.stringify(missRow!.bindings)).toContain("99 99 99 99 99");
  });

  it("SEC-14: strips control chars from the cron string in the cron-miss alert text", async () => {
    const posts: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      posts.push(JSON.parse(init.body).text as string);
      return new Response("ok");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = makeFakeDb();
    const env = makeEnv({ db, kv: makeKv().kv, extra: { ALERT_WEBHOOK_URL: "https://hook.test" } });
    // A cron carrying CR + an ANSI escape — a log/webhook injection vector.
    // (The alert body legitimately uses "\n" to separate its own lines, so we
    // assert on CR and ESC, which the message format never emits structurally.)
    await dispatchCron("0 5 * *\r\x1b[31mfake", env);
    errSpy.mockRestore();
    expect(posts).toHaveLength(1);
    expect(posts[0]!).not.toContain("\r"); // carriage-return stripped
    expect(posts[0]!).not.toContain("\x1b"); // ANSI escape stripped
    expect(posts[0]!).toContain("�"); // replaced with U+FFFD, proving sanitisation ran
  });
});

afterEach(() => vi.unstubAllGlobals());
