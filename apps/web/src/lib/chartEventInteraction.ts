/** The durable part of event inspection; hover/focus is intentionally transient. */
export interface ChartEventState {
  pinnedEventId: string | null;
}

interface ChartEventController {
  capture(): ChartEventState;
  restore(state: ChartEventState | null): void;
  dispose(): void;
}

type EventControl = HTMLElement | SVGElement;
const controllers = new WeakMap<HTMLElement, ChartEventController>();

function chartsWithin(root: ParentNode | HTMLElement): HTMLElement[] {
  const charts = Array.from(root.querySelectorAll<HTMLElement>(".annotated-chart"));
  if (root.nodeType === 1 && (root as Element).matches(".annotated-chart")) charts.unshift(root as HTMLElement);
  return charts;
}

/** Idempotent progressive enhancement, including a chart passed as root. */
export function initialiseChartEvents(root: ParentNode | HTMLElement = document): void {
  for (const chart of chartsWithin(root)) {
    if (controllers.has(chart)) continue;
    const controller = initialiseChart(chart);
    if (controller) controllers.set(chart, controller);
  }
}

/** Call before replacing a region so detached charts retain no global handlers. */
export function disposeChartEvents(root: ParentNode | HTMLElement = document): void {
  for (const chart of chartsWithin(root)) {
    controllers.get(chart)?.dispose();
    controllers.delete(chart);
  }
}

export function captureChartEventState(chart: HTMLElement): ChartEventState | null {
  return controllers.get(chart)?.capture() ?? null;
}

/** Restores by source event ID, never by position in a refreshed event array. */
export function restoreChartEventState(chart: HTMLElement, state: ChartEventState | null): void {
  initialiseChartEvents(chart);
  controllers.get(chart)?.restore(state);
}

function initialiseChart(chart: HTMLElement): ChartEventController | null {
  const controls = chart.querySelectorAll<EventControl>("[data-event-id][aria-label]");
  const tooltips = chart.querySelectorAll<HTMLElement>(".tooltip[data-event-id]");
  const ownerDocument = chart.ownerDocument;
  const view = ownerDocument.defaultView;
  if (!controls.length || !view) return null;

  const tooltipsById = new Map<string, HTMLElement>();
  const controlsById = new Map<string, EventControl[]>();
  for (const tooltip of tooltips) {
    const id = tooltip.dataset.eventId;
    if (id) tooltipsById.set(id, tooltip);
  }
  for (const control of controls) {
    const id = control.dataset.eventId;
    if (!id || !tooltipsById.has(id)) continue;
    const group = controlsById.get(id) ?? [];
    group.push(control);
    controlsById.set(id, group);
  }
  if (!controlsById.size) return null;

  let pinnedId: string | null = null;
  let suppressNextClick = false;
  let suppressTimer: number | undefined;
  let disposed = false;
  const frames = new Map<HTMLElement, number>();
  const listeners: Array<() => void> = [];
  function listen(target: EventTarget, type: string, listener: EventListener, options?: AddEventListenerOptions) {
    target.addEventListener(type, listener, options);
    listeners.push(() => target.removeEventListener(type, listener, options));
  }
  function clearAllActive() {
    tooltips.forEach(tooltip => { tooltip.dataset.active = "false"; });
    controls.forEach(control => { control.dataset.active = "false"; });
  }
  function clearAllPinned() {
    pinnedId = null;
    tooltips.forEach(tooltip => { tooltip.dataset.pinned = "false"; });
    controls.forEach(control => {
      control.dataset.pinned = "false";
      control.setAttribute("aria-pressed", "false");
    });
  }
  function setControlState(eventId: string, key: "active" | "pinned", value: boolean) {
    for (const control of controlsById.get(eventId) ?? []) {
      control.dataset[key] = String(value);
      if (key === "pinned") control.setAttribute("aria-pressed", String(value));
    }
  }
  function clampTooltip(tooltip: HTMLElement) {
    const previousFrame = frames.get(tooltip);
    if (previousFrame !== undefined) view!.cancelAnimationFrame(previousFrame);
    tooltip.style.setProperty("--tip-shift", "0px");
    const frame = view!.requestAnimationFrame(() => {
      frames.delete(tooltip);
      if (disposed || !chart.isConnected) return;
      const tipRect = tooltip.getBoundingClientRect();
      const chartRect = chart.getBoundingClientRect();
      const margin = 8;
      let shift = 0;
      if (tipRect.left < chartRect.left + margin) shift = chartRect.left + margin - tipRect.left;
      else if (tipRect.right > chartRect.right - margin) shift = chartRect.right - margin - tipRect.right;
      if (shift !== 0) tooltip.style.setProperty("--tip-shift", `${shift}px`);
    });
    frames.set(tooltip, frame);
  }
  function activate(eventId: string) {
    clearAllActive();
    const tooltip = tooltipsById.get(eventId);
    if (!tooltip) return;
    tooltip.dataset.active = "true";
    setControlState(eventId, "active", true);
    clampTooltip(tooltip);
  }
  function deactivate(eventId: string) {
    if (pinnedId === eventId) return;
    const tooltip = tooltipsById.get(eventId);
    if (tooltip) tooltip.dataset.active = "false";
    setControlState(eventId, "active", false);
  }
  function clearPinnedAndActive() {
    clearAllPinned();
    clearAllActive();
  }
  function pin(eventId: string) {
    pinnedId = eventId;
    tooltipsById.get(eventId)!.dataset.pinned = "true";
    setControlState(eventId, "pinned", true);
    activate(eventId);
  }
  function togglePinned(eventId: string) {
    const wasPinned = pinnedId === eventId;
    clearAllPinned();
    if (wasPinned) deactivate(eventId);
    else pin(eventId);
  }
  function eventIdFromHitTarget(node: EventTarget | null): string | null {
    const element = node as Element | null;
    if (!element || typeof element.closest !== "function") return null;
    const hit = element.closest(".marker-hit, .event-label-hit");
    if (!hit || !chart.contains(hit)) return null;
    return hit.closest<EventControl>("[data-event-id]")?.dataset.eventId ?? null;
  }
  function clearClickSuppression() {
    if (suppressTimer !== undefined) view!.clearTimeout(suppressTimer);
    suppressTimer = undefined;
    suppressNextClick = false;
  }
  function suppressSyntheticClick() {
    clearClickSuppression();
    suppressNextClick = true;
    suppressTimer = view!.setTimeout(() => {
      suppressTimer = undefined;
      suppressNextClick = false;
    }, 700);
  }

  listen(chart, "pointerover", event => {
    const eventId = eventIdFromHitTarget(event.target);
    if (!eventId || !tooltipsById.has(eventId) || (pinnedId && pinnedId !== eventId)) return;
    activate(eventId);
  });
  listen(chart, "pointerout", event => {
    const eventId = eventIdFromHitTarget(event.target);
    if (!eventId || !tooltipsById.has(eventId)) return;
    if (eventIdFromHitTarget((event as PointerEvent).relatedTarget) !== eventId) deactivate(eventId);
  });
  controls.forEach(control => {
    const eventId = control.dataset.eventId;
    if (!eventId || !tooltipsById.has(eventId)) return;
    listen(control, "focus", () => {
      if (!pinnedId || pinnedId === eventId) activate(eventId);
    });
    listen(control, "blur", () => { deactivate(eventId); });
    listen(control, "keydown", event => {
      const key = (event as KeyboardEvent).key;
      if (key !== "Enter" && key !== " ") return;
      event.preventDefault();
      togglePinned(eventId);
    });
    listen(control, "pointerdown", event => {
      if ((event as PointerEvent).pointerType === "mouse") return;
      event.preventDefault();
      event.stopPropagation();
      suppressSyntheticClick();
      togglePinned(eventId);
    });
    // Older WebKit did not consistently emit Pointer Events for SVG children.
    listen(control, "touchend", event => {
      if ("PointerEvent" in view) return;
      event.preventDefault();
      event.stopPropagation();
      suppressSyntheticClick();
      togglePinned(eventId);
    }, { passive: false });
    listen(control, "click", event => {
      event.stopPropagation();
      if (suppressNextClick) clearClickSuppression();
      else togglePinned(eventId);
    });
  });

  listen(ownerDocument, "click", event => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const inside = path.some(node => {
      const classes = (node as Element | null)?.classList;
      return classes?.contains("marker") || classes?.contains("event-label") || classes?.contains("tooltip");
    });
    if (!inside) clearPinnedAndActive();
  });
  listen(ownerDocument, "keydown", event => {
    if ((event as KeyboardEvent).key === "Escape") clearPinnedAndActive();
  });
  listen(view, "resize", () => {
    tooltips.forEach(tooltip => {
      if (tooltip.dataset.active === "true") clampTooltip(tooltip);
    });
  }, { passive: true });
  chart.dataset.chartEventsReady = "true";

  return {
    capture: () => ({ pinnedEventId: pinnedId }),
    restore(state) {
      clearPinnedAndActive();
      const id = state?.pinnedEventId;
      if (id && tooltipsById.has(id) && controlsById.has(id)) pin(id);
    },
    dispose() {
      disposed = true;
      listeners.forEach(remove => remove());
      clearClickSuppression();
      frames.forEach(frame => view.cancelAnimationFrame(frame));
      frames.clear();
      clearPinnedAndActive();
      tooltips.forEach(tooltip => { tooltip.style.removeProperty("--tip-shift"); });
      delete chart.dataset.chartEventsReady;
    },
  };
}
