// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyLiveDocument, startLiveRefresh } from "./liveRefresh.js";
import { disposeScoreCharts, initialiseScoreCharts } from "./scoreChartInteraction.js";
import { disposeChartEvents } from "./chartEventInteraction.js";

const stamp = "2026-10-29T11:30:00.000Z";
const newer = "2026-10-29T11:35:00.000Z";
function page(updatedAt = stamp, count = 2, valid = true) {
  const points = Array.from({ length: count }, (_, index) => ({ timestamp: `2026-10-29T11:${String(index * 5).padStart(2, "0")}:00.000Z`, headline: 37 + index, pillars: { market: 34, fiscal: 37, labour: 45, delivery: 31 }, x: index * 100, y: 20 }));
  return `<html><head><meta name="live-score-updated-at" content="${updatedAt}"></head><body>
    <div data-live-region="score"><time>${updatedAt}</time></div>
    <form><select name="resolution"><option>raw</option><option>daily</option></select><input name="draft" value="original"></form>
    <section data-live-region="history" data-live-valid="${valid}"><div class="annotated-chart">
      <script type="application/json" class="score-chart-data">${JSON.stringify({ points, width: 100, padL: 0, plotW: 100 })}</script>
      <svg class="chart-svg"><path class="pillar-fiscal"/><g class="score-crosshair"><line/><circle/></g></svg>
      <span data-score-position></span><time data-score-date></time><span data-score-value="headline">38</span>
      <button data-toggle-pillar="fiscal" aria-pressed="true">Fiscal</button>
      <input class="score-scrubber" type="range" min="0" max="${count - 1}"><button data-score-reset>Latest</button>
      <details><summary>Events</summary>Context</details>
    </div></section><span data-live-status hidden>Updates automatically · every minute</span>
  </body></html>`;
}
const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
const response = (html: string) => new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(stamp));
  document.documentElement.innerHTML = parse(page()).documentElement.innerHTML;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  initialiseScoreCharts();
});
afterEach(() => {
  stop?.(); stop = undefined;
  disposeScoreCharts(); disposeChartEvents();
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe("live region replacement", () => {
  it("updates scores while retaining historical selection, series, disclosures, focus and untouched form drafts", () => {
    const slider = document.querySelector<HTMLInputElement>(".score-scrubber")!;
    slider.value = "0"; slider.dispatchEvent(new Event("input")); slider.focus();
    document.querySelector<HTMLButtonElement>("[data-toggle-pillar]")!.click();
    document.querySelector("details")!.open = true;
    const draft = document.querySelector<HTMLInputElement>('[name="draft"]')!;
    draft.value = "my unsaved scenario";
    document.querySelector("select")!.value = "daily";
    applyLiveDocument(parse(page(newer, 3)));
    expect(document.querySelector('[data-live-region="score"]')!.textContent).toBe(newer);
    expect(document.querySelector("[data-score-date]")!.getAttribute("datetime")).toBe("2026-10-29T11:00:00.000Z");
    expect(document.querySelector("[data-score-value]")!.textContent).toBe("37.0");
    expect(document.querySelector("[data-toggle-pillar]")!.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector("details")!.open).toBe(true);
    expect(document.activeElement).toBe(document.querySelector(".score-scrubber"));
    expect(document.querySelector('[name="draft"]')).toBe(draft);
    expect(draft.value).toBe("my unsaved scenario");
    expect(document.querySelector("select")!.value).toBe("daily");
  });
  it("advances readers following Latest and leaves unchanged charts attached", () => {
    applyLiveDocument(parse(page(newer, 3)));
    expect(document.querySelector("[data-score-value]")!.textContent).toBe("39.0");
    const chart = document.querySelector(".annotated-chart");
    expect(applyLiveDocument(parse(page(newer, 3))).updated).toBe(0);
    expect(document.querySelector(".annotated-chart")).toBe(chart);
  });
  it("rejects older, placeholder and malformed snapshots without changing the page", () => {
    const chart = document.querySelector(".annotated-chart");
    for (const date of ["2026-10-28T11:30:00Z", "1970-01-01T00:00:00Z", "invalid"]) {
      expect(() => applyLiveDocument(parse(page(date)))).toThrow();
    }
    expect(document.querySelector(".annotated-chart")).toBe(chart);
    expect(document.querySelector('[data-live-region="score"]')!.textContent).toBe(stamp);
  });
  it("retains good history on partial failure and retries it even at the same snapshot timestamp", () => {
    const chart = document.querySelector(".annotated-chart");
    expect(applyLiveDocument(parse(page(newer, 3, false))).unavailable).toBe(true);
    expect(document.querySelector(".annotated-chart")).toBe(chart);
    applyLiveDocument(parse(page(newer, 3)));
    expect(document.querySelector("[data-score-value]")!.textContent).toBe("39.0");
  });
  it("defers a busy chart while refreshing other regions and never imports executable scripts", () => {
    const fresh = parse(page(newer, 3));
    fresh.querySelector('[data-live-region="score"]')!.insertAdjacentHTML("beforeend", '<script>window.bad=true</script><b onclick="bad()">new</b>');
    const chart = document.querySelector(".annotated-chart");
    applyLiveDocument(fresh, region => region.dataset.liveRegion === "history");
    expect(document.querySelector(".annotated-chart")).toBe(chart);
    expect(document.querySelector('[data-live-region="score"] script')).toBeNull();
    expect(document.querySelector("[onclick]")).toBeNull();
    expect(document.querySelector(".score-chart-data")).not.toBeNull();
  });
  it("retains the animated walker and scrolled tables while updating their readings", () => {
    const extra = '<div class="tightrope-walker" data-animate="true" data-score="60" data-amp="9" data-speed="1" aria-label="old pose"></div><div class="table-scroll">table</div>';
    document.querySelector('[data-live-region="score"]')!.insertAdjacentHTML("beforeend", extra);
    const walker = document.querySelector(".tightrope-walker");
    const table = document.querySelector<HTMLElement>(".table-scroll")!;
    table.scrollLeft = 200;
    const fresh = parse(page(newer));
    fresh.querySelector('[data-live-region="score"]')!.insertAdjacentHTML("beforeend", extra.replace('data-amp="9"', 'data-amp="11"').replace("old pose", "new pose"));
    applyLiveDocument(fresh);
    expect(document.querySelector(".tightrope-walker")).toBe(walker);
    expect(walker!.getAttribute("data-amp")).toBe("11");
    expect(walker!.getAttribute("aria-label")).toBe("new pose");
    expect(document.querySelector(".table-scroll")!.scrollLeft).toBe(200);
  });
});

describe("background polling", () => {
  it("polls after a minute, retaining the exact range/sampling URL without navigation", async () => {
    window.history.replaceState(null, "", "/composite?range=7&resolution=raw&embed=1#chart");
    const fetcher = vi.fn().mockResolvedValue(response(page(newer, 3)));
    vi.stubGlobal("fetch", fetcher);
    stop = startLiveRefresh();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher.mock.calls[0]![0]).toContain("/composite?range=7&resolution=raw&embed=1");
    expect(fetcher.mock.calls[0]![0]).not.toContain("#");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ cache: "no-store", redirect: "error" });
    expect(window.location.hash).toBe("#chart");
    expect(document.querySelector("[data-live-status]")!.getAttribute("data-live-checked-at")).toBeTruthy();
  });
  it("pauses in hidden tabs and offline, then refreshes immediately on return", async () => {
    const visible = vi.spyOn(document, "visibilityState", "get");
    const online = vi.spyOn(navigator, "onLine", "get");
    visible.mockReturnValue("hidden");
    const fetcher = vi.fn().mockImplementation(async () => response(page(newer)));
    vi.stubGlobal("fetch", fetcher);
    stop = startLiveRefresh();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetcher).not.toHaveBeenCalled();
    visible.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    online.mockReturnValue(false); window.dispatchEvent(new Event("offline"));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-live-status]")!.textContent).toContain("Offline");
    online.mockReturnValue(true); window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("keeps last-good content on failure, backs off, recovers and cleans up", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(response(page(newer, 3)));
    vi.stubGlobal("fetch", fetcher); stop = startLiveRefresh();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(document.querySelector('[data-live-region="score"]')!.textContent).toBe(stamp);
    expect(document.querySelector("[data-live-status]")!.textContent).toContain("Update delayed");
    await vi.advanceTimersByTimeAsync(119_999); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(document.querySelector("[data-score-value]")!.textContent).toBe("39.0");
    stop(); await vi.advanceTimersByTimeAsync(600_000); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("releases a drag lock when the window loses focus before pointerup", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(page(newer, 3))));
    stop = startLiveRefresh();
    document.querySelector(".score-scrubber")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(document.querySelector(".score-scrubber")!.getAttribute("max")).toBe("2");
    expect(document.querySelector("[data-score-value]")!.textContent).toBe("39.0");
  });
  it("bounds hanging requests and ignores a late response after stopping", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal("fetch", fetcher); stop = startLiveRefresh();
    await vi.advanceTimersByTimeAsync(60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!.aborted).toBe(true);
    stop(); resolve(response(page(newer, 3))); await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('[data-live-region="score"]')!.textContent).toBe(stamp);
  });
});
