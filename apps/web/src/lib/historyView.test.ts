import { describe, expect, it } from "vitest";
import { chartTickLabel, historyHref, parseHistoryRange, parseHistoryResolution } from "./historyView.js";

describe("history view requests", () => {
  it("offers short recorded windows and full available storage without accepting partial numeric input", () => {
    expect(parseHistoryRange("1")).toEqual({ option: 1, days: 1 });
    expect(parseHistoryRange("7")).toEqual({ option: 7, days: 7 });
    expect(parseHistoryRange("all")).toEqual({ option: "all", days: 7305 });
    expect(parseHistoryRange("30junk")).toEqual({ option: 90, days: 90 });
  });
  it("validates resolution and keeps embed/navigation preferences", () => {
    expect(parseHistoryResolution("raw")).toBe("raw");
    expect(parseHistoryResolution("invented")).toBe("auto");
    expect(historyHref(7, "hourly", true)).toBe("/composite?range=7&resolution=hourly&embed=1");
  });
  it("uses time-of-day labels for intraday records and dates for long views", () => {
    expect(chartTickLabel("2026-10-28T13:25:00Z", 86_400_000)).toBe("13:25");
    expect(chartTickLabel("2026-10-28T13:25:00Z", 7 * 86_400_000)).toContain("28 Oct");
  });
});
