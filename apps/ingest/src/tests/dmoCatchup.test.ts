import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";

const { adapterMock, recomputeMock, todayMock } = vi.hoisted(() => ({
  adapterMock: vi.fn(), recomputeMock: vi.fn(), todayMock: vi.fn(),
}));
vi.mock("../pipelines/runAdapter.js", () => ({ runAdapterSafe: adapterMock }));
vi.mock("../pipelines/recompute.js", () => ({ recomputeScores: recomputeMock }));
vi.mock("../pipelines/todayMovements.js", () => ({ updateTodayMovements: todayMock }));

const { dispatchCron } = await import("../index.js");

beforeEach(() => {
  adapterMock.mockReset(); recomputeMock.mockReset(); todayMock.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("weekday DMO publication catchup", () => {
  it("fetches only DMO, then recomputes without any equity or Brent calls", async () => {
    const order: string[] = [];
    adapterMock.mockImplementationOnce(async (_env, adapter) => { order.push(adapter.id); });
    recomputeMock.mockImplementationOnce(async () => { order.push("recompute"); return null; });
    const env = {} as Env;

    await dispatchCron("45 9,15 * * MON-FRI", env);

    expect(order).toEqual(["dmo", "recompute"]);
    expect(adapterMock).toHaveBeenCalledTimes(1);
    expect(adapterMock.mock.calls[0]![0]).toBe(env);
    expect(todayMock).not.toHaveBeenCalled();
  });

  it("still recomputes if the DMO request fails", async () => {
    adapterMock.mockRejectedValueOnce(new Error("DMO unavailable"));
    recomputeMock.mockResolvedValueOnce(null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await dispatchCron("45 9,15 * * MON-FRI", {} as Env);

    expect(adapterMock).toHaveBeenCalledTimes(1);
    expect(recomputeMock).toHaveBeenCalledTimes(1);
    expect(todayMock).not.toHaveBeenCalled();
  });
});
