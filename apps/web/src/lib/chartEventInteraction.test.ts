/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureChartEventState, disposeChartEvents, initialiseChartEvents, restoreChartEventState,
} from "./chartEventInteraction.js";

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

function chartFixture(ids = ["budget", "rates"]): HTMLElement {
  const chart = document.createElement("div");
  chart.className = "annotated-chart";
  chart.innerHTML = `<svg>${ids.map(id => `
    <g class="marker" tabindex="0" role="button" aria-pressed="false" aria-label="${id}" data-event-id="${id}"><circle class="marker-hit" /></g>
    <g class="event-label" tabindex="0" role="button" aria-pressed="false" aria-label="${id}" data-event-id="${id}"><rect class="event-label-hit" /></g>
  `).join("")}</svg><div class="tooltip-layer">${ids.map(id => `
    <div class="tooltip" data-event-id="${id}" role="tooltip"><a href="#source">Source</a></div>
  `).join("")}</div>`;
  document.body.appendChild(chart);
  return chart;
}

function marker(chart: HTMLElement, id = "budget"): SVGElement {
  return chart.querySelector<SVGElement>(`.marker[data-event-id="${id}"]`)!;
}

function tooltip(chart: HTMLElement, id = "budget"): HTMLElement {
  return chart.querySelector<HTMLElement>(`.tooltip[data-event-id="${id}"]`)!;
}

function click(control: Element) {
  control.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function flushFrames() {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach(callback => callback(0));
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  frames = new Map();
  nextFrame = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
});

afterEach(() => {
  disposeChartEvents();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("refresh-safe chart event inspection", () => {
  it("initialises a chart root only once, so one click pins one event", () => {
    const chart = chartFixture();
    initialiseChartEvents(chart);
    initialiseChartEvents(chart);
    initialiseChartEvents();
    click(marker(chart));
    expect(captureChartEventState(chart)).toEqual({ pinnedEventId: "budget" });
    expect(tooltip(chart).dataset.pinned).toBe("true");
    expect(chart.querySelector('.event-label[data-event-id="budget"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("preserves hover, keyboard pinning, source-link interaction and Escape dismissal", () => {
    const chart = chartFixture();
    initialiseChartEvents(chart);
    const control = marker(chart);
    control.querySelector("circle")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    expect(tooltip(chart).dataset.active).toBe("true");
    expect(captureChartEventState(chart)?.pinnedEventId).toBeNull();
    control.querySelector("circle")!.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
    expect(tooltip(chart).dataset.active).toBe("false");
    control.dispatchEvent(new FocusEvent("focus"));
    expect(tooltip(chart).dataset.active).toBe("true");
    control.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    control.dispatchEvent(new FocusEvent("blur"));
    expect(tooltip(chart).dataset.active).toBe("true");
    click(tooltip(chart).querySelector("a")!);
    expect(captureChartEventState(chart)?.pinnedEventId).toBe("budget");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(captureChartEventState(chart)?.pinnedEventId).toBeNull();
    expect(tooltip(chart).dataset.active).toBe("false");
  });

  it("switches a pin through the permanent label and dismisses it on an outside click", () => {
    const chart = chartFixture();
    initialiseChartEvents(chart);
    click(marker(chart));
    click(chart.querySelector('.event-label[data-event-id="rates"]')!);
    expect(captureChartEventState(chart)?.pinnedEventId).toBe("rates");
    expect(tooltip(chart).dataset.active).toBe("false");
    expect(tooltip(chart, "rates").dataset.pinned).toBe("true");
    click(document.body);
    expect(captureChartEventState(chart)?.pinnedEventId).toBeNull();
    expect(tooltip(chart, "rates").dataset.active).toBe("false");
  });

  it("pins once for a touch pointer and suppresses its synthetic click", async () => {
    const chart = chartFixture();
    initialiseChartEvents(chart);
    const control = marker(chart);
    control.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true, cancelable: true }));
    click(control);
    expect(captureChartEventState(chart)?.pinnedEventId).toBe("budget");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(701);
    click(control);
    expect(captureChartEventState(chart)?.pinnedEventId).toBeNull();
  });

  it("restores the same event after replacement even when event order changes", () => {
    const oldChart = chartFixture();
    initialiseChartEvents(oldChart);
    click(marker(oldChart));
    const state = captureChartEventState(oldChart);
    disposeChartEvents(oldChart);
    oldChart.remove();
    const fresh = chartFixture(["new-event", "rates", "budget"]);
    restoreChartEventState(fresh, state);
    expect(captureChartEventState(fresh)).toEqual({ pinnedEventId: "budget" });
    expect(tooltip(fresh).dataset.active).toBe("true");
    expect(marker(fresh).getAttribute("aria-pressed")).toBe("true");
    expect(tooltip(fresh, "new-event").dataset.pinned).toBe("false");
  });

  it("drops a removed event pin and does not restore transient hover", () => {
    const chart = chartFixture(["rates"]);
    restoreChartEventState(chart, { pinnedEventId: "budget" });
    expect(captureChartEventState(chart)?.pinnedEventId).toBeNull();
    expect(tooltip(chart, "rates").dataset.active).toBe("false");
    marker(chart, "rates").querySelector("circle")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    const state = captureChartEventState(chart);
    expect(state).toEqual({ pinnedEventId: null });
    restoreChartEventState(chart, state);
    expect(tooltip(chart, "rates").dataset.active).toBe("false");
  });

  it("keeps identical source event IDs scoped to their own chart", () => {
    const first = chartFixture(), second = chartFixture();
    initialiseChartEvents();
    click(marker(first));
    expect(captureChartEventState(first)?.pinnedEventId).toBe("budget");
    expect(captureChartEventState(second)?.pinnedEventId).toBeNull();
    disposeChartEvents(first);
    click(marker(second, "rates"));
    expect(captureChartEventState(second)?.pinnedEventId).toBe("rates");
  });

  it("clamps active details to the chart and reclamps after resize", () => {
    const chart = chartFixture();
    const tip = tooltip(chart);
    chart.getBoundingClientRect = () => ({ left: 0, right: 300 }) as DOMRect;
    tip.getBoundingClientRect = () => ({ left: -25, right: 215 }) as DOMRect;
    initialiseChartEvents(chart);
    click(marker(chart));
    flushFrames();
    expect(tip.style.getPropertyValue("--tip-shift")).toBe("33px");
    tip.getBoundingClientRect = () => ({ left: 110, right: 350 }) as DOMRect;
    window.dispatchEvent(new Event("resize"));
    flushFrames();
    expect(tip.style.getPropertyValue("--tip-shift")).toBe("-58px");
  });

  it("cancels timers/frames and removes old local and global handlers before replacement", () => {
    const chart = chartFixture();
    const tip = tooltip(chart);
    initialiseChartEvents(chart);
    marker(chart).dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true, cancelable: true }));
    expect(vi.getTimerCount()).toBe(1);
    const queued = [...frames.values()];
    expect(queued).toHaveLength(1);
    const measure = vi.spyOn(tip, "getBoundingClientRect");
    disposeChartEvents(chart);
    expect(vi.getTimerCount()).toBe(0);
    expect(frames.size).toBe(0);
    expect(captureChartEventState(chart)).toBeNull();
    expect(chart.dataset.chartEventsReady).toBeUndefined();
    tip.dataset.active = "disposed-sentinel";
    tip.dataset.pinned = "disposed-sentinel";
    click(marker(chart));
    click(document.body);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    window.dispatchEvent(new Event("resize"));
    queued.forEach(callback => callback(0));
    expect(tip.dataset.active).toBe("disposed-sentinel");
    expect(tip.dataset.pinned).toBe("disposed-sentinel");
    expect(measure).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    chart.remove();
  });

  it("can reinitialise the same disposed chart without duplicate listeners", () => {
    const chart = chartFixture();
    initialiseChartEvents(chart);
    disposeChartEvents(chart);
    initialiseChartEvents(chart);
    click(marker(chart));
    expect(captureChartEventState(chart)?.pinnedEventId).toBe("budget");
    click(marker(chart));
    expect(captureChartEventState(chart)?.pinnedEventId).toBeNull();
  });
});
