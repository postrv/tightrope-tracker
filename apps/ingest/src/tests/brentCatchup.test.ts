import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";

const { backfillMock } = vi.hoisted(() => ({ backfillMock: vi.fn() }));
vi.mock("../pipelines/backfillObservations.js", () => ({ backfillObservations: backfillMock }));

const { backfillRecentBrent } = await import("../pipelines/brentCatchup.js");

describe("daily Brent catch-up", () => {
  it("fetches the previous 14 UTC days without overwriting observations", async () => {
    const env = {} as Env;
    backfillMock.mockResolvedValueOnce({ rowsWritten: 0 });

    await backfillRecentBrent(env, new Date("2026-10-13T02:00:00Z"));

    expect(backfillMock).toHaveBeenCalledTimes(1);
    const [passedEnv, adapter, opts] = backfillMock.mock.calls[0]!;
    expect(passedEnv).toBe(env);
    expect(adapter.id).toBe("eia_brent");
    expect(opts).toEqual({
      from: new Date("2026-09-29T00:00:00.000Z"),
      to: new Date("2026-10-12T23:59:59.999Z"),
      dryRun: false,
      overwrite: false,
    });
  });
});
