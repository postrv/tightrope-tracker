import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureScoreChartState, disposeScoreCharts, initialiseScoreCharts, restoreScoreChartState } from "../../lib/scoreChartInteraction.js";

function fixture(responsive = false, samples?: Array<{ timestamp: string; headline: number }>, initialise = true) {
  disposeScoreCharts();
  const data = {
    width: 100, padL: 10, plotW: 80,
    ...(responsive ? { responsive: { width: 880, height: 420, padL: 44, padR: 16, padT: 44, padB: 64 } } : {}),
    points: [
      { timestamp: "2026-10-01T12:00:00Z", headline: 50.1, pillars: { market: 40, fiscal: 50, labour: 60, delivery: 70 }, x: 10, y: 50 },
      { timestamp: "2026-10-11T12:00:00Z", headline: 42.3, pillars: { market: 31.2, fiscal: 45, labour: 52, delivery: 60 }, x: 90, y: 58 },
    ],
  };
  if (samples) data.points = samples.map((sample, index) => ({ ...sample,
    pillars: { market: sample.headline, fiscal: 50, labour: 60, delivery: 70 },
    x: 10 + (index / Math.max(1, samples.length - 1)) * 80, y: 50,
  }));
  document.body.innerHTML = `<div class="annotated-chart"><script type="application/json" class="score-chart-data">${JSON.stringify(data)}</script>
    <svg class="chart-svg"><path class="headline-line"></path><path class="pillar-line pillar-market" data-pillar="market"></path><line data-score-tick="100"></line><text data-score-tick="100">100</text><g class="score-crosshair"><line></line><circle></circle></g></svg>
    <time data-score-date></time><span data-score-position></span><span data-score-value="headline"></span><span data-score-value="market"></span>
    <input class="score-scrubber" type="range" min="0" max="${data.points.length - 1}" value="${data.points.length - 1}"><button data-score-reset>Latest</button><button data-score-previous>Previous</button><button data-score-next>Next</button><input type="datetime-local" data-score-jump><button data-toggle-pillar="market" aria-pressed="true">Market</button><details class="event-list"><summary>Events</summary></details></div>`;
  if (responsive) document.querySelector<SVGSVGElement>("svg")!.getBoundingClientRect = () => ({ left: 0, width: 350 }) as DOMRect;
  if (initialise) initialiseScoreCharts();
  return document.querySelector<HTMLElement>(".annotated-chart")!;
}

afterEach(() => {
  disposeScoreCharts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("score history inspection", () => {
  beforeEach(() => fixture());

  it("updates exact values, timestamp and crosshair together when scrubbing", () => {
    const slider = document.querySelector<HTMLInputElement>("input")!;
    slider.value = "0";
    slider.dispatchEvent(new Event("input"));
    expect(document.querySelector('[data-score-value="headline"]')?.textContent).toBe("50.1");
    expect(document.querySelector('[data-score-value="market"]')?.textContent).toBe("40.0");
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-01T12:00:00Z");
    expect(document.querySelector(".score-crosshair circle")?.getAttribute("cx")).toBe("10");
    expect(slider.getAttribute("aria-valuetext")).toContain("headline 50.1");
  });

  it("returns to latest on Escape and can toggle pillar lines", () => {
    const slider = document.querySelector<HTMLInputElement>("input")!;
    slider.value = "0";
    slider.dispatchEvent(new Event("input"));
    slider.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(slider.value).toBe("1");
    const toggle = document.querySelector<HTMLButtonElement>("[data-toggle-pillar]")!;
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector<SVGElement>(".pillar-market")?.style.display).toBe("none");
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector<SVGElement>(".pillar-market")?.style.display).toBe("");
  });

  it("selects real samples on hover and keeps a clicked recording pinned", () => {
    const svg = document.querySelector<SVGSVGElement>("svg")!;
    svg.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
    svg.dispatchEvent(new PointerEvent("pointermove", { clientX: 10, pointerType: "mouse" }));
    expect(document.querySelector('[data-score-value="headline"]')?.textContent).toBe("50.1");
    svg.dispatchEvent(new MouseEvent("click", { clientX: 10 }));
    svg.dispatchEvent(new PointerEvent("pointermove", { clientX: 90, pointerType: "mouse" }));
    expect(document.querySelector('[data-score-value="headline"]')?.textContent).toBe("50.1");
    expect(document.querySelector("[data-score-position]")?.textContent).toContain("Pinned");
    document.querySelector<HTMLButtonElement>("[data-score-reset]")!.click();
    expect(document.querySelector('[data-score-value="headline"]')?.textContent).toBe("42.3");
  });

  it("reprojects a narrow chart and keeps axes, line and crosshair on the same scale", () => {
    fixture(true);
    expect(document.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 350 300");
    expect(document.querySelector(".score-crosshair circle")?.getAttribute("cx")).toBe("338");
    expect(document.querySelector("line[data-score-tick]")?.getAttribute("y1")).toBe("16");
    expect(document.querySelector("text[data-score-tick]")?.getAttribute("x")).toBe("28");
    expect(document.querySelector(".headline-line")?.getAttribute("d")).toContain("338.00,160.25");
  });

  it("moves between actual recordings and jumps to the nearest UTC date", () => {
    document.querySelector<HTMLButtonElement>("[data-score-previous]")!.click();
    expect(document.querySelector('[data-score-value="headline"]')?.textContent).toBe("50.1");
    document.querySelector<HTMLButtonElement>("[data-score-next]")!.click();
    expect(document.querySelector('[data-score-value="headline"]')?.textContent).toBe("42.3");
    const jump = document.querySelector<HTMLInputElement>("[data-score-jump]")!;
    jump.value = "2026-10-02T12:00";
    jump.dispatchEvent(new Event("change"));
    expect(document.querySelector('[data-score-value="headline"]')?.textContent).toBe("50.1");
  });
});

describe("score chart refresh lifecycle", () => {
  const samples = [
    { timestamp: "2026-10-01T12:00:00Z", headline: 50.1 },
    { timestamp: "2026-10-11T12:00:00Z", headline: 42.3 },
    { timestamp: "2026-10-21T12:00:00Z", headline: 44.8 },
  ];

  it("follows the new tail when latest was selected, including initialization of the root chart itself", () => {
    const old = fixture();
    const state = captureScoreChartState(old)!;
    expect(state.followingLatest).toBe(true);
    disposeScoreCharts(old);
    const fresh = fixture(false, samples, false);
    // A copied ready attribute cannot substitute for a live controller.
    fresh.dataset.scoreReady = "true";
    restoreScoreChartState(fresh, state);
    expect(fresh.querySelector("time")?.getAttribute("datetime")).toBe(samples[2]!.timestamp);
    expect(fresh.querySelector('[data-score-value="headline"]')?.textContent).toBe("44.8");
    expect(fresh.querySelector("[data-score-position]")?.textContent).toContain("Latest");
    expect(captureScoreChartState(fresh)?.followingLatest).toBe(true);
  });

  it("restores an unpinned historical selection by timestamp after the array grows and shifts indices", () => {
    const old = fixture(false, samples);
    old.querySelector<HTMLButtonElement>("[data-score-previous]")!.click();
    const state = captureScoreChartState(old)!;
    expect(state).toMatchObject({ selectedTimestamp: samples[1]!.timestamp, followingLatest: false, pinned: false });
    const fresh = fixture(false, [{ timestamp: "2026-09-21T12:00:00Z", headline: 52 }, ...samples,
      { timestamp: "2026-10-29T12:00:00Z", headline: 37 }]);
    restoreScoreChartState(fresh, state);
    expect(fresh.querySelector<HTMLInputElement>(".score-scrubber")?.value).toBe("2");
    expect(fresh.querySelector("time")?.getAttribute("datetime")).toBe(samples[1]!.timestamp);
    expect(fresh.querySelector("[data-score-position]")?.textContent).toContain("Recorded");
  });

  it("restores the nearest real recording after coarsening and preserves historical intent when it clamps to the tail", () => {
    const old = fixture(false, samples);
    const slider = old.querySelector<HTMLInputElement>(".score-scrubber")!;
    slider.value = "1";
    slider.dispatchEvent(new Event("input"));
    const state = captureScoreChartState(old)!;
    const fresh = fixture(false, [samples[0]!, { timestamp: "2026-10-12T12:00:00Z", headline: 43 }]);
    restoreScoreChartState(fresh, state);
    expect(fresh.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-12T12:00:00Z");
    expect(fresh.querySelector('[data-score-value="headline"]')?.textContent).toBe("43.0");
    expect(captureScoreChartState(fresh)?.followingLatest).toBe(false);
    expect(fresh.querySelector("[data-score-position]")?.textContent).toContain("Recorded");
    fresh.querySelector<HTMLButtonElement>("[data-score-reset]")!.click();
    expect(captureScoreChartState(fresh)?.followingLatest).toBe(true);
  });

  it("keeps a pinned old tail fixed while new points arrive and retains pillar, draft-date and event-list choices", () => {
    const old = fixture();
    const svg = old.querySelector<SVGSVGElement>("svg")!;
    svg.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
    svg.dispatchEvent(new MouseEvent("click", { clientX: 90 }));
    old.querySelector<HTMLButtonElement>("[data-toggle-pillar]")!.click();
    old.querySelector<HTMLInputElement>("[data-score-jump]")!.value = "2026-10-05T13:35";
    old.querySelector<HTMLDetailsElement>("details")!.open = true;
    const state = captureScoreChartState(old)!;
    expect(state).toMatchObject({ pinned: true, followingLatest: false, eventDetailsOpen: true, dateInputDraft: "2026-10-05T13:35", pillarVisibility: { market: false } });
    const fresh = fixture(false, samples);
    restoreScoreChartState(fresh, state);
    expect(fresh.querySelector("time")?.getAttribute("datetime")).toBe(samples[1]!.timestamp);
    expect(fresh.querySelector("[data-score-position]")?.textContent).toContain("Pinned");
    expect(fresh.querySelector("[data-toggle-pillar]")?.getAttribute("aria-pressed")).toBe("false");
    expect(fresh.querySelector<SVGElement>(".pillar-market")?.style.display).toBe("none");
    expect(fresh.querySelector<HTMLInputElement>("[data-score-jump]")?.value).toBe("2026-10-05T13:35");
    expect(fresh.querySelector<HTMLDetailsElement>("details")?.open).toBe(true);
    const freshSvg = fresh.querySelector<SVGSVGElement>("svg")!;
    freshSvg.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
    freshSvg.dispatchEvent(new PointerEvent("pointermove", { clientX: 90, pointerType: "mouse" }));
    expect(fresh.querySelector("time")?.getAttribute("datetime")).toBe(samples[1]!.timestamp);
  });

  it("disconnects resize observers and DOM listeners, tolerates queued callbacks, and reinitializes once", () => {
    const observers: Array<{ callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal("ResizeObserver", class {
      disconnect = vi.fn();
      constructor(callback: ResizeObserverCallback) { observers.push({ callback, disconnect: this.disconnect }); }
      observe() {}
    });
    const chart = fixture(true);
    initialiseScoreCharts(chart);
    expect(observers).toHaveLength(1);
    const oldPath = chart.querySelector(".headline-line")?.getAttribute("d");
    disposeScoreCharts(chart);
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(chart.dataset.scoreReady).toBeUndefined();
    expect(captureScoreChartState(chart)).toBeNull();
    chart.querySelector<HTMLButtonElement>("[data-toggle-pillar]")!.click();
    expect(chart.querySelector("[data-toggle-pillar]")?.getAttribute("aria-pressed")).toBe("true");
    chart.querySelector<SVGSVGElement>("svg")!.getBoundingClientRect = () => ({ left: 0, width: 400 }) as DOMRect;
    observers[0]!.callback([], {} as ResizeObserver);
    expect(chart.querySelector(".headline-line")?.getAttribute("d")).toBe(oldPath);
    initialiseScoreCharts(chart);
    initialiseScoreCharts(chart);
    expect(observers).toHaveLength(2);
    chart.querySelector<HTMLButtonElement>("[data-toggle-pillar]")!.click();
    expect(chart.querySelector("[data-toggle-pillar]")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("removes the window resize fallback on disposal", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const chart = fixture(true);
    const resizeListener = add.mock.calls.find(([type]) => String(type) === "resize")?.[1];
    expect(resizeListener).toBeTypeOf("function");
    disposeScoreCharts(chart);
    expect(remove).toHaveBeenCalledWith("resize", resizeListener, { passive: true });
  });
});
